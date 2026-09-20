import { randomBytes } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { requestSigningBytes, responseSigningBytes } from './canon'
import { rawToPub, sha256, sign, verify } from './sign'

/**
 * 云端 HTTP 客户端：给每个请求签名、验每个响应的签名。
 *
 * 三条铁律：
 * 1. **请求**用设备私钥签，`authKey` 日常完全不出网。
 * 2. **响应**必须验签。**2xx 而没有合法签名 = 当作攻击，直接中断**，绝不采信内容。
 * 3. 非 2xx 且没有签名，**只能当传输故障，永不作为权威结论**——尤其不得据此判定
 *    "账号不存在""密码错误""设备被吊销"。中间层自产的 429/502/504 天生没有签名，
 *    如果不写死这条，就等于留了一条降级通道。
 */

/** 服务器 Ed25519 签名公钥。**与 TLS 证书完全无关**，证书怎么轮换都影响不到它。
 *  这是响应验签的唯一信任锚。 */
const SERVER_PUB_RAW = 'OJtfyO80dxWWuGy+QQZN/32+aNuwspyVTP7BJ+3sJ+E='

/** TLS SPKI pin。**当前不强制校验**，值先备着。 */
export const TLS_PINS = {
  main: 'JX2vFf1R3Oxp2uLVko/vrUW+x4OeT/6/Rp2Y649FvME=',
  backup1: 's9xFsZQxHtQ+B13ZFG6PQBLFo8ABKlZjlek5aBSXucQ=',
  backup2: 'pedLSkryIQp6IyF5O/Avh4wVmSDpnhONZdpti4wgOh0='
} as const

export const CLOUD_HOST = 'deephub.cyou'
const BASE = `https://${CLOUD_HOST}`
const DEFAULT_TIMEOUT_MS = 20_000

/** 传输层故障：网络不通、超时、代理插手、响应无签名。**不可作为业务结论。** */
export class CloudTransportError extends Error {
  readonly kind = 'transport'
  constructor(message: string) {
    super(message)
  }
}

/** 服务端给出的、带合法签名的业务错误。可以据此下结论。 */
export class CloudApiError extends Error {
  readonly kind = 'api'
  readonly status: number
  readonly code: string
  constructor(status: number, code: string) {
    super(`cloud_api_${status}:${code}`)
    this.status = status
    this.code = code
  }
}

/** 调用方自己 abort 的（登出、换账号）。既不是离线也不是业务错误，调用方应静默丢弃。 */
export class CloudAbortedError extends Error {
  readonly kind = 'aborted'
  constructor() {
    super('cloud_call_aborted')
  }
}

/** 2xx 却没有合法签名——有人在中间捣鬼。 */
export class CloudSecurityError extends Error {
  readonly kind = 'security'
  constructor(message: string) {
    super(message)
  }
}

export interface CallOptions {
  method: string
  /** 形如 `/api/v1/account/me`，可带 query */
  target: string
  body?: unknown
  /** authed 模式必填 */
  deviceId?: string
  /** enroll 模式：签名用即将注册的设备私钥，且 deviceId 不进待签串 */
  enroll?: boolean
  timeoutMs?: number
  /**
   * 调用方的中断信号。同步器在 stop()/换账号时 abort 它，
   * 否则挂着的 30s 长轮询会在登出之后才回来，把上一个账号的东西写进这台机器。
   * 与超时信号合并：哪个先到都算中断。
   */
  signal?: AbortSignal
}

/** 把"超时"和"调用方主动中断"合成一个信号。Node 20 有 AbortSignal.any，没有就手工接。 */
function mergeSignals(timeoutMs: number, extra?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  if (!extra) return timeout
  const anyFn = (AbortSignal as unknown as { any?: (s: AbortSignal[]) => AbortSignal }).any
  if (typeof anyFn === 'function') return anyFn([timeout, extra])
  const ac = new AbortController()
  const onAbort = (): void => ac.abort()
  if (extra.aborted || timeout.aborted) ac.abort()
  extra.addEventListener('abort', onAbort, { once: true })
  timeout.addEventListener('abort', onAbort, { once: true })
  return ac.signal
}

export class CloudClient {
  private readonly serverPub: KeyObject
  private privateKey: KeyObject | null = null
  private baseUrl: string
  /**
   * 本次会话协商出来的协议版本与能力集。
   *
   * **为什么住在这里，而不是停在上层的 service 里**：验响应签名发生在本类内部
   * （`call()` 里那句 `responseSigningBytes`）。将来若把响应签名改成绑定 method/target，
   * 窗口期内客户端要**同时会验新旧两套**，按协商结果选用哪一套——那个判断点
   * 就在这里。现在不把这条线铺好，到时候要回头重新穿一遍。
   *
   * `null` = 还没协商过（启动最初的一瞬、或探测失败）。此时一律按最保守的老行为走。
   */
  private negotiated: { version: number; caps: ReadonlySet<string> } | null = null

  constructor(opts: { baseUrl?: string; serverPubRaw?: string } = {}) {
    this.baseUrl = opts.baseUrl ?? BASE
    this.serverPub = rawToPub(Buffer.from(opts.serverPubRaw ?? SERVER_PUB_RAW, 'base64'))
  }

  /** 设备私钥来自宿主注入的 `KeyStore`（见 `keystore.ts`），进程内持有，不落这里的盘。 */
  setDeviceKey(priv: KeyObject | null): void {
    this.privateKey = priv
  }

  /** 协商完成后由 `service` 灌进来。传 `null` 表示"回到未协商状态"（登出、换账号）。 */
  setNegotiated(n: { version: number; caps: ReadonlySet<string> } | null): void {
    this.negotiated = n
  }

  /** 协商出来的版本；`null` = 还没协商过。 */
  get protocolVersion(): number | null {
    return this.negotiated?.version ?? null
  }

  /**
   * 这次会话能不能用某个能力。**没协商过一律是 false** —— 新能力必须等协商确认，
   * 不能"先用了再说"。
   */
  capable(name: string): boolean {
    return this.negotiated?.caps.has(name) ?? false
  }

  async call<T = unknown>(o: CallOptions): Promise<T> {
    if (!this.privateKey) throw new CloudTransportError('设备密钥未就绪')
    const raw = o.body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(o.body), 'utf8')
    const ts = Math.floor(Date.now() / 1000)
    const nonce = randomBytes(16)
    const deviceId = o.enroll ? '' : (o.deviceId ?? '')

    const sig = sign(
      this.privateKey,
      requestSigningBytes({
        host: CLOUD_HOST,
        method: o.method,
        target: o.target,
        deviceId,
        bodyHash: sha256(raw),
        ts,
        nonce
      })
    )

    let res: Response
    try {
      res = await fetch(this.baseUrl + o.target, {
        method: o.method,
        body: raw.length ? raw : undefined,
        headers: {
          'content-type': 'application/json',
          'x-dh-device': deviceId,
          'x-dh-ts': String(ts),
          'x-dh-nonce': nonce.toString('hex'),
          'x-dh-signature': sig.toString('base64')
        },
        signal: mergeSignals(o.timeoutMs ?? DEFAULT_TIMEOUT_MS, o.signal)
      })
    } catch (e) {
      // 调用方主动中断（登出/换账号）：不是网络故障，单独一类，让同步器安静丢弃
      if (o.signal?.aborted) throw new CloudAbortedError()
      // 断网、超时、DNS 失败都走这里。离线是常态，调用方必须能安静降级。
      throw new CloudTransportError(e instanceof Error ? e.message : String(e))
    }

    const bodyBuf = Buffer.from(await res.arrayBuffer())
    const sigB64 = res.headers.get('x-dh-signature')
    const signed =
      !!sigB64 &&
      verify(
        this.serverPub,
        responseSigningBytes({ nonce, status: res.status, bodyHash: sha256(bodyBuf) }),
        Buffer.from(sigB64, 'base64')
      )

    if (res.status >= 200 && res.status < 300) {
      // 铁律 2：2xx 无合法签名一律当攻击
      if (!signed) throw new CloudSecurityError('响应缺少合法签名，已中断')
      try {
        return JSON.parse(bodyBuf.toString('utf8')) as T
      } catch {
        throw new CloudSecurityError('响应不是合法 JSON')
      }
    }

    // 铁律 3：非 2xx 无签名 → 只当传输故障
    if (!signed) throw new CloudTransportError(`上游返回 ${res.status}，且无签名，不作为业务结论`)

    let code = 'unknown'
    try {
      const j = JSON.parse(bodyBuf.toString('utf8')) as { error?: string }
      if (typeof j.error === 'string') code = j.error
    } catch {
      /* 保持 unknown */
    }
    throw new CloudApiError(res.status, code)
  }

  /** 探活。**不需要设备密钥**，也不验签——只用来判断"云端是否可达"与校时。 */
  async health(timeoutMs = 8000): Promise<{ ok: boolean; server_time: number } | null> {
    try {
      const r = await fetch(`${this.baseUrl}/api/health`, { signal: AbortSignal.timeout(timeoutMs) })
      if (!r.ok) return null
      return (await r.json()) as { ok: boolean; server_time: number }
    } catch {
      return null
    }
  }

  /**
   * 与服务器的时钟偏差（秒）。签名有 ±300 秒窗口，偏差过大会让所有请求 401 且
   * 报错不可诊断——所以要能主动告诉用户"你的系统时间不对"。
   */
  async clockSkew(): Promise<number | null> {
    const h = await this.health()
    if (!h?.server_time) return null
    return Math.floor(Date.now() / 1000) - h.server_time
  }
}
