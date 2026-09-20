/**
 * 朋友在这条线上的样子。**Host 与浏览器共用的纯类型**，没有运行时代码
 * （与 `shared/idea.ts` 同一条规矩：跨半边的形状放这儿，不要让浏览器半去 import Host 的模块）。
 */
import type { Friend } from '@deephub/cloud-protocol'

/**
 * 朋友 + 我给他起的备注。
 *
 * 备注跟着朋友列表一起走，**不另开一个 op**：界面要的是"这个人显示成什么"，
 * 分两次拿会出现列表先到、备注后到，几处名字各闪各的。
 *
 * `remark` 只有我看得到 —— 它是用主密钥加密之后才上服务端的（共享包 `social.ts`）。
 */
export type FriendWithRemark = Friend & { remark: string | null }

/**
 * 界面上显示一个朋友的名字，三级回退：**我的备注 → 他自己设的 → 兜底**。
 *
 * 插件这边五处地方显示朋友的名字（左边那列、详情页头、选人、收到的卡片、落地标题），
 * 规则**只能写在这一处**。各写各的迟早对不上，而名字对不上比没有名字更难受。
 *
 * **不把它提到共享包里**：那样就得从 `@deephub/cloud-protocol` 值导入，
 * 会把整包加密代码拖进浏览器半的 bundle。这里多一个小函数，换的是浏览器 bundle 的干净。
 *
 * 空串不算名字。`??` 只挡 null —— 而"清除备注"在路上任何一环变成空串，
 * 都会让列表里出现一片空白。这里用 `||` 一并挡掉（顺手去掉首尾空白）。
 */
export const friendName = (
  f: { remark?: string | null; displayName?: string | null },
  unnamed: string
): string => f.remark?.trim() || f.displayName?.trim() || unnamed
