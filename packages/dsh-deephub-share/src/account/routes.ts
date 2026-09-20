/**
 * 账号路由 `POST /api/deephub-share/account/<op>`。一个 op 对应 DeepHub 桌面端的一条账号命令，
 * 入参出参与之一致；浏览器半的状态机也与桌面端的账号面板同源。
 *
 * | op | 入参 | 出参 |
 * |---|---|---|
 * | status | `{ probe?: boolean }` | `CloudStatus`（probe=true 时先探活校时） |
 * | register | `{ email, password }` | `CloudResult` |
 * | verify | `{ email, code }` | `CloudResult<{ shortId, recoveryCode }>` —— 恢复码只在这里出现一次 |
 * | pending-recovery | — | `{ code: string \| null }`（抄写屏误关了接回来） |
 * | confirm-recovery | — | `{ ok: true }`，这一刻才把主密钥缓存进凭据存储 |
 * | rotate-recovery | `{ password }` | `CloudResult<{ recoveryCode }>` |
 * | login | `{ email, password }` | `CloudResult<{ pending, shortId }>`，pending=新设备待老设备确认 |
 * | recovery-challenge | `{ email }` | `CloudResult` |
 * | recovery-login | `{ email, emailCode, recoveryCode, newPassword }` | `CloudResult<{ pending }>` |
 * | devices | — | `CloudResult<{ devices, pending }>` |
 * | approve-device | `{ deviceId, code }` | `CloudResult` |
 * | revoke-device | `{ deviceId }` | `CloudResult<{ wasCurrent }>` |
 * | sign-out | — | `{ ok: true }`；保留设备密钥 |
 */
import type { Context } from '@deepseek-ai/cordis'
import { registerOps, str } from '../routes.ts'
import type { Cloud } from './service.ts'

export const ACCOUNT_PREFIX = '/api/deephub-share/account'

export function registerAccountRoutes(ctx: Context, cloudReady: Promise<Cloud>): void {
  const svc = async () => (await cloudReady).svc
  registerOps(ctx, ACCOUNT_PREFIX, {
    // 打一行耗时：「打开分享时云端状态迟迟不回来」这类报障，靠它才分得清是
    // 「等 cloudReady（凭据预读）」慢还是「探活本身」慢。`ctx.logger` 在 dsh web 控制台看不见
    'status': async (b) => {
      const probe = b?.probe === true
      const t0 = Date.now()
      const s = await svc()
      const ready = Date.now() - t0
      const r = probe ? await s.probe() : s.status()
      console.log(`[dsh-deephub-share] account/status probe=${probe} ready=${ready}ms total=${Date.now() - t0}ms`)
      return r
    },
    'register': async (b) => (await svc()).register(str(b, 'email'), str(b, 'password')),
    'verify': async (b) => (await svc()).verifyEmail(str(b, 'email'), str(b, 'code')),
    'pending-recovery': async () => (await svc()).pendingRecoveryCode(),
    'confirm-recovery': async () => (await svc()).confirmRecoveryCode(),
    'rotate-recovery': async (b) => (await svc()).rotateRecoveryCode(str(b, 'password')),
    'login': async (b) => (await svc()).login(str(b, 'email'), str(b, 'password')),
    'recovery-challenge': async (b) => (await svc()).recoveryChallenge(str(b, 'email')),
    'recovery-login': async (b) => (await svc()).recoveryLogin(
      str(b, 'email'), str(b, 'emailCode'), str(b, 'recoveryCode'), str(b, 'newPassword'),
    ),
    'devices': async () => (await svc()).devices(),
    'approve-device': async (b) => (await svc()).approveDevice(str(b, 'deviceId'), str(b, 'code')),
    'revoke-device': async (b) => (await svc()).revokeDevice(str(b, 'deviceId')),
    'sign-out': async () => (await svc()).signOut(),
  })
}
