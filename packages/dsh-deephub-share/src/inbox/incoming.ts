/**
 * 别人机器上做出来的那份思路，进我们这边之前先「过一遍筛子」。
 *
 * 发送端的 `isIdeaDoc`（share.ts）只认自己刚生成的形状，够用；**收件路径不行**：
 * 这份 JSON 是另一台机器写的，可能是老版本、可能被人手改过、也可能故意撑得很大。
 * 它接下来要做两件事——写进会话日志（永久留着）、进模型上下文——所以这里
 * **只做形状与长度**：类型不对的丢掉，超长的截断，超量的截掉。
 *
 * 这里刻意**不做任何"语义"判断**（不猜哪句话危险、不认关键词）——那种事交给人和模型，
 * 写死的规则只管"这是不是一个字符串、是不是太长了"。
 */
import type { DeliverableKind, IdeaDoc, IdeaRawItem } from '../shared/idea.ts'
import { IDEA_DOC_BYTES_MAX, IDEA_RAW_COUNT_MAX, utf8Bytes } from '@deephub/cloud-protocol'

/**
 * **单条文本没有长度上限。**
 *
 * 0930 之前这里是 `TEXT_MAX = 4000`：一条五千字的回答进来被切成四千字，
 * 而且连省略号都不加，收的人看不出少了一截。有 `IDEA_DOC_BYTES_MAX` 这道整份闸之后，
 * 单条再长也超不过整份，单独卡单条只会在传输能力之内凭空毁数据。
 * 超长记录是**显示层**折叠的事（见 `ReceivedIdeaCard`），不是把字丢掉。
 */
/** 标题/目标的上限。标题还要再进侧栏，短一点。 */
const TITLE_MAX = 200
const GOAL_MAX = 4000
/** 列表类字段各自最多留多少条。 */
const LIST_MAX = 200

const KINDS = new Set<DeliverableKind>(['file', 'doc', 'sheet', 'slides', 'pdf', 'email', 'note', 'link'])
const ROLES = new Set<IdeaRawItem['role']>(['user', 'agent', 'tool'])

const text = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.slice(0, max) : ''

/** 正文不截断，只限条数。 */
const textList = (v: unknown, max = LIST_MAX): string[] =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, max)
    : []

/**
 * 筛子的结果。**超限时要带上实际值** —— UI 得把「多大 / 多少条」告诉用户，
 * 否则他只知道「收不下」，不知道该让对方去掉什么再发。
 */
export type SanitizeResult =
  | { ok: true; doc: IdeaDoc }
  | { ok: false; reason: 'malformed' }
  | { ok: false; reason: 'too_large'; bytes: number }
  | { ok: false; reason: 'too_many'; count: number }

/**
 * 把收到的 JSON 收拾成一份能用的 `IdeaDoc`，说清楚收不下时是为什么。
 *
 * 判死的只有五件事：不是对象、`v` 不是 1、标题空、整份超字节上限、原始记录超条数上限。
 * 其余一律「尽量留下」——对方少给一个字段不该让整份思路收不下来。
 *
 * **超量的条数是拒收，不是截掉。** 悄悄切到 2 万条等于让收的人拿到一份残缺的记录还不知情。
 */
export function sanitizeIdeaDocEx(v: unknown): SanitizeResult {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return { ok: false, reason: 'malformed' }
  const x = v as Record<string, unknown>
  if (x['v'] !== 1) return { ok: false, reason: 'malformed' }

  const title = text(x['title'], TITLE_MAX).trim()
  if (title.length === 0) return { ok: false, reason: 'malformed' }

  if (Array.isArray(x['raw']) && x['raw'].length > IDEA_RAW_COUNT_MAX) {
    return { ok: false, reason: 'too_many', count: x['raw'].length }
  }

  const deps = (typeof x['deps'] === 'object' && x['deps'] !== null ? x['deps'] : {}) as Record<string, unknown>

  const deliverables = Array.isArray(x['deliverables'])
    ? x['deliverables']
      .filter((d): d is Record<string, unknown> => typeof d === 'object' && d !== null)
      .slice(0, LIST_MAX)
      .map((d) => ({
        title: text(d['title'], TITLE_MAX),
        kind: (KINDS.has(d['kind'] as DeliverableKind) ? d['kind'] : 'file') as DeliverableKind,
      }))
      .filter((d) => d.title.length > 0)
    : []

  const raw = Array.isArray(x['raw'])
    ? x['raw']
      .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
      .slice(0, IDEA_RAW_COUNT_MAX)
      .map((r): IdeaRawItem => ({
        role: (ROLES.has(r['role'] as IdeaRawItem['role']) ? r['role'] : 'agent') as IdeaRawItem['role'],
        text: typeof r['text'] === 'string' ? r['text'] : '',
        ...(typeof r['label'] === 'string' ? { label: r['label'].slice(0, TITLE_MAX) } : {}),
      }))
      .filter((r) => r.text.length > 0)
    : []

  const doc: IdeaDoc = {
    v: 1,
    title,
    goal: text(x['goal'], GOAL_MAX),
    deps: {
      tools: textList(deps['tools']),
      connectors: textList(deps['connectors']),
      capabilities: textList(deps['capabilities']),
    },
    steps: textList(x['steps']),
    forks: textList(x['forks']),
    pitfalls: textList(x['pitfalls']),
    deliverables,
    raw,
  }

  // 收拾完还是过大 → 不收。这份要永久写进会话日志，不能让一条投递把日志撑坏。
  // **按 UTF-8 字节算**，不是 `.length`：一个汉字 3 字节，用字符数判会放进三倍的量。
  const bytes = utf8Bytes(JSON.stringify(doc))
  return bytes > IDEA_DOC_BYTES_MAX ? { ok: false, reason: 'too_large', bytes } : { ok: true, doc }
}

/** 旧签名，留给只关心「能不能用」的调用方。要知道为什么收不下就用 {@link sanitizeIdeaDocEx}。 */
export function sanitizeIdeaDoc(v: unknown): IdeaDoc | null {
  const r = sanitizeIdeaDocEx(v)
  return r.ok ? r.doc : null
}
