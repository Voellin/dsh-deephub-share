import { createHash, createPublicKey, generateKeyPairSync, sign as nodeSign, verify as nodeVerify } from 'node:crypto'
import type { KeyObject } from 'node:crypto'

/**
 * Ed25519 签验。
 *
 * 两把不同用途的密钥，别混：
 * - **设备密钥**：客户端自己生成，私钥永不离开本机（见 `keystore.ts`），用来签**请求**。
 *   它让 `authKey` 日常完全不出网 —— 只在注册/新设备登录/改密码时才上传一次。
 * - **服务器公钥**：硬编码在 `client.ts`，用来验**响应**。与 TLS 证书无关，
 *   证书怎么轮换都影响不到它。
 */

/** Ed25519 公钥的 SPKI DER 前缀，用于 32 字节裸公钥 ↔ KeyObject 互转 */
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex')

export interface Keypair {
  publicKey: KeyObject
  privateKey: KeyObject
  /** 32 字节裸公钥，上传给服务端 */
  rawPub: Buffer
}

export function newKeypair(): Keypair {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  return { publicKey, privateKey, rawPub: pubToRaw(publicKey) }
}

export const pubToRaw = (pub: KeyObject): Buffer =>
  Buffer.from(pub.export({ format: 'der', type: 'spki' })).subarray(-32)

export function rawToPub(raw: Buffer): KeyObject {
  if (!Buffer.isBuffer(raw) || raw.length !== 32) throw new Error('公钥必须是 32 字节')
  return createPublicKey({ key: Buffer.concat([SPKI_ED25519, raw]), format: 'der', type: 'spki' })
}

export const sha256 = (b?: Buffer): Buffer => createHash('sha256').update(b ?? Buffer.alloc(0)).digest()

export const sign = (priv: KeyObject, bytes: Buffer): Buffer => nodeSign(null, bytes, priv)

/** 验签失败一律返回 false，不抛错——调用方据此判定，不需要区分失败原因。 */
export function verify(pub: KeyObject, bytes: Buffer, sig: Buffer): boolean {
  try {
    return nodeVerify(null, bytes, pub, sig)
  } catch {
    return false
  }
}
