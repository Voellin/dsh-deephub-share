/**
 * DeepHub 零知识密钥体系。
 *
 * 一句话：**密码和主密钥都不离开本机，服务器只保管解不开的密文。**
 *
 * 改动 `INFO_*` 常量、`keyScheme` 值或信封字段，等同于换密钥版本，老数据将解不开。
 */
export {
  defaultKdfParams,
  deriveAuthKey,
  deriveKek,
  deriveMaster,
  deriveMkVerifier,
  hkdf,
  newSalt,
  INFO_AUTH,
  INFO_KEK,
  INFO_MK_VERIFIER,
  INFO_RECOVERY,
  KDF_N,
  KDF_P,
  KDF_R,
  type KdfParams
} from './kdf'

export {
  decryptObject,
  encryptObject,
  open,
  seal,
  type Box,
  type EncryptedObject
} from './envelope'

export {
  newRecoveryCode,
  parseRecoveryCode,
  RECOVERY_CODE_LENGTH,
  type RecoveryCode
} from './recovery'

export {
  authHashForPassword,
  changePassword,
  login,
  loginWithRecovery,
  register,
  rewrapForNewPassword,
  rotateRecovery,
  type RegisterResult,
  type ServerAccountBlob,
  type UnlockResult
} from './account'

