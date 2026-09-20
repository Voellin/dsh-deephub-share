import { createHash } from 'node:crypto'
import { PROTOCOL_VERSION } from '../protocol/version'
import { deriveAuthKey, deriveMaster, deriveMkVerifier, type KdfParams } from '../crypto/kdf'
import type { Box } from '../crypto/envelope'
import { changePassword, login, loginWithRecovery, register, rotateRecovery, type ServerAccountBlob } from '../crypto/account'
import { CloudApiError, CloudClient } from './client'
import type { DeviceIdentity, KeyStore } from '../keystore'

/**
 * 账号流程：把 `crypto/`（纯本地密钥运算）与 `client`（签名传输）接起来。
 *
 * 贯穿的一条：**密码和主密钥 MK 都不离开本机**。上传的只有
 * `sha256(authKey)` 和一堆服务器解不开的信封。
 */

/**
 * 只算 `authHash`、不解 MK。
 *
 * 登录第一步和改密码校验当前密码都需要它，但 `crypto/account.ts` 的 `login()`
 * 一定会去解 `wrapped_MK_pwd`（那时我们还没拿到信封），所以在这里用它导出的原语拼一个。
 *
 * ⚠️ 这段逻辑与 `crypto/account.ts` 里私有的 `authHashOf` **必须保持一致**：
 * 都是 `base64(sha256(authKey))`。改动任何一边都要同步。
 */
const deriveAuthHash = (password: string, kdf: KdfParams): string =>
  createHash('sha256').update(deriveAuthKey(deriveMaster(password, kdf), kdf)).digest().toString('base64')

export interface CloudSession {
  accountId: string
  shortId: string
  email: string
  deviceId: string
  /** 主密钥，只在内存里。调用方按需交给 keystore 缓存以实现免密启动。 */
  MK: Buffer
}

/** 服务端下发的登录结果，两种形态 */
type LoginRes =
  | {
      status: 'ok'
      account_id: string
      short_id: string
      device_id: string
      kdf: KdfParams
      wrapped_mk_pwd: Box
      /** 这个账号还没有 MK 验证子（新服务端上线前注册的）——登录成功后补传一次 */
      mk_verifier_missing?: boolean
    }
  | { status: 'pending_approval'; device_id: string }

export class CloudAccount {
  private readonly client: CloudClient
  private readonly store: KeyStore
  private device: DeviceIdentity

  /** `store` 是宿主注入的本机密钥存取（Electron safeStorage / dsh 凭据 / 明文文件）。 */
  constructor(store: KeyStore, client?: CloudClient) {
    this.store = store
    this.client = client ?? new CloudClient()
    this.device = store.loadOrCreateDevice()
    this.client.setDeviceKey(this.device.keypair.privateKey)
  }

  get identity(): DeviceIdentity {
    return this.device
  }
  get pubB64(): string {
    return this.device.keypair.rawPub.toString('base64')
  }
  get api(): CloudClient {
    return this.client
  }

  private deviceMeta(name: string, platform: string): Record<string, string> {
    return { device_pubkey: this.pubB64, device_name: name, platform }
  }

  /** 取 KDF 参数。**未注册邮箱也会返回一份确定性伪参数**，故不能据此判断账号是否存在。 */
  async fetchKdf(email: string): Promise<KdfParams> {
    const r = await this.client.call<{ kdf: KdfParams }>({
      method: 'POST',
      target: '/api/v1/account/kdf',
      body: { email },
      enroll: true
    })
    return r.kdf
  }

  /**
   * 注册第一步。**服务端恒返 202**，不告诉你邮箱是否已被占用（防抢注枚举），
   * 所以 UI 上只能说"验证码已发出，请查收"。
   */
  async register(email: string, password: string, deviceName: string, platform: string): Promise<{ recoveryCode: string; blob: ServerAccountBlob; MK: Buffer }> {
    const r = register(password)
    await this.client.call({
      method: 'POST',
      target: '/api/v1/account/register',
      enroll: true,
      body: {
        email,
        authHash: r.server.authHash,
        kdf: r.server.kdf,
        wrapped_mk_pwd: r.server.wrapped_MK_pwd,
        recovery_salt: r.server.recovery.salt,
        wrapped_mk_recovery: r.server.recovery.wrapped_MK,
        // MK 验证子：日后走恢复流程时用它证明「我真的解出了主密钥」。
        // 一生只写一次，服务端不给覆写 —— 所以必须在建号这一刻就带上。
        mk_verifier: mkVerifierB64(r.MK),
        ...this.deviceMeta(deviceName, platform)
      }
    })
    return { recoveryCode: r.recoveryCode, blob: r.server, MK: r.MK }
  }

  /** 注册第二步：填邮箱收到的验证码。**必须由发起注册的这台机器完成**（服务端会比对公钥）。 */
  async verifyEmail(email: string, code: string, MK: Buffer): Promise<CloudSession> {
    const r = await this.client.call<{ account_id: string; short_id: string; device_id: string }>({
      method: 'POST',
      target: '/api/v1/account/verify-email',
      enroll: true,
      // proto：让设备行从诞生就带着版本号。真正保证它不过期的是启动时的探测（cloud/protocol.ts）
      body: { email, code: code.trim().toUpperCase(), device_pubkey: this.pubB64, proto: PROTOCOL_VERSION }
    })
    this.bind(r.account_id, r.device_id, email, r.short_id)
    return { accountId: r.account_id, shortId: r.short_id, email, deviceId: r.device_id, MK }
  }

  /**
   * 登录。返回 `null` 表示**新设备待老设备确认** —— 不是失败。
   * 密码错与账号不存在在服务端是同一个响应，这里也无法区分，只能笼统提示。
   */
  async login(email: string, password: string, deviceName: string, platform: string): Promise<CloudSession | null> {
    const kdf = await this.fetchKdf(email)
    // 用服务端下发的 kdf 参数在本机派生；密码本身永不出网
    const res = await this.client.call<LoginRes>({
      method: 'POST',
      target: '/api/v1/account/login',
      enroll: true,
      body: { email, authHash: deriveAuthHash(password, kdf), proto: PROTOCOL_VERSION, ...this.deviceMeta(deviceName, platform) }
    })
    if (res.status === 'pending_approval') {
      this.store.saveDeviceBinding({ email })
      this.device = { ...this.device, email }
      return null
    }
    // 真正解 MK：用同一个密码 + 服务端下发的信封
    const un = login(password, {
      kdf: res.kdf,
      authHash: '',
      wrapped_MK_pwd: res.wrapped_mk_pwd,
      recovery: { salt: '', wrapped_MK: dummyBox() }
    })
    this.bind(res.account_id, res.device_id, email, res.short_id)
    // 存量账号关窗：这会儿手上同时有 MK 和密码，别处凑不齐这两样。失败不影响登录。
    if (res.mk_verifier_missing) {
      await this.backfillMkVerifier(un.MK, deriveAuthHash(password, res.kdf), res.device_id)
    }
    return { accountId: res.account_id, shortId: res.short_id, email, deviceId: res.device_id, MK: un.MK }
  }

  /**
   * 给还没有 MK 验证子的老账号补一次（存量账号的过渡窗口）。
   *
   * **只在密码登录成功后调用**：服务端要求同时具备活跃设备、当前密码、解出来的 MK。
   * 服务端对已有验证子的账号返回 409，所以重复调用是安全的。
   *
   * 补不上不算登录失败 —— 那只意味着这个账号的恢复流程还在过渡路径上，下次登录再试。
   */
  private async backfillMkVerifier(MK: Buffer, currentAuthHash: string, deviceId: string): Promise<void> {
    try {
      await this.client.call({
        method: 'POST',
        target: '/api/v1/account/mk-verifier',
        deviceId,
        body: { current_auth_hash: currentAuthHash, mk_verifier: mkVerifierB64(MK) }
      })
    } catch {
      /* 静默：登录已经成功，这一步失败不该把用户挡在门外 */
    }
  }

  /** 恢复第一步：请服务端往注册邮箱发一次性令牌。**恒返 202**，不泄露账号是否存在。 */
  async recoveryChallenge(email: string): Promise<void> {
    await this.client.call({
      method: 'POST',
      target: '/api/v1/account/recovery/challenge',
      body: { email },
      enroll: true
    })
  }

  /**
   * 恢复第二步：邮箱令牌 + 恢复码 → 解出 MK。
   * 注意服务端下发的 `recovery_salt` **必须**存在，否则恢复码永远解不开 MK。
   */
  async recoveryLogin(
    email: string,
    emailCode: string,
    recoveryCode: string,
    deviceName: string,
    platform: string
  ): Promise<{ MK: Buffer; accountId: string; deviceId: string; pending: boolean; resetToken: string }> {
    const r = await this.client.call<{
      account_id: string
      kdf: KdfParams
      recovery_salt: string
      wrapped_mk_recovery: Box
      device_id: string
      device_status: string
      reset_token: string
    }>({
      method: 'POST',
      target: '/api/v1/account/recovery-login',
      enroll: true,
      body: { email, code: emailCode.trim().toUpperCase(), proto: PROTOCOL_VERSION, ...this.deviceMeta(deviceName, platform) }
    })
    const MK = loginWithRecovery(recoveryCode, {
      kdf: r.kdf,
      authHash: '',
      wrapped_MK_pwd: dummyBox(),
      recovery: { salt: r.recovery_salt, wrapped_MK: r.wrapped_mk_recovery }
    })
    const pending = r.device_status !== 'active'
    if (!pending) this.bind(r.account_id, r.device_id, email)
    return { MK, accountId: r.account_id, deviceId: r.device_id, pending, resetToken: r.reset_token }
  }

  /**
   * 恢复流程的收尾：凭一次性重置票设新密码。
   *
   * **必须做，否则恢复只走了一半** —— 走恢复码这条路拿不到 authKey，
   * 不设新密码的话，下次还是登不上。
   * 不能复用 `changePassword`：那里要 `current_auth_hash`，而这个人恰恰就是忘了密码的人。
   */
  async setPasswordAfterRecovery(
    email: string,
    resetToken: string,
    MK: Buffer,
    newPassword: string,
    /** 本次恢复入册到的账号与设备。接管成功后要用它落绑定 —— 见下方说明。 */
    session?: { accountId: string; deviceId: string }
  ): Promise<{ tookOver: boolean; devicesRevoked: number }> {
    const next = changePassword(MK, newPassword)
    const r = await this.client.call<{ changed: boolean; took_over?: boolean; devices_revoked?: number }>({
      method: 'POST',
      target: '/api/v1/account/recovery/set-password',
      enroll: true,
      body: {
        email: email.trim(),
        reset_token: resetToken,
        new_auth_hash: next.authHash,
        kdf: next.kdf,
        wrapped_mk_pwd: next.wrapped_MK_pwd,
        // 证明「我解出了 MK」= 证明我持有恢复码。少了这一句，这整条流程就只等于"持有邮箱"。
        mk_verifier: mkVerifierB64(MK),
        device_pubkey: this.pubB64,
        // 接管路径上可能要补建这台设备，一并把版本带上
        proto: PROTOCOL_VERSION
      }
    })
    // 老服务端不回这两个字段 —— 按"没接管"处理，界面上就不会说那句不实的话
    const tookOver = r.took_over === true
    /**
     * 接管成功 = 这台设备在服务端已经是 active 了，**不管上一步 recovery-login 说的是
     * pending 还是 revoked**。那一步发生在验证子校验之前，它的结论此刻已经过时。
     * 不在这里落绑定，用户就会看到一句"还需在旧设备上确认"——而旧设备刚刚全被踢掉了，
     * 根本没人能确认。
     */
    if (tookOver && session) this.bind(session.accountId, session.deviceId, email)
    return { tookOver, devicesRevoked: r.devices_revoked ?? 0 }
  }

  /**
   * 改密码。**必须带当前密码**——光有设备私钥改不了，这是防设备私钥失窃的那道闸。
   *
   * `revokeOthers` 为真时顺带把其它设备全部踢下线。这是夺回账号的第二条路径
   * （「持有本设备 + 持有当前密码」），与恢复流程那条各走各的。**不可逆**：
   * 其它设备要重新走一次"新设备"流程，所以界面上必须事前说清。
   */
  async changePassword(
    MK: Buffer,
    currentPassword: string,
    newPassword: string,
    opts?: { revokeOthers?: boolean }
  ): Promise<{ devicesRevoked: number }> {
    const email = this.device.email
    if (!email || !this.device.deviceId) throw new Error('未登录')
    const curKdf = await this.fetchKdf(email)
    const next = changePassword(MK, newPassword)
    const r = await this.client.call<{ changed: boolean; devices_revoked?: number }>({
      method: 'POST',
      target: '/api/v1/account/change-password',
      deviceId: this.device.deviceId,
      body: {
        current_auth_hash: deriveAuthHash(currentPassword, curKdf),
        new_auth_hash: next.authHash,
        kdf: next.kdf,
        wrapped_mk_pwd: next.wrapped_MK_pwd,
        ...(opts?.revokeOthers ? { revoke_others: true } : {})
      }
    })
    return { devicesRevoked: r.devices_revoked ?? 0 }
  }

  /**
   * 重新生成恢复码。**必须带当前密码**，与改密码同强度——
   * 光有设备私钥换不了恢复码，否则偷到设备私钥的人能给自己签一张、日后凭它 + 邮箱接管账号。
   * 返回新恢复码给用户抄；旧码从服务端接受这次请求起作废。
   */
  async rotateRecovery(MK: Buffer, currentPassword: string): Promise<string> {
    const email = this.device.email
    if (!email || !this.device.deviceId) throw new Error('未登录')
    const curKdf = await this.fetchKdf(email)
    const next = rotateRecovery(MK)
    await this.client.call({
      method: 'POST',
      target: '/api/v1/account/recovery/rotate',
      deviceId: this.device.deviceId,
      body: {
        current_auth_hash: deriveAuthHash(currentPassword, curKdf),
        recovery_salt: next.recovery.salt,
        wrapped_mk_recovery: next.recovery.wrapped_MK
      }
    })
    return next.recoveryCode
  }

  async me(): Promise<{ account_id: string; email: string; short_id: string; quota_bytes: number; used_bytes: number }> {
    if (!this.device.deviceId) throw new CloudApiError(401, 'not_logged_in')
    return this.client.call({ method: 'GET', target: '/api/v1/account/me', deviceId: this.device.deviceId })
  }

  logout(): void {
    this.store.clearDeviceBinding()
    this.device = { ...this.device, deviceId: null, accountId: null, email: null, shortId: null }
  }

  private bind(accountId: string, deviceId: string, email: string, shortId?: string): void {
    const patch = { accountId, deviceId, email, ...(shortId ? { shortId } : {}) }
    this.store.saveDeviceBinding(patch)
    this.device = { ...this.device, ...patch }
  }

  /**
   * 短 ID 变了（换 ID / probe 拿到）就落盘。
   * **不落盘的话，免密启动和断网时界面上就是个 `—`** —— 这个 bug 已经犯过两次。
   */
  rememberShortId(shortId: string): void {
    if (!shortId || this.device.shortId === shortId) return
    this.store.saveDeviceBinding({ shortId })
    this.device = { ...this.device, shortId }
  }
}

const dummyBox = (): Box => ({ iv: '', ct: '', tag: '' })

/** MK → 上传形态的验证子。只依赖 MK，恢复流程里手上也只有它。 */
const mkVerifierB64 = (MK: Buffer): string => deriveMkVerifier(MK).toString('base64')
