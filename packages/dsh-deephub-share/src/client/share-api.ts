/**
 * 浏览器半 → Host 半的分享/朋友调用。同源 `fetch`，dsh 的 /api 鉴权 cookie 自动带上。
 * 类型从共享包**只取类型**（构建时擦掉）。
 */
import type { FriendWithRemark } from '../shared/social.ts'
import type { BuildResponse, IdeaDoc, RedactCandidate } from '../shared/idea.ts'

export type { Friend } from '@deephub/cloud-protocol'
export type { FriendWithRemark } from '../shared/social.ts'
export type { BuildResponse, IdeaDoc, RedactCandidate } from '../shared/idea.ts'

const PREFIX = '/api/deephub-share'

export interface AttachmentInfo { path: string; name: string; size: number; tooBig: boolean }
export interface PeekResponse {
  title: string
  rawCount: number
  state: 'none' | 'running' | 'ready'
  built?: BuildResponse
}
export type SendReason = 'offline' | 'not_friend' | 'no_key' | 'peer_no_key' | 'too_large' | 'inbox_full' | 'too_many_pending' | 'no_space' | 'other'

async function post(op: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${PREFIX}/${op}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function call<T>(op: string, body: Record<string, unknown> = {}): Promise<T> {
  const r = await post(op, body)
  const data: unknown = await r.json().catch(() => null)
  if (!r.ok) {
    const msg = typeof data === 'object' && data !== null && typeof (data as { error?: unknown }).error === 'string'
      ? (data as { error: string }).error
      : `HTTP ${r.status}`
    throw new Error(msg)
  }
  return data as T
}

export const shareApi = {
  /** 打开对话框先问这一句：标题、记录条数、有没有现成结果。不调模型、不花钱 */
  peek: (sessionId: string) => call<PeekResponse>('peek', { sessionId }),
  build: (sessionId: string, force = false) => call<BuildResponse>('build', { sessionId, force }),
  attachments: (sessionId: string) => call<{ files: AttachmentInfo[]; totalMax: number }>('attachments', { sessionId }),
  scan: (doc: IdeaDoc, route: { provider: string; model: string }) =>
    call<{ ok: true; candidates: RedactCandidate[] } | { ok: false; reason: string }>('scan', { doc, route }),
  send: (sessionId: string, toAccountId: string, doc: IdeaDoc, paths: string[], decisions: RedactCandidate[]) =>
    call<{ ok: true; deliveryId: string | null; attachments: number } | { ok: false; reason: SendReason }>('send', {
      sessionId, toAccountId, doc, paths, decisions,
    }),
  friends: () => call<{ friends: FriendWithRemark[] }>('social/friends'),
  request: (shortId: string) => call<{ ok: boolean; reason?: 'bad_short_id' | 'offline' }>('social/request', { shortId }),
  status: (probe = false) => call<{ loggedIn: boolean; reachable: boolean | null; shortId: string | null }>('account/status', { probe }),

  /** 导出 Markdown：拿到文件就地触发下载（同源 blob，不用登录）。 */
  async exportMarkdown(doc: IdeaDoc, decisions: RedactCandidate[] = []): Promise<void> {
    const r = await post('export', { doc, decisions })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const blob = await r.blob()
    const disposition = r.headers.get('content-disposition') ?? ''
    const star = disposition.indexOf("filename*=UTF-8''")
    const filename = star >= 0 ? decodeURIComponent(disposition.slice(star + "filename*=UTF-8''".length)) : 'idea.md'
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => { URL.revokeObjectURL(url) }, 1000)
  },
}

export const fileSize = (n: number): string =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`
