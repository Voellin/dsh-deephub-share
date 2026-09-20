/**
 * 脱敏：一份思路发出去之前，把不该跟着走的东西挡下来。分三层，与 DeepHub 桌面端同源。
 *
 * | 层 | 处理什么 | 谁判断 | 开关 |
 * |---|---|---|---|
 * | ① 结构化 | 工具参数 JSON 里的凭据键、绝对路径 | 程序 | **无，永远执行** |
 * | ② 正文语义 | 人名/公司名/客户名/金额/内部链接 | **LLM** | 有，默认关 |
 * | ③ 注入段 | `extract.ts` 的过滤已从根上不带 | 程序 | 无 |
 *
 * 绝对路径先按会话的 `cwd` **相对化**（`<cwd>/src/a.ts` → `src/a.ts`，收件方照着目录结构
 * 还能对上），不在 `cwd` 下的才退到「只留文件名」——路径里常常带着用户名与目录习惯。
 *
 * ⚠️ **这一层不是安全边界。** 键名匹配一定有漏网，真正的防线是发出前那一屏「过目」。
 * 界面上在没跑 ② 的时候**绝不能出现「已检查」字样**。
 */
import type { IdeaDoc, IdeaRawItem, RedactCandidate } from './shared/idea.ts'

/**
 * 凭据类键名。**这是"位置明确的结构化字段"，不是用正则判断业务语义** ——
 * 红线针对的是"用正则去猜某段话是不是危险操作"，而这里是按 JSON 键名剔值。
 * 漏了的会原样进"过目"屏，由用户自己看见。（清单与 DeepHub 一致）
 */
const SECRET_KEYS = [
  'key', 'apikey', 'api_key', 'token', 'secret', 'password', 'passwd', 'pwd',
  'authorization', 'auth', 'cookie', 'session', 'credential', 'access_key', 'accesskey',
  'signature', 'sign', 'private',
]

const looksSecretKey = (k: string): boolean => {
  const low = k.toLowerCase()
  return SECRET_KEYS.some((s) => low === s || low.includes(s))
}

/** Windows 盘符路径或 POSIX 绝对路径。这两条是**人工审过的**字符级匹配，不做语义猜测。 */
const WIN_ABS = /[A-Za-z]:\\[^\s"'<>|]*/g
const POSIX_ABS = /(?<![\w.])\/(?:home|Users|root|var|tmp|opt|mnt|sessions)\/[^\s"'<>|]*/g

const basename = (p: string): string => {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts.length ? (parts[parts.length - 1] as string) : p
}

/**
 * 先把会话 cwd 前缀去掉（纯字符串替换，不是正则），再把剩下的绝对路径换成文件名。
 * **只动路径本身，不碰周围的话。**
 */
export function stripAbsolutePaths(text: string, cwd?: string): string {
  let out = text
  if (cwd) {
    let root = cwd
    while (root.endsWith('/') || root.endsWith('\\')) root = root.slice(0, -1)
    if (root) {
      // `<cwd>/x` 与 `<cwd>\x` → `x`；单独出现的 `<cwd>` → `.`
      out = out.split(root + '/').join('').split(root + '\\').join('')
      out = out.split(root).join('.')
    }
  }
  return out.replace(WIN_ABS, (m) => basename(m)).replace(POSIX_ABS, (m) => basename(m))
}

/**
 * 工具参数 JSON 的程序脱敏：凭据键剔值、路径值相对化/只留文件名。
 * 解析不了就整体当字符串处理（宁可保守）。
 */
export function redactArgs(argsJson: string, cwd?: string): string {
  let parsed: unknown
  try { parsed = JSON.parse(argsJson) } catch { return stripAbsolutePaths(argsJson, cwd) }

  const walk = (v: unknown, key?: string): unknown => {
    if (typeof v === 'string') {
      if (key !== undefined && looksSecretKey(key)) return '「已剔除」'
      return stripAbsolutePaths(v, cwd)
    }
    if (Array.isArray(v)) return v.map((x) => walk(x))
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        out[k] = looksSecretKey(k) && typeof val !== 'object' ? '「已剔除」' : walk(val, k)
      }
      return out
    }
    return v
  }
  try { return JSON.stringify(walk(parsed)) } catch { return '「参数无法处理，已剔除」' }
}

/** ① 层：对整份思路做程序脱敏。幂等，可以重复跑。 */
export function redactStructural(doc: IdeaDoc, cwd?: string): IdeaDoc {
  const strip = (s: string): string => stripAbsolutePaths(s, cwd)
  // 工具条目（参数与结果）都走 redactArgs：是 JSON 就按键剔值，不是就退回纯路径处理——与 DeepHub 一致
  const raw: IdeaRawItem[] = doc.raw.map((it) =>
    it.role === 'tool'
      ? { ...it, text: redactArgs(it.text, cwd) }
      : { ...it, text: strip(it.text) },
  )
  return {
    ...doc,
    title: strip(doc.title),
    goal: strip(doc.goal),
    steps: doc.steps.map(strip),
    forks: doc.forks.map(strip),
    pitfalls: doc.pitfalls.map(strip),
    deliverables: doc.deliverables.map((d) => ({ ...d, title: strip(d.title) })),
    raw,
  }
}

/* ────────────────────────── ② 层：LLM 语义扫描 ────────────────────────── */

/** 一次扫多少字符。太大模型会偷懒漏标，太小请求数爆炸。 */
const CHUNK = 6000

const SCAN_PROMPT = `你在帮用户检查一份即将分享给朋友的工作记录，找出**可能不该外传**的内容。

只找这几类，逐条列出：
- person：真实人名（同事、客户、领导的名字）
- company：公司名、组织名、部门名
- client：客户或项目代号、合同号
- money：金额、报价、预算、薪酬
- internal：内部术语、内部系统名、内部流程代号
- link：内部链接、内网地址、共享文档链接

规则：
1. **宁可多标，不要漏标** —— 用户会逐条决定保留还是打码，标错的代价只是他划掉一下。
2. 只标**确实出现在文本里的原文片段**，一字不差地抄下来，不要改写、不要合并同类项。
3. 公开的东西不要标：知名开源库、公开网站、通用技术名词、示例数据。
4. 没有可标的就返回空数组。

只输出 JSON，不要解释，不要代码块围栏：
[{"kind":"person","text":"原文片段","why":"一句话"}]

以下是待检查的文本：
---
`

interface RawHit { kind?: string; text?: string; why?: string }

const KINDS = new Set(['person', 'company', 'client', 'money', 'internal', 'link', 'other'])

/** 从模型回复里取出 JSON 数组。模型偶尔会套代码块或前后加话，这里容忍。 */
function parseHits(out: string): RawHit[] {
  const s = out.indexOf('[')
  const e = out.lastIndexOf(']')
  if (s < 0 || e <= s) return []
  try {
    const arr: unknown = JSON.parse(out.slice(s, e + 1))
    return Array.isArray(arr) ? (arr as RawHit[]) : []
  } catch { return [] }
}

/** 把一份思路摊平成待扫的文本块。 */
function chunksOf(doc: IdeaDoc): string[] {
  const lines = [
    doc.title, doc.goal, ...doc.steps, ...doc.forks, ...doc.pitfalls,
    ...doc.deliverables.map((d) => d.title),
    ...doc.raw.map((r) => (r.label ? `[${r.label}] ${r.text}` : r.text)),
  ].filter((x) => typeof x === 'string' && x.trim())

  const out: string[] = []
  let cur = ''
  for (const l of lines) {
    // 单行就超长（工具返回的大段原文）：切开，别整行丢掉
    if (l.length > CHUNK) {
      if (cur) { out.push(cur); cur = '' }
      for (let i = 0; i < l.length; i += CHUNK) out.push(l.slice(i, i + CHUNK))
      continue
    }
    if (cur.length + l.length + 1 > CHUNK) { out.push(cur); cur = '' }
    cur += (cur ? '\n' : '') + l
  }
  if (cur) out.push(cur)
  return out
}

export interface ScanDeps {
  /** 一次纯文本调用：喂 prompt，回全文。见 `llm.ts` 的 `oneshot` */
  oneshot: (prompt: string, opts?: { maxTokens?: number }) => Promise<string>
  onProgress?: (done: number, total: number) => void
}

/**
 * ② 层：**分块全扫，不截断。**
 *
 * 为什么不截断：客户名字出现在第 200 条就会被漏掉，而界面还会告诉用户"已扫描" ——
 * 那比不扫更糟。代价是长会话要等十几秒，所以有 `onProgress`。
 *
 * 失败处理：**某一块失败就整体失败**（抛错），不返回半份结果。半份结果会让用户
 * 以为"扫过了没问题"，那是最坏的一种错。调用方据此提示"扫描没成功，可以直接过目发送"。
 */
export async function scanSemantic(doc: IdeaDoc, deps: ScanDeps): Promise<RedactCandidate[]> {
  const chunks = chunksOf(doc)
  const hits: RedactCandidate[] = []
  const seen = new Set<string>()
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i] as string
    const out = await deps.oneshot(SCAN_PROMPT + chunk)
    for (const h of parseHits(out)) {
      const text = typeof h.text === 'string' ? h.text.trim() : ''
      if (!text) continue
      // 模型偶尔会"标"一段原文里根本没有的话（改写过的）。对不上就丢掉——
      // 拿它去做替换只会把用户的原文改坏。
      if (!chunk.includes(text)) continue
      const key = text.toLowerCase()
      if (seen.has(key)) continue
      seen.add(key)
      hits.push({
        id: 'rc_' + hits.length,
        kind: (KINDS.has(String(h.kind)) ? h.kind : 'other') as RedactCandidate['kind'],
        text,
        action: 'keep', // 默认不动，由用户逐条选
        ...(typeof h.why === 'string' ? { why: h.why } : {}),
      })
    }
    deps.onProgress?.(i + 1, chunks.length)
  }
  return hits
}

/** 把用户逐条选好的处理意见应用到全文。`keep` 什么都不做。 */
export function applyDecisions(doc: IdeaDoc, decisions: RedactCandidate[]): IdeaDoc {
  const subs = decisions
    .filter((d) => d.action !== 'keep' && d.text)
    // 长的先替换，避免短的先命中把长的切碎
    .sort((a, b) => b.text.length - a.text.length)
    .map((d) => ({
      from: d.text,
      to: d.action === 'mask' ? '█'.repeat(Math.min(d.text.length, 6)) : (d.replacement || '「已隐去」'),
    }))
  if (!subs.length) return doc

  const rep = (s: string): string => {
    let out = s
    for (const { from, to } of subs) out = out.split(from).join(to)
    return out
  }
  return {
    ...doc,
    title: rep(doc.title),
    goal: rep(doc.goal),
    steps: doc.steps.map(rep),
    forks: doc.forks.map(rep),
    pitfalls: doc.pitfalls.map(rep),
    deliverables: doc.deliverables.map((d) => ({ ...d, title: rep(d.title) })),
    raw: doc.raw.map((r) => ({ ...r, text: rep(r.text) })),
  }
}
