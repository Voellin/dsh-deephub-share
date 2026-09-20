/**
 * @deephub/cloud-protocol —— DeepHub 云端协议的客户端实现，桌面端与 dsh 插件共用。
 *
 * 分层：
 *   cloud/canon    待签字节构造。**必须与服务端的对应实现逐字节等价**
 *   cloud/sign     Ed25519 签验
 *   cloud/client   签名 HTTP 客户端 + 响应验签规则
 *   cloud/account  注册/登录/恢复/改密码，组合 `crypto/` 与 client
 *   cloud/identity 账号级 X25519 身份密钥
 *   cloud/social   朋友关系
 *   cloud/delivery 思路投递（端到端加密）
 *   cloud/service  上面几件的持有者；MK 与恢复码只在这里
 *   crypto/*       KDF、信封、账号密钥运算、恢复码
 *   keystore       宿主注入的本机密钥存取（接口 + 文件实现）
 *
 * 三条不变量：
 * 1. **密码与主密钥 MK 永不离开本机**，上传的只有 `sha256(authKey)` 和服务器解不开的信封。
 * 2. **离线是常态**：所有云端调用都可能抛 `CloudTransportError`，调用方必须能安静降级。
 * 3. **2xx 无合法签名 = 攻击**，直接中断；非 2xx 无签名只当传输故障，永不作为业务结论。
 */

export type {
  CloudStatus,
  CloudFailKind,
  CloudFail,
  CloudResult,
  CloudSyncStatus,
  CloudDevice,
  CloudPendingApproval
} from './types'

export { FileKeyStore, type KeyStore, type Sealer, type DeviceIdentity, type DeviceBindingPatch } from './keystore'

export { assertTarget, requestSigningBytes, responseSigningBytes, BadTarget } from './cloud/canon'
export { newKeypair, pubToRaw, rawToPub, sha256, sign, verify, type Keypair } from './cloud/sign'
export {
  CloudClient,
  CloudApiError,
  CloudTransportError,
  CloudSecurityError,
  CloudAbortedError,
  CLOUD_HOST,
  TLS_PINS,
  type CallOptions
} from './cloud/client'
export { CloudAccount, type CloudSession } from './cloud/account'
export {
  IdentityManager,
  OBJ_TYPE_IDENTITY,
  PURPOSE_IDEA,
  identityObjId,
  sharedKey,
  readIdentity,
  type IdentityPayload,
  type ResolvedIdentity
} from './cloud/identity'
export {
  SocialClient,
  parseShortId,
  FRIEND_NOTES_OBJ_ID,
  OBJ_TYPE_FRIEND_NOTES,
  REMARK_MAX,
  type Friend,
  type FriendNotes,
  type IncomingRequest,
  type OutgoingRequest
} from './cloud/social'
export {
  DeliveryClient,
  ATTACH_ONE_MAX,
  ATTACH_TOTAL_MAX,
  type Attachment,
  type DeliveryPayload,
  type InboxItem,
  type ReceivedDelivery
} from './cloud/delivery'
export { CloudService, toFail, type SyncLike } from './cloud/service'

export * from './crypto'

// 协议版本协商：登记簿、协商原语、客户端侧的探测与判定
export { PROTOCOL_VERSION, CLIENT_MIN_SERVER, capabilitiesFor, negotiate, type ProtocolRange, type Negotiation } from './protocol/version'
export { REGISTRY, type ProtocolRegistry } from './protocol/registry'
export { checkProtocol, fetchServerProtocol, parseServerProtocol, shouldNegotiate, type ProtoCheck, type ServerProtocol } from './cloud/protocol'
