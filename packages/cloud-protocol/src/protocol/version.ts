import { REGISTRY } from './registry'

/**
 * 协议版本与能力集。
 *
 * 版本登记簿本身在 `registry.ts`（那里写了为什么是 .ts 不是 .json）。
 * 服务端有一份等价的 JSON 副本，由一条交叉校验硬断言两者相等——
 * 两份实现分居两个仓库，不比对就一定会漂。
 *
 * ── 为什么版本号和能力集都要 ──────────────────────────────────────
 *
 * 版本号是**协商的原语**：可比较、可排序、可设下限。
 * 能力集是**调用点的读接口**：业务代码一律写 `caps.has('resp-sig-v2')`，
 * **不写 `v >= 2`** —— 后者逼着读代码的人先去翻版本历史才知道 2 加了什么。
 *
 * ── 演进规矩（三条，`PROTOCOL.md` 里有完整说明）────────────────────
 *
 *   加一个能力       = 版本号 +1
 *   下线一个旧行为   = 抬 MIN_SUPPORTED（且必须先走弃用窗口），**不是**从表里删条目
 *   改一个行为       = 加一个新能力 + 日后抬 MIN_SUPPORTED
 *
 * `added` 只能表达累积并集，表达不了「删」——所以下线只能靠抬下限，这条规矩
 * 不是风格偏好，是数据结构决定的。
 *
 * ⚠️ **不给历史行为补命名能力。** MK 验证子、好友备注这些是既成事实、从来没被
 * 协商过，硬塞进能力表只会制造一段假历史。v1 就叫 `base`，含义是「2026-09-17
 * 那天的协议」。能力名只给**真正需要条件分支**的东西用。
 */

/** 本端实现的协议版本。 */
export const PROTOCOL_VERSION: number = REGISTRY.current

/**
 * 我肯说话的最老服务端。
 *
 * 这是**客户端侧的策略**，不在登记簿里 —— 它和服务端的
 * 「我接受的最老客户端」是两个会各自变动的数，混进共享文件的话，一次正常的
 * 策略调整就会让交叉校验报红；红几次之后人就开始忽略它，那条断言也就废了。
 * 只比对共享真相，断言才一直有意义。
 */
export const CLIENT_MIN_SERVER = 0

const ADDED = REGISTRY.added

/** 某个版本**累积**拥有的能力（≤ version 的所有条目取并集）。 */
export function capabilitiesFor(version: number): ReadonlySet<string> {
  const out = new Set<string>()
  for (const [at, names] of Object.entries(ADDED)) {
    if (Number(at) <= version) for (const n of names) out.add(n)
  }
  return out
}

/** 一端能说的版本区间。`current` 是它实现的版本，`min` 是它肯接受的最低对端版本。 */
export interface ProtocolRange {
  current: number
  min: number
}

export type Negotiation =
  | { kind: 'ok'; version: number }
  | { kind: 'client_too_old'; serverMin: number; mine: number }
  | { kind: 'server_too_old'; serverCurrent: number; myMin: number }

/**
 * 协商：取双方 `current` 的较小者，且必须同时满足两边的下限。
 *
 * **「我比服务端新」不是错误** —— 那只说明服务端还没升级，按较小者说话即可。
 * 只有低到对方的下限以下才是错误，而这两种错误分属两端：
 *   - 服务端的 current 低于我的下限 → `server_too_old`（我这边判）
 *   - 我的 current 低于服务端的下限 → `client_too_old`（我这边先说给用户听，
 *     但**裁决权在服务端** —— 客户端判出来之后照常发请求，由服务端回 426。
 *     本地判断绝不自我封锁，否则离线或时钟异常时会把一个其实能用的客户端锁死。）
 */
export function negotiate(mine: ProtocolRange, theirs: ProtocolRange): Negotiation {
  if (theirs.current < mine.min) {
    return { kind: 'server_too_old', serverCurrent: theirs.current, myMin: mine.min }
  }
  if (mine.current < theirs.min) {
    return { kind: 'client_too_old', serverMin: theirs.min, mine: mine.current }
  }
  return { kind: 'ok', version: Math.min(mine.current, theirs.current) }
}
