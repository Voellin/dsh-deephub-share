/**
 * 交付物：从会话里折出「这次做出来了什么文件」。
 *
 * dsh 的"产出文件行"是**浏览器端**从 `tool/call` + `tool/result` 折出来的，Host 没有现成事实
 * （`packages/client/ui-deliverables/src/client/turn-deliverables.ts`）。这里在 Host 复刻同一个折叠：
 *
 * - `write`（有 `content`）/ `edit`（合法 old/new）/ `str_replace_editor`（create / str_replace / insert）
 *   的调用路径，**只在对应 `tool/result` 不是错误时**算数；
 * - `deliverables/presented` 事件（`dsh-tool-present` 写的）里模型明确"交付"的文件。
 *
 * 判定规则与 dsh 逐条一致（0.1.5-rc.2）；dsh 发版后对一遍 `mutationPath`。
 */
import { resolve } from 'node:path'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-tool-present/types'

export interface Produced {
  /** 工具收到的路径原样（相对会话 cwd 或绝对） */
  path: string
  /** 模型通过 present 明确交付的（`description` 由模型给） */
  presented?: string
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const pathValue = (v: unknown): string | null =>
  typeof v === 'string' && v.trim().length > 0 ? v : null

function validEditArgs(a: Record<string, unknown>): boolean {
  return typeof a.old_string === 'string' && a.old_string.length > 0
    && typeof a.new_string === 'string' && a.old_string !== a.new_string
    && (a.replace_all === undefined || typeof a.replace_all === 'boolean')
}

function editorMutationPath(a: Record<string, unknown>): string | null {
  const path = pathValue(a.path)
  if (path === null) return null
  switch (a.command) {
    case 'create':
      return typeof a.file_text === 'string' ? path : null
    case 'str_replace':
      return typeof a.old_str === 'string' && a.old_str.length > 0
        && (a.new_str === undefined || typeof a.new_str === 'string') ? path : null
    case 'insert':
      return typeof a.insert_line === 'number' && Number.isInteger(a.insert_line) && a.insert_line >= 0
        && typeof a.new_str === 'string' ? path : null
    default:
      return null
  }
}

/** 照抄 dsh 的 `mutationPath`：只认三个第一方写文件工具，其它一律 null。 */
export function mutationPath(name: string, argsRaw: string): string | null {
  let args: unknown
  try { args = JSON.parse(argsRaw) } catch { return null }
  if (!isRecord(args)) return null
  switch (name) {
    case 'write': return typeof args.content === 'string' ? pathValue(args.file_path) : null
    case 'edit': return validEditArgs(args) ? pathValue(args.file_path) : null
    case 'str_replace_editor': return editorMutationPath(args)
    default: return null
  }
}

/**
 * 从整条日志折出产出文件。同一个文件多次写只留一条（按 cwd 解析成绝对路径去重，
 * `out/a.md` 与 `/proj/out/a.md` 算同一个），按首次出现排序；presented 的描述覆盖上去。
 * 返回的 `path` 是第一次见到的原样写法。
 */
export function foldDeliverables(events: readonly SessionEvent[], cwd?: string): Produced[] {
  const keyOf = (p: string): string => (cwd ? resolve(cwd, p) : p)
  const pending = new Map<string, string>() // callId → path
  const produced = new Map<string, Produced>() // 解析后的绝对路径 → 记录
  for (const ev of events) {
    if (ev.type === 'tool/call') {
      const p = mutationPath(ev.data.name, ev.data.arguments)
      if (p !== null) pending.set(String(ev.data.callId), p)
      continue
    }
    if (ev.type === 'tool/result') {
      const callId = String(ev.data.message.source.callId)
      const p = pending.get(callId)
      pending.delete(callId)
      if (p === undefined) continue
      if (ev.data.message.content[0].isError === true) continue
      const k = keyOf(p)
      if (!produced.has(k)) produced.set(k, { path: p })
      continue
    }
    if (ev.type === 'deliverables/presented') {
      for (const f of ev.data.files) {
        const k = keyOf(f.path)
        const cur = produced.get(k) ?? { path: f.path }
        if (f.description !== undefined) cur.presented = f.description
        else if (cur.presented === undefined) cur.presented = ''
        produced.set(k, cur)
      }
    }
  }
  return [...produced.values()]
}

/** 只留最后一段做标题（路径本身进 `files` 给附件屏，思路正文不带目录结构）。 */
export function basenameOf(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts.length ? (parts[parts.length - 1] as string) : p
}
