# @deephub/cloud-protocol

DeepHub 云端协议的客户端实现。**这是正本**——DeepHub 桌面端、dsh 插件 `dsh-deephub-share`
以及将来任何一个消费者，引用的都是这一份源码。

| 目录 | 内容 |
|---|---|
| `src/cloud/canon.ts` | 待签字节构造。**必须与服务端的对应实现逐字节等价**，改动任何一边都需同步 |
| `src/cloud/sign.ts` `client.ts` | Ed25519 请求签名与响应验签；服务器签名公钥与 TLS pin 值硬编码在 `client.ts`（pin 当前不强制校验） |
| `src/cloud/account.ts` | 注册、登录、恢复、改密码、重新生成恢复码 |
| `src/cloud/identity.ts` | 账号级 X25519 身份密钥（先上传私钥密文，再认领公钥） |
| `src/cloud/social.ts` | 朋友：按短 ID 发起请求、接受与拒绝、列表、更换短 ID |
| `src/cloud/delivery.ts` | 思路投递：随机 DK、AES-256-GCM、`wrappedDK = seal(sharedKey(本方私钥, 对方公钥), DK)`；附件合计 ≤ 15 MB |
| `src/cloud/service.ts` | `CloudService`：MK 与恢复码仅存在于此，永不经过 IPC |
| `src/crypto/*` | scrypt + HKDF 派生、信封、账号密钥运算、恢复码 |
| `src/keystore.ts` | `KeyStore` 接口（11 个方法）与 `FileKeyStore`（可注入 `Sealer`） |

## 宿主接入

```ts
import { CloudService, FileKeyStore, type Sealer } from '@deephub/cloud-protocol'

// 宿主具备操作系统级封装能力时注入 Sealer（桌面端使用 Electron safeStorage）
const svc = new CloudService(new FileKeyStore(userDataDir, mySealer()))
// 不注入 Sealer：设备密钥以 0600 明文落盘，主密钥与身份私钥不缓存
// baseUrl / serverPubRaw 指向自行实现的服务端；两者均不传即为生产路径
const svc2 = new CloudService(new FileKeyStore(dir), { baseUrl, serverPubRaw })
```

同步器（云端对象同步）由宿主实现，通过 `attachSync(engine)` 注入，满足 `SyncLike` 即可。

## 发布形态

协议客户端与 DeepHub 服务端必须同时演进，无法对第三方承诺稳定接口，因此不发布为 npm 包。
本包在这里是**可读、可审计、不可安装**的。

消费者以**源码**方式引用：同仓的插件走 npm workspaces，闭源的桌面端走 `tsconfig` 的 `paths`
与打包器的 `alias`，构建时整包内联，不经过 node_modules。`main` 直接指向 `src/index.ts`，
没有 `lib/` 构建步骤，由消费方自行编译。

协议演进方式详见 [PROTOCOL.md](PROTOCOL.md)。

## 许可

MIT
