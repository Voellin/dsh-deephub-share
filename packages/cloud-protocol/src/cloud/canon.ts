/**
 * 请求目标校验 + 待签字节构造。
 *
 * ⚠️ **本文件必须与服务端的对应实现逐字节等价。**
 * 差一个字节 = 全部请求 401，而服务端刻意不区分失败原因（只回 `unauthorized`），
 * 极难排查。改动任何一处都要重跑两端的交叉校验。
 *
 * 设计上**不做路径归一化**：客户端签什么字节，服务端就验什么字节。
 * 归一化需要两端各写一套实现并"保证一致"，那是长期 bug 温床。
 * 任何中间环节改写了 URI，签名自然失败——这是正确行为，不是 bug。
 */

const TARGET_MAX = 2048

/** RFC 3986 允许出现在 path/query 的字符 + `%`。这条白名单顺带挡掉 CR/LF/NUL/空格/非 ASCII。 */
const TARGET_OK = /^[A-Za-z0-9\-._~!$&'()*+,;=:@/?%[\]]+$/

export class BadTarget extends Error {
  readonly why: string
  constructor(why: string) {
    super('bad_target:' + why)
    this.why = why
  }
}

/** 校验并原样返回。非 ASCII 必须由调用方自己百分号编码好。 */
export function assertTarget(t: string): string {
  if (typeof t !== 'string') throw new BadTarget('not_string')
  if (t.length === 0) throw new BadTarget('empty')
  if (t.length > TARGET_MAX) throw new BadTarget('too_long')
  if (!t.startsWith('/')) throw new BadTarget('must_start_with_slash')
  if (!TARGET_OK.test(t)) throw new BadTarget('illegal_char')
  for (let i = t.indexOf('%'); i !== -1; i = t.indexOf('%', i + 1)) {
    if (!/^[0-9A-Fa-f]{2}$/.test(t.slice(i + 1, i + 3))) throw new BadTarget('bad_pct')
  }
  return t
}

/** 长度前缀（4 字节大端）。让任何字段内容都无法伪造出另一种合法切分。 */
function lp(x: Buffer | string): Buffer[] {
  const b = Buffer.isBuffer(x) ? x : Buffer.from(String(x), 'utf8')
  const n = Buffer.allocUnsafe(4)
  n.writeUInt32BE(b.length)
  return [n, b]
}

const u64 = (v: number): Buffer => {
  const b = Buffer.allocUnsafe(8)
  b.writeBigUInt64BE(BigInt(v))
  return b
}
const u16 = (v: number): Buffer => {
  const b = Buffer.allocUnsafe(2)
  b.writeUInt16BE(v)
  return b
}

export interface RequestSignInput {
  host: string
  method: string
  target: string
  /** enroll 模式传空串 */
  deviceId: string
  bodyHash: Buffer
  ts: number
  nonce: Buffer
}

export function requestSigningBytes(i: RequestSignInput): Buffer {
  assertTarget(i.target)
  if (!Buffer.isBuffer(i.bodyHash) || i.bodyHash.length !== 32) throw new Error('bodyHash 必须是 32 字节')
  if (!Buffer.isBuffer(i.nonce) || i.nonce.length !== 16) throw new Error('nonce 必须是 16 字节')
  return Buffer.concat([
    Buffer.from('DH-SIGN-V1', 'utf8'),
    ...lp(i.host),
    ...lp(i.method.toUpperCase()),
    ...lp(i.target),
    ...lp(i.deviceId || ''),
    ...lp(i.bodyHash),
    ...lp(u64(i.ts)),
    ...lp(i.nonce)
  ])
}

/** 绑请求 nonce：nonce 由客户端随机生成，攻击者无法预置，所以旧响应重放不了。 */
export function responseSigningBytes(i: { nonce: Buffer; status: number; bodyHash: Buffer }): Buffer {
  return Buffer.concat([
    Buffer.from('DH-RESP-V1', 'utf8'),
    ...lp(i.nonce),
    ...lp(u16(i.status)),
    ...lp(i.bodyHash)
  ])
}
