/**
 * 收下 = 在 dsh 里落成一条新会话。
 *
 * **下面四步的顺序不能动**，每一步都被 dsh 的某条约束钉死：
 *
 *   1. 先选工作区，**用它的 path 当会话的 cwd** —— `attachSession` 会把 header 里的 cwd
 *      realpath 之后跟工作区的 path **严格比对**，不等就抛错。所以顺序不能反。
 *   2. `agents.create({ sessionId, meta:{cwd}, seed })` —— **整条会话一次写完**，seed 里四条：
 *      卡片事件、给模型看的正文、以及把它们包起来的那一轮（见下面 SEEN_TURN）。
 *   3. `attachSession` —— 不 attach 的话会话是好的，但**不属于任何工作区、侧栏里看不见**。
 *   4. `sessionTitle.rename` —— 插件来源的 `user/message` **不会**触发 dsh 自动起标题，
 *      不自己改就是一条无标题会话。
 *
 * 正文走 seed 而不是 `agent.followup()`：followup 会立刻起一轮模型调用（花钱），
 * 我们只是把内容塞进上下文，等用户自己开口。
 *
 * 这几个服务都用 `ctx.get(...)` 拿，**不写进 `inject`**：cordis 的 inject 没有"可选"一说，
 * 写进去就是硬依赖，哪天 profile 里少一个，整个插件都装不上。
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import type {} from './events.ts'
import type { LandedAttachment, ReceivedIdeaEvent } from './events.ts'
import type { IdeaDoc } from './shared/idea.ts'

// ── dsh 那几个服务的结构类型（只写我们用到的那几下，不引第二份运行时依赖）──

interface WorkspaceLike {
  readonly id: string
  readonly path: string
  readonly title: string
  attachSession(sessionId: SessionId): Promise<void>
}
interface RegistryLike { list(): WorkspaceLike[] }
/** 建完会话拿到的那个 session：现在只用来改标题（正文已经在 seed 里了）。 */
interface SessionLike {
  readonly id: string
}
interface AgentsLike {
  create(options: {
    sessionId: SessionId
    meta: { cwd: string }
    seed?: readonly SessionEvent[]
  }): Promise<{ agent: { session: SessionLike } }>
}
interface CtxGet { get(name: string): unknown }

const svc = <T>(ctx: Context, name: string): T | undefined =>
  (ctx as unknown as CtxGet).get(name) as T | undefined

/** 收下时能落到哪儿。`id` 回传给 `land()`。 */
export interface WorkspaceChoice { id: string; path: string; title: string }

export function workspaces(ctx: Context): WorkspaceChoice[] {
  const reg = svc<RegistryLike>(ctx, 'workspaceRegistry')
  return reg === undefined ? [] : reg.list().map((w) => ({ id: w.id, path: w.path, title: w.title }))
}

// ── 文件名消毒 ────────────────────────────────────────────────────────

/** 文件名里一律换掉的字符：Windows 不许用的那几个。路径分隔符在上面先切过了。 */
const BANNED = '<>:"|?*'
/** 开头的点：`.`、`..`、`.ssh` 这类不让它出现在开头。 */
const LEADING_DOTS = /^\.+/

/**
 * 别人给的文件名**只取最后一段**，再把危险字符换成 `_`。
 *
 * 这里是**按字符集合逐个换**，不是拿正则去"猜文件名的含义"——
 * 没有哪个 LLM 该来判断 `..` 算不算穿越，这种事就得写死。与 DeepHub 桌面端同一条规矩。
 */
export function safeName(raw: string): string {
  const last = raw.split('/').join('\\').split('\\').pop() ?? ''
  const cleaned = Array.from(last)
    .map((ch) => {
      const code = ch.codePointAt(0)
      // 控制字符、路径分隔符、Windows 不许用的那几个，一律换成下划线
      return code === undefined || code < 32 || BANNED.includes(ch) ? '_' : ch
    })
    .join('')
    .replace(LEADING_DOTS, '_')
    .trim()
  return cleaned.length > 0 ? cleaned.slice(0, 120) : 'file'
}

/** 目录名同理，外加把空白压成一个空格。 */
const safeDir = (raw: string): string => safeName(raw).replace(/\s+/g, ' ')

export interface LandInput {
  doc: IdeaDoc
  from: { accountId: string; shortId: string; displayName: string | null }
  ideaId: string
  attachments: Array<{ name: string; data: Buffer }>
  /** 工作区 id；不给或找不到就用第一个 */
  workspaceId?: string
  /** 会话标题的模板，`{who}` `{title}` 两个位置。文案在浏览器半的词典里，Host 不管语言 */
  titleFmt: string
  /** 对方没设名字时用什么称呼 */
  unnamed: string
}

export interface LandResult {
  ok: true
  sessionId: string
  workspace: WorkspaceChoice
  /** 真正写进去的附件（相对工作区根） */
  attachments: LandedAttachment[]
}

/** 收到的附件都落在工作区下的这个目录里。 */
const ROOT_DIR = '收到的思路'

/** dsh 的标题上限没有公开常量，这里自己收一下，免得一个超长标题把侧栏撑坏。 */
const TITLE_MAX = 80

/*
 * SEEN_TURN —— 为什么 seed 里要有一轮"没跟模型说过话"的轮次。
 *
 * dsh 判一条会话是不是"空会话（blank）"只看一件事：日志里出现过 `turn/start` 没有
 * （`applySessionListMetadata`：`blank = state.blank && event.type !== 'turn/start'`）。
 * 而侧栏的可见性是 `!blank || 就是当前这条` —— 也就是说**空会话只在打开着的时候出现在侧栏，
 * 一切走就不列了，会话搜索也把它排除在外**。
 *
 * 而收下落地的会话，在用户开口之前**正好就是一条空会话**——不补这一轮，它一旦被关掉，
 * 就从侧栏和会话搜索里同时消失，用户再也找不回那份思路。
 *
 * 所以 seed 里补一轮：`turn/start` + 正文 + `turn/end`。已知代价：
 *   - 日志里多了一轮"没调过模型"的轮次；
 *   - 轨迹页里用户自己的第一句会显示成「第 2 轮」。
 * 换来的是这条会话跟别的会话一样，关了还找得回来。
 */

export async function land(ctx: Context, input: LandInput): Promise<LandResult> {
  const reg = svc<RegistryLike>(ctx, 'workspaceRegistry')
  const agents = svc<AgentsLike>(ctx, 'agents')
  if (reg === undefined || agents === undefined) {
    throw new Error('这份 dsh 里没有工作区或 agent 服务，收下没法落地')
  }
  const all = reg.list()
  const ws = all.find((w) => w.id === input.workspaceId) ?? all[0]
  if (ws === undefined) throw new Error('还没有工作区，先在 dsh 里建一个')

  const who = input.from.displayName ?? input.unnamed
  const title = input.titleFmt
    .replace('{who}', who)
    .replace('{title}', input.doc.title)
    .slice(0, TITLE_MAX)

  // ① 附件先落盘：卡片上的「打开」得有真文件可开，而事件里要记下它们的相对路径
  const landed = await writeAttachments(ws.path, input.doc.title, input.attachments)

  // ② 建会话。整条会话**一次写完**：卡片、给模型看的正文、还有那一轮的起止，全在 seed 里。
  //    - 卡片事件只能走 seed（唯一能带 `ignorable` 的口子，见 events.ts）；
  //    - 那一轮（`turn/start`/`turn/end`）是**为了让这条会话在侧栏里留得住**，见下面 SEEN_TURN 的说明；
  //    - 正文跟着放进同一轮里，轨迹页读起来就是"第 1 轮：收到的思路"，而不是一轮空的。
  const sessionId = SessionId(`idea-${randomUUID()}`)
  const now = Date.now()
  const data: ReceivedIdeaEvent = {
    ideaId: input.ideaId,
    from: input.from,
    receivedAt: now,
    doc: input.doc,
    attachments: landed,
  }
  const { createUserMessage } = await import('@deepseek-ai/dsh-llm')
  const seed: readonly SessionEvent[] = [
    { type: 'deephub-share/received', seq: 0, time: now, data, ignorable: true },
    {
      type: 'user/message',
      seq: 1,
      time: now,
      surfaceOp: 'append',
      data: createUserMessage({
        content: [{ type: 'text', text: modelText(input.doc, who) }],
        source: { kind: 'plugin', plugin: 'dsh-deephub-share', form: 'notice', summary: title },
      }),
    },
    { type: 'turn/start', seq: 2, time: now, data: { turn: 1 } },
    { type: 'turn/end', seq: 3, time: now, data: { turn: 1, reason: { kind: 'completed' } } },
  ] as unknown as readonly SessionEvent[]
  const handle = await agents.create({ sessionId, meta: { cwd: ws.path }, seed })
  const session = handle.agent.session

  // ③ 进工作区，否则侧栏里看不见
  await ws.attachSession(sessionId)

  // ④ 标题：插件来源的消息不会触发 dsh 自动起标题
  try {
    const st = svc<{ rename(s: unknown, t: string): unknown }>(ctx, 'sessionTitle')
    st?.rename(session, title)
  } catch (e) {
    console.log(`[dsh-deephub-share] rename failed: ${(e as Error).message}`)
  }

  console.log(`[dsh-deephub-share] landed ${sessionId} in ${ws.title} (${landed.length} attachments)`)
  return { ok: true, sessionId: String(sessionId), workspace: { id: ws.id, path: ws.path, title: ws.title }, attachments: landed }
}

/**
 * 附件落到 `<工作区>/收到的思路/<标题>/`。
 *
 * **每收下一份就新开一个目录**：同一个人可能把同一份思路改完再发一遍，标题一模一样；
 * 要是复用同一个目录，第二份的 `notes.txt` 会把第一份的悄悄盖掉，第一张卡片上的「打开」
 * 从此打开的就是新文件。所以目录被占了就往后排 `-2`、`-3`。
 * 一份之内的同名文件同样往后排。
 */
async function writeAttachments(
  wsPath: string,
  docTitle: string,
  files: Array<{ name: string; data: Buffer }>,
): Promise<LandedAttachment[]> {
  if (files.length === 0) return []
  const base = safeDir(docTitle) || 'idea'
  const { dir, rel } = await freshDir(wsPath, base)

  const used = new Set<string>()
  const out: LandedAttachment[] = []
  for (const f of files) {
    let name = safeName(f.name)
    if (used.has(name)) {
      const dot = name.lastIndexOf('.')
      const stem = dot > 0 ? name.slice(0, dot) : name
      const ext = dot > 0 ? name.slice(dot) : ''
      let n = 2
      while (used.has(`${stem}-${n}${ext}`)) n += 1
      name = `${stem}-${n}${ext}`
    }
    used.add(name)
    await writeFile(join(dir, name), f.data)
    out.push({ name, path: `${rel}/${name}`, size: f.data.length })
  }
  return out
}

/**
 * 开一个还没被占的目录，返回绝对路径与相对工作区根的路径。
 *
 * 用 `mkdir` 不带 `recursive` 来占位：它在目录已存在时会抛 `EEXIST`，所以"检查 + 创建"
 * 是一步完成的，不会两次收下同时看到"还没有"然后一起写进同一个目录。
 */
async function freshDir(wsPath: string, base: string): Promise<{ dir: string; rel: string }> {
  await mkdir(join(wsPath, ROOT_DIR), { recursive: true })
  for (let n = 1; n < 1000; n += 1) {
    const name = n === 1 ? base : `${base}-${n}`
    const dir = join(wsPath, ROOT_DIR, name)
    try {
      await mkdir(dir)
      return { dir, rel: `${ROOT_DIR}/${name}` }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
    }
  }
  throw new Error(`${base}: 同名目录太多了`)
}

/** 给模型看的正文：和导出的 Markdown 同一套内容，但去掉原始记录（那份留在卡片里）。 */
function modelText(doc: IdeaDoc, who: string): string {
  const lines: string[] = [`${who} 分享了一份思路：${doc.title}`, '']
  if (doc.goal) lines.push(`目标：${doc.goal}`, '')
  const block = (head: string, items: readonly string[]): void => {
    if (items.length === 0) return
    lines.push(`${head}：`)
    for (const x of items) lines.push(`- ${x}`)
    lines.push('')
  }
  block('步骤', doc.steps)
  block('岔路', doc.forks)
  block('踩坑', doc.pitfalls)
  if (doc.deliverables.length > 0) {
    lines.push('交付物：')
    for (const d of doc.deliverables) lines.push(`- ${d.title}`)
  }
  return lines.join('\n').trim()
}
