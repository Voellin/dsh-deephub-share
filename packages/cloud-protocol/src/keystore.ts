import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { createPrivateKey, createPublicKey } from 'node:crypto'
import { dirname, join } from 'node:path'
import { newKeypair, pubToRaw, type Keypair } from './cloud/sign'

/**
 * 本机密钥存取（设备密钥、主密钥缓存、身份私钥缓存）。
 *
 * 这是协议客户端与"宿主"之间唯一的分界：
 * - DeepHub 桌面端注入 Electron `safeStorage`（Windows 走 DPAPI，绑当前 OS 用户）；
 * - dsh 插件注入 dsh 的凭据存储；
 * - 测试什么都不注入，走明文文件。
 *
 * 落盘的文件名、目录与字段是**定死的**：`cloud/device_key`、`cloud/device.json`、
 * `account.key`、`identity.key` —— 改任何一个，老用户本机的密钥就读不出来了。
 */

/** 操作系统级的加解密能力（Electron safeStorage 的最小子集）。 */
export interface Sealer {
  isAvailable(): boolean
  encryptString(s: string): Buffer
  decryptString(b: Buffer): string
}

export interface DeviceIdentity {
  keypair: Keypair
  /** 服务端下发的设备 id；注册/登录成功前为 null */
  deviceId: string | null
  /** 当前绑定的账号 id；未登录为 null */
  accountId: string | null
  email: string | null
  /**
   * 对外短 ID。**必须落盘**——它要在免密启动、断网的情况下也显示得出来。
   *
   * 之前只存在内存里，靠注册验证/登录/probe 三条路径回填，于是"打开某个新面板
   * 时短 ID 是空的"这个 bug 犯了两次：第一次修法是往那三个调用点补回填，
   * 结果加第四个入口（朋友面板）时又中招。落盘之后这一类问题不再存在。
   */
  shortId: string | null
  /** 私钥是否受 OS 安全存储保护（false = 降级成了明文文件） */
  encrypted: boolean
}

export type DeviceBindingPatch = Partial<Pick<DeviceIdentity, 'deviceId' | 'accountId' | 'email' | 'shortId'>>

/**
 * 协议客户端需要宿主提供的全部本机存取，一共 11 个方法。
 */
export interface KeyStore {
  /** 读出本机设备身份；没有就地生成一把新的并落盘。 */
  loadOrCreateDevice(): DeviceIdentity
  /** 注册/登录拿到 deviceId 后回写。短 ID 也走这里落盘。 */
  saveDeviceBinding(patch: DeviceBindingPatch): void
  /** 退出登录：解绑账号但**保留设备密钥**，下次登录还是同一台设备，不用重新确认。 */
  clearDeviceBinding(): void
  /** 彻底重置（设备被吊销、或要换一台"新设备"时用）。 */
  resetDevice(): void

  /** 本机是否具备安全缓存能力。false 时上层应提示"本机不支持安全存储，每次启动需输入密码"。 */
  isCacheAvailable(): boolean
  /** 缓存 MK。不可用时**静默不写**并返回 false。绝不在不可用时明文落盘。 */
  cacheMasterKey(MK: Buffer): boolean
  /** 读回 MK。没缓存、解不开、文件坏了 —— 一律返回 null。 */
  loadMasterKey(): Buffer | null
  /** 退出登录 / 换账号时清掉。 */
  clearMasterKey(): void

  /** 账号级身份私钥（X25519）的本机缓存，与 MK 同一套做法。 */
  cacheIdentityKey(rawPriv: Buffer): boolean
  loadIdentityKey(): Buffer | null
  clearIdentityKey(): void
}

const DIR = 'cloud'
const KEY_FILE = 'device_key'
const META_FILE = 'device.json'
const MK_FILE = 'account.key'
const IDENT_FILE = 'identity.key'

interface Meta {
  deviceId: string | null
  accountId: string | null
  email: string | null
  shortId: string | null
  encrypted: boolean
}

function writeAtomic(path: string, data: Buffer | string): void {
  const tmp = path + '.tmp'
  writeFileSync(tmp, data, { mode: 0o600 })
  renameSync(tmp, path)
}

/**
 * 文件型 KeyStore。
 *
 * 设备密钥：有 sealer 就加密落盘，没有就**静默降级**为明文文件 + 0600 权限——
 * 宁可能用，也不要因为存不了密钥就整个云端功能不可用。
 * 主密钥与身份私钥：**没有 sealer 就不缓存**（返回 false / null），绝不明文落盘；
 * 上层据此提示"每次启动需输入密码"。
 */
export class FileKeyStore implements KeyStore {
  constructor(
    private readonly userDataDir: string,
    private readonly sealer: Sealer | null = null
  ) {}

  private get dir(): string { return join(this.userDataDir, DIR) }
  private get keyPath(): string { return join(this.dir, KEY_FILE) }
  private get metaPath(): string { return join(this.dir, META_FILE) }
  private get mkPath(): string { return join(this.userDataDir, MK_FILE) }
  private get identPath(): string { return join(this.userDataDir, IDENT_FILE) }

  /** 可用的 sealer；不可用（或 isAvailable 抛错）时为 null。 */
  private sealerIfAvailable(): Sealer | null {
    const s = this.sealer
    if (!s) return null
    try {
      return s.isAvailable() ? s : null
    } catch {
      return null
    }
  }

  private readMeta(): Meta {
    const empty: Meta = { deviceId: null, accountId: null, email: null, shortId: null, encrypted: false }
    try {
      const raw = JSON.parse(readFileSync(this.metaPath, 'utf8')) as Partial<Meta>
      // shortId 是后加的字段：老 meta 里没有 → 补成 null，不需要迁移也不用 bump 版本
      return { ...empty, ...raw, shortId: raw.shortId ?? null }
    } catch {
      return empty
    }
  }

  loadOrCreateDevice(): DeviceIdentity {
    mkdirSync(this.dir, { recursive: true })
    const meta = this.readMeta()
    const ss = this.sealerIfAvailable()

    if (existsSync(this.keyPath)) {
      try {
        const raw = readFileSync(this.keyPath)
        const pem = meta.encrypted && ss ? ss.decryptString(raw) : raw.toString('utf8')
        const privateKey = createPrivateKey(pem)
        const publicKey = createPublicKey(privateKey)
        return {
          keypair: { privateKey, publicKey, rawPub: pubToRaw(publicKey) },
          deviceId: meta.deviceId,
          accountId: meta.accountId,
          email: meta.email,
          shortId: meta.shortId,
          encrypted: meta.encrypted
        }
      } catch {
        // 密钥读不出来（换了 OS 用户、safeStorage 失效、文件损坏）——只能重新生成。
        // 后果是这台机器要重新走一次"新设备需老设备确认"，数据不会丢。
        try {
          unlinkSync(this.keyPath)
        } catch {
          /* 忽略 */
        }
      }
    }

    const kp = newKeypair()
    const pem = kp.privateKey.export({ format: 'pem', type: 'pkcs8' }).toString()
    const encrypted = !!ss
    writeAtomic(this.keyPath, encrypted && ss ? ss.encryptString(pem) : pem)
    const fresh: Meta = { deviceId: null, accountId: null, email: null, shortId: null, encrypted }
    writeAtomic(this.metaPath, JSON.stringify(fresh, null, 2))
    return { keypair: kp, ...fresh }
  }

  saveDeviceBinding(patch: DeviceBindingPatch): void {
    const meta = { ...this.readMeta(), ...patch }
    writeAtomic(this.metaPath, JSON.stringify(meta, null, 2))
  }

  clearDeviceBinding(): void {
    this.saveDeviceBinding({ deviceId: null, accountId: null, email: null, shortId: null })
  }

  resetDevice(): void {
    for (const p of [this.keyPath, this.metaPath]) {
      try {
        unlinkSync(p)
      } catch {
        /* 本来就不存在 */
      }
    }
  }

  isCacheAvailable(): boolean {
    return this.sealerIfAvailable() !== null
  }

  cacheMasterKey(MK: Buffer): boolean {
    return this.cacheSecret(this.mkPath, MK)
  }

  loadMasterKey(): Buffer | null {
    return this.loadSecret(this.mkPath)
  }

  clearMasterKey(): void {
    this.clearSecret(this.mkPath)
  }

  cacheIdentityKey(rawPriv: Buffer): boolean {
    return this.cacheSecret(this.identPath, rawPriv)
  }

  loadIdentityKey(): Buffer | null {
    return this.loadSecret(this.identPath)
  }

  clearIdentityKey(): void {
    this.clearSecret(this.identPath)
  }

  /** 32 字节密钥的加密缓存：不可用时静默不写。 */
  private cacheSecret(path: string, secret: Buffer): boolean {
    const ss = this.sealerIfAvailable()
    if (!ss) return false
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, ss.encryptString(secret.toString('base64')))
      return true
    } catch {
      return false
    }
  }

  /** 没缓存、解不开（换了机器/换了系统账户）、文件坏了 —— 一律返回 null。 */
  private loadSecret(path: string): Buffer | null {
    const ss = this.sealerIfAvailable()
    if (!ss) return null
    if (!existsSync(path)) return null
    try {
      const raw = Buffer.from(ss.decryptString(readFileSync(path)), 'base64')
      return raw.length === 32 ? raw : null
    } catch {
      return null
    }
  }

  private clearSecret(path: string): void {
    try {
      rmSync(path, { force: true })
    } catch {
      /* best-effort */
    }
  }
}
