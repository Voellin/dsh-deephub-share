/**
 * 设置里的「DeepHub 账号」分区。状态机与 DeepHub 桌面端的账号面板同源：
 *
 *   login ─ register ─ verify ─ recoveryCode ─ signedIn
 *     │                                          ├─ rotate ─ recoveryCode
 *     └─ forgot ──────────────────────────────────┘
 *
 * 三条克制与 DeepHub 一致：不猜服务端没说的事（注册恒返 202、登录不区分账号不存在与密码错）；
 * 离线不是错误；恢复码只出现一次，**必须回填一致才放行**。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Input } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import { NS } from './locales.ts'
import {
  accountApi as api, looksLikeEmail, normalizeRecoveryCode, prettyRecoveryCode,
  type CloudDevice, type CloudFail, type CloudPendingApproval, type CloudStatus,
} from './account-api.ts'
import css from './AccountSection.module.css'

export type AccountSectionProps = PropsRuntime<'settings.section'> & PropsLocale<typeof NS>

type View = 'login' | 'register' | 'verify' | 'recoveryCode' | 'forgot' | 'signedIn' | 'rotate'
type Msg = { kind: 'ok' | 'bad' | 'warn' | 'wait' | 'acc'; text: string } | null

/** css-modules 的类名在 noUncheckedIndexedAccess 下是 string | undefined；Input 的 className 只收 string。 */
const cx = (...ks: Array<string | undefined | false>): string => ks.filter((k): k is string => typeof k === 'string' && k.length > 0).join(' ')

const RECOVERY_LEN = 24
const CODE_LEN = 8
const MIN_PASSWORD = 10

export function AccountSection({ t }: AccountSectionProps) {
  const [st, setSt] = useState<CloudStatus | null>(null)
  const [view, setView] = useState<View>('login')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<Msg>(null)

  const [email, setEmail] = useState('')
  const [pwd, setPwd] = useState('')
  const [pwd2, setPwd2] = useState('')
  const [code, setCode] = useState('')
  const [recovery, setRecovery] = useState('')
  const [retyped, setRetyped] = useState('')

  const [fEmailCode, setFEmailCode] = useState('')
  const [fRecovery, setFRecovery] = useState('')
  const [fNewPwd, setFNewPwd] = useState('')
  const [challengeSent, setChallengeSent] = useState(false)

  const [devices, setDevices] = useState<CloudDevice[]>([])
  const [pending, setPending] = useState<CloudPendingApproval[]>([])
  const [confirmRevoke, setConfirmRevoke] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const failMsg = (f: CloudFail): Msg => ({ kind: f.kind === 'offline' ? 'warn' : 'bad', text: f.message })

  const loadDevices = useCallback(async (): Promise<void> => {
    const r = await api.devices()
    if (r.ok && alive.current) { setDevices(r.devices); setPending(r.pending) }
  }, [])

  const refresh = useCallback(async (probe = false): Promise<CloudStatus> => {
    const s = await api.status(probe)
    if (alive.current) setSt(s)
    return s
  }, [])

  // 打开分区：先看本机状态；有没抄完的恢复码就接回来；再探活拉设备
  useEffect(() => {
    void (async () => {
      try {
        const s = await api.status()
        if (!alive.current) return
        setSt(s)
        if (s.email) setEmail(s.email)
        const pend = await api.pendingRecovery().catch(() => ({ code: null }))
        if (pend.code) { setRecovery(pend.code); setView('recoveryCode'); return }
        setView(s.loggedIn ? 'signedIn' : 'login')
        const p = await refresh(true)
        if (p.loggedIn && p.reachable) void loadDevices()
      } catch (e) {
        if (alive.current) setMsg({ kind: 'bad', text: t('acct.fail', { message: (e as Error).message }) })
      }
    })()
  }, [refresh, loadDevices, t])

  // 登录态下每 10 秒重探一次（配额、设备、待确认项都要新）
  useEffect(() => {
    if (!st?.loggedIn || view !== 'signedIn') return
    const timer = setInterval(() => { void refresh(true).then(loadDevices).catch(() => undefined) }, 10_000)
    return () => clearInterval(timer)
  }, [st?.loggedIn, view, refresh, loadDevices])

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setBusy(true); setMsg(null)
    try { await fn() } catch (e) {
      if (alive.current) setMsg({ kind: 'bad', text: t('acct.fail', { message: (e as Error).message }) })
    } finally { if (alive.current) setBusy(false) }
  }
  const goto = (v: View): void => { setView(v); setMsg(null) }

  // ── 注册 ──
  const doRegister = (): void => void run(async () => {
    setMsg({ kind: 'wait', text: t('acct.working') })
    const r = await api.register(email.trim(), pwd)
    if (!r.ok) { setMsg(failMsg(r)); return }
    setView('verify')
    setMsg({ kind: 'acc', text: t('acct.registered', { email: email.trim() }) })
  })
  const doVerify = (): void => void run(async () => {
    const r = await api.verify(email.trim(), code)
    if (!r.ok) { setMsg(failMsg(r)); return }
    setRecovery(r.recoveryCode); setRetyped('')
    setView('recoveryCode')
  })
  const doConfirmRecovery = (): void => void run(async () => {
    await api.confirmRecovery()
    setRecovery(''); setRetyped(''); setPwd(''); setPwd2(''); setCode('')
    const s = await refresh(true)
    if (s.loggedIn) { setView('signedIn'); void loadDevices() }
    setMsg({ kind: 'ok', text: t('acct.recovery.ready') })
  })
  const doRotate = (): void => void run(async () => {
    setMsg({ kind: 'wait', text: t('acct.working') })
    const r = await api.rotateRecovery(pwd)
    if (!r.ok) { setMsg(failMsg(r)); return }
    setPwd(''); setRecovery(r.recoveryCode); setRetyped('')
    setView('recoveryCode'); setMsg(null)
  })

  // ── 登录 ──
  const doLogin = (): void => void run(async () => {
    setMsg({ kind: 'wait', text: t('acct.working') })
    const r = await api.login(email.trim(), pwd)
    if (!r.ok) { setMsg(failMsg(r)); return }
    setPwd('')
    if (r.pending) { await refresh(); setMsg({ kind: 'warn', text: t('acct.login.pending') }); return }
    const s = await refresh(true)
    if (s.loggedIn) { setView('signedIn'); void loadDevices() }
    setMsg({ kind: 'ok', text: t('acct.login.ok') })
  })

  // ── 忘记密码 ──
  const doChallenge = (): void => void run(async () => {
    const r = await api.recoveryChallenge(email.trim())
    if (!r.ok) { setMsg(failMsg(r)); return }
    setChallengeSent(true)
    setMsg({ kind: 'acc', text: t('acct.forgot.sent') })
  })
  const doRecover = (): void => void run(async () => {
    const n = normalizeRecoveryCode(fRecovery).length
    if (n !== RECOVERY_LEN) { setMsg({ kind: 'bad', text: t('acct.forgot.recovery.len', { n }) }); return }
    setMsg({ kind: 'wait', text: t('acct.working') })
    const r = await api.recoveryLogin(email.trim(), fEmailCode, fRecovery, fNewPwd)
    if (!r.ok) { setMsg(r.kind === 'local' ? { kind: 'bad', text: t('acct.forgot.bad') } : failMsg(r)); return }
    setFRecovery(''); setFNewPwd(''); setFEmailCode(''); setChallengeSent(false)
    const s = await refresh(true)
    if (s.loggedIn) { setView('signedIn'); void loadDevices() }
    // 「其它设备已全部退出」只在服务端真做了接管时才说
    const kicked = r.tookOver
      ? ' ' + (r.devicesRevoked > 0 ? t('acct.forgot.kicked', { n: r.devicesRevoked }) : t('acct.forgot.kicked.none'))
      : ''
    setMsg({ kind: 'ok', text: t(r.pending ? 'acct.forgot.okPending' : 'acct.forgot.ok') + kicked })
  })

  // ── 设备 ──
  const approve = (d: CloudPendingApproval): void => void run(async () => {
    const r = await api.approveDevice(d.device_id, d.code)
    if (!r.ok) { setMsg(failMsg(r)); return }
    await loadDevices(); setMsg({ kind: 'ok', text: t('acct.approved') })
  })
  const revoke = (id: string): void => void run(async () => {
    setConfirmRevoke(null)
    const r = await api.revokeDevice(id)
    if (!r.ok) { setMsg(failMsg(r)); return }
    if (r.wasCurrent) { await refresh(); setView('login'); setMsg({ kind: 'warn', text: t('acct.revoked.self') }) }
    else { await loadDevices(); setMsg({ kind: 'ok', text: t('acct.revoked') }) }
  })
  const signOut = (): void => void run(async () => {
    await api.signOut()
    setDevices([]); setPending([]); setPwd('')
    await refresh()
    setView('login')
    setMsg({ kind: 'ok', text: t('acct.signOut.done') })
  })

  const canRegister = looksLikeEmail(email) && pwd.length >= MIN_PASSWORD && pwd === pwd2
  const canLogin = looksLikeEmail(email) && pwd.length > 0
  const recoveryMatched = normalizeRecoveryCode(retyped) === normalizeRecoveryCode(recovery) && recovery.length > 0

  const msgLine = msg && <p className={cx(css.msg, css['msg_' + msg.kind])}>{msg.text}</p>

  /**
   * 协议版本提示。放进 header，于是**每个视图都看得到** —— 客户端太旧时登录本身
   * 就会失败，只挂在已登录视图里的话，真正需要它的人永远看不到。
   * `unknown`（探不到）什么都不说：离线是常态，不是错误。
   */
  const protoLine = st?.protocol === 'client_too_old'
    ? <p className={cx(css.msg, css.msg_bad)}>{t('acct.proto.tooOld')}</p>
    : st?.protocol === 'client_deprecated'
      ? <p className={cx(css.msg, css.msg_warn)}>{st.protocolSunset
        ? t('acct.proto.deprecated.until', { date: new Date(st.protocolSunset * 1000).toLocaleDateString() })
        : t('acct.proto.deprecated')}</p>
      : null

  const header = (
    <>
      <h2 className={css.title}>{t('acct.title')}</h2>
      {st && <p className={css.meta}>{t('acct.host')} {st.host}</p>}
      {protoLine}
    </>
  )

  if (view === 'signedIn' && st) {
    return (
      <div className={css.section}>
        {header}
        <dl className={css.facts}>
          <dt>{t('acct.signedIn.as')}</dt><dd>{st.email ?? '—'}</dd>
          <dt>{t('acct.shortId')}</dt><dd><code className={css.mono}>{st.shortId ?? '—'}</code> <span className={css.dim}>{t('acct.shortId.hint')}</span></dd>
          <dt>{t('acct.reachable')}</dt><dd>{st.reachable === false ? t('acct.reachable.no') : st.reachable ? t('acct.reachable.yes') : '—'}</dd>
        </dl>
        <p className={css.note}>{t('acct.protection')}</p>
        {!st.unlocked && <p className={css.warnNote}>{t('acct.locked')}</p>}
        {msgLine}

        {pending.length > 0 && (
          <div className={css.block}>
            <h3 className={css.subtitle}>{t('acct.approvals')}</h3>
            <ul className={css.list}>
              {pending.map((p) => (
                <li key={p.approval_id} className={css.row}>
                  <div className={css.grow}>
                    <div>{p.device_name ?? '—'} · {p.platform ?? '—'}</div>
                    <div className={css.dim}>{t('acct.approval.code')}</div>
                  </div>
                  <Button variant="primary" size="sm" disabled={busy} onClick={() => { approve(p) }}>{t('acct.approve')}</Button>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className={css.block}>
          <h3 className={css.subtitle}>{t('acct.devices')}</h3>
          <ul className={css.list}>
            {devices.map((d) => (
              <li key={d.id} className={css.row}>
                <div className={css.grow}>
                  <div>{d.name ?? '—'}{d.is_current ? <span className={css.tag}>{t('acct.device.current')}</span> : null}</div>
                  <div className={css.dim}>{d.platform ?? '—'} · {t(`acct.device.${d.status}`)}</div>
                </div>
                {d.status !== 'revoked' && (
                  <Button variant="ghost" size="sm" disabled={busy}
                    onClick={() => { if (d.is_current && confirmRevoke !== d.id) setConfirmRevoke(d.id); else revoke(d.id) }}>
                    {d.is_current && confirmRevoke === d.id ? t('acct.device.revoke.confirm') : t('acct.device.revoke')}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>

        <div className={css.actions}>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => { void refresh(true).then(loadDevices) }}>{t('acct.refresh')}</Button>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => { setPwd(''); goto('rotate') }}>{t('acct.rotate')}</Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={signOut}>{t('acct.signOut')}</Button>
        </div>
      </div>
    )
  }

  if (view === 'recoveryCode') {
    return (
      <div className={css.section}>
        {header}
        <h3 className={css.subtitle}>{t('acct.recovery.title')}</h3>
        <p className={css.warnNote}>{t('acct.recovery.once')}</p>
        <div className={css.code}>{prettyRecoveryCode(normalizeRecoveryCode(recovery))}</div>
        <p className={css.note}>{t('acct.recovery.retype')}</p>
        <Input className={cx(css.input, css.mono)} name="recovery-retype" value={retyped} autoFocus spellCheck={false}
          onChange={(e) => { setRetyped(e.target.value) }} />
        {msgLine}
        <div className={css.actions}>
          <Button variant="primary" size="sm" disabled={busy || !recoveryMatched} onClick={doConfirmRecovery}>{t('acct.recovery.confirm')}</Button>
        </div>
      </div>
    )
  }

  if (view === 'rotate') {
    return (
      <div className={css.section}>
        {header}
        <h3 className={css.subtitle}>{t('acct.rotate')}</h3>
        <p className={css.note}>{t('acct.rotate.intro')}</p>
        <Input className={cx(css.input)} type="password" placeholder={t('acct.password')} value={pwd} autoFocus
          onChange={(e) => { setPwd(e.target.value) }} onKeyDown={(e) => { if (e.key === 'Enter' && pwd) doRotate() }} />
        {msgLine}
        <div className={css.actions}>
          <Button variant="primary" size="sm" disabled={busy || !pwd} onClick={doRotate}>{t('acct.rotate.go')}</Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => { goto('signedIn') }}>{t('acct.back')}</Button>
        </div>
      </div>
    )
  }

  if (view === 'verify') {
    return (
      <div className={css.section}>
        {header}
        {msgLine}
        <Input className={cx(css.input, css.mono)} value={code} maxLength={CODE_LEN} autoFocus spellCheck={false}
          placeholder={t('acct.code')}
          onChange={(e) => { setCode(e.target.value.toUpperCase()) }}
          onKeyDown={(e) => { if (e.key === 'Enter' && code.length === CODE_LEN) doVerify() }} />
        <div className={css.actions}>
          <Button variant="primary" size="sm" disabled={busy || code.length !== CODE_LEN} onClick={doVerify}>{t('acct.verify')}</Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => { goto('register') }}>{t('acct.back')}</Button>
        </div>
      </div>
    )
  }

  if (view === 'forgot') {
    return (
      <div className={css.section}>
        {header}
        <p className={css.note}>{t('acct.forgot.intro')}</p>
        {/* 走完这一步会踢掉其它全部设备 —— 这正是它能把被人占走的账号夺回来的原因，
            但必须**事前**说清，不能让用户点完才发现别的设备上退登了。 */}
        <p className={css.warnNote}>{t('acct.forgot.willKick')}</p>
        <Input className={cx(css.input)} type="email" placeholder={t('acct.email')} value={email} onChange={(e) => { setEmail(e.target.value) }} />
        {!challengeSent ? (
          <div className={css.actions}>
            <Button variant="primary" size="sm" disabled={busy || !looksLikeEmail(email)} onClick={doChallenge}>{t('acct.forgot.send')}</Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => { goto('login') }}>{t('acct.back')}</Button>
          </div>
        ) : (
          <>
            <Input className={cx(css.input, css.mono)} placeholder={t('acct.code')} value={fEmailCode} maxLength={CODE_LEN} spellCheck={false}
              onChange={(e) => { setFEmailCode(e.target.value.toUpperCase()) }} />
            <Input className={cx(css.input, css.mono)} placeholder={t('acct.forgot.recovery')} value={fRecovery} spellCheck={false}
              onChange={(e) => { setFRecovery(e.target.value) }} />
            <Input className={cx(css.input)} type="password" placeholder={`${t('acct.forgot.newPassword')} · ${t('acct.password.min')}`} value={fNewPwd}
              onChange={(e) => { setFNewPwd(e.target.value) }} />
            <div className={css.actions}>
              <Button variant="primary" size="sm"
                disabled={busy || fEmailCode.length !== CODE_LEN || !fRecovery || fNewPwd.length < MIN_PASSWORD}
                onClick={doRecover}>{t('acct.forgot.go')}</Button>
              <Button variant="ghost" size="sm" disabled={busy} onClick={() => { goto('login') }}>{t('acct.back')}</Button>
            </div>
          </>
        )}
        {msgLine}
      </div>
    )
  }

  // login / register
  const registering = view === 'register'
  return (
    <div className={css.section}>
      {header}
      <p className={css.intro}>{t('acct.intro')}</p>
      <Input className={cx(css.input)} type="email" placeholder={t('acct.email')} value={email} autoFocus
        onChange={(e) => { setEmail(e.target.value) }} />
      <Input className={cx(css.input)} type="password" placeholder={registering ? `${t('acct.password')} · ${t('acct.password.min')}` : t('acct.password')} value={pwd}
        onChange={(e) => { setPwd(e.target.value) }}
        onKeyDown={(e) => { if (e.key === 'Enter' && !registering && canLogin) doLogin() }} />
      {registering && (
        <>
          <Input className={cx(css.input)} type="password" placeholder={t('acct.password.again')} value={pwd2}
            onChange={(e) => { setPwd2(e.target.value) }}
            onKeyDown={(e) => { if (e.key === 'Enter' && canRegister) doRegister() }} />
          {pwd2.length > 0 && pwd !== pwd2 && <p className={css.err}>{t('acct.password.mismatch')}</p>}
        </>
      )}
      {msgLine}
      <p className={css.note}>{t('acct.protection')}</p>
      <div className={css.actions}>
        {registering ? (
          <>
            <Button variant="primary" size="sm" disabled={busy || !canRegister} onClick={doRegister}>{t('acct.register')}</Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => { goto('login') }}>{t('acct.back')}</Button>
          </>
        ) : (
          <>
            <Button variant="primary" size="sm" disabled={busy || !canLogin} onClick={doLogin}>{t('acct.login')}</Button>
            <Button variant="outline" size="sm" disabled={busy} onClick={() => { setPwd2(''); goto('register') }}>{t('acct.register')}</Button>
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setChallengeSent(false); goto('forgot') }}>{t('acct.forgot')}</Button>
          </>
        )}
      </div>
    </div>
  )
}
