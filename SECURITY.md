# Security Policy

**Full policy: <https://deephub.cyou/security>** — threat model, key hierarchy, algorithms and parameters, and local key storage.

**完整版在 <https://deephub.cyou/security>**：威胁模型、密钥层次、算法与参数、本机密钥怎么存。

## Reporting a vulnerability · 报告漏洞

Email **`voellin@yeah.net`** with the affected version, reproduction steps, and the impact you believe it has. **Please do not open a public issue.**

请发邮件到 **`voellin@yeah.net`**，写清受影响的版本、复现步骤、你认为的影响。**不要开公开 issue。**

| Stage · 环节 | Target · 时限 |
|---|---|
| Acknowledgement · 收到确认 | 2 business days · 2 个工作日 |
| Triage · 分级与初步结论 | 7 days · 7 天 |
| Fix shipped · 修复上线 | 90 days for confirmed issues · 已确认问题 90 天内 |

**The server is not open source** — testing necessarily goes against the live `deephub.cyou`. Use your own accounts only; do not access other users' data; do not run denial-of-service or load tests.

**服务端不开源**——测试只能打在线上的 `deephub.cyou`。请只用**自己的账号**；不要碰别人的数据；不要做压力测试或拒绝服务测试。

客户端协议实现在 `packages/cloud-protocol`，`CloudClient` 的 `baseUrl` / `serverPubRaw` 两个构造参数可以把它指向你自己的服务端。

## Key handling · 如何处理密钥

The plugin runs inside DeepSeek Harness, where the desktop client's `safeStorage` is not available. All four key records live in dsh's own credential store — the same file and the same permissions as dsh's model API key:

插件跑在 DeepSeek Harness 里，没有客户端的 `safeStorage` 可用。四条密钥记录全部存进 dsh 自己的凭据存储，与 dsh 的模型 API key 同一个文件、同一把锁：

| Record in `$DSH_HOME/.credentials.yaml` · 记录 | Contents · 内容 | Protection · 保护 |
|---|---|---|
| `deephub-share/device` | Device Ed25519 private key · 设备签名私钥 | **Plaintext** · **明文**，0600 |
| `deephub-share/master-key` | Cached master key, for password-less startup · 主密钥缓存，免密启动用 | **Plaintext** · **明文**，0600 |
| `deephub-share/identity` | Account X25519 private key · 账号身份私钥 | **Plaintext** · **明文**，0600 |
| `deephub-share/binding` | Device id, account id, email, short ID · 设备 id、账号 id、邮箱、短 ID | Plaintext, no secrets · 明文，不含密钥 |

## Scope · 适用范围

In scope: everything in this repository — the protocol client (`packages/cloud-protocol`) and the dsh plugin (`packages/dsh-deephub-share`) — plus the DeepHub server's handling of what they send it.
Out of scope: DeepSeek Harness itself, the DeepSeek model API, and other dsh plugins.

范围内：本仓库的全部内容——协议客户端（`packages/cloud-protocol`）与 dsh 插件（`packages/dsh-deephub-share`），以及 DeepHub 服务端对它们所发内容的处理。
范围外：DeepSeek Harness 本身、DeepSeek 模型 API、其它 dsh 插件。
