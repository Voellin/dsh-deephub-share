# dsh-deephub-share

将 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）中的一条会话提炼为「思路」，
经人工确认脱敏后加密发送给 DeepHub 上的朋友；收到的思路在 dsh 中落为一条新会话。

Built on DeepSeek Harness；**非官方插件**。

## 安装

```sh
dsh plugin --profile web add dsh-deephub-share
```

需要 dsh 0.1.5-rc.1 或更新。完整步骤（账号创建、从源码构建、指向自行实现的服务端）见[仓库根 README](https://github.com/Voellin/dsh-deephub-share#readme)。

---

## 功能

### 发送

会话头部的「分享思路」按钮打开一屏对话框，自上而下分为五段：

| 段 | 说明 |
|---|---|
| **发给谁** | 朋友列表。尚无朋友时可在此按短 ID 添加，也可复制自己的短 ID |
| **内容** | 初始仅显示标题与记录条数；**点击「整理这条会话」后才调用模型**。整理完成后可展开全文与原始记录 |
| **扫描敏感信息** | 由模型扫描一遍，每条候选提供 保留 / 打码 / 换词 三种处理 |
| **附件** | 本次会话产出的文件，默认不包含；**原样发送，不参与脱敏**（界面以橙色标注） |
| **导出 / 发送** | 导出 Markdown **无需登录**；确认发送为端到端加密，对方接收前无法看到内容 |

`build` 依次完成以下步骤：读取会话日志 → **仅保留用户在界面上可见的部分**（系统提示词、各插件注入上下文的片段、
模型推理块、失败的尝试均不纳入）→ 依赖清单**由程序统计得出**（精确匹配工具名，不作推测）→ 产出文件按 dsh
浏览器端的同一套规则折叠 → 使用**该会话自身调用过的模型**分块整理出标题、目标、步骤、岔路与踩坑 →
执行结构化脱敏（剔除工具参数中凭据类键的值，绝对路径按会话 cwd 相对化）。模型不可用时仍会产出草稿，仅缺少叙述部分。

`send` 设有三道校验，且**不信任浏览器端提交的任何内容**：思路再次执行结构化脱敏（幂等）→ 仅接受
`keep / mask / placeholder` 三种决定 → 附件路径必须落在 Host **当场重新计算**的候选集合内
（位于会话 cwd 之内、为真实文件、解析 symlink 后仍在 cwd 内），否则整个请求失败。
对方公钥仅从朋友列表中读取。

### 接收

在「朋友与收件箱」面板中点击「收下」：取回密文 → 使用**服务端登记的发件人公钥**解密（解密失败即视为冒充，
**直接失败，不作降级**）→ 附件写入工作区的 `收到的思路/<标题>/` → 落为**一条新会话**并跳转。

会话顶部为一张卡片，包含发件人、标题、目标、依赖、步骤、岔路、踩坑、交付物、附件「打开」入口与可折叠的原始记录。
卡片下方可折叠的「上下文注入」才是**提供给模型的正文**——**卡片本身不进入模型上下文**。

收到的思路是**由对方机器生成**的 JSON，入库前经过一道过滤（`src/inbox/incoming.ts`）：仅按**结构与长度**处理
——类型不符的丢弃、超长的截断、超量的截取、整份超过 2 MB 的不予接收，**不作任何语义判断**。
附件名仅取路径最后一段并做消毒处理，`../../etc/passwd` 落地后为 `passwd`。

「已收下」清单**不维护独立台账**：每次均从 dsh 的会话库实时筛选（按 id 前缀粗筛，再核对第 0 条事件）。
在 dsh 中删除的条目，此处随之消失。

---

## 账号与密钥

账号协议与 DeepHub 桌面端为**同一份代码**（[`@deephub/cloud-protocol`](https://github.com/Voellin/dsh-deephub-share/tree/main/packages/cloud-protocol)）：
密码与主密钥永不离开本机，上传的仅有 `sha256(authKey)` 及服务器无法解密的信封。

本机密钥（设备 Ed25519 私钥、账号绑定、主密钥缓存、X25519 身份私钥缓存）**全部保存在 dsh 的凭据存储中**
——即 `ctx.credentials` 的四条 `deephub-share/*` 记录，位于 `$DSH_HOME/.credentials.yaml`，
**明文、仅当前用户可读（0600）**，与 dsh 自身的模型 API key 同一文件、同一保护级别。

---

## 配置

profile 的 `cordis.patch.yml` 可对 `deephub-share` 这一行覆盖配置。`baseUrl` 与 `serverPubRaw`
见[仓库根 README](https://github.com/Voellin/dsh-deephub-share#readme)；此外还有 `provider` / `model`（会话未使用过模型时的兜底路由）、
`maxToolChars` 与 `llmTimeoutMs`。

---

## 代码地图

| 文件 | 职责 |
|---|---|
| `src/index.ts` | Host 入口：注册全部路由；外层包裹装载护栏 |
| `src/compat.ts` | 装载前的能力探测与护栏，两个 face 共用 |
| `src/routes.ts` | 路由工具（JSON 应答、请求体读取、按 op 批量注册） |
| `src/account/keystore.ts` | `DshKeyStore`：`KeyStore` 的 dsh 实现，对应四条凭据记录 |
| `src/account/service.ts` | 构造 `CloudService` |
| `src/account/routes.ts` | `account/<op>` 路由表 |
| `src/build.ts` | 一条会话 → 一份草稿，串联下列各环节 |
| `src/extract.ts` | 日志过滤与依赖清单 |
| `src/deliverables.ts` | 产出文件折叠 |
| `src/llm.ts` | 路由解析、`ctx.llm.stream` 单次调用、分块叙述 |
| `src/share.ts` | `peek / build / export / attachments / scan / send` 六条路由 |
| `src/build-cache.ts` | 整理结果的指纹缓存与在途请求去重 |
| `src/attachments.ts` | 会话产出文件 → 附件候选；发送时按候选重新计算并校验路径 |
| `src/social/routes.ts` | `social/<op>` 路由表 |
| `src/inbox/routes.ts` | `inbox/<op>` 路由表（待收、拒收、收下、工作区、已收下） |
| `src/inbox/incoming.ts` | 收件路径的过滤：仅按结构与长度处理 |
| `src/inbox/landed.ts` | 「已收下」清单：从 dsh 会话库实时筛选，不另建台账 |
| `src/land.ts` | 收下流程：附件落盘、建立会话（seed 四条）、加入工作区、修改标题 |
| `src/events.ts` | `deephub-share/received` 事件声明，以及「只能走 seed」这一约束的由来 |
| `src/redact.ts` | 脱敏：① 程序规则，② LLM 扫描 |
| `src/shared/idea.ts` | `IdeaDoc v:1`，跨端投递的载荷格式 |
| `src/shared/markdown.ts` | 思路 → Markdown |
| `src/client/index.ts` | 浏览器入口：四处界面挂载点 |
| `src/client/AccountSection.tsx` | 「DeepHub 账号」设置分区 |
| `src/client/ShareAction.tsx` / `ShareModal.tsx` | 会话头按钮 / 分享对话框 |
| `src/client/InboxPanel.tsx` / `inbox-api.ts` | 「朋友与收件箱」面板及其数据层 |
| `src/client/received-idea-definition.ts` / `ReceivedIdeaCard.tsx` | 事件认领 / 卡片渲染 |
| `src/client/locales.ts` | 中英文案 |
| `tsdown.config.ts` | 两个 face 的构建规则；浏览器 face 必须符合 dsh 模块表要求的闭包工厂格式 |
| `tests/` | `node --test`，直接运行 TS 源码 |

---

## 与 dsh 版本的关系

dsh 处于开发者预览阶段，公开 API 尚未稳定。本插件的 `devDependencies` 与 `engines.dsh` 跟随 dsh 版本。
**dsh 每发布一版，应先核对以下四处再发布插件**：会话事件的结构（`extract.ts`）、产出文件的折叠规则
（`deliverables.ts`）、各工具包中的工具名（`extract.ts` 的归类表）、`settings.section` 与 `credentials` 的契约。

Host 在运行时 import `@deepseek-ai/dsh-llm` 与 `@deepseek-ai/dsh-session`，二者声明为**可选 peer**：
pnpm 不会在 profile 中重复安装，Node 的父目录查找会解析到 dsh 自身的那一份。

---

## 网络行为

插件只访问两处：本机 dsh 配置的模型，以及 `https://deephub.cyou`（账号、朋友、思路投递；响应带服务器签名，
2xx 无合法签名即中断）。两处会主动发起请求的场景如下：

- **已登录时，dsh 启动即向 deephub.cyou 探测一次可达性，并在同一次协商中上报本端协议版本号**（服务端据此记录该设备所用版本）。未登录则不发起任何请求；
  离线时该探测在后台 8 秒超时，不阻塞启动。
- **登录状态下每 30 秒轮询一次**（打开页面时先拉取一次），内容为待收、朋友、他人的好友请求与自己的显示名四项。
  - **页面处于隐藏状态时不发起任何请求**（切换到其他标签页、窗口最小化），切回后立即补拉一次。
    「窗口被其他应用完全遮挡」是否计为隐藏，浏览器不作保证。
  - **未登录时仅查询一次本机登录态，不出网。**
  - 轮询间隔定义在 `src/client/inbox-api.ts` 的 `POLL_MS`。

除上述两条外，不登录、不操作界面即不会联网。私钥与主密钥仅在 Host（Node）侧生成并保存于
`$DSH_HOME/.credentials.yaml`，浏览器侧无法获取。密码由浏览器侧传至 Host 侧走本机 HTTP
（与 dsh 自身的设置一致，`dsh web` 默认仅监听 127.0.0.1）。

---

## 许可

MIT，见 [LICENSE](https://github.com/Voellin/dsh-deephub-share/blob/main/LICENSE)。安全问题见 [SECURITY.md](https://github.com/Voellin/dsh-deephub-share/blob/main/SECURITY.md)，**请勿开公开 issue**。
