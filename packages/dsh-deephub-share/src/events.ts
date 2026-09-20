/**
 * 收到的思路在会话日志里长什么样。
 *
 * ⚠️ **这条事件只能在建会话时用 `seed` 写，不能用 `session.append()`。**
 * dsh 的持久化读路径有一张代码生成的白名单 `KNOWN_SESSION_EVENT_TYPES`，
 * 树外插件的事件**按设计**不在里面；没有信封上的 `ignorable: true`，
 * 会话一旦落盘再被读回，**整条日志会被拒绝解释、会话就此打不开**。
 * 而 `append()` 的签名里没有地方能传 `ignorable`——唯一能传的是 `agents.create({ seed })`。
 *
 * 连带的一条约束：seed 必须是会话从 0 开始的连续前缀，所以
 * **一条会话只承载一份思路、卡片永远在最顶上**。
 */
import type { IdeaDoc } from './shared/idea.ts'

/** 落地时随附件一起写进工作区的那份文件。`path` 是相对工作区根的，给卡片上的「打开」用。 */
export interface LandedAttachment {
  name: string
  /** 相对工作区根，用 `/` 分隔（Windows 上也是，给浏览器半看的） */
  path: string
  size: number
}

/** `deephub-share/received` 的负载。必须是无损 JSON（不能有 undefined / Date / Map…）。 */
export interface ReceivedIdeaEvent {
  /** 投递 id，同一份思路重复收下时用来认出是同一张卡 */
  ideaId: string
  from: { accountId: string; shortId: string; displayName: string | null }
  /** Unix 毫秒（这条是我们自己写的，与服务端那些以秒计的字段不同） */
  receivedAt: number
  doc: IdeaDoc
  attachments: LandedAttachment[]
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** 收到并收下的一份思路。日志里只此一条，永远在 seq 0。 */
    'deephub-share/received': ReceivedIdeaEvent
  }
}
