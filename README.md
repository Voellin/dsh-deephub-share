# DeepHub · 开放部分

<p align="center">
  <img src="docs/images/architecture.svg" alt="Who uses the protocol" width="100%">
</p>

<p align="center">
  <a href="https://github.com/Voellin/dsh-deephub-share/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/Voellin/dsh-deephub-share/ci.yml?branch=main&style=flat-square&label=CI&logo=githubactions&logoColor=white" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/Voellin/dsh-deephub-share?color=blue&style=flat-square" alt="License"></a>
  <img src="https://img.shields.io/badge/Node-%E2%89%A5%2022.19-339933?logo=node.js&logoColor=white&style=flat-square" alt="Node">
  <img src="https://img.shields.io/badge/TypeScript-5.9-3178C6?logo=typescript&logoColor=white&style=flat-square" alt="TypeScript">
  <img src="https://img.shields.io/badge/cloud--protocol-0%20dependencies-2da44e?style=flat-square" alt="Zero dependencies">
  <a href="https://github.com/Voellin/dsh-deephub-share/stargazers"><img src="https://img.shields.io/github/stars/Voellin/dsh-deephub-share?style=flat-square&color=fa8c16" alt="Stars"></a>
</p>

<p align="center">
  <a href="#功能预览">功能预览</a> ·
  <a href="#密钥体系">密钥体系</a> ·
  <a href="#快速开始">快速开始</a> ·
  <a href="#代码地图">代码地图</a> ·
  <a href="README.en.md">English</a>
</p>

---

## 这是什么

DeepHub 是一个运行在本机的 AI 助手，云端仅作**加密数据的中转**：密码与主密钥永不离开本机，
服务端保存的始终是其自身无法解密的密文。

本仓库包含 DeepHub 中**可由外部验证的部分**：

| 包 | 内容 |
|---|---|
| [`packages/cloud-protocol`](packages/cloud-protocol) | **云端协议客户端**。密钥派生、信封加密、请求与响应签名、账号与投递协议。DeepHub 桌面端与下述插件运行的是**同一份代码**，而非两份相似的实现 |
| [`packages/dsh-deephub-share`](packages/dsh-deephub-share) | **[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）插件**：将一条会话提炼为「思路」，经人工确认脱敏后加密发送给 DeepHub 上的朋友；收到的思路在 dsh 中落为一条新会话 |

**协议是主体，插件是其第一个消费者。**

> Built on DeepSeek Harness；**非 DeepSeek 官方插件**。

---

## 功能预览

### 发送

会话头部新增「分享思路」按钮：

<p align="center"><img src="docs/images/ui-share-button.png" alt="会话头部的「分享思路」按钮" width="100%"></p>

点击后打开一屏对话框，分为五段：**发给谁 / 内容 / 扫描敏感信息 / 附件 / 导出或发送**。

<p align="center"><img src="docs/images/ui-share-modal.png" alt="分享思路对话框" width="80%"></p>

> 初始仅显示标题与记录条数，**点击「整理这条会话」后才调用模型**；导出 Markdown 无需登录；
> 「确认发送」为端到端加密，**对方接收前无法看到内容**。

<p align="center"><img src="docs/images/ui-share-sent.png" alt="已发出" width="55%"></p>

### 接收

侧边栏的「朋友与收件箱」。收件箱**只有元数据**（发件人、大小、附件数、时间），标题位于密文中；
点击「收下」解密，并落为一条新会话：

<p align="center"><img src="docs/images/ui-friends.png" alt="朋友与收件箱" width="90%"></p>

### 账号

设置中新增「DeepHub 账号」分区：登录状态、短 ID、云端可达性、设备列表（可逐台吊销）、重新生成恢复码。

<p align="center"><img src="docs/images/ui-account.png" alt="设置 · DeepHub 账号" width="85%"></p>

---

## 密钥体系

<p align="center"><img src="docs/images/key-hierarchy.svg" alt="密钥体系" width="100%"></p>

---

## 请求与响应签名

每个请求由**设备 Ed25519 私钥**签名；`authKey` 在日常使用中不出网，仅在注册、新设备登录与改密码时上传。
待签字节采用长度前缀拼接，任一字段的内容都无法伪造出另一种合法切分：

```
DH-SIGN-V1 ‖ lp(host) ‖ lp(METHOD) ‖ lp(target) ‖ lp(deviceId) ‖ lp(sha256(body)) ‖ lp(u64 ts) ‖ lp(nonce)
DH-RESP-V1 ‖ lp(nonce) ‖ lp(u16 status) ‖ lp(sha256(body))

lp(x) = uint32be(len(x)) ‖ x
```

规则详见：[`src/cloud/client.ts`](packages/cloud-protocol/src/cloud/client.ts)。

1. 请求由设备私钥签名。
2. 2xx 响应若无合法签名，**一律视为攻击并中断**，不采信其内容。
3. 非 2xx 且无签名的响应**仅视为传输故障**，不作为业务结论。

响应签名绑定请求的 `nonce`；nonce 由客户端随机生成，攻击者无法预置，因此旧响应无法重放。

---

## 快速开始

### 1 · 安装

需要 **dsh 0.1.5-rc.1 或更新**，以及 PATH 上的 **pnpm**（`dsh plugin` 用它安装包）。

```sh
dsh plugin --profile web add dsh-deephub-share
```

也可以装 Release 里的预构建包：

```sh
curl -LO https://github.com/Voellin/dsh-deephub-share/releases/latest/download/dsh-deephub-share.tgz
dsh plugin --profile web add ./dsh-deephub-share.tgz
```

两种都是预构建包，安装时不触发构建授权。验证：

```sh
dsh --profile web --dump-config                   # 末尾应出现 "# == dsh-deephub-share" 配置层
dsh web                                           # 控制台应打印 [dsh-deephub-share] host loaded … 与 cloud ready …
```

卸载：

```sh
dsh plugin --profile web remove dsh-deephub-share
```

配置层随之移除；凭据文件中的四条 `deephub-share/*` 记录需自行删除。

### 2 · 创建账号

打开 **设置 → DeepHub 账号**：

1. 注册：邮箱 + 密码 → 接收验证码 → **抄录恢复码**（6 组 4 字符，Crockford Base32）。
2. 若已在 DeepHub 桌面端注册，直接登录即可：同一用户的桌面端与 dsh 插件视为**同一账号下的两台设备**，
   在一台已登录的旧设备上确认后即可使用。
3. 登录后主密钥缓存于 dsh 的凭据存储，后续启动无需再次输入密码。

### 3 · 发送一条思路

在任意会话中点击「分享思路」→ 添加朋友（互换短 ID，格式为 `DH-XXXX-XXX`，**需对方同意**）→
「整理这条会话」→ 确认脱敏结果 → 发送。对方在「朋友与收件箱」中点击「收下」。

### 从源码构建

贡献者路径，安装插件不需要这一步。需要 Node **≥ 22.19**（或 ≥ 24，测试直接运行 TS 源码，依赖 Node 内置的类型擦除）
与 npm 10+（npm workspaces 单仓，**必须在根目录安装**）。

```sh
git clone https://github.com/Voellin/dsh-deephub-share.git
cd dsh-deephub-share

npm install            # 必须在仓库根目录执行，workspaces 会关联两个包
npm run typecheck      # 两个包分别执行 tsc --noEmit
npm test               # cloud-protocol 32 项，插件 73 项
npm run build          # 构建插件的两个 face
```

构建产物：

| 文件 | 运行环境 | 格式 |
|---|---|---|
| `packages/dsh-deephub-share/lib/index.js` | Node（Host） | ESM |
| `packages/dsh-deephub-share/lib/client.js` | dsh 的界面（浏览器） | CJS 闭包工厂，dsh 模块表要求的格式 |

**两者分别装载、互相不可见**：私钥与主密钥仅存在于 Host，浏览器只能通过本机 HTTP 向 Host 请求结果。

装本地构建的包：

```sh
cd packages/dsh-deephub-share && npm pack
dsh plugin --profile web add ./dsh-deephub-share-<版本号>.tgz
```

### 指向自行实现的服务端

DeepHub 的服务端不开源。以下两个参数用于指向按 [PROTOCOL.md](packages/cloud-protocol/PROTOCOL.md) 自行实现的兼容服务端，或一个测试实例。

在 profile 的 `cordis.patch.yml` 中为 `deephub-share` 覆盖：

```yaml
- id: deephub-share
  config:
    baseUrl: http://127.0.0.1:18790      # 你自己实现的兼容服务端
    serverPubRaw: <该服务端的签名公钥 base64>
```

---

## 代码地图

| # | 文件 | 主要内容 |
|---|---|---|
| 1 | [`crypto/kdf.ts`](packages/cloud-protocol/src/crypto/kdf.ts) | 密码 → master → authKey / KEK 的派生；scrypt 与 HKDF 的参数 |
| 2 | [`crypto/envelope.ts`](packages/cloud-protocol/src/crypto/envelope.ts) | 每个对象的随机 DK、AES-256-GCM 信封、AAD 绑定 |
| 3 | [`cloud/canon.ts`](packages/cloud-protocol/src/cloud/canon.ts) | 待签字节的**唯一**定义；请求目标的字符白名单 |
| 4 | [`cloud/client.ts`](packages/cloud-protocol/src/cloud/client.ts) | 签名传输、响应验签规则、错误归类 |

目录结构：

```
packages/cloud-protocol/
  PROTOCOL.md          版本登记簿、演进规则、抬升最低支持版本的判据
  src/crypto/          密钥派生、信封、账号密钥包裹、恢复码
  src/cloud/           签名、待签字节、传输、账号、身份、朋友、投递、版本协商
  src/keystore.ts      私钥落盘的接口与默认实现（宿主可注入更强的封装）
  src/protocol/        版本登记簿的机器可读形式
  test/                node --test，直接运行 TS 源码

packages/dsh-deephub-share/
  src/                 Host：路由、整理、脱敏、附件、收下落地
  src/client/          浏览器：按钮、设置分区、收件箱面板、会话卡片
  tests/               node --test，直接运行 TS 源码
```

更详细的分层与「两条跨仓不变量」见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。

---

## 资源

- **完整安全说明**：<https://deephub.cyou/security>
- **协议规范**：[packages/cloud-protocol/PROTOCOL.md](packages/cloud-protocol/PROTOCOL.md)
- **架构**：[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **dsh**：[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)
- **安全策略**：[SECURITY.md](SECURITY.md)
- **报告 Bug**：[GitHub Issues](https://github.com/Voellin/dsh-deephub-share/issues)

## 许可

[MIT](LICENSE) © [wanglin](https://github.com/Voellin)
