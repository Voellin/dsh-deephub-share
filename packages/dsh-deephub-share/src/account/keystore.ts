/**
 * `KeyStore` 的 dsh 实现：设备密钥、账号绑定、主密钥缓存、身份私钥缓存**全部**放进 dsh 的凭据存储
 * （`ctx.credentials` 的 record 半，四条 `deephub-share/*` 记录）。
 *
 * 为什么不用共享包里的 `FileKeyStore`：
 * - dsh 没有 Electron safeStorage，`FileKeyStore` 没有 sealer 就**不缓存主密钥**——免密启动不成立；
 * - dsh 自己的密钥（API key）就存在凭据存储里，本插件的密钥跟它同一处，同一把锁、同一个文件权限、
 *   将来 dsh 换成系统钥匙串后自动受益；
 * - 一处退出、一处清干净。
 *
 * 保护级别（界面上要如实说）：`dsh-credentials-local` 落在 `$DSH_HOME/.credentials.yaml`，**明文、0600**，
 * 弱于 DeepHub 桌面端的 DPAPI。`DeviceIdentity.encrypted` 因此恒为 false。
 *
 * 同步/异步：`KeyStore` 的 11 个方法都是同步的（`CloudService` 构造时就要读），而 `ctx.credentials`
 * 全是异步。做法：`open()` 时把四条记录预读进内存；之后读走内存、写走一条串行队列（写失败记日志，
 * 内存值照旧——下次启动会发现少了什么，退回"重新登录"，不会丢用户数据）。
 */
import { createPrivateKey, createPublicKey } from 'node:crypto'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { newKeypair, pubToRaw, type DeviceBindingPatch, type DeviceIdentity, type KeyStore } from '@deephub/cloud-protocol'

/** `ctx.credentials` 里本插件用到的三个方法（结构类型，不依赖 Service 类本身）。 */
export interface CredentialsLike {
  readRecord(key: CredentialKey): Promise<CredentialRecord | undefined>
  modifyRecord(
    key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined>
  deleteRecord(key: CredentialKey): Promise<void>
}

const SCOPE = 'deephub-share'
/** 四条记录的 id。都是合法的凭据 key 段（`^[a-z][a-z0-9-]*$`），用常量拼、不经 `credentialKey()` 校验。 */
const IDS = { device: 'device', binding: 'binding', mk: 'master-key', ident: 'identity-key' } as const
type RecordId = (typeof IDS)[keyof typeof IDS]
const keyOf = (id: RecordId): CredentialKey => `${SCOPE}/${id}` as CredentialKey

interface DevicePayload { v: 1; pem: string }
interface BindingPayload { v: 1; deviceId: string | null; accountId: string | null; email: string | null; shortId: string | null }
interface SecretPayload { v: 1; b64: string }

const EMPTY_BINDING: BindingPayload = { v: 1, deviceId: null, accountId: null, email: null, shortId: null }

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null

function grantPayload(rec: CredentialRecord | undefined): unknown {
  return rec !== undefined && rec.kind === 'grant' ? rec.payload : undefined
}

export class DshKeyStore implements KeyStore {
  private device: DevicePayload | null = null
  private binding: BindingPayload = { ...EMPTY_BINDING }
  private mk: string | null = null
  private ident: string | null = null
  /** 写队列：同一时刻只有一个 modifyRecord/deleteRecord 在飞，顺序与调用顺序一致 */
  private chain: Promise<void> = Promise.resolve()
  private lastError: Error | null = null

  private constructor(
    private readonly creds: CredentialsLike,
    private readonly log: (msg: string) => void,
  ) {}

  /** 预读四条记录。坏记录当不存在（会被下一次写覆盖）。 */
  static async open(creds: CredentialsLike, log: (msg: string) => void = () => {}): Promise<DshKeyStore> {
    const s = new DshKeyStore(creds, log)
    const [d, b, m, i] = await Promise.all([
      creds.readRecord(keyOf(IDS.device)), creds.readRecord(keyOf(IDS.binding)),
      creds.readRecord(keyOf(IDS.mk)), creds.readRecord(keyOf(IDS.ident)),
    ])
    const dp = grantPayload(d)
    if (isRecord(dp) && dp.v === 1 && typeof dp.pem === 'string') s.device = { v: 1, pem: dp.pem }
    const bp = grantPayload(b)
    if (isRecord(bp) && bp.v === 1) {
      const str = (x: unknown): string | null => (typeof x === 'string' && x ? x : null)
      s.binding = { v: 1, deviceId: str(bp.deviceId), accountId: str(bp.accountId), email: str(bp.email), shortId: str(bp.shortId) }
    }
    const mp = grantPayload(m)
    if (isRecord(mp) && mp.v === 1 && typeof mp.b64 === 'string') s.mk = mp.b64
    const ip = grantPayload(i)
    if (isRecord(ip) && ip.v === 1 && typeof ip.b64 === 'string') s.ident = ip.b64
    return s
  }

  /** 等所有排队的写落盘（测试与关机用）。 */
  flush(): Promise<void> { return this.chain }
  /** 最近一次写失败（没有就是 null）。界面可以据此提醒"凭据没存下来"。 */
  writeError(): Error | null { return this.lastError }

  private write(id: RecordId, payload: DevicePayload | BindingPayload | SecretPayload | null): void {
    const key = keyOf(id)
    this.chain = this.chain
      .then(() => payload === null
        ? this.creds.deleteRecord(key)
        : this.creds.modifyRecord(key, async () => ({ kind: 'grant', payload })).then(() => undefined))
      .then(() => { this.lastError = null })
      .catch((e: unknown) => {
        this.lastError = e instanceof Error ? e : new Error(String(e))
        this.log(`deephub-share: credentials write "${key}" failed: ${this.lastError.message}`)
      })
  }

  /* ───────── 设备密钥 + 绑定 ───────── */

  loadOrCreateDevice(): DeviceIdentity {
    if (this.device !== null) {
      try {
        const privateKey = createPrivateKey(this.device.pem)
        const publicKey = createPublicKey(privateKey)
        return { keypair: { privateKey, publicKey, rawPub: pubToRaw(publicKey) }, ...this.bindingView(), encrypted: false }
      } catch {
        // 记录坏了只能重新生成：这台机器要重新走一次"新设备需老设备确认"，数据不会丢
        this.device = null
      }
    }
    const kp = newKeypair()
    const pem = kp.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    this.device = { v: 1, pem }
    this.binding = { ...EMPTY_BINDING }
    this.write(IDS.device, this.device)
    this.write(IDS.binding, this.binding)
    return { keypair: kp, ...this.bindingView(), encrypted: false }
  }

  private bindingView(): Pick<DeviceIdentity, 'deviceId' | 'accountId' | 'email' | 'shortId'> {
    const b = this.binding
    return { deviceId: b.deviceId, accountId: b.accountId, email: b.email, shortId: b.shortId }
  }

  saveDeviceBinding(patch: DeviceBindingPatch): void {
    const next: BindingPayload = { ...this.binding }
    if (patch.deviceId !== undefined) next.deviceId = patch.deviceId
    if (patch.accountId !== undefined) next.accountId = patch.accountId
    if (patch.email !== undefined) next.email = patch.email
    if (patch.shortId !== undefined) next.shortId = patch.shortId
    this.binding = next
    this.write(IDS.binding, next)
  }

  clearDeviceBinding(): void {
    this.saveDeviceBinding({ deviceId: null, accountId: null, email: null, shortId: null })
  }

  resetDevice(): void {
    this.device = null
    this.binding = { ...EMPTY_BINDING }
    this.write(IDS.device, null)
    this.write(IDS.binding, null)
  }

  /* ───────── 主密钥 / 身份私钥缓存 ───────── */

  /** 凭据存储总在（dsh-base 自带 credentials-local），所以恒为 true；保护级别的说明在界面上给。 */
  isCacheAvailable(): boolean { return true }

  cacheMasterKey(MK: Buffer): boolean {
    this.mk = MK.toString('base64')
    this.write(IDS.mk, { v: 1, b64: this.mk })
    return true
  }
  loadMasterKey(): Buffer | null { return this.secret(this.mk) }
  clearMasterKey(): void { this.mk = null; this.write(IDS.mk, null) }

  cacheIdentityKey(rawPriv: Buffer): boolean {
    this.ident = rawPriv.toString('base64')
    this.write(IDS.ident, { v: 1, b64: this.ident })
    return true
  }
  loadIdentityKey(): Buffer | null { return this.secret(this.ident) }
  clearIdentityKey(): void { this.ident = null; this.write(IDS.ident, null) }

  /** 32 字节才算数，别的当没缓存。 */
  private secret(b64: string | null): Buffer | null {
    if (b64 === null) return null
    try {
      const raw = Buffer.from(b64, 'base64')
      return raw.length === 32 ? raw : null
    } catch { return null }
  }
}
