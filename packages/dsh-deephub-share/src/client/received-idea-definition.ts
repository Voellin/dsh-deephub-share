/**
 * 认领「收到的思路」那条事件，在会话流里产出一张卡片。
 *
 * dsh 的会话流是"定义 + 渲染器"两件事：这里是**定义**（认哪条事件、状态是什么、画成什么节点），
 * 卡片长什么样在 `ReceivedIdeaCard.tsx`，两边靠 `kind` 对上。
 *
 * 三条约束来自 `packages/client/AGENTS.md`：
 *   - `match()` **只看当前这一条事件**，不翻历史；
 *   - 单事件即 start，没有 update（一条会话只承载一份思路，见 events.ts）；
 *   - 热路径里不扫整个事件窗口。
 *
 * 另：dsh 的 `chatNode()` helper **没有从 `/client` 导出**，所以下面那个节点字面量是照它的实现抄的
 * （`lib/client.js` 的 `chatNode`：key/kind/id/target/anchorSeq/location/visibility/data）。
 */
import type { ConversationNodeDefinition } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { ReceivedIdeaEvent } from '../events.ts'

/** 卡片的 dispatch key：定义这边产出它，渲染器那边按它认领。 */
export const RECEIVED_KIND = 'deephub-share/received'

declare module '@deepseek-ai/dsh-client-ui-chat/client' {
  interface ChatNodeDataMap {
    /** 收到并收下的一份思路，整张卡片的数据就是那条事件的负载。 */
    'deephub-share/received': ReceivedIdeaEvent
  }
}

const isReceived = (data: unknown): data is ReceivedIdeaEvent =>
  typeof data === 'object' && data !== null && typeof (data as ReceivedIdeaEvent).ideaId === 'string'

export const receivedIdeaDefinition: ConversationNodeDefinition<ReceivedIdeaEvent> = {
  kind: RECEIVED_KIND,
  target: 'chat',

  match: (event) => {
    if (event.type !== RECEIVED_KIND) return null
    // 事件是别人机器上写进来的，进 UI 之前先确认形状对得上；不对就当没看见，不画坏卡片
    return isReceived(event.data) ? { id: event.data.ideaId, role: 'start' } : null
  },

  start: (_context, match) => match.event.data as ReceivedIdeaEvent,

  // 一条会话只有这一条事件，没有后续要合并的
  update: (context) => context.state,

  buildViewNode: (context) => {
    if (context.state === undefined) return null
    return {
      key: context.key,
      kind: RECEIVED_KIND,
      id: context.id,
      target: 'chat',
      anchorSeq: context.start?.event.seq ?? 0,
      location: context.start?.location ?? context.matches[0]?.location ?? { kind: 'unresolved' },
      visibility: 'visible',
      data: context.state,
    }
  },
}
