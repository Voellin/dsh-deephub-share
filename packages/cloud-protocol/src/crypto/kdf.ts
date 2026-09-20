import { hkdfSync, randomBytes, scryptSync } from 'node:crypto'

/**
 * 零知识密钥派生。
 *
 * 密码 ──scrypt──▶ master ──HKDF 双分叉──▶ authKey（上传，服务端再加盐 hash 后存）
 *                                      └─▶ KEK（永不离开本机，只用来裹主密钥 MK）
 *
 * 服务器只见 authKey，见不到密码，也就永远派生不出 KEK —— 这是"零知识"成立的前提。
 * 一旦改成把密码提交给服务器，零知识立刻变成假的。
 */

/** 落库/上传的 KDF 参数。**必须随账号一起存**，否则换机后派生不出同一把钥匙。 */
export interface KdfParams {
  alg: 'scrypt'
  N: number
  r: number
  p: number
  /** base64 */
  salt: string
}

/**
 * N=2^16（64MB）。**这个数是按最弱的目标设备定的，不是按开发机。**
 *
 * 同一账号要在桌面和手机登录同一套数据，KDF 参数必须完全一致，所以只能取
 * 移动端扛得住的档位。一台普通桌面机上的实测：2^16≈170ms / 2^17≈350ms /
 * 2^18≈690ms。2^18 峰值 256MB，iOS 上大概率被系统杀掉，故不取。
 *
 * 参数随账号存在服务端，将来可给新用户提档、老用户改密码时顺带升级。
 */
export const KDF_N = 1 << 16
export const KDF_R = 8
export const KDF_P = 1
export const KEY_BYTES = 32

/**
 * Node 的 `crypto.scrypt` 默认 maxmem 只有 32MB，而 scrypt 需要 128*N*r 字节
 * （N=2^16,r=8 → 64MB），不显式放开会直接抛错。留 1.5 倍余量。
 */
const maxmemFor = (N: number, r: number): number => Math.ceil(128 * N * r * 1.5)

/** HKDF info 串。**改动任何一个都等于换密钥版本**，老数据将解不开。 */
export const INFO_AUTH = 'dh-auth-v1'
export const INFO_KEK = 'dh-kek-v1'
export const INFO_RECOVERY = 'dh-recovery-v1'
export const INFO_MK_VERIFIER = 'dh-mk-verifier-v1'

export const newSalt = (bytes = 16): Buffer => randomBytes(bytes)

export function defaultKdfParams(salt?: Buffer): KdfParams {
  return { alg: 'scrypt', N: KDF_N, r: KDF_R, p: KDF_P, salt: (salt ?? newSalt()).toString('base64') }
}

/** 密码 + 参数 → master。慢是故意的（这是抗离线爆破的唯一屏障）。 */
export function deriveMaster(password: string, params: KdfParams): Buffer {
  if (params.alg !== 'scrypt') throw new Error(`不支持的 KDF: ${params.alg}`)
  const salt = Buffer.from(params.salt, 'base64')
  return scryptSync(Buffer.from(password, 'utf8'), salt, KEY_BYTES, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: maxmemFor(params.N, params.r)
  })
}

export function hkdf(ikm: Buffer, salt: Buffer, info: string, len = KEY_BYTES): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from(info, 'utf8'), len))
}

/** 上传给服务端的登录凭证。服务端拿到它也推不出 KEK。 */
export function deriveAuthKey(master: Buffer, params: KdfParams): Buffer {
  return hkdf(master, Buffer.from(params.salt, 'base64'), INFO_AUTH)
}

/** 裹主密钥用的钥匙。**永不离开本机。** */
export function deriveKek(master: Buffer, params: KdfParams): Buffer {
  return hkdf(master, Buffer.from(params.salt, 'base64'), INFO_KEK)
}

/**
 * MK 验证子：向服务端证明「我确实解出了主密钥」，而不泄露主密钥本身。
 *
 * 为什么需要它：`recovery/set-password` 以前只凭一次性重置票
 * 就覆写密码凭证，而那张票的唯一来源是邮箱验证码 —— **能读到你邮箱的人就能换掉你的
 * 密码凭证**。恢复流程本该等价于「持有邮箱 + 持有恢复码」，但服务端从头到尾没有
 * 要求证明后半句。验证子补的就是后半句。
 *
 * **只依赖 MK，不掺密码、不掺 authKey。** 恢复流程里客户端手上只有刚用恢复码解开的
 * MK，别的什么都没有；掺进任何一样，恢复流程就算不出这个值，这条修复也就不成立。
 *
 * **salt 取空是有意的。** HKDF 的 salt 用来给低熵 ikm 补随机性，而 MK 本身就是
 * 32 字节均匀随机，补无可补；取空还顺带保证「同一个 MK 一生只有一个验证子」，
 * 不需要服务端把盐发回来（发回来就等于多一个可被枚举的账号存在性探针）。
 *
 * **MK 一生不变**（注册时随机生成一次，改密码只是换一层包裹），所以验证子也一生
 * 不变，不需要轮换。服务端存的是它的加盐 HMAC，与 authHash 完全同一套。
 *
 * 不削弱零知识：256 bit 随机值的验证子不构成爆破靶子；HKDF 单向，拿到验证子推不回
 * MK，也解不开任何一个信封。
 */
export function deriveMkVerifier(MK: Buffer): Buffer {
  if (!Buffer.isBuffer(MK) || MK.length !== KEY_BYTES) throw new Error('MK 必须是 32 字节')
  return hkdf(MK, Buffer.alloc(0), INFO_MK_VERIFIER)
}
