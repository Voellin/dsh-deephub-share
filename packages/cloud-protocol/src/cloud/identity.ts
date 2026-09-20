import { createHash, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync } from 'node:crypto'
import type { KeyObject } from 'node:crypto'
import { decryptObject, encryptObject, type EncryptedObject } from '../crypto/envelope'
import type { KeyStore } from '../keystore'
import { CloudApiError } from './client'
import type { CloudService } from './service'

/**
 * **账号级身份密钥（X25519）。**
 *
 * 与设备密钥完全是两回事，别混：
 * - 设备密钥（见 `keystore.ts`）是 Ed25519，**只能签名**，每台机器一把，私钥永不出本机。
 * - 这一把是 X25519，用来做**密钥协商**：朋友用我的公钥包住 DK，我用私钥解开。
 *   它必须**跨机可用**，所以私钥用 MK 裹住当加密对象上云。
 *
 * SPKI / PKCS8 的前缀字节是定死的：改动任何一处，已有的身份密钥都会解不开。
 *
 * ⚠️ X25519 的 OID 是 `1.3.101.110`（`2b656e`），Ed25519 是 `1.3.101.112`（`2b6570`）——
 * **只差一个字节**。照 `sign.ts` 抄前缀最容易死在这里。
 */
const SPKI_X25519 = Buffer.from('302a300506032b656e032100', 'hex')
const PKCS8_X25519 = Buffer.from('302e020100300506032b656e04220420', 'hex')

export const OBJ_TYPE_IDENTITY = 'identity'

/** 当前唯一的用途串。加新用途时**换新串**，别复用——见 `sharedKey` 的注释。 */
export const PURPOSE_IDEA = 'idea-v1'

export interface IdentityPayload {
  v: 1
  alg: 'X25519'
  /** base64 的 32 字节私钥 */
  priv: string
  /** base64 的 32 字节公钥。冗余存一份，纯为可读性；真要用时从私钥推 */
  pub: string
}

export const pubToRaw = (pub: KeyObject): Buffer =>
  Buffer.from(pub.export({ format: 'der', type: 'spki' })).subarray(-32)

export const privToRaw = (priv: KeyObject): Buffer =>
  Buffer.from(priv.export({ format: 'der', type: 'pkcs8' })).subarray(-32)

export function rawToPub(raw: Buffer): KeyObject {
  if (!Buffer.isBuffer(raw) || raw.length !== 32) throw new Error('公钥必须是 32 字节')
  return createPublicKey({ key: Buffer.concat([SPKI_X25519, raw]), format: 'der', type: 'spki' })
}

export function rawToPriv(raw: Buffer): KeyObject {
  if (!Buffer.isBuffer(raw) || raw.length !== 32) throw new Error('私钥必须是 32 字节')
  return createPrivateKey({ key: Buffer.concat([PKCS8_X25519, raw]), format: 'der', type: 'pkcs8' })
}

/**
 * 与某个朋友的共享密钥。
 *
 * 三件事一件都不能省：
 * - **必须过 HKDF**：ECDH 的原始输出不是均匀分布、也不带上下文，不能直接当 AES 密钥。
 * - **info 里写进双方公钥**：身份绑定，否则同一把密钥可能被张冠李戴到别的对手身上。
 * - **两把公钥按字节序排序**：这样 A→B 与 B→A 推出同一把，不用约定谁是发起方。
 */
export function sharedKey(myPriv: KeyObject, theirRawPub: Buffer, purpose = PURPOSE_IDEA): Buffer {
  const secret = diffieHellman({ privateKey: myPriv, publicKey: rawToPub(theirRawPub) })
  const mine = pubToRaw(createPublicKey(myPriv))
  const pair = [mine, theirRawPub].sort(Buffer.compare)
  const info = Buffer.concat([Buffer.from(`deephub|${purpose}|`, 'utf8'), pair[0], pair[1]])
  return Buffer.from(hkdfSync('sha256', secret, Buffer.alloc(0), info, 32))
}

/**
 * 对象 id 里带公钥指纹。
 *
 * 为什么不用固定的 `'identity'`：两台机器同时首次登录会各自生成一把，固定 id 意味着
 * 后写的那台**覆盖**前一台的私钥密文，而服务端的 `friend_pub` 是先到先得不可替换的——
 * 于是云上留着 B 的私钥、服务端登记着 A 的公钥，朋友加密给 A，谁都解不开。
 * 指纹进 id 之后两个对象各自存在，服务端的公钥说了算，输的那份只是一小块垃圾。
 */
export const identityObjId = (rawPub: Buffer): string =>
  'id_' + createHash('sha256').update(rawPub).digest('hex').slice(0, 16)

export interface ResolvedIdentity {
  rawPub: Buffer
  privateKey: KeyObject
}

/**
 * 身份密钥的持有者。**私钥只在这里，不经过 IPC**（沿用 `service.ts` 的边界）。
 *
 * 生成时机：**登录后就办**，不等用户点进朋友页。
 */
export class IdentityManager {
  private resolved: ResolvedIdentity | null = null
  /** 从云端拉下来的候选：公钥指纹 → 私钥。哪一把作数由服务端的 friend_pub 决定 */
  private candidates = new Map<string, Buffer>()
  private working = false

  constructor(
    private readonly svc: CloudService,
    /** 本机缓存走宿主注入的 KeyStore（与 MK 同一处） */
    private readonly store: KeyStore
  ) {}

  /** 同步器每拉到一个 identity 对象就喂进来。 */
  offer(payload: unknown): void {
    const p = payload as IdentityPayload | null
    if (!p || p.v !== 1 || p.alg !== 'X25519' || typeof p.priv !== 'string') return
    let raw: Buffer
    try { raw = Buffer.from(p.priv, 'base64') } catch { return }
    if (raw.length !== 32) return
    try {
      const pub = pubToRaw(createPublicKey(rawToPriv(raw)))
      this.candidates.set(pub.toString('hex'), raw)
    } catch { /* 坏数据丢掉，不影响别的对象 */ }
  }

  current(): ResolvedIdentity | null {
    return this.resolved
  }

  /**
   * 确保这个账号有一把可用的身份密钥。幂等，可以随便多调。
   *
   * 顺序是刻意的：**先把私钥密文放上云，再去认领公钥**。反过来的话，认领成功却在
   * 上传前崩掉 = 服务端登记了一把谁也没有私钥的公钥，而 `friend_pub` 不可替换，
   * 这个账号的朋友功能就永久废了。
   */
  async ensure(): Promise<ResolvedIdentity | null> {
    if (this.resolved) return this.resolved
    if (this.working) return null
    const MK = this.svc.masterKey()
    const deviceId = this.svc.status().deviceId
    if (!MK || !deviceId) return null

    // ★ 先看本机缓存。**重启之后就靠它**，不联网也能用。
    const cached = this.store.loadIdentityKey()
    if (cached) {
      try {
        const priv = rawToPriv(cached)
        this.resolved = { rawPub: pubToRaw(createPublicKey(priv)), privateKey: priv }
        return this.resolved
      } catch { this.store.clearIdentityKey() }   // 坏了就当没有，下面重新认领
    }

    this.working = true
    try {
      const mine = await this.svc.account.api.call<{ friend_pub: string | null }>({
        method: 'GET', target: '/api/v1/social/identity', deviceId
      })

      // 服务端已经登记过公钥：只认那一把
      if (mine.friend_pub) {
        const want = Buffer.from(mine.friend_pub, 'base64')
        let priv: Buffer | null | undefined = this.candidates.get(want.toString('hex'))
        if (!priv) {
          /**
           * 同步流里没有它 —— 这是**常态**而不是异常：对象只在游标推进时送一次，
           * 第二次启动游标早过去了。所以按公钥指纹算出对象 id **点对点直取**。
           * （指纹进 id 本是为了防两台机器互相覆盖，这里白捡了第二个用处。）
           */
          priv = await this.fetchByFingerprint(want, MK, deviceId)
        }
        if (!priv) return null
        this.resolved = { rawPub: want, privateKey: rawToPriv(priv) }
        this.store.cacheIdentityKey(priv)
        return this.resolved
      }

      // 还没有：生成一把，先存私钥再认领
      const { publicKey, privateKey } = generateKeyPairSync('x25519')
      const rawPub = pubToRaw(publicKey)
      const rawPriv = privToRaw(privateKey)
      const objId = identityObjId(rawPub)
      const payload: IdentityPayload = {
        v: 1, alg: 'X25519', priv: rawPriv.toString('base64'), pub: rawPub.toString('base64')
      }
      const env: EncryptedObject = encryptObject(MK, objId, OBJ_TYPE_IDENTITY, payload, {
        version: 1, updatedAt: Math.floor(Date.now() / 1000)
      })
      await this.svc.account.api.call({
        method: 'PUT', target: `/api/v1/objects/${objId}`, deviceId, body: env
      })
      this.candidates.set(rawPub.toString('hex'), rawPriv)

      try {
        await this.svc.account.api.call({
          method: 'PUT', target: '/api/v1/social/identity', deviceId,
          body: { friend_pub: rawPub.toString('base64') }
        })
      } catch (e) {
        // 409 = 另一台设备先认领了。放弃自己这把，认服务端那把（下一轮 ensure 会捡起来）
        if (e instanceof CloudApiError && e.status === 409) return null
        throw e
      }
      this.resolved = { rawPub, privateKey }
      this.store.cacheIdentityKey(rawPriv)
      return this.resolved
    } finally {
      this.working = false
    }
  }

  /**
   * 按公钥指纹直接取那一个对象。
   *
   * 404 = 服务端登记着一把公钥，但对应的私钥密文不在了。这时该账号的朋友功能其实
   * 已经废了（`friend_pub` 不可静默替换）——**明确报出来，不要静默返回 null**
   * 让用户对着一句莫名其妙的提示猜。
   */
  private async fetchByFingerprint(rawPub: Buffer, MK: Buffer, deviceId: string): Promise<Buffer | null> {
    const objId = identityObjId(rawPub)
    try {
      const env = await this.svc.account.api.call<EncryptedObject>({
        method: 'GET', target: `/api/v1/objects/${objId}`, deviceId
      })
      const p = decryptObject<IdentityPayload>(MK, env)
      const raw = Buffer.from(p.priv, 'base64')
      if (raw.length !== 32) return null
      this.candidates.set(rawPub.toString('hex'), raw)
      return raw
    } catch (e) {
      if (e instanceof CloudApiError && e.status === 404) {
        console.error(`[identity] 服务端登记的公钥对应的私钥密文不存在（${objId}）——本账号无法收发思路`)
      }
      return null
    }
  }

  /** 登出时清干净：私钥不留在内存里等下一个账号。 */
  reset(): void {
    this.resolved = null
    this.candidates.clear()
    this.store.clearIdentityKey()      // 换账号绝不能留着上一个账号的私钥
  }
}

/** 给测试用：从密文里解出身份（生产路径不用，正常走 IdentityManager）。 */
export function readIdentity(MK: Buffer, rec: EncryptedObject): ResolvedIdentity {
  const p = decryptObject<IdentityPayload>(MK, rec)
  const priv = rawToPriv(Buffer.from(p.priv, 'base64'))
  return { rawPub: pubToRaw(createPublicKey(priv)), privateKey: priv }
}
