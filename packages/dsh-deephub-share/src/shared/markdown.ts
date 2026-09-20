/**
 * 思路 → Markdown。Host 与浏览器共用的纯函数。
 *
 * **不登录也能用**：导出这条路不碰账号、不联网，插件装上就能把一次会话整理成一份文件。
 * 上层与 DeepHub 桌面端同一口径（标题 / 目标 / 依赖清单 / 步骤 / 岔路 / 踩坑 / 交付物），
 * 下层把原始记录完整展开——导出文件是给人离线看的，不折叠。
 */
import type { IdeaDoc } from './idea.ts'

const section = (title: string, xs: readonly string[]): string =>
  xs.length ? `\n\n## ${title}\n\n${xs.map((s) => `- ${s}`).join('\n')}` : ''

/** 原始记录里的一条 → 引用块；多行文本每行都加 `> `，代码围栏不做（工具参数本来就是 JSON 一行）。 */
function quote(text: string): string {
  return text.split('\n').map((l) => `> ${l}`).join('\n')
}

export function ideaToMarkdown(doc: IdeaDoc, meta: { from?: string; exportedAt?: Date } = {}): string {
  const d = doc.deps
  const deps = [
    d.tools.length ? `工具：${d.tools.join('、')}` : '',
    d.connectors.length ? `需要连：${d.connectors.join('、')}` : '',
    d.capabilities.length ? `需要配：${d.capabilities.join('、')}` : '',
  ].filter(Boolean)

  const head = [
    `# ${doc.title || '（无标题）'}`,
    doc.goal ? `\n\n${doc.goal}` : '',
    meta.from ? `\n\n来自 ${meta.from} 分享的思路。` : '',
    section('依赖清单', deps),
    section('步骤', doc.steps),
    section('关键岔路', doc.forks),
    section('踩坑与返工', doc.pitfalls),
    section('交付物', doc.deliverables.map((x) => x.title)),
  ].join('')

  const raw = doc.raw.length
    ? `\n\n---\n\n## 原始记录（${doc.raw.length} 条）\n\n` + doc.raw.map((r) => {
      const who = r.role === 'user' ? '用户' : r.role === 'agent' ? '助手' : `工具 ${r.label ?? ''}`.trim()
      return `**${who}**\n\n${quote(r.text)}`
    }).join('\n\n')
    : ''

  const foot = meta.exportedAt
    ? `\n\n---\n\n_由 dsh-deephub-share 导出，${meta.exportedAt.toISOString().slice(0, 10)}。_`
    : ''

  return head + raw + foot + '\n'
}

/** 导出文件名：标题里不能进文件名的字符换成空格，截到 60 字。**只按字符集合过滤，不判断语义。** */
export function markdownFilename(doc: IdeaDoc): string {
  const bad = new Set(['\\', '/', ':', '*', '?', '"', '<', '>', '|', '\n', '\r', '\t'])
  let name = ''
  for (const ch of doc.title) name += bad.has(ch) ? ' ' : ch
  name = name.trim().slice(0, 60) || '思路'
  return `${name}.md`
}
