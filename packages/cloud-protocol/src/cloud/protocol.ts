import { CLIENT_MIN_SERVER, PROTOCOL_VERSION, capabilitiesFor, negotiate } from '../protocol/version'
import type { CloudClient } from './client'

/**
 * 协议版本协商（客户端侧）。
 *
 * 规矩见 `PROTOCOL.md`。这个文件只做三件事：**问**、**严格地解析**、**得出结论**。
 * 它不做任何"因为版本不对所以不发请求"的决定 —— 见下方 `checkProtocol` 的说明。
 */

/** 服务端广播的版本区间。字段名是线上格式（snake_case），这里转成本地风格。 */
export interface ServerProtocol {
  current: number
  minSupported: number
  deprecatedBelow: number
  /** 计划抬下限的时间（Unix 秒）；没定就是 null */
  sunset: number | null
  /** **仅供诊断**，不作为能力判断依据 —— 见 `checkProtocol` */
  capabilities: readonly string[]
}

export type ProtoCheck =
  | { kind: 'ok'; version: number; caps: ReadonlySet<string> }
  | { kind: 'client_too_old'; serverMin: number; mine: number }
  /**
   * 还能用，但已经在弃用窗口里。**必须照样带 version 和 caps** ——
   * 它是"仍受支持"的一种，退回未协商的最保守行为会让两边错开：
   * 服务端按客户端声明的版本应答，客户端却以为自己什么新能力都没有。
   */
  | { kind: 'client_deprecated'; sunset: number | null; mine: number; version: number; caps: ReadonlySet<string> }
  | { kind: 'server_too_old'; serverCurrent: number; myMin: number }
  | { kind: 'unknown' }

const nonNegInt = (x: unknown): x is number => typeof x === 'number' && Number.isInteger(x) && x >= 0

/**
 * **严格**解析服务端的广播。任何一处不对劲都返回 `null`（上层落 `unknown`），
 * **绝不"尽力而为"地补默认值**。
 *
 * 为什么这么紧：`open` 路由不消耗 nonce，而响应签名
 * 只盖 `nonce|status|bodyHash`、**不绑定 method 与 target**。于是有能力拦截 TLS 的
 * 中间人可以把我们发往 `/api/v1/protocol` 的请求（连同它的 nonce）转发到另一条
 * `open` 路由——比如 `/api/v1/account/kdf`——拿回一个**签名完全合法**的 200，
 * 再当作协议应答塞回来。签名验得过，内容却是别人的。
 *
 * 唯一的防线就是这里：形状不对 = 不是协议应答。宁可落 `unknown`（= 什么都不说），
 * 也不能落 `ok`（= 告诉上层"协商成功，能力是这些"）。
 */
export function parseServerProtocol(x: unknown): ServerProtocol | null {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return null
  const o = x as Record<string, unknown>
  if (!nonNegInt(o.current) || !nonNegInt(o.min_supported) || !nonNegInt(o.deprecated_below)) return null
  if (!(o.sunset === null || nonNegInt(o.sunset))) return null
  if (!Array.isArray(o.capabilities) || !o.capabilities.every((c) => typeof c === 'string')) return null
  // 自洽性：下限不可能高于当前版本；弃用线同理。不自洽的一份不是我们的服务端发的
  if (o.min_supported > o.current || o.deprecated_below > o.current) return null
  return {
    current: o.current,
    minSupported: o.min_supported,
    deprecatedBelow: o.deprecated_below,
    sunset: o.sunset as number | null,
    capabilities: o.capabilities as readonly string[]
  }
}

/**
 * 问服务端要版本区间，顺便把自己的版本报上去。
 *
 * **必须走 `call()`**（带 nonce、验响应签名），不能用 `health()` 那种裸 fetch ——
 * 那条路不验签，把版本区间挂在上面等于亲手开一扇降级门：中间人可以随口谎报
 * 服务端支持的范围。
 *
 * 已登录走 POST（顺手把版本记进设备行），未登录走 GET（只拿区间）。
 * POST 失败时回落到 GET：设备处于 pending（新设备等待确认）时 authed 会 401，
 * 而那种状态下用户**更**需要知道"是不是我的客户端太老了"。
 *
 * 任何失败都返回 `null` —— 离线是常态，不是错误。
 */
export async function fetchServerProtocol(api: CloudClient, deviceId: string | null): Promise<ServerProtocol | null> {
  if (deviceId) {
    try {
      const r = await api.call<unknown>({
        method: 'POST', target: '/api/v1/protocol', deviceId, body: { proto: PROTOCOL_VERSION }
      })
      const parsed = parseServerProtocol(r)
      if (parsed) return parsed
    } catch {
      /* 落到下面的 GET */
    }
  }
  try {
    return parseServerProtocol(await api.call<unknown>({ method: 'GET', target: '/api/v1/protocol' }))
  } catch {
    return null
  }
}

/**
 * 得出结论。
 *
 * ⚠️ **能力集一律用本地表按协商版本算出来，不采信服务端广播的那一份。**
 * 服务端给的 `capabilities` 只供人眼诊断：采信它等于让服务端（或冒充它的人）
 * 决定我们以为自己能做什么，而我们真正能做的只有本地代码实现了的那些。
 *
 * ⚠️ **判出 `client_too_old` 之后不要自我封锁。** 上层照常发请求，由服务端回 426。
 * 单一裁决权在服务端，这里只负责把话说给用户听。代价是多一个注定失败的往返，
 * 换来的是：本地判断永远不会把一个其实能用的客户端锁死（离线、时钟偏差、
 * 探测被中间人掐掉，都属于这一类）。
 */
export function checkProtocol(server: ServerProtocol | null): ProtoCheck {
  if (!server) return { kind: 'unknown' }
  const n = negotiate(
    { current: PROTOCOL_VERSION, min: CLIENT_MIN_SERVER },
    { current: server.current, min: server.minSupported }
  )
  if (n.kind === 'client_too_old') return { kind: 'client_too_old', serverMin: n.serverMin, mine: n.mine }
  if (n.kind === 'server_too_old') return { kind: 'server_too_old', serverCurrent: n.serverCurrent, myMin: n.myMin }
  // 还能用，但已经在弃用窗口里 —— 提前告诉用户，别等到哪天突然登不上。
  // 能力集照给：它仍然是"协商成功"的一种，只是多一句提醒
  if (PROTOCOL_VERSION < server.deprecatedBelow) {
    return {
      kind: 'client_deprecated', sunset: server.sunset, mine: PROTOCOL_VERSION,
      version: n.version, caps: capabilitiesFor(n.version)
    }
  }
  return { kind: 'ok', version: n.version, caps: capabilitiesFor(n.version) }
}

/**
 * 该不该重新协商。抽成纯函数是因为这条规则有三种情形、而错一种的后果都不明显：
 *
 *   从没协商成功过（`unknown`） → **总是重试**，不受 TTL 限制。
 *       离线是常态，上一次没探到不该让客户端在接下来半小时里一直「不知道」。
 *   协商过、还新鲜            → 不重来。DeepHub 账号面板开着时是 10 秒一次 probe，
 *                               而协议区间只在服务端重新部署时才变。
 *   协商过、过期了            → 重来。
 */
export function shouldNegotiate(prev: ProtoCheck['kind'], lastAt: number, now: number, ttlMs: number): boolean {
  if (prev === 'unknown') return true
  return now - lastAt >= ttlMs
}
