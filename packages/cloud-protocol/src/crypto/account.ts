import { createHash, randomBytes } from 'node:crypto'
import {
  defaultKdfParams,
  deriveAuthKey,
  deriveKek,
  deriveMaster,
  hkdf,
  INFO_RECOVERY,
  newSalt,
  type KdfParams
} from './kdf'
import { open, seal, type Box } from './envelope'
import { newRecoveryCode, parseRecoveryCode } from './recovery'

/**
 * 账号级密钥流程：注册 / 登录 / 恢复码登录 / 改密码。
 *
 * 贯穿的一条原则：**密码和主密钥 MK 都不离开本机**，
 * 上传给服务端的只有 `ServerAccountBlob` 这一坨，里面没有一样东西能反推出明文。
 */

/** 服务端保管的全部密钥材料。拖库拿到的就是这些。 */
export interface ServerAccountBlob {
  kdf: KdfParams
  /** sha256(authKey) 的 base64。服务端入库时还会再加自己的盐，这里只是客户端侧的形态。 */
  authHash: string
  /** MK 被"密码派生的 KEK"裹起来 */
  wrapped_MK_pwd: Box
  /** MK 被"恢复码派生的 KEK"裹起来 */
  recovery: { salt: string; wrapped_MK: Box }
}

export interface RegisterResult {
  /** 上传给服务端的那一坨 */
  server: ServerAccountBlob
  /** 主密钥。留在本机，可按需交给 keystore 缓存 */
  MK: Buffer
  /** 登录凭证，上传 */
  authKey: Buffer
  /** 给用户抄写的恢复码（6 组 4 字符）。**只在这一刻出现，之后再也拿不到。** */
  recoveryCode: string
}

export interface UnlockResult {
  MK: Buffer
  authKey: Buffer
}

const authHashOf = (authKey: Buffer): string => createHash('sha256').update(authKey).digest().toString('base64')

export function register(password: string): RegisterResult {
  const kdf = defaultKdfParams()
  const master = deriveMaster(password, kdf)
  const authKey = deriveAuthKey(master, kdf)
  const KEK = deriveKek(master, kdf)

  const MK = randomBytes(32)
  const rec = newRecoveryCode()
  const recSalt = newSalt()
  const recKek = hkdf(rec.raw, recSalt, INFO_RECOVERY)

  return {
    server: {
      kdf,
      authHash: authHashOf(authKey),
      wrapped_MK_pwd: seal(KEK, MK),
      recovery: { salt: recSalt.toString('base64'), wrapped_MK: seal(recKek, MK) }
    },
    MK,
    authKey,
    recoveryCode: rec.pretty
  }
}

/**
 * 登录：只凭密码 + 服务端那一坨，在本机重新解出 MK。
 * 密码不对时抛错（GCM 认证失败），不区分"密码错"和"数据坏"。
 */
export function login(password: string, server: ServerAccountBlob): UnlockResult {
  const master = deriveMaster(password, server.kdf)
  return {
    MK: open(deriveKek(master, server.kdf), server.wrapped_MK_pwd),
    authKey: deriveAuthKey(master, server.kdf)
  }
}

/** 恢复码登录。注意：拿不到 authKey —— 走这条路必须紧接着设置新密码。 */
export function loginWithRecovery(codeInput: string, server: ServerAccountBlob): Buffer {
  const raw = parseRecoveryCode(codeInput)
  const recKek = hkdf(raw, Buffer.from(server.recovery.salt, 'base64'), INFO_RECOVERY)
  return open(recKek, server.recovery.wrapped_MK)
}

/**
 * 改密码 = **只重裹一次 MK**，业务数据一个字节都不用动。
 * 这正是用信封加密（而不是拿密码直接加密数据）的全部意义。
 *
 * 恢复码那一份不受影响，仍然有效。
 */
export function changePassword(
  MK: Buffer,
  newPassword: string
): Pick<ServerAccountBlob, 'kdf' | 'authHash' | 'wrapped_MK_pwd'> & { authKey: Buffer } {
  const kdf = defaultKdfParams()
  const master = deriveMaster(newPassword, kdf)
  const authKey = deriveAuthKey(master, kdf)
  return { kdf, authHash: authHashOf(authKey), wrapped_MK_pwd: seal(deriveKek(master, kdf), MK), authKey }
}

/**
 * 重新生成恢复码：新码 + 新盐重裹一次 MK，其它一个字节不动。
 *
 * 零知识下恢复码是 MK 的唯一副本、不能落盘，所以"注册中途关了软件 / 纸丢了"只有这一条路。
 * 返回的 `recovery` 上传给服务端换掉旧的；**旧恢复码从此作废**。
 * 上传接口要求带当前密码的 authHash（与改密码同强度），由调用方另算。
 */
export function rotateRecovery(MK: Buffer): { recoveryCode: string; recovery: ServerAccountBlob['recovery'] } {
  const rec = newRecoveryCode()
  const recSalt = newSalt()
  const recKek = hkdf(rec.raw, recSalt, INFO_RECOVERY)
  return { recoveryCode: rec.pretty, recovery: { salt: recSalt.toString('base64'), wrapped_MK: seal(recKek, MK) } }
}

/** 当前密码 → authHash（给需要"再输一次密码"的接口用：改密码、重生成恢复码）。 */
export function authHashForPassword(password: string, kdf: KdfParams): string {
  return authHashOf(deriveAuthKey(deriveMaster(password, kdf), kdf))
}

/**
 * 老设备"重裹"：用户在别处走邮箱重置了密码，本机还持有 MK 明文，
 * 于是用新密码重新裹一次 MK 上传 —— 用户全程无感，数据不丢。
 *
 * 这是把"忘密码 = 数据全没"从常态压缩成极小概率三重失败的关键一步。
 */
export const rewrapForNewPassword = changePassword
