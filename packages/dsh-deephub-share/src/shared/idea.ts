/**
 * 思路（IdeaDoc `v: 1`）——**跨端投递的载荷格式**。
 *
 * 与 DeepHub 桌面端的定义逐字一致：投递出去的就是这个对象，两端互发**不做任何格式转换**。
 * 所以这里加一个字段，就是改一次跨端契约——收件方可能是旧版本，加字段要可选、要能被忽略。
 *
 * Host 与浏览器共用的纯类型，没有运行时代码。
 */

export type DeliverableKind = 'file' | 'doc' | 'sheet' | 'slides' | 'pdf' | 'email' | 'note' | 'link'

/** 依赖清单。**必须准确** —— 没有它，思路就是"看着爽抄不动"。程序提取，不靠 LLM 猜。 */
export interface IdeaDeps {
  /** 用到的工具（从日志里的 `tool/call` 直接数出来的） */
  tools: string[]
  /** 需要连的外部：dsh 里是"搜索"与 MCP 服务器名；DeepHub 里是飞书 / 钉钉 / 企微 / 浏览器 */
  connectors: string[]
  /** 需要配的模型能力：视觉 / 文生图 / 搜索 */
  capabilities: string[]
}

/** 原始记录里的一条。已过程序脱敏（见 `redact.ts`）。 */
export interface IdeaRawItem {
  role: 'user' | 'agent' | 'tool'
  text: string
  /** 工具调用时的标签，如 `write` / `write → 结果` */
  label?: string
}

/** 一份思路。投递出去的就是它（外加用户勾的附件）。 */
export interface IdeaDoc {
  v: 1
  title: string
  goal: string
  deps: IdeaDeps
  steps: string[]
  /** 关键岔路：在哪儿做了选择、为什么 */
  forks: string[]
  /** 踩坑与返工。**默认保留** —— 所有教程里永远缺的、也最值钱的部分 */
  pitfalls: string[]
  deliverables: Array<{ title: string; kind: DeliverableKind }>
  raw: IdeaRawItem[]
}

/** LLM 扫出来的一条待定项。**用户逐条选**，不自动处理。 */
export interface RedactCandidate {
  id: string
  kind: 'person' | 'company' | 'client' | 'money' | 'internal' | 'link' | 'other'
  /** 命中的原文 */
  text: string
  /** 用户选什么：保留 / 打码 / 换占位词 */
  action: 'keep' | 'mask' | 'placeholder'
  /** action='placeholder' 时替换成什么 */
  replacement?: string
  why?: string
}

/** `/api/deephub-share/build` 的应答。`route` 为 null 表示这条会话没用过模型、插件也没配——生成按钮该禁用，导出/发送不禁。 */
export interface BuildResponse {
  doc: IdeaDoc
  llmOk: boolean
  /**
   * `llmOk:false` 时这一次为什么没成：模型/网络给的原话，或 `'no_steps'`
   * （模型回了话，但里面解析不出步骤）。Host 半同时往控制台打一行——
   * `ctx.logger` 在 `dsh web` 控制台看不见，不打就等于没记。
   */
  llmError?: string
  /** 内容是从截断的输出里捞出来的：能用，但末尾可能不全 */
  llmTruncated?: boolean
  route: { provider: string; model: string } | null
  /** 产出文件（会话 cwd 下的相对路径或绝对路径，原样）；附件勾选屏的候选 */
  files: string[]
}
