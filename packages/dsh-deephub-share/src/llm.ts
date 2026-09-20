/**
 * 调模型。写法与 dsh 自带的 `session-title-llm` 一致：
 *
 * **输出上限不由本插件写死**：`maxTokens` 不传时按 dsh 适配器为这个模型配的默认上限走
 * （和这条会话正常回答用的是同一个上限）。写死一个数会随着会话变长、或换个爱思考的模型
 * （思考 token 与正文共用输出预算）而被截断。
 *
 * - 路由：`foldRequestHeader(events)?.config` → **用这条会话自己用过的模型**；没有就用插件配置里的
 *   `provider/model`；都没有 → 返回 null，生成按钮禁用，导出/发送不禁。
 * - 调用：`ctx.llm.stream(...)`，`BlockAssembler` 收 text 块；出现 `tool-call` 块或非 `stop` 结束 → 当失败。
 *
 * LLM 只负责"叙述"那三段（steps / forks / pitfalls）与标题目标；
 * 依赖清单、交付物、原始记录都是**程序**给的，不受模型发挥影响。
 */
import type { Context } from '@deepseek-ai/cordis'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { FinishReason, GenerateOptions } from '@deepseek-ai/dsh-llm'
import { foldRequestHeader } from '@deepseek-ai/dsh-session'
import type { SessionEvent, SessionId } from '@deepseek-ai/dsh-session'
import type { IdeaDoc, IdeaRawItem } from './shared/idea.ts'

export const PLUGIN_ID = 'dsh-deephub-share'

export interface Route { provider: string; model: string }

/** 会话用过的模型优先；其次插件配置；都没有 → null。 */
export function resolveRoute(events: readonly SessionEvent[], configured?: Partial<Route>): Route | null {
  const cfg = foldRequestHeader(events)?.config
  if (cfg !== undefined && cfg.provider && cfg.model) return { provider: cfg.provider, model: cfg.model }
  if (configured?.provider && configured.model) return { provider: configured.provider, model: configured.model }
  return null
}

/**
 * 输出撞上上限：正文多半是半截的，但**半截里常常已经有能用的东西**
 * （模型把 JSON 写完了又接着解释，被砍掉的是解释），所以把已收到的正文一起带出来，
 * 要不要用交给调用方。解析不出来时这个错就是失败原因。
 */
export class TruncatedOutput extends Error {
  readonly text: string
  constructor(text: string) {
    super('deephub-share: model output hit maxTokens')
    this.text = text
  }
}

function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'stop': return undefined
    case 'error':
    case 'aborted': {
      const e = new Error(finish.failure.message) as Error & { code?: string }
      e.code = finish.failure.code
      return e
    }
    case 'max-tokens': return undefined // oneshot 单独处理：带上已收到的正文
    case 'tool-calls': return new Error('deephub-share: model unexpectedly requested a tool')
    default: return new Error(`deephub-share: unsupported finish reason "${String((finish as { kind?: unknown }).kind)}"`)
  }
}

export interface OneshotOptions {
  /** 不传 = 用 dsh 适配器为这个模型配的默认上限（推荐）。传了就是硬上限 */
  maxTokens?: number
  timeoutMs?: number
  signal?: AbortSignal
  sessionId?: SessionId
}

/** 一次纯文本调用：喂 prompt，回全文。没有 system，没有 tools。 */
export async function oneshot(ctx: Context, route: Route, prompt: string, opts: OneshotOptions = {}): Promise<string> {
  const signals: AbortSignal[] = [AbortSignal.timeout(opts.timeoutMs ?? 120_000)]
  if (opts.signal) signals.push(opts.signal)
  const signal = AbortSignal.any(signals)

  const options: GenerateOptions = {
    provider: route.provider,
    model: route.model,
    messages: [createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'plugin', plugin: PLUGIN_ID },
    })],
    ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}),
    signal,
    ...(opts.sessionId !== undefined ? { sessionId: opts.sessionId } : {}),
  }

  const assembler = new BlockAssembler()
  for await (const chunk of ctx.llm.stream(options)) {
    signal.throwIfAborted()
    assembler.push(chunk)
  }
  signal.throwIfAborted()
  const blocks = assembler.blocks()
  if (blocks.some((b) => b.type === 'tool-call')) throw new Error('deephub-share: model unexpectedly requested a tool')
  const text = blocks.filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text').map((b) => b.text).join(' ')
  if (assembler.finish.kind === 'max-tokens') throw new TruncatedOutput(text)
  const err = finishError(assembler.finish)
  if (err !== undefined) throw err
  return text
}

/* ───────────────────────── 生成思路 ───────────────────────── */

/** 提示词与 DeepHub `idea/extract.ts` 逐字一致：两边生成的思路读起来是一个口径。 */
const PROMPT = `下面是一段工作记录（一个人和他的 AI 助手完成一件事的全过程）。请把它整理成一份能让**别人照着做**的思路。

只输出 JSON，不要解释，不要代码块围栏：
{
 "title": "一句话标题",
 "goal": "一句话说清这件事要达成什么",
 "steps": ["按顺序的关键步骤，每条一句话，说清做了什么、为什么这么做"],
 "forks": ["在哪里做了选择、为什么选这个而不是那个"],
 "pitfalls": ["哪一步失败了/返工了、怎么绕过去的"]
}

要求：
- **pitfalls 必须保留**，哪怕看起来不体面。失败和返工是所有教程里永远缺的、也最值钱的部分。没有就给空数组，不要编。
- steps 要具体到"用了什么、改了什么"，不要写成"进行需求分析"这种废话。
- 不要加记录里没有的内容。
- 全部用中文。

工作记录：
---
`

interface LlmPart {
  title?: string; goal?: string
  steps?: unknown; forks?: unknown; pitfalls?: unknown
}

const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim()) : []

function parseJson(out: string): LlmPart {
  const s = out.indexOf('{')
  const e = out.lastIndexOf('}')
  if (s < 0 || e <= s) return {}
  try { return JSON.parse(out.slice(s, e + 1)) as LlmPart } catch { return {} }
}

/** 喂给模型的摘要。太长会超窗，这里按"人说的话 + 工具名 + 结果头部"压一遍。 */
export function digest(raw: readonly IdeaRawItem[], limit = 24000): string {
  const lines = raw.map((r) =>
    r.role === 'tool'
      ? `[工具 ${r.label ?? ''}] ${r.text.slice(0, 300)}`
      : `${r.role === 'user' ? '用户' : '助手'}：${r.text.slice(0, 1200)}`,
  )
  let out = ''
  for (const l of lines) {
    if (out.length + l.length > limit) break
    out += l + '\n'
  }
  return out
}

/**
 * 长会话**分块全扫，不截断**：每块各出一份 JSON，最后合并——
 * steps/forks/pitfalls 顺序拼接，title/goal 取第一块非空的。
 */
const NARRATIVE_CHUNK = 24000

export interface Narrative {
  title: string; goal: string; steps: string[]; forks: string[]; pitfalls: string[]
  /** 至少有一块是从截断的输出里捞出来的：内容能用，但末尾可能不全 */
  truncated: boolean
}

/** 叙述三段 + 标题目标。任何一块失败 → 抛错（调用方退回"只有程序部分"的草稿）。 */
export async function narrate(
  call: (prompt: string) => Promise<string>,
  raw: readonly IdeaRawItem[],
): Promise<Narrative | null> {
  // 按 digest 的行切块：一行不拆
  const lines = digest(raw, Number.MAX_SAFE_INTEGER).split('\n').filter(Boolean)
  const chunks: string[] = []
  let cur = ''
  for (const l of lines) {
    if (cur && cur.length + l.length + 1 > NARRATIVE_CHUNK) { chunks.push(cur); cur = '' }
    cur += l + '\n'
  }
  if (cur) chunks.push(cur)
  if (!chunks.length) return null

  const merged: Narrative = { title: '', goal: '', steps: [], forks: [], pitfalls: [], truncated: false }
  let any = false
  let cutErr: TruncatedOutput | null = null
  for (let i = 0; i < chunks.length; i++) {
    const head = chunks.length > 1 ? `（这是第 ${i + 1}/${chunks.length} 段记录，只整理这一段）\n` : ''
    let out: string
    let cut = false
    try {
      out = await call(PROMPT + head + chunks[i])
    } catch (e) {
      if (!(e instanceof TruncatedOutput)) throw e
      out = e.text
      cut = true
      if (cutErr === null) cutErr = e
    }
    const p = parseJson(out)
    const steps = strList(p.steps)
    if (!steps.length) continue // 这一块没捞着；别的块还可能有
    any = true
    if (cut) merged.truncated = true
    if (!merged.title && typeof p.title === 'string' && p.title.trim()) merged.title = p.title.trim()
    if (!merged.goal && typeof p.goal === 'string' && p.goal.trim()) merged.goal = p.goal.trim()
    merged.steps.push(...steps)
    merged.forks.push(...strList(p.forks))
    merged.pitfalls.push(...strList(p.pitfalls))
  }
  // 一块都没捞着，而且是被截断的 → 失败原因就是截断
  if (!any && cutErr !== null) throw cutErr
  return any ? merged : null
}

/** 空草稿：程序部分由调用方填。 */
export function emptyDoc(title: string): IdeaDoc {
  return { v: 1, title, goal: '', deps: { tools: [], connectors: [], capabilities: [] }, steps: [], forks: [], pitfalls: [], deliverables: [], raw: [] }
}
