import { hostname, platform } from 'node:os'
import type { KeyStore } from '../keystore'
import type { CloudDevice, CloudFail, CloudPendingApproval, CloudResult, CloudStatus, CloudSyncStatus } from '../types'
import { CloudAccount } from './account'
import { CLOUD_HOST, CloudApiError, CloudClient, CloudSecurityError, CloudTransportError } from './client'
import { DeliveryClient } from './delivery'
import { IdentityManager } from './identity'
import { SocialClient } from './social'
import { checkProtocol, fetchServerProtocol, shouldNegotiate, type ProtoCheck } from './protocol'

/** 协议区间只在服务端重新部署时才变，半小时问一次足够；离线时不受它限制，见 negotiateProtocol。 */
const PROTO_TTL_MS = 30 * 60_000

/**
 * 同步器的最小约定。同步器本身留在宿主（它要读写宿主的 store），
 * CloudService 只认这几个方法；DeepHub 的 `SyncEngine` 结构上满足即可。
 */
export interface SyncLike {
  start(): void
  stop(): void
  resetCursor(): void
  pullNow(): Promise<unknown>
  nudge(): void
  getStatus(): CloudSyncStatus
  onIdentity(cb: (payload: unknown) => void): void
}

/**
 * 云端会话的主进程持有者。
 *
 * **主密钥 MK 和恢复码只存在于这里**，永远不经过 IPC 到渲染层。
 * 渲染层拿到的只有"登录没登录、是谁、够不够额度"这类可以安全显示的东西。
 *
 * 另一条：**云端不可用绝不能影响本地干活**。所有方法要么返回结构化结果，
 * 要么抛出已归类的错误，调用方（IPC 层）统一转成 `CloudResult` 交给 UI。
 */

/* CloudStatus / CloudFail / CloudResult 等类型定义在 ../types.ts —— 宿主的渲染层也要用，
   放一处避免两边各自漂移。 */

/** 把各类异常收敛成 UI 能直接用的东西。 */
export function toFail(e: unknown): CloudFail {
  if (e instanceof CloudTransportError) {
    return { ok: false, kind: 'offline', message: '云端暂时连不上。本地功能不受影响。' }
  }
  if (e instanceof CloudSecurityError) {
    return { ok: false, kind: 'insecure', message: '连接可能被劫持：服务器响应没有合法签名，已中断。' }
  }
  if (e instanceof CloudApiError) {
    return { ok: false, kind: 'rejected', code: e.code, status: e.status, message: apiMessage(e) }
  }
  return { ok: false, kind: 'local', message: e instanceof Error ? e.message : String(e) }
}

/**
 * 服务端刻意不区分"账号不存在"和"密码错误"（两者响应逐字节相同），
 * 所以这里也只能给一句笼统的话 —— **不要试图猜得更细，那会变成谎话**。
 */
function apiMessage(e: CloudApiError): string {
  if (e.status === 401) return '邮箱或密码不正确。'
  if (e.status === 429) return '尝试太频繁，请稍后再试。'
  if (e.status === 507) return '云端空间不足。'
  if (e.status === 409) return '这一步已经完成过了。'
  if (e.status === 410) return '验证码已过期，请重新获取。'
  if (e.status === 400) return '请求内容不合法。'
  // 426 Upgrade Required：服务端不再接受这个协议版本的客户端。这是唯一一种
  // "换个说法也没用、只能升级"的业务错误，必须给一句能照做的话
  if (e.status === 426) return '这个版本已经不能连云端了，请更新到最新版。'
  return `云端返回错误（${e.status}）。`
}

/**
 * 邮箱归一化：去空白 + **小写**。服务端入库时一律小写，查询时以前却原样比对——
 * 注册时带了大写的人之后登不上。两端都归一化，谁先谁后都对。
 */
const normEmail = (email: string): string => email.trim().toLowerCase()

const deviceName = (): string => {
  try {
    return hostname() || 'DeepHub'
  } catch {
    return 'DeepHub'
  }
}

export class CloudService {
  private readonly acct: CloudAccount
  /** 宿主注入的本机密钥存取。MK 缓存、设备密钥、身份私钥缓存都经它。 */
  private readonly store: KeyStore
  /** ⚠️ 只在内存 + 本机安全存储里，永不经过 IPC */
  private MK: Buffer | null = null
  /** ⚠️ 只在内存里，用户确认抄写后立即清掉，永不落盘 */
  private pendingRecovery: { code: string; email: string } | null = null
  private reachable: boolean | null = null
  private skew: number | null = null
  private quota: { quotaBytes: number; usedBytes: number } | null = null
  /** 短 ID 由服务端下发，本机只缓存用于显示（加朋友时要给对方看） */
  private shortId: string | null = null
  /** 同步器由 main/index 注入（它需要 store 的读写口子，那是本模块不该知道的东西） */
  private sync: SyncLike | null = null
  /** ⚠️ 账号级身份私钥的唯一持有者，与 MK 同级：永不经过 IPC */
  private readonly ident: IdentityManager
  private readonly soc: SocialClient
  private readonly dlv: DeliveryClient
  /** 注册/登录时报给服务端的平台名。DeepHub 桌面端是 OS 名；dsh 插件传 'dsh'，设备列表里才分得清 */
  private readonly platformName: string

  /**
   * `opts.baseUrl` / `opts.serverPubRaw` 只为**测试**存在：让整套逻辑能打在另一份服务端实现上，
   * 而不必动线上。
   *
   * 生产路径**一个都不传** —— 走硬编码的 `https://deephub.cyou` 和硬编码的服务器签名公钥。
   * 那把公钥是响应验签的唯一信任锚，能被参数覆盖就等于没有。
   *
   * `opts.platform`：宿主自报的平台名（`devices.platform` 是自由字符串）。不传 = `os.platform()`，DeepHub 本体行为不变。
   */
  constructor(store: KeyStore, opts: { baseUrl?: string; serverPubRaw?: string; platform?: string } = {}) {
    this.store = store
    this.platformName = opts.platform || platform()
    const testClient = opts.baseUrl || opts.serverPubRaw
      ? new CloudClient({ baseUrl: opts.baseUrl, serverPubRaw: opts.serverPubRaw })
      : undefined
    this.acct = new CloudAccount(store, testClient)
    this.ident = new IdentityManager(this, store)
    this.soc = new SocialClient(this)
    this.dlv = new DeliveryClient(this)
    // 免密启动：设备已绑账号且本机缓存过 MK，就直接解锁
    if (this.acct.identity.deviceId) {
      const mk = store.loadMasterKey()
      if (mk) this.MK = mk
    }
  }

  /**
   * 协议协商的结论。初始是 `unknown` —— 没探到就什么都不说，离线是常态。
   */
  private proto: ProtoCheck = { kind: 'unknown' }
  /** 上次协商成功的时刻。0 = 没成功过。 */
  private protoAt = 0

  status(): CloudStatus {
    const d = this.acct.identity
    return {
      host: CLOUD_HOST,
      loggedIn: !!d.deviceId && !!d.accountId,
      email: d.email,
      accountId: d.accountId,
      // 内存里的优先（刚 probe/换过的最新），否则落盘的那份 ——
      // **免密启动与断网时全靠后者**，否则界面上是个 `—`（这个 bug 犯过两次）
      shortId: this.shortId ?? d.shortId,
      deviceId: d.deviceId,
      keyEncrypted: d.encrypted,
      cacheAvailable: this.store.isCacheAvailable(),
      unlocked: !!this.MK,
      pendingRecoveryCode: !!this.pendingRecovery,
      reachable: this.reachable,
      skewSeconds: this.skew,
      quotaBytes: this.quota?.quotaBytes ?? null,
      usedBytes: this.quota?.usedBytes ?? null,
      protocol: this.proto.kind,
      protocolVersion: this.proto.kind === 'ok' || this.proto.kind === 'client_deprecated' ? this.proto.version : null,
      protocolSunset: this.proto.kind === 'client_deprecated' ? this.proto.sunset : null
    }
  }

  /**
   * 协议协商。**失败一律落 `unknown`，绝不把用户挡在外面。**
   *
   * 判出 `client_too_old` 也照常继续跑：裁决权在服务端（它会回 426），这里只负责
   * 把话说给用户听。本地判断绝不自我封锁——离线、时钟偏差、探测被中间人掐掉，
   * 都会走到这条路上，而它们都不该让一个其实能用的客户端停摆。
   *
   * ⚠️ **有 TTL，不能跟着 `probe()` 每次都跑。** 宿主的账号面板开着时可能是
   * **10 秒一次** `probe()`，而协议区间只在服务端重新部署时才变——
   * 每 10 秒问一次纯属浪费，也是白给服务端添请求。
   *
   * 上次是 `unknown`（离线/探测失败）时不受 TTL 限制，下次探活会立刻重试；
   * 登录成功那一次传 `force`，因为设备行这时才存在、POST 才记得进去。
   */
  private async negotiateProtocol(force = false): Promise<void> {
    if (!force && !shouldNegotiate(this.proto.kind, this.protoAt, Date.now(), PROTO_TTL_MS)) return
    const server = await fetchServerProtocol(this.acct.api, this.acct.identity.deviceId)
    this.proto = checkProtocol(server)
    if (this.proto.kind !== 'unknown') this.protoAt = Date.now()
    // ok 与 client_deprecated **都要灌** —— 后者是"仍受支持"的一种。只灌 ok 的话，
    // 一个已弃用但仍可用的客户端会退回 negotiated=null 的最保守行为，而服务端按它
    // 声明的版本应答，两边就错开了（v1 阶段无感，v2 会咬人）
    this.acct.api.setNegotiated(
      this.proto.kind === 'ok' || this.proto.kind === 'client_deprecated'
        ? { version: this.proto.version, caps: this.proto.caps }
        : null
    )
  }

  /** 探活 + 校时。失败不抛错，只把 reachable 置 false —— 离线是常态。 */
  async probe(): Promise<CloudStatus> {
    const h = await this.acct.api.health()
    this.reachable = !!h
    this.skew = h?.server_time ? Math.floor(Date.now() / 1000) - h.server_time : null
    if (this.reachable && this.acct.identity.deviceId) {
      try {
        const me = await this.acct.me()
        this.quota = { quotaBytes: me.quota_bytes, usedBytes: me.used_bytes }
        this.shortId = me.short_id
        this.acct.rememberShortId(me.short_id)
      } catch {
        /* 未登录或凭据失效，不影响探活结果 */
      }
    }
    // 协商跟着探活走：能连上才有意义，连不上就保持 unknown
    if (this.reachable) await this.negotiateProtocol()
    return this.status()
  }

  /** 注册第一步。服务端恒返 202，**不能据此判断邮箱是否已被占用**。 */
  async register(email: string, password: string): Promise<CloudResult> {
    try {
      const r = await this.acct.register(normEmail(email), password, deviceName(), this.platformName)
      // 恢复码先攥在手里，等邮箱验证通过再展示给用户抄
      this.pendingRecovery = { code: r.recoveryCode, email: normEmail(email) }
      this.MK = r.MK
      return { ok: true }
    } catch (e) {
      return toFail(e)
    }
  }

  /** 注册第二步：邮箱验证码。成功后才把恢复码交给 UI 展示。 */
  async verifyEmail(email: string, code: string): Promise<CloudResult<{ shortId: string; recoveryCode: string }>> {
    if (!this.MK || !this.pendingRecovery) return { ok: false, kind: 'local', message: '没有进行中的注册流程，请重新开始。' }
    try {
      const s = await this.acct.verifyEmail(normEmail(email), code, this.MK)
      this.shortId = s.shortId
      // 新账号从零开始：游标归零、在途请求作废。login() 早就这么做了，这里以前漏了——
      // 上一个账号登出时若有批次在途，它的指纹会写进新账号的同步状态。
      this.sync?.resetCursor()
      this.sync?.start()
      this.ensureIdentity()
      return { ok: true, shortId: s.shortId, recoveryCode: this.pendingRecovery.code }
    } catch (e) {
      return toFail(e)
    }
  }

  /**
   * 用户确认抄写完毕。**这一刻才把 MK 缓存进本机安全存储**（免密启动的前提）。
   * 在此之前不缓存，是为了让"没抄恢复码就换机器"的人至少还没被自动放行。
   */
  confirmRecoveryCode(): { ok: true } {
    this.pendingRecovery = null
    if (this.MK) this.store.cacheMasterKey(this.MK)
    return { ok: true }
  }

  async login(email: string, password: string): Promise<CloudResult<{ pending: boolean; shortId: string | null }>> {
    try {
      const s = await this.acct.login(normEmail(email), password, deviceName(), this.platformName)
      if (!s) return { ok: true, pending: true, shortId: null } // 待老设备确认，不是失败
      // 半途放弃的注册（验证码没收到）会留下一张从未建成账号的恢复码；登录成功就清掉，
      // 否则面板一打开会把它当"你的恢复码"展示
      this.pendingRecovery = null
      this.MK = s.MK
      this.shortId = s.shortId
      this.store.cacheMasterKey(s.MK)
      // 换账号时游标必须归零，否则会拿上一个账号的进度去问新账号
      this.sync?.resetCursor()
      await this.sync?.pullNow()      // 先把云端的设置拉下来 —— "新机器登录能拿回设置"就是这一句
      this.sync?.start()
      this.ensureIdentity()
      // 设备行这会儿才存在，POST /protocol 才记得进去；顺带把协商结果刷新成已登录那一版
      await this.negotiateProtocol(true)
      return { ok: true, pending: false, shortId: s.shortId }
    } catch (e) {
      return toFail(e)
    }
  }

  async recoveryChallenge(email: string): Promise<CloudResult> {
    try {
      await this.acct.recoveryChallenge(normEmail(email))
      return { ok: true }
    } catch (e) {
      return toFail(e)
    }
  }

  /**
   * 恢复登录 + **紧接着设新密码**（一次做完，中间不给用户留退出的机会）。
   *
   * 走恢复码这条路拿不到 `authKey`，不设新密码的话下次还是登不上——所以这两步
   * 必须捆在一起。设密码用的是服务端一次性签发的重置票，不是 `change-password`
   * （那里要当前密码，而这个人恰恰就是忘了密码的人）。
   *
   * 恢复码对不对，取决于能不能解开 `wrapped_MK_recovery` —— 解不开会在本地抛错，
   * 这时新密码也不会被设置。服务端那一侧要求随请求带上 **MK 验证子**
   * （`HKDF(MK,"","dh-mk-verifier-v1")`），于是它也能独立确认"这个人确实解出了 MK"，
   * 不必再只凭一张邮箱验证码换来的票就覆写密码凭证。
   *
   * 过了这一关，服务端会**接管账号**：除本机外的设备全部吊销、待批准票据作废。
   * `tookOver` 如实回传，界面上那句"其它设备已全部退出"只能在它为真时说。
   */
  async recoveryLogin(
    email: string,
    emailCode: string,
    recoveryCode: string,
    newPassword: string
  ): Promise<CloudResult<{ pending: boolean; tookOver: boolean; devicesRevoked: number }>> {
    try {
      const r = await this.acct.recoveryLogin(normEmail(email), emailCode, recoveryCode, deviceName(), this.platformName)
      // 能走到这里说明恢复码解开了 MK
      const takeover = await this.acct.setPasswordAfterRecovery(
        normEmail(email), r.resetToken, r.MK, newPassword, { accountId: r.accountId, deviceId: r.deviceId })
      this.pendingRecovery = null
      this.MK = r.MK
      // 接管成功时这台已经是 active 了 —— recovery-login 那一步说的 pending 发生在
      // 验证子校验之前，此刻已经过时。照它走会让用户去等一个刚被踢光的旧设备来确认。
      const pending = r.pending && !takeover.tookOver
      if (!pending) {
        this.store.cacheMasterKey(r.MK)
        this.sync?.resetCursor()
        await this.sync?.pullNow()
        this.sync?.start()
        this.ensureIdentity()
      }
      return { ok: true, pending, tookOver: takeover.tookOver, devicesRevoked: takeover.devicesRevoked }
    } catch (e) {
      return toFail(e)
    }
  }

  async devices(): Promise<CloudResult<{ devices: CloudDevice[]; pending: CloudPendingApproval[] }>> {
    const id = this.acct.identity.deviceId
    if (!id) return { ok: false, kind: 'local', message: '未登录' }
    try {
      const r = await this.acct.api.call<{ devices: CloudDevice[]; pending_approvals: CloudPendingApproval[] }>({
        method: 'GET',
        target: '/api/v1/devices',
        deviceId: id
      })
      return { ok: true, devices: r.devices, pending: r.pending_approvals }
    } catch (e) {
      return toFail(e)
    }
  }

  async approveDevice(targetDeviceId: string, code: string): Promise<CloudResult> {
    const id = this.acct.identity.deviceId
    if (!id) return { ok: false, kind: 'local', message: '未登录' }
    try {
      await this.acct.api.call({
        method: 'POST',
        target: `/api/v1/devices/${targetDeviceId}/approve`,
        deviceId: id,
        body: { code: code.trim().toUpperCase() }
      })
      return { ok: true }
    } catch (e) {
      return toFail(e)
    }
  }

  async revokeDevice(targetDeviceId: string): Promise<CloudResult<{ wasCurrent: boolean }>> {
    const id = this.acct.identity.deviceId
    if (!id) return { ok: false, kind: 'local', message: '未登录' }
    try {
      const r = await this.acct.api.call<{ was_current?: boolean }>({
        method: 'POST',
        target: `/api/v1/devices/${targetDeviceId}/revoke`,
        deviceId: id
      })
      if (r.was_current) this.signOut()
      return { ok: true, wasCurrent: !!r.was_current }
    } catch (e) {
      return toFail(e)
    }
  }

  /**
   * 把还没确认的恢复码再取一次。
   *
   * 它本来就在 verifyEmail 时经 IPC 送过一次，这里不是新的暴露面；给它一条回头路，
   * 是因为那一屏点一下背景就关了、而这串东西**再也拿不回来**——零知识账号里
   * 丢恢复码等于"忘密码即永久丢全部内容"。确认（confirmRecoveryCode）之后
   * pendingRecovery 被清掉，这里就只返回 null，取不到了。
   */
  pendingRecoveryCode(): { code: string | null } {
    return { code: this.pendingRecovery?.code ?? null }
  }

  /**
   * 重新生成恢复码。零知识下恢复码是 MK 的唯一副本、不能落盘，
   * "注册中途关了软件 / 纸丢了"只有这一条根治：MK 在内存时换一份新的上去，旧的作废。
   * 要用户再输一次密码（服务端与改密码同强度地校验 current_auth_hash）。
   * 新码同样走 pendingRecovery：抄写屏误关了还能从 cmd:cloudPendingRecovery 接回来。
   */
  async rotateRecoveryCode(password: string): Promise<CloudResult<{ recoveryCode: string }>> {
    if (!this.MK) return { ok: false, kind: 'local', message: '主密钥不在内存里：先退出登录，再用密码登录一次。' }
    try {
      const code = await this.acct.rotateRecovery(this.MK, password)
      this.pendingRecovery = { code, email: this.acct.identity.email ?? '' }
      return { ok: true, recoveryCode: code }
    } catch (e) {
      return toFail(e)
    }
  }

  /** 退出登录：清账号绑定与 MK 缓存，**保留设备密钥**——下次登录还是同一台设备，不用重新确认。 */
  signOut(): { ok: true } {
    this.MK = null
    this.pendingRecovery = null
    this.quota = null
    this.shortId = null
    this.sync?.stop()
    this.sync?.resetCursor()
    // 身份私钥不能留在内存里等下一个账号
    this.ident.reset()
    // 好友备注同理：下一个账号绝不能看到上一个账号管别人叫什么
    this.soc.resetRemarks()
    // 协商结果跟着账号走：下次探活会重新算
    this.proto = { kind: 'unknown' }
    this.protoAt = 0
    this.acct.api.setNegotiated(null)
    this.store.clearMasterKey()
    this.acct.logout()
    return { ok: true }
  }

  /** 彻底重置本机云端身份（设备被吊销后用）。下次登录会被当作全新设备。 */
  resetIdentity(): { ok: true } {
    this.signOut()
    this.store.resetDevice()
    return { ok: true }
  }

  attachSync(engine: SyncLike): void {
    this.sync = engine
    // 同步器拉到身份密钥就喂给 IdentityManager，喂完立刻再试一次认领：
    // 换机登录时"服务端已有公钥、私钥还在路上"这个状态就是靠这里收敛的
    engine.onIdentity((p) => {
      this.ident.offer(p)
      void this.ident.ensure().catch(() => undefined)
    })
    // 免密启动的情况：构造时就已解锁，这里直接把同步跑起来
    if (this.MK && this.acct.identity.deviceId) {
      /**
       * ⚠️ **上报排在 `engine.start()` 之前**。
       *
       * 反过来的话，设备行还是 0 的客户端升级后第一次启动，同步器的第一发请求会抢在
       * `POST /protocol` 前面吃一个 426。它没 await，所以对调只能保证**先发出去**、
       * 保证不了先回来 —— 真正兜住这件事的是 `pushConversations` 里对 426 的归类
       *（见 `classifyPushReject`）：整批留在队列里等下一轮，而不是被当成对象级拒收清空。
       * 两手一起才够。
       */
      void this.negotiateProtocol()
      engine.start()
      this.ensureIdentity()
      /*
       * 上面那一句是协议上报的**唯一可靠时机**：免密启动不走 `login()`，而 `probe()` 只由
       * 账号面板和朋友页触发——一个从不打开那两处的用户会永远不上报版本，于是
       * 「最近 N 天活跃设备都 ≥ 目标版本」这条抬下限的判据根本没有数据可看。
       * 这正是把版本号挂在 enroll 上的那个老毛病换了一层皮：设备密钥跨升级保留，
       * 所以"升级了但没重新登录"才是常态。
       *
       * 不 await：它只是上报 + 拿区间，界面不该为它等。放在这个 `if` 里也不会让任何
       * 本该不联网的情形联网——进这个分支的前提就是已解锁。
       */
    }
  }

  /**
   * 认领账号级身份密钥。**登录就办**，
   * 不等用户点进朋友页。失败无所谓——每次同步拉到 identity 对象都会再试。
   */
  private ensureIdentity(): void {
    void this.ident.ensure().catch(() => undefined)
  }

  /**
   * 同上，但**可等、可问结果**：给没有同步器的宿主用（dsh 插件）。
   * DeepHub 桌面端免密启动后是 `attachSync` 顺手 ensure 的；插件没有 SyncEngine，
   * 重启后主密钥在、身份密钥却没人去认领，发思路会报 `no_key`——启动时和发送前各叫一次。幂等。
   */
  async ensureIdentityKey(): Promise<boolean> {
    try {
      return (await this.ident.ensure()) !== null
    } catch {
      return false
    }
  }

  /** 短 ID 变了（换 ID）之后回写内存 + 落盘。由 SocialClient 调。 */
  noteShortId(shortId: string): void {
    this.shortId = shortId
    this.acct.rememberShortId(shortId)
  }

  /** 朋友功能。私钥不经过它，只走 HTTP。 */
  get social(): SocialClient {
    return this.soc
  }
  /** 思路投递。加解密在主进程里做，明文与密钥都不过 IPC。 */
  get delivery(): DeliveryClient {
    return this.dlv
  }
  /** 给投递用：拿当前账号的身份密钥（未认领到时为 null）。**不经过 IPC。** */
  identityKey(): ReturnType<IdentityManager['current']> {
    return this.ident.current()
  }

  /** 给同步器用：拿主密钥。未解锁时返回 null，调用方必须能安静跳过。 */
  masterKey(): Buffer | null {
    return this.MK
  }
  /** 设置被改过时叫一下，让上传立刻发生 */
  nudgeSync(): void {
    this.sync?.nudge()
  }
  syncStatus(): CloudSyncStatus | null {
    return this.sync?.getStatus() ?? null
  }
  get account(): CloudAccount {
    return this.acct
  }
}
