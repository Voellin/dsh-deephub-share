/**
 * 朋友路由 `POST /api/deephub-share/social/<op>`：列名单、就地加人、收发好友请求、
 * 拒绝请求、解除朋友、改显示名、换短 ID。
 *
 * | op | 入参 | 出参 |
 * |---|---|---|
 * | friends | — | `{ friends: FriendWithRemark[] }`，`friendPub` 为 null 的还收不了；`remark` 是我给他起的备注 |
 * | request | `{ shortId }` | `{ ok, reason? }`；服务端对不存在的短 ID 也返回成功，界面不能说"已找到" |
 * | inbox | — | `{ incoming, outgoing }`；同意之前只知道对方短 ID |
 * | accept | `{ requestId }` | `{ ok, friend?, reason? }` |
 * | reject | `{ requestId, block? }` | `{ ok, reason? }`；`block` 才是拉黑，默认只是拒绝 |
 * | remove | `{ accountId }` | `{ ok, reason? }`；单方面解除，对方那边也没了 |
 * | profile | — | `{ displayName }`；我在别人朋友列表里显示的名字 |
 * | set-name | `{ name }` | `{ ok }` —— 改的是**我对外叫什么**，全世界都看得到 |
 * | set-remark | `{ accountId, text }` | `{ ok }` —— 改的是**我管他叫什么**，加密后存服务端，只有我解得开；`text` 空串＝清掉 |
 * | reset-short-id | — | `{ ok, shortId? }`；**旧短 ID 立刻作废**，已是朋友的不受影响 |
 */
import type { Context } from '@deepseek-ai/cordis'
import { registerOps, str } from '../routes.ts'
import type { Cloud } from '../account/service.ts'
import type { FriendWithRemark } from '../shared/social.ts'

export const SOCIAL_PREFIX = '/api/deephub-share/social'

export function registerSocialRoutes(ctx: Context, cloudReady: Promise<Cloud>): void {
  const social = async () => (await cloudReady).svc.social
  registerOps(ctx, SOCIAL_PREFIX, {
    'friends': async () => {
      const soc = await social()
      // `remarks()` 内存里那份最多吃 60 秒，不是每次都打一个来回（见共享包 social.ts）
      const [friends, remarks] = await Promise.all([soc.friends(), soc.remarks()])
      return {
        friends: friends.map((f): FriendWithRemark => ({ ...f, remark: remarks[f.accountId] ?? null })),
      }
    },
    'request': async (b) => (await social()).request(str(b, 'shortId')),
    'inbox': async () => (await social()).inbox(),
    'accept': async (b) => (await social()).accept(str(b, 'requestId')),
    'reject': async (b) => (await social()).reject(str(b, 'requestId'), b?.['block'] === true),
    'remove': async (b) => (await social()).remove(str(b, 'accountId')),
    'profile': async () => (await social()).myProfile(),
    'set-name': async (b) => (await social()).setDisplayName(str(b, 'name')),
    'set-remark': async (b) => (await social()).setRemark(str(b, 'accountId'), str(b, 'text')),
    'reset-short-id': async () => (await social()).resetShortId(),
  })
}
