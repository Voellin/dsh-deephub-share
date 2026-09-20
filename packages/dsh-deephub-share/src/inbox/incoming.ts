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

/** 单条文本的上限：一步、一个坑、一段原始记录各自最长这么多字符。 */
const TEXT_MAX = 4000
/** 标题/目标的上限。标题还要再进侧栏，短一点。 */
const TITLE_MAX = 200
const GOAL_MAX = 4000
/** 列表类字段各自最多留多少条。 */
const LIST_MAX = 200
const RAW_MAX = 500
/** 整份文档序列化之后的上限（字节）。超了就当这份思路不可用——不截半截给用户看。 */
const DOC_BYTES_MAX = 2 * 1024 * 1024

const KINDS = new Set<DeliverableKind>(['file', 'doc', 'sheet', 'slides', 'pdf', 'email', 'note', 'link'])
const ROLES = new Set<IdeaRawItem['role']>(['user', 'agent', 'tool'])

const text = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.slice(0, max) : ''

const textList = (v: unknown, max = LIST_MAX): string[] =>
  Array.isArray(v)
    ? v.filter((x): x is string => typeof x === 'string' && x.length > 0).slice(0, max).map((x) => x.slice(0, TEXT_MAX))
    : []

/**
 * 把收到的 JSON 收拾成一份能用的 `IdeaDoc`；实在不成形就返回 `null`。
 *
 * 判死的只有三件事：不是对象、`v` 不是 1、标题空。其余一律「尽量留下」——
 * 对方少给一个字段不该让整份思路收不下来。
 */
export function sanitizeIdeaDoc(v: unknown): IdeaDoc | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null
  const x = v as Record<string, unknown>
  if (x['v'] !== 1) return null

  const title = text(x['title'], TITLE_MAX).trim()
  if (title.length === 0) return null

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
      .slice(0, RAW_MAX)
      .map((r): IdeaRawItem => ({
        role: (ROLES.has(r['role'] as IdeaRawItem['role']) ? r['role'] : 'agent') as IdeaRawItem['role'],
        text: text(r['text'], TEXT_MAX),
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

  // 收拾完还是过大 → 不收。这份要永久写进会话日志，不能让一条投递把日志撑坏
  return Buffer.byteLength(JSON.stringify(doc), 'utf8') > DOC_BYTES_MAX ? null : doc
}
