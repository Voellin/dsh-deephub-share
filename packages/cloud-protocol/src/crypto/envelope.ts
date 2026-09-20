import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

/**
 * 信封加密：每个对象一把随机数据钥匙 DK，DK 再被主密钥 MK 裹起来。
 *
 * 这样改密码时只需重裹 MK（见 account.changePassword），几百 GB 数据一个字节都不用重传。
 * 全部用 AES-256-GCM —— 它自带认证，密文被改一个 bit 解密就会抛错。
 */

/** 一个 AES-256-GCM 密文盒子，三段都是 base64。 */
export interface Box {
  iv: string
  ct: string
  tag: string
}

/** 落库/上传的加密对象。**服务端只见得到这个结构。** */
export interface EncryptedObject {
  id: string
  /** conversation / schedule / memory / experience / settings / idea … */
  type: string
  /**
   * 密钥体系标识。当前只有 'zk-v1'（纯零知识）。
   * 预留这个字段是为了将来万一要引入别的体系时不用改表结构。
   */
  keyScheme: 'zk-v1'
  /** 信封格式版本 */
  v: 1
  alg: 'A256GCM'
  iv: string
  ct: string
  tag: string
  /** DK 被 MK 裹起来的样子 */
  wrappedDK: Box
  /** 业务版本号，可变对象冲突消解用 */
  version: number
  updated_at: number
}

const IV_BYTES = 12

export function seal(key: Buffer, plaintext: Buffer, aad?: string): Box {
  const iv = randomBytes(IV_BYTES)
  const c = createCipheriv('aes-256-gcm', key, iv)
  if (aad) c.setAAD(Buffer.from(aad, 'utf8'))
  const ct = Buffer.concat([c.update(plaintext), c.final()])
  return { iv: iv.toString('base64'), ct: ct.toString('base64'), tag: c.getAuthTag().toString('base64') }
}

/** 解封。密钥不对、密文被改、AAD 不匹配——三种情况都在这里抛错，不区分（不给攻击者信息）。 */
export function open(key: Buffer, box: Box, aad?: string): Buffer {
  const d = createDecipheriv('aes-256-gcm', key, Buffer.from(box.iv, 'base64'))
  if (aad) d.setAAD(Buffer.from(aad, 'utf8'))
  d.setAuthTag(Buffer.from(box.tag, 'base64'))
  return Buffer.concat([d.update(Buffer.from(box.ct, 'base64')), d.final()])
}

/**
 * AAD 绑定对象元数据，防止密文被张冠李戴——
 * 把 A 会话的密文塞进 B 会话的记录里，解密会失败而不是悄悄成功。
 */
const aadFor = (id: string, type: string, keyScheme: string): string => `${id}|${type}|${keyScheme}`

export function encryptObject(
  MK: Buffer,
  id: string,
  type: string,
  payload: unknown,
  opts: { version?: number; updatedAt?: number } = {}
): EncryptedObject {
  const DK = randomBytes(32)
  const body = seal(DK, Buffer.from(JSON.stringify(payload), 'utf8'), aadFor(id, type, 'zk-v1'))
  return {
    id,
    type,
    keyScheme: 'zk-v1',
    v: 1,
    alg: 'A256GCM',
    iv: body.iv,
    ct: body.ct,
    tag: body.tag,
    wrappedDK: seal(MK, DK),
    version: opts.version ?? 1,
    updated_at: opts.updatedAt ?? 0
  }
}

export function decryptObject<T = unknown>(MK: Buffer, rec: EncryptedObject): T {
  if (rec.keyScheme !== 'zk-v1') throw new Error(`不认识的 keyScheme: ${rec.keyScheme}`)
  const DK = open(MK, rec.wrappedDK)
  const plain = open(DK, { iv: rec.iv, ct: rec.ct, tag: rec.tag }, aadFor(rec.id, rec.type, rec.keyScheme))
  return JSON.parse(plain.toString('utf8')) as T
}
