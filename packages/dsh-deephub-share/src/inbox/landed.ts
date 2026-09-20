/**
 * 「已收下」清单：过去收下的思路各自落在哪条会话里。
 *
 * **不另起一份台账。** 清单直接从 dsh 的会话库里挑：
 *   1. 会话 id 是我们自己起的，形如 `idea-<uuid>` —— 先按前缀粗筛，便宜；
 *   2. 再核一下这条会话**第 0 条事件确实是我们那条卡片事件** —— 前缀只是命名约定，
 *      这一步才是真凭据。
 *
 * 这么做的好处是**不会对不上**：用户在 dsh 里删掉一条会话，它就自动从清单里消失，
 * 不会出现"台账里有、点开是空"。代价是**发件人拿不到**（它在事件正文里，翻出来要整条日志
 * 全读一遍，太贵），所以清单不按人分组——好在标题里本来就带着发件人的名字。
 *
 * 这份清单**不进 30 秒轮询**：它不会自己变，只有用户点开「已收下」那一下才查。
 */
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'

/** 我们建的会话 id 前缀（`land.ts` 里生成）。只是粗筛，真凭据是第 0 条事件。 */
const ID_PREFIX = 'idea-'
/** 第 0 条事件的类型，与 `events.ts` 里声明的那条对上。 */
const RECEIVED_TYPE = 'deephub-share/received'
/** 最多回多少条。清单是"回头找一份"，不是归档浏览器。 */
const MAX = 50

export interface LandedIdea {
  sessionId: string
  /** dsh 自己的会话标题（就是侧栏上那句，落地时我们改过） */
  title: string
  /** 落在哪个工作区（绝对路径）；拿不到就是 null */
  cwd: string | null
  /** 会话建立时间，Unix **毫秒**（dsh header 给的，与服务端那些以秒计的字段不同） */
  createdAt: number
}

/** 一条会话是不是我们落的：看它第 0 条事件。读不出来就当不是，不猜。 */
async function isOurs(ctx: Context, id: ReturnType<typeof SessionId>): Promise<boolean> {
  try {
    const events = await ctx.sessionQuery.listEvents(id)
    return events[0]?.type === RECEIVED_TYPE
  } catch {
    return false
  }
}

export async function landedIdeas(ctx: Context): Promise<LandedIdea[]> {
  const sessions = await ctx.sessionQuery.listSessions()
  const out: LandedIdea[] = []
  // listSessions 是新的在前，所以按顺序扫、够数就停
  for (const record of sessions) {
    if (out.length >= MAX) break
    const header = record.header
    if (!String(header.id).startsWith(ID_PREFIX)) continue
    const id = SessionId(String(header.id))
    if (!await isOurs(ctx, id)) continue

    let title = ''
    try {
      const t = await ctx.sessionQuery.readTitle(id)
      title = t?.title.trim() ?? ''
    } catch { /* 标题读不到不该让这条从清单里消失 */ }

    out.push({
      sessionId: String(header.id),
      title,
      cwd: header.cwd ?? null,
      createdAt: header.createdAt,
    })
  }
  return out
}
