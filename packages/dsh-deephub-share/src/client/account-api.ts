/**
 * 浏览器半 → Host 半的账号调用。同源 `fetch`，dsh 的 /api 鉴权 cookie 自动带上。
 * 类型从共享包 **只取类型**（`import type`，构建时擦掉；共享包本身是 Node 代码，不能进浏览器包）。
 */
import type { CloudDevice, CloudPendingApproval, CloudResult, CloudStatus } from '@deephub/cloud-protocol'

export type { CloudDevice, CloudFail, CloudPendingApproval, CloudResult, CloudStatus } from '@deephub/cloud-protocol'

const PREFIX = '/api/deephub-share/account'

async function call<T>(op: string, body: Record<string, unknown> = {}): Promise<T> {
  const r = await fetch(`${PREFIX}/${op}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data: unknown = await r.json().catch(() => null)
  if (!r.ok) {
    const msg = typeof data === 'object' && data !== null && typeof (data as { error?: unknown }).error === 'string'
      ? (data as { error: string }).error
      : `HTTP ${r.status}`
    throw new Error(msg)
  }
  return data as T
}

export const accountApi = {
  status: (probe = false) => call<CloudStatus>('status', { probe }),
  register: (email: string, password: string) => call<CloudResult>('register', { email, password }),
  verify: (email: string, code: string) => call<CloudResult<{ shortId: string; recoveryCode: string }>>('verify', { email, code }),
  pendingRecovery: () => call<{ code: string | null }>('pending-recovery'),
  confirmRecovery: () => call<{ ok: true }>('confirm-recovery'),
  rotateRecovery: (password: string) => call<CloudResult<{ recoveryCode: string }>>('rotate-recovery', { password }),
  login: (email: string, password: string) => call<CloudResult<{ pending: boolean; shortId: string | null }>>('login', { email, password }),
  recoveryChallenge: (email: string) => call<CloudResult>('recovery-challenge', { email }),
  recoveryLogin: (email: string, emailCode: string, recoveryCode: string, newPassword: string) =>
    // tookOver：服务端确实接管了账号（其它设备已全部踢下线）。老服务端不回这个字段，
    // 按 false 处理 —— 界面上那句"其它设备已退出"只能在它为真时说。
    call<CloudResult<{ pending: boolean; tookOver: boolean; devicesRevoked: number }>>(
      'recovery-login', { email, emailCode, recoveryCode, newPassword }),
  devices: () => call<CloudResult<{ devices: CloudDevice[]; pending: CloudPendingApproval[] }>>('devices'),
  approveDevice: (deviceId: string, code: string) => call<CloudResult>('approve-device', { deviceId, code }),
  revokeDevice: (deviceId: string) => call<CloudResult<{ wasCurrent: boolean }>>('revoke-device', { deviceId }),
  signOut: () => call<{ ok: true }>('sign-out'),
}

/**
 * 恢复码归一化，与共享包 `crypto/recovery.ts` 的 `parseRecoveryCode` 一致：
 * 大写、只留 0-9A-Z、Crockford 等价映射（O→0、I/L→1、U→V）。逐字符做，不用正则。
 */
const CROCKFORD: Record<string, string> = { O: '0', I: '1', L: '1', U: 'V' }
export function normalizeRecoveryCode(s: string): string {
  let out = ''
  for (const raw of s.toUpperCase()) {
    const ch = CROCKFORD[raw] ?? raw
    if ((ch >= '0' && ch <= '9') || (ch >= 'A' && ch <= 'Z')) out += ch
  }
  return out
}

/** `RZ08W62Q8P1EJF4QEYWPHV0Z` → `RZ08-W62Q-8P1E-JF4Q-EYWP-HV0Z` */
export function prettyRecoveryCode(code: string): string {
  const parts: string[] = []
  for (let i = 0; i < code.length; i += 4) parts.push(code.slice(i, i + 4))
  return parts.join('-')
}

/** 够格当邮箱的最低要求：有 @、@ 后面有点、没有空白。服务端才是真判断，这里只挡手滑。 */
export function looksLikeEmail(s: string): boolean {
  const v = s.trim()
  if (v.length !== s.trim().length || v.includes(' ')) return false
  const at = v.indexOf('@')
  if (at <= 0 || at !== v.lastIndexOf('@')) return false
  const dot = v.indexOf('.', at)
  return dot > at + 1 && dot < v.length - 1
}
