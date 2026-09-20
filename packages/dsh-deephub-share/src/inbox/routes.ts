/**
 * 收件箱路由 `POST /api/deephub-share/inbox/<op>`：列待收、取回、收下、拒收。
 *
 * 服务端是零知识的：**拒收之前只看得到"谁发的、多大、几个附件、什么时候"**，
 * 标题在密文里。界面必须如实这么说，不能假装能预览（共享包 `delivery.ts` 的原话）。
 *
 * | op | 入参 | 出参 |
 * |---|---|---|
 * | list | — | `{ items: InboxItem[] }`；没登录/没解锁时是空表，不报错 |
 * | reject | `{ deliveryId }` | `{ ok, reason? }`；服务端**真删密文**，不是打标记 |
 * | workspaces | — | `{ list: WorkspaceChoice[] }`；收下时落到哪儿，给面板列选项 |
 * | accept | `{ deliveryId, workspaceId?, titleFmt, unnamed }` | `{ ok, sessionId?, ... }` |
 * | landed | — | `{ list: LandedIdea[] }`；过去收下的都落在哪条会话里（不进轮询，点开才查） |
 *
 * 「收下」= 取回 + 解密 + 过筛子 + 落成一条新会话。三条规矩：
 *   - **解不开就当冒充**，直接失败，不降级（共享包 `fetch()` 的原话）；
 *   - 收到的 JSON 先过 `sanitizeIdeaDoc`，它要永久进会话日志、还要进模型上下文；
 *   - 文案（标题模板、"未设置名字"）由浏览器半传进来，Host 不管语言。
 */
import type { Context } from '@deepseek-ai/cordis'
import { registerOps, str } from '../routes.ts'
import type { Cloud } from '../account/service.ts'
import { land, workspaces } from '../land.ts'
import { sanitizeIdeaDoc } from './incoming.ts'
import { landedIdeas } from './landed.ts'

export const INBOX_PREFIX = '/api/deephub-share/inbox'

/** 收下失败的原因。除 `undecryptable`/`malformed` 外都是能重试的。 */
export type AcceptFailure = 'offline' | 'no_key' | 'not_found' | 'undecryptable' | 'malformed'

export function registerInboxRoutes(ctx: Context, cloudReady: Promise<Cloud>): void {
  const delivery = async () => (await cloudReady).svc.delivery
  registerOps(ctx, INBOX_PREFIX, {
    'list': async () => ({ items: await (await delivery()).inbox() }),
    'reject': async (b) => (await delivery()).reject(str(b, 'deliveryId')),

    'workspaces': async () => ({ list: workspaces(ctx) }),
    'landed': async () => ({ list: await landedIdeas(ctx) }),

    'accept': async (b) => {
      const deliveryId = str(b, 'deliveryId')
      const got = await (await delivery()).fetch(deliveryId)
      if (!got.ok || got.delivery === undefined) {
        return { ok: false, reason: (got.reason ?? 'not_found') satisfies AcceptFailure }
      }
      const doc = sanitizeIdeaDoc(got.delivery.idea)
      // 密文解开了、里面却不是一份能用的思路：这条我们收不下来，让用户去拒收
      if (doc === null) return { ok: false, reason: 'malformed' satisfies AcceptFailure }

      return await land(ctx, {
        doc,
        from: got.delivery.from,
        ideaId: got.delivery.deliveryId,
        attachments: got.delivery.attachments.map((a) => ({ name: a.name, data: a.data })),
        ...(str(b, 'workspaceId') ? { workspaceId: str(b, 'workspaceId') } : {}),
        titleFmt: str(b, 'titleFmt') || '{who}：{title}',
        unnamed: str(b, 'unnamed') || '(unnamed)',
      })
    },
  })
}
