/**
 * 附件：这条会话产出的文件，给附件勾选屏当候选，发送时按勾选读出来。
 *
 * 两条硬规则：
 * 1. **只认会话目录（cwd）下的文件。** 候选来自 `deliverables.ts` 折出来的产出路径；不在 cwd 下的、
 *    软链接、不是普通文件的，一律不列。
 * 2. **发送时 Host 重新算一遍候选，浏览器传来的路径必须在候选里**——浏览器半传什么都不信，
 *    否则页面里一段脚本就能把本机任意文件当附件发出去。
 *
 * 读文件走 `node:fs`，没走 dsh 的 `ctx.fs` 隔离层——它的策略目前不覆盖插件的读。
 */
import { lstat, readFile, realpath } from 'node:fs/promises'
import { basename, isAbsolute, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import { ATTACH_ONE_MAX, ATTACH_TOTAL_MAX, type Attachment } from '@deephub/cloud-protocol'
import { foldDeliverables } from './deliverables.ts'

export interface AttachmentInfo {
  /** 绝对路径（Host 侧用；浏览器只拿来回传做勾选键，不显示） */
  path: string
  name: string
  size: number
  /** 超过单个附件上限，勾不了 */
  tooBig: boolean
}

export interface AttachmentList {
  files: AttachmentInfo[]
  totalMax: number
}

const sameCase = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p)

/** `child` 是否在 `root` 之下（含等于）。两边都已 resolve；Windows 不分大小写。 */
export function isInside(root: string, child: string): boolean {
  const r = sameCase(resolve(root))
  const c = sameCase(resolve(child))
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep)
}

/**
 * 从产出路径里挑出可当附件的：解析到 cwd 下、realpath 也在 cwd 下（防软链指出去）、是普通文件。
 * 纯函数部分（路径判定）与 fs 部分分开，便于测试。
 */
export function resolveCandidates(cwd: string | undefined, produced: readonly string[]): string[] {
  if (!cwd) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const p of produced) {
    const abs = isAbsolute(p) ? resolve(p) : resolve(cwd, p)
    if (!isInside(cwd, abs)) continue
    const key = sameCase(abs)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(abs)
  }
  return out
}

async function statFile(cwd: string, abs: string): Promise<AttachmentInfo | null> {
  try {
    const st = await lstat(abs)
    if (!st.isFile()) return null // 软链接、目录都不要
    const real = await realpath(abs)
    if (!isInside(await realpath(cwd), real)) return null
    return { path: abs, name: basename(abs), size: st.size, tooBig: st.size > ATTACH_ONE_MAX }
  } catch {
    return null // 已被删掉等，不列
  }
}

export async function listAttachments(ctx: Context, sessionId: string): Promise<AttachmentList> {
  const { session, events } = await ctx.sessionQuery.readSession(SessionId(sessionId))
  const cwd = session.cwd
  const files: AttachmentInfo[] = []
  if (cwd) {
    for (const abs of resolveCandidates(cwd, foldDeliverables(events, cwd).map((p) => p.path))) {
      const info = await statFile(cwd, abs)
      if (info) files.push(info)
    }
  }
  return { files, totalMax: ATTACH_TOTAL_MAX }
}

/** 发送前读附件。`paths` 每一项都必须是 `listAttachments` 此刻算出来的候选，否则整个请求拒绝。 */
export async function readAttachments(ctx: Context, sessionId: string, paths: readonly string[]): Promise<Attachment[]> {
  if (paths.length === 0) return []
  const allowed = new Map((await listAttachments(ctx, sessionId)).files.map((f) => [sameCase(f.path), f]))
  const out: Attachment[] = []
  let total = 0
  for (const p of paths) {
    const info = allowed.get(sameCase(resolve(p)))
    if (!info) throw new Error(`attachment not allowed: ${basename(p)}`)
    if (info.tooBig) throw new Error(`attachment too large: ${info.name}`)
    const data = await readFile(info.path)
    total += data.length
    if (total > ATTACH_TOTAL_MAX) throw new Error('attachments exceed total limit')
    out.push({ name: info.name, data })
  }
  return out
}
