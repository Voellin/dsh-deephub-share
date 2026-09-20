/**
 * 协议版本登记簿 —— **共享真相的唯一字面量**。
 *
 * 服务端有一份逐字节等价的 JSON 副本，两端由一条交叉校验硬断言它们相等。
 * 两半分居两个仓库，不比对就一定会漂。
 *
 * ── 为什么是 .ts 而不是 .json ──────────────────────────────────────
 *
 * 本来更自然的做法是一个 `.json`，两边各自 import。实测走不通：这个包有**四种**
 * 消费方式，而 JSON 导入没有一种写法能同时满足：
 *
 *   Node ESM（插件 `npm test` 直接跑 TS 源码）  **必须**写 `with { type: 'json' }`
 *   编译成 CommonJS 的那种消费方式              带属性直接报 TS2856
 *                                                （"不允许出现在编译成 require 的语句上"）
 *
 * 两条硬性要求方向相反，所以字面量放在 TS 里、JSON 那份留给服务端，
 * 用一条会红的断言把它们钉住。交叉校验用 `node --experimental-transform-types`
 * 动态 import 本文件，仍然**不需要任何构建步骤**。
 *
 * ── 改这里之前 ────────────────────────────────────────────────────
 *
 * 看 `PROTOCOL.md`：加能力 = 版本 +1；下线旧行为 = 抬 MIN_SUPPORTED（先走弃用窗口），
 * **不是**从 `added` 里删条目——`added` 是只增不减的累积表，删一项会让所有历史版本的
 * 能力集跟着变。改完记得同步服务端那份副本，否则交叉校验会红。
 */

export interface ProtocolRegistry {
  /** 本实现的协议版本。 */
  readonly current: number
  /** 每一版**新增**的能力；`capabilitiesFor(v)` 取 ≤ v 的累积并集。 */
  readonly added: Readonly<Record<string, readonly string[]>>
}

export const REGISTRY: ProtocolRegistry = {
  current: 1,
  added: {
    1: ['base']
  }
}
