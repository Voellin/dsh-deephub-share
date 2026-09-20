/**
 * 会话日志 → 原始记录 + 依赖清单。
 *
 * 两条硬规则，与 DeepHub 桌面端同源：
 *
 * 1. **只带走用户在界面上看见过的。** dsh 的日志什么都在里面——渲染后的系统提示词、
 *    各插件塞进上下文的东西（AGENTS.md、记忆、通知）、模型的推理块、失败的尝试。
 *    这里的过滤是从根上决定什么出门，比"事后扫一遍删掉"可靠得多。
 * 2. **依赖清单是程序数出来的，不是 LLM 猜的。** 猜错了整份思路就废了。
 *
 * | 日志事件 | 处理 |
 * |---|---|
 * | `user/message` 且 `source.kind === 'user'` | 带走文本块 |
 * | `user/message` 其它来源（plugin） | **整条丢**——这就是 DeepHub 的"记忆注入段" |
 * | `system/message` | **整条丢** |
 * | `assistant/message` | 只取 `text` 块；`reasoning` 从根上不带 |
 * | `assistant/attempt` | 丢 |
 * | `tool/call` | 带 `name` + `arguments`（脱敏①在 `redact.ts`） |
 * | `tool/result` | 文本块，截到 `maxToolChars` |
 * | 其它（request/turn/step/end-seed/自定义） | 丢 |
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { IdeaDeps, IdeaRawItem } from './shared/idea.ts'

export interface ExtractOptions {
  /** 每条工具结果最多带多少字。一次网页抓取能有几百 KB，全带上纯属烧带宽。 */
  maxToolChars?: number
}

export interface Extracted {
  raw: IdeaRawItem[]
  deps: IdeaDeps
  /** 用户消息里出现过图片 → `capabilities: 视觉` */
  hasImage: boolean
  /** 第一条用户消息的第一行，作为模型不可用时的标题兜底 */
  firstUserLine: string
}

/** 把一组内容块里的文本拼起来；image / file / tool-* 一律不带。 */
function textOf(blocks: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const b of blocks) if (b.type === 'text' && b.text.trim()) parts.push(b.text)
  return parts.join('\n')
}

function hasImageBlock(blocks: readonly ContentBlock[]): boolean {
  return blocks.some((b) => b.type === 'image')
}

export function extractRaw(events: readonly SessionEvent[], opts: ExtractOptions = {}): Extracted {
  const cap = opts.maxToolChars ?? 4000
  const raw: IdeaRawItem[] = []
  const toolNames: string[] = []
  /** callId → 工具名，给 `tool/result` 贴标签用 */
  const nameByCall = new Map<string, string>()
  let hasImage = false
  let firstUserLine = ''

  for (const ev of events) {
    switch (ev.type) {
      case 'user/message': {
        if (ev.data.source.kind !== 'user') break // 插件注入段：整条丢
        if (hasImageBlock(ev.data.content)) hasImage = true
        const text = textOf(ev.data.content)
        if (!text.trim()) break
        if (!firstUserLine) firstUserLine = (text.split('\n').find((l) => l.trim()) ?? '').trim()
        raw.push({ role: 'user', text })
        break
      }
      case 'assistant/message': {
        const text = textOf(ev.data.message.content) // reasoning 块在这里被丢掉
        if (text.trim()) raw.push({ role: 'agent', text })
        break
      }
      case 'tool/call': {
        const name = ev.data.name
        nameByCall.set(String(ev.data.callId), name)
        toolNames.push(name)
        raw.push({ role: 'tool', label: name, text: ev.data.arguments })
        break
      }
      case 'tool/result': {
        const block = ev.data.message.content[0]
        const name = nameByCall.get(String(ev.data.message.source.callId)) ?? '?'
        const text = textOf(block.content)
        const failed = block.isError === true || ev.data.error !== undefined
        // 失败的结果也带：往往那里才有"为什么返工"的证据
        const body = (failed ? '（失败）' : '') + text.slice(0, cap)
        if (body.trim()) raw.push({ role: 'tool', label: `${name} → 结果`, text: body })
        break
      }
      default:
        // system/message、assistant/attempt、request/*、turn/*、step/*、session/end-seed、自定义事件：不带
        break
    }
  }

  return { raw, deps: countDeps(toolNames, hasImage), hasImage, firstUserLine }
}

/* ───────────────────────── 依赖清单 ───────────────────────── */

/**
 * dsh 工具名 → 归类。**精确名匹配，不做正则猜测**——名字是 dsh 各工具包里写死的常量，
 * 认不出的工具宁可不归类，也不靠名字里的字眼去猜。dsh 发版后核一遍这张表。
 */
const GROUP_OF: ReadonlyMap<string, string> = new Map([
  ['bash', 'shell'], ['pwsh', 'shell'],
  ['read', '文件'], ['write', '文件'], ['edit', '文件'], ['glob', '文件'], ['grep', '文件'],
  ['str_replace_editor', '文件'], ['read_image', '文件'],
  ['web_search', '联网'], ['web_fetch', '联网'],
  ['subagent', '子 agent'], ['workflow', '子 agent'], ['ralph', '子 agent'],
  ['list_subagent_models', '子 agent'], ['list_agents', '子 agent'], ['send_message', '子 agent'],
  ['interrupt_agent', '子 agent'], ['job_list', '子 agent'], ['job_output', '子 agent'], ['job_kill', '子 agent'],
])

/** `mcp__<server>__<raw>` → server；不是这个形状就返回 null。**按分隔符切，不是正则。** */
export function mcpServerOf(name: string): string | null {
  if (!name.startsWith('mcp__')) return null
  const rest = name.slice('mcp__'.length)
  const i = rest.indexOf('__')
  if (i <= 0) return null
  return rest.slice(0, i)
}

/**
 * 数出来的清单。`tools` 里同一归类合并成一条 `归类（名1、名2）`，其它工具原样列出；
 * `connectors` = 联网时的"搜索" + MCP 服务器名；`capabilities` 第一版只有"视觉"。
 */
export function countDeps(toolNames: readonly string[], hasImage: boolean): IdeaDeps {
  const byGroup = new Map<string, Set<string>>()
  const plain = new Set<string>()
  const connectors = new Set<string>()
  const capabilities = new Set<string>()

  for (const name of toolNames) {
    const server = mcpServerOf(name)
    if (server !== null) {
      connectors.add(server)
      plain.add(name)
      continue
    }
    const group = GROUP_OF.get(name)
    if (group === undefined) { plain.add(name); continue }
    let set = byGroup.get(group)
    if (set === undefined) { set = new Set(); byGroup.set(group, set) }
    set.add(name)
    if (group === '联网') connectors.add('搜索')
    if (name === 'read_image') capabilities.add('视觉')
  }
  if (hasImage) capabilities.add('视觉')

  const tools = [
    ...[...byGroup.entries()].map(([g, names]) => `${g}（${[...names].sort().join('、')}）`),
    ...[...plain].sort(),
  ]
  return { tools, connectors: [...connectors].sort(), capabilities: [...capabilities].sort() }
}
