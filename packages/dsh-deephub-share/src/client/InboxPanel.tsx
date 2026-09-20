/**
 * 「朋友与收件箱」一级面板。
 *
 * 两件东西：
 *   `PanelIcon` —— 左栏那一行的图标（行本身、文字、点击都是 dsh 画的，我们只给图标）。
 *                  未读数字只能挂在这 16px 的图标上：那一行的 label 是注册时给的一个字符串，
 *                  跟着语言走、不跟着数据走，塞不进活的数字。
 *   `InboxPanel` —— 主区整页。左边一列人（我的名片 → 朋友 → 想加你的人 → 加朋友），
 *                   右边看选中那个人发来的。
 *
 * 一条没变的规矩：**收下之前看不到内容**。服务端零知识，标题在密文里，它自己也解不开，
 * 所以这一屏绝不假装能预览。「收下」才是真取：取回 + 解密 + 落成一条新会话，落完直接跳过去。
 * 落到哪个工作区由上面那个选择器定，只有一个工作区时不显示它。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { Button, Input, Menu } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { NS } from './locales.ts'
import {
  daysAgo, daysLeft, dropItem, fileSize, inboxApi as api, openSession, refreshInbox, useInbox,
  type AcceptFailure, type FriendWithRemark, type InboxItem, type LandedIdea, type WorkspaceChoice,
} from './inbox-api.ts'
import { friendName } from '../shared/social.ts'
import css from './InboxPanel.module.css'

type T = TranslateNS<typeof NS>

export type InboxPanelProps = PropsRuntime<'main'> & { t: T }

const cx = (...ks: Array<string | undefined | false>): string =>
  ks.filter((k): k is string => typeof k === 'string' && k.length > 0).join(' ')

/** 短 ID 长这样：DH-XXXX-XXX。就地判长度，真假由服务端说了算。 */
const SHORT_ID_LEN = 11

/**
 * 一个人显示成什么。三级回退：**我的备注 → 他自己设的 → 「未设置名字」**，
 * 规则在 `shared/social.ts` 里写一次，界面各处都走它。
 *
 * 备注只有我看得到 —— 它是用主密钥加密之后才上服务端的。
 */
const nameOf = (f: { remark?: string | null; displayName: string | null }, t: T): string =>
  friendName(f, t('inbox.unnamed'))
/** 头像就是名字第一个字；两个名字都没有就用短 ID 去掉 DH- 的第一个字符。 */
const initial = (f: { remark?: string | null; displayName: string | null; shortId: string }): string =>
  friendName(f, f.shortId.replace('DH-', '')).slice(0, 1).toUpperCase()

/** 工作区显示名：路径的最后一段。只是切路径，不猜含义。 */
const wsName = (cwd: string | null): string => {
  if (cwd === null) return ''
  const parts = cwd.split('\\').join('/').split('/').filter((x) => x.length > 0)
  return parts[parts.length - 1] ?? ''
}

function whenText(s: number, t: T): string {
  const d = daysAgo(s)
  return d === 0 ? t('inbox.today') : d === 1 ? t('inbox.yesterday') : t('inbox.daysAgo', { n: d })
}

// ── 左栏那一行的图标 ────────────────────────────────────────────────────

/**
 * 图标 + 未读数字。`size` 由 dsh 给（当前是 16），`active` 是这个面板选中没有。
 * 数字做得比图标窄一点、外面套一圈底色，免得盖住图标看不清。
 */
export function PanelIcon({ size, active }: PropsRuntime<'sidebar.panellist'>) {
  const { items } = useInbox()
  return (
    <span className={css.glyph} data-deephub-panel-icon>
      <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
        strokeWidth={active ? 2.2 : 1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M16 20v-2a4 4 0 0 0-8 0v2" /><circle cx="12" cy="9" r="3" />
        <path d="M3 20v-1a4 4 0 0 1 3-3.87" />
      </svg>
      {items.length > 0
        ? <span className={css.glyphBadge} data-deephub-panel-badge>{items.length > 99 ? '99+' : items.length}</span>
        : null}
    </span>
  )
}

/** 收不下来的原因 → 文案键。多出来的原因（老服务端）落到 `other`。 */
const FAIL_KEY = {
  offline: 'inbox.accept.fail.offline',
  no_key: 'inbox.accept.fail.no_key',
  not_found: 'inbox.accept.fail.not_found',
  undecryptable: 'inbox.accept.fail.undecryptable',
  malformed: 'inbox.accept.fail.malformed',
} as const satisfies Record<AcceptFailure, string>

// ── 一条待收 ────────────────────────────────────────────────────────────

function IdeaRow({ item, t, onGone, workspaceId, canAccept, onLanded }: {
  item: InboxItem
  t: T
  onGone: (id: string) => void
  /** 落到哪个工作区；undefined = 让 Host 用第一个 */
  workspaceId: string | undefined
  /** 一个工作区都没有的时候收不了 */
  canAccept: boolean
  /** 收下成功之后叫一声，让「已收下」那份清单作废、下次点开重查 */
  onLanded: () => void
}) {
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState<'' | 'accept' | 'reject'>('')
  const [err, setErr] = useState<string | null>(null)

  const accept = async (): Promise<void> => {
    setBusy('accept')
    setErr(null)
    try {
      const r = await api.acceptIdea(item.deliveryId, {
        ...(workspaceId === undefined ? {} : { workspaceId }),
        // 标题模板原样传给 Host —— 缺参数时 dsh 的 t() 会把 {who}/{title} 留在原地，正是要的
        titleFmt: t('inbox.idea.landedTitle'),
        unnamed: t('inbox.unnamed'),
      })
      if (!r.ok) { setErr(t(FAIL_KEY[r.reason] ?? 'inbox.accept.fail.other')); return }
      onGone(item.deliveryId)
      onLanded()
      // 落好了就跳过去。跳不了（这份 dsh 没有 uiWorkspace）也不算失败——会话已经在工作区里了
      openSession(r.sessionId)
    } catch (e) { setErr((e as Error).message) } finally { setBusy('') }
  }

  const reject = async (): Promise<void> => {
    if (!confirm) { setConfirm(true); return }
    setBusy('reject')
    setErr(null)
    try {
      const r = await api.rejectIdea(item.deliveryId)
      if (r.ok) onGone(item.deliveryId)
      else setErr(t('inbox.idea.rejectFail'))
    } catch (e) { setErr((e as Error).message) } finally { setBusy('') }
  }

  return (
    <li className={css.item} data-deephub-inbox-item>
      <div className={css.itemMeta}>
        {[
          fileSize(item.size),
          item.attachments > 0 ? t('inbox.idea.attachments', { n: item.attachments }) : '',
          whenText(item.createdAt, t),
          t('inbox.idea.expires', { n: daysLeft(item.expiresAt) }),
        ].filter(Boolean).join(' · ')}
      </div>
      <div className={css.itemFoot}>
        <span className={css.dim}>{t('inbox.idea.sealed')}</span>
        <span className={css.ops}>
          <Button variant="primary" size="sm" disabled={busy !== '' || !canAccept}
            onClick={() => { void accept() }}>
            {busy === 'accept' ? t('inbox.idea.accepting') : t('inbox.idea.accept')}
          </Button>
          <Button variant="ghost" size="sm" disabled={busy !== ''} onClick={() => { void reject() }}>
            {confirm ? t('inbox.idea.rejectConfirm') : t('inbox.idea.reject')}
          </Button>
        </span>
      </div>
      {err !== null ? <div className={css.err}>{err}</div> : null}
    </li>
  )
}

// ── 「已收下」那一栏 ────────────────────────────────────────────────────

/**
 * 过去收下的思路。**每条就是一条会话**，点「打开」直接跳过去。
 * 这份清单是现从 dsh 会话库里挑的，所以用户在 dsh 里删掉哪条，这儿就少哪条。
 */
function LandedList({ list, t }: { list: LandedIdea[] | null; t: T }) {
  if (list === null) return <p className={css.dim}>{t('inbox.landed.loading')}</p>
  if (list.length === 0) return <p className={css.dim}>{t('inbox.landed.empty')}</p>
  return (
    <>
      <div className={css.sectitle}>
        <span>{t('inbox.landed.n', { n: list.length })}</span>
        <span className={css.dim}>{t('inbox.landed.hint')}</span>
      </div>
      <ul className={css.list}>
        {list.map((x) => (
          <li key={x.sessionId} className={css.item} data-deephub-landed-item>
            <div className={css.landedHead}>
              <span className={css.landedTitle}>{x.title || t('inbox.landed.untitled')}</span>
              <Button variant="ghost" size="sm" onClick={() => { openSession(x.sessionId) }}>
                {t('inbox.landed.open')}
              </Button>
            </div>
            <div className={css.itemMeta}>
              {[wsName(x.cwd), whenText(Math.floor(x.createdAt / 1000), t)].filter(Boolean).join(' · ')}
            </div>
          </li>
        ))}
      </ul>
    </>
  )
}

// ── 主区整页 ────────────────────────────────────────────────────────────

export function InboxPanel({ t }: InboxPanelProps) {
  const st = useInbox()
  const [picked, setPicked] = useState<string | null>(null)
  const [shortId, setShortId] = useState('')
  const [addMsg, setAddMsg] = useState<{ kind: 'ok' | 'bad'; text: string } | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState('')
  const [copied, setCopied] = useState(false)
  const [busy, setBusy] = useState(false)
  /**
   * 朋友那一行的右键菜单。
   *
   * 没用 dsh 那个 `Menu` 原语：它是**锚在触发元素上**的，右键菜单要跟着鼠标，
   * 得拿一个 0×0 的假锚点去骗它。就手画一个，十来行，位置也拿得准。
   * `createPortal` 出去是因为左边这一列有 `overflow`，会把它裁掉。
   */
  const [ctxMenu, setCtxMenu] = useState<{ accountId: string; x: number; y: number } | null>(null)
  /** 正在改谁的备注。null = 没在改。 */
  const [remarking, setRemarking] = useState<string | null>(null)
  const [remarkText, setRemarkText] = useState('')
  /** 收下落到哪儿。进面板时问一次 Host；工作区是 dsh 那边的东西，不跟着轮询走 */
  const [spaces, setSpaces] = useState<WorkspaceChoice[]>([])
  const [wsId, setWsId] = useState<string | null>(null)
  const [wsOpen, setWsOpen] = useState(false)
  /** 右边这会儿在看什么：某个人，还是「已收下」那一栏 */
  const [view, setView] = useState<'people' | 'landed'>('people')
  /** null = 还没查过（点开才查，见 landed.ts：这份清单不跟着 30 秒轮询走） */
  const [landed, setLanded] = useState<LandedIdea[] | null>(null)

  /** 每个人有几份等着 */
  const pendingOf = useMemo(() => {
    const m = new Map<string, InboxItem[]>()
    for (const x of st.items) {
      const list = m.get(x.from.shortId)
      if (list === undefined) m.set(x.from.shortId, [x]); else list.push(x)
    }
    return m
  }, [st.items])

  /** 一个列表，有待收的排最上面；其余按名字。**不分「待收」「朋友」两组**，省得同一个人出现两次 */
  const people = useMemo(() => {
    const n = (f: FriendWithRemark): number => pendingOf.get(f.shortId)?.length ?? 0
    return [...st.friends].sort((a, b) => n(b) - n(a) || nameOf(a, t).localeCompare(nameOf(b, t)))
  }, [st.friends, pendingOf, t])

  // 选中谁：用户没点过就跟着数据走（优先有待收的那个）
  const current = useMemo(() => {
    const byId = people.find((f) => f.accountId === picked)
    return byId ?? people[0] ?? null
  }, [people, picked])

  useEffect(() => { setName(st.displayName ?? '') }, [st.displayName])

  // 右键菜单：点任何地方、滚动、按 Esc 都关掉。**滚动也要关** ——
  // 它是 fixed 定位的，左边这列一滚，菜单会停在原地指着另一个人。
  useEffect(() => {
    if (ctxMenu === null) return
    const close = (): void => { setCtxMenu(null) }
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') close() }
    document.addEventListener('mousedown', close)
    document.addEventListener('scroll', close, true)
    window.addEventListener('resize', close)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('scroll', close, true)
      window.removeEventListener('resize', close)
      window.removeEventListener('keydown', onKey)
    }
  }, [ctxMenu])

  useEffect(() => {
    let alive = true
    void api.workspaces()
      .then((r) => { if (alive) setSpaces(r.list) })
      .catch(() => { if (alive) setSpaces([]) })
    return () => { alive = false }
  }, [])

  const act = useCallback(async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try { await fn(); await refreshInbox() } finally { setBusy(false) }
  }, [])

  /** 点开「已收下」：第一次点才去查，之后用手里这份；收下一份新的会把它清空重查。 */
  const openLanded = (): void => {
    setView('landed')
    if (landed !== null) return
    void api.landed()
      .then((r) => { setLanded(r.list) })
      .catch(() => { setLanded([]) })
  }

  const add = async (): Promise<void> => {
    const id = shortId.trim().toUpperCase()
    if (id.length !== SHORT_ID_LEN) { setAddMsg({ kind: 'bad', text: t('inbox.add.badId') }); return }
    setBusy(true)
    setAddMsg(null)
    try {
      const r = await api.request(id)
      setAddMsg(r.ok ? { kind: 'ok', text: t('inbox.add.ok') } : { kind: 'bad', text: t('inbox.add.badId') })
      if (r.ok) setShortId('')
    } catch (e) { setAddMsg({ kind: 'bad', text: (e as Error).message }) } finally { setBusy(false) }
  }

  const copyId = async (): Promise<void> => {
    if (st.shortId === null) return
    try { await navigator.clipboard.writeText(st.shortId); setCopied(true); setTimeout(() => { setCopied(false) }, 1500) }
    catch { /* 剪贴板被拒就算了 */ }
  }

  const saveName = async (): Promise<void> => {
    setBusy(true)
    try { await api.setName(name.trim()); setRenaming(false); await refreshInbox() } finally { setBusy(false) }
  }

  /**
   * 存备注。空串＝清掉。
   *
   * 与 `saveName` 是两件事：那个改的是「我对外叫什么」，全世界看得到；
   * 这个改的是「我管他叫什么」，加密后存服务端，只有我自己的设备解得开。
   */
  const saveRemark = async (accountId: string): Promise<void> => {
    setBusy(true)
    try {
      await api.setRemark(accountId, remarkText.trim())
      setRemarking(null)
      await refreshInbox()
    } finally { setBusy(false) }
  }

  /** 右键菜单点「设置备注」：选中这个人、切到他，再把页头换成输入框。 */
  const beginRemark = (f: { accountId: string; remark: string | null }): void => {
    setPicked(f.accountId)
    setView('people')
    setRemarkText(f.remark ?? '')
    setRemarking(f.accountId)
    setCtxMenu(null)
  }

  if (st.loggedIn === null) {
    // 拉不到状态就如实说，别一直转圈——Host 半没装上时，转圈会转到天荒地老
    return (
      <div className={css.blank} data-deephub-inbox-panel>
        {st.error === null
          ? <p className={css.dim}>{t('inbox.checking')}</p>
          : <p className={css.err}>{t('inbox.statusFail', { message: st.error })}</p>}
      </div>
    )
  }
  if (!st.loggedIn) {
    return <div className={css.blank} data-deephub-inbox-panel><p className={css.dim}>{t('inbox.needLogin')}</p></div>
  }

  const mine = current === null ? [] : pendingOf.get(current.shortId) ?? []
  // 用户没选过就用第一个（Host 那边的默认也是第一个，两边一致）
  const ws = spaces.find((w) => w.id === wsId) ?? spaces[0] ?? null

  return (
    <div className={css.root} data-deephub-inbox-panel>

      {/* ── 左：我的名片 + 人名单 + 加朋友 ── */}
      <aside className={css.people}>
        <div className={css.me}>
          <span className={cx(css.av, css.avMe)}>{(st.displayName ?? 'me').slice(0, 1).toUpperCase()}</span>
          <span className={css.meBody}>
            {renaming
              ? <Input className={cx(css.nameInput)} value={name} placeholder={t('inbox.me.namePlaceholder')}
                  onChange={(e) => { setName(e.target.value) }} />
              : <span className={css.meName}>{st.displayName ?? t('inbox.unnamed')}</span>}
            <span className={cx(css.dim, css.mono)}>{st.shortId ?? '—'}</span>
          </span>
          <span className={css.meOps}>
            {renaming
              ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void saveName() }}>{t('inbox.me.save')}</Button>
              : <>
                  <Button variant="ghost" size="sm" disabled={st.shortId === null} onClick={() => { void copyId() }}>
                    {copied ? t('inbox.copied') : t('inbox.copy')}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => { setRenaming(true) }}>{t('inbox.me.rename')}</Button>
                </>}
          </span>
        </div>

        <div className={css.scroll}>
          {st.error !== null ? <p className={css.err}>{t('inbox.loadFail', { message: st.error })}</p> : null}

          <button type="button" className={cx(css.prow, view === 'landed' && css.prowOn)}
            data-deephub-landed-row onClick={openLanded}>
            <span className={cx(css.av, css.avGhost)}>✓</span>
            <span className={css.prowBody}>
              <span className={css.prowName}>{t('inbox.landed')}</span>
              <span className={css.dim}>
                {landed === null ? '' : t('inbox.landed.count', { n: landed.length })}
              </span>
            </span>
          </button>

          <div className={css.grouphead}>{t('inbox.friends')} · {people.length}</div>
          {people.length === 0
            ? <p className={cx(css.dim, css.pad)}>{t('inbox.people.empty')}</p>
            : <ul className={css.list}>
                {people.map((f) => {
                  const n = pendingOf.get(f.shortId)?.length ?? 0
                  const on = current !== null && current.accountId === f.accountId
                  return (
                    <li key={f.accountId}>
                      <button type="button" className={cx(css.prow, on && css.prowOn)} data-deephub-person
                        onClick={() => { setPicked(f.accountId); setView('people') }}
                        onContextMenu={(e) => {
                          e.preventDefault()
                          setCtxMenu({ accountId: f.accountId, x: e.clientX, y: e.clientY })
                        }}>
                        <span className={css.av}>{initial(f)}</span>
                        <span className={css.prowBody}>
                          <span className={css.prowName}>{nameOf(f, t)}</span>
                          <span className={cx(css.dim, n === 0 && css.mono)}>
                            {n > 0 ? t('inbox.pending.n', { n }) : f.shortId}
                          </span>
                        </span>
                        {n > 0 ? <span className={css.badge}>{n}</span> : null}
                      </button>
                    </li>
                  )
                })}
              </ul>}

          {st.incoming.length > 0 ? (
            <>
              <div className={css.grouphead}>{t('inbox.requests')} · {st.incoming.length}</div>
              <ul className={css.list}>
                {st.incoming.map((r) => (
                  <li key={r.requestId} className={css.prow} data-deephub-request>
                    <span className={css.av}>?</span>
                    <span className={css.prowBody}>
                      <span className={cx(css.prowName, css.mono)}>{r.shortId}</span>
                      <span className={css.dim}>{whenText(r.createdAt, t)}</span>
                    </span>
                    <span className={css.reqOps}>
                      <Button variant="primary" size="sm" disabled={busy} onClick={() => { void act(() => api.accept(r.requestId)) }}>
                        {t('inbox.request.accept')}
                      </Button>
                      <Button variant="ghost" size="sm" disabled={busy} onClick={() => { void act(() => api.rejectRequest(r.requestId)) }}>
                        {t('inbox.request.reject')}
                      </Button>
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : null}
        </div>

        <div className={css.addhead}>{t('inbox.add')}</div>
        <div className={css.addbar}>
          <Input className={cx(css.addInput)} value={shortId} placeholder={t('inbox.add.placeholder')}
            onChange={(e) => { setShortId(e.target.value); setAddMsg(null) }} />
          <Button variant="primary" size="sm" disabled={busy || shortId.trim().length === 0} onClick={() => { void add() }}>
            {t('inbox.add.send')}
          </Button>
        </div>
        {addMsg !== null ? <p className={cx(css.pad, addMsg.kind === 'ok' ? css.ok : css.err)}>{addMsg.text}</p> : null}
      </aside>

      {/* ── 右：这个人发来的 ── */}
      <section className={css.detail}>
        {view === 'landed'
          ? <LandedList list={landed} t={t} />
          : current === null
          ? <p className={css.dim}>{t('inbox.detail.pick')}</p>
          : <>
              <div className={css.dhead}>
                <span className={cx(css.av, css.avLg)}>{initial(current)}</span>
                <span className={css.dheadBody}>
                  {remarking === current.accountId
                    ? <Input className={cx(css.remarkInput)} value={remarkText} autoFocus
                        placeholder={t('inbox.remark.placeholder')}
                        onChange={(e) => { setRemarkText(e.target.value) }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !busy) void saveRemark(current.accountId)
                          else if (e.key === 'Escape') setRemarking(null)
                        }} />
                    : <span className={css.dheadName}>{nameOf(current, t)}</span>}
                  <span className={cx(css.dim, css.mono)}>
                    {current.shortId}
                    {/* 有备注时把**他自己设的那个名字**补在这儿：上面那行只显示备注，
                        不补的话「他在 DeepHub 上管自己叫什么」就没有任何地方看得到了。
                        不加「他叫」这种前缀——这一行本来就是一串事实。 */}
                    {current.remark !== null && current.displayName !== null ? ` · ${current.displayName}` : ''}
                    {current.friendPub === null ? ` · ${t('inbox.friend.notReady')}` : ''}
                  </span>
                </span>
                {remarking === current.accountId
                  ? <span className={css.dheadSave}>
                      <Button variant="ghost" size="sm" disabled={busy}
                        onClick={() => { void saveRemark(current.accountId) }}>
                        {t('inbox.remark.save')}
                      </Button>
                    </span>
                  : null}
                <Button variant="ghost" size="sm" disabled={busy}
                  onClick={() => { void act(() => api.remove(current.accountId)) }}>
                  {t('inbox.friend.remove')}
                </Button>
              </div>

              {mine.length === 0
                ? <p className={css.dim}>{t('inbox.detail.none')}</p>
                : <>
                    <div className={css.sectitle}>
                      <span>{t('inbox.detail.pending', { n: mine.length })}</span>
                      {/* 只有一个工作区就不问了；一个都没有时说清楚为什么收不了 */}
                      {spaces.length > 1 && ws !== null ? (
                        <span className={css.landTo} data-deephub-land-to>
                          <span className={css.dim}>{t('inbox.landTo')}</span>
                          <Menu
                            open={wsOpen}
                            anchor={
                              <Button variant="ghost" size="sm" onClick={() => { setWsOpen((v) => !v) }}>
                                {ws.title}
                              </Button>
                            }
                            items={spaces.map((w) => ({ id: w.id, label: w.title }))}
                            selectedId={ws.id}
                            onSelect={(id) => { setWsId(id); setWsOpen(false) }}
                            onClose={() => { setWsOpen(false) }}
                            align="end"
                          />
                        </span>
                      ) : null}
                    </div>
                    {spaces.length === 0 ? <p className={css.err}>{t('inbox.landTo.none')}</p> : null}
                    <ul className={css.list}>
                      {mine.map((x) => (
                        <IdeaRow key={x.deliveryId} item={x} t={t} onGone={dropItem}
                          workspaceId={ws?.id} canAccept={ws !== null}
                          onLanded={() => { setLanded(null) }} />
                      ))}
                    </ul>
                  </>}
            </>}
      </section>

      {/* 朋友行的右键菜单。portal 出去（左边那列有 overflow，会把它裁掉），fixed 跟着鼠标。
          菜单自己吞掉 mousedown，否则上面那个"点别处就关"会抢先把它关了。
          位置做了个简单的靠边收，贴到窗口右下角时往回挪，免得被切掉半边。 */}
      {ctxMenu !== null
        ? createPortal(
            <div className={css.ctx} data-deephub-person-ctx
              style={{
                left: Math.min(ctxMenu.x, window.innerWidth - 168),
                top: Math.min(ctxMenu.y, window.innerHeight - 56),
              }}
              onMouseDown={(e) => { e.stopPropagation() }}>
              <button type="button" className={css.ctxItem}
                onClick={() => {
                  // 列表可能已经刷新过了（比如刚被解除关系），现找一遍，找不到就只关菜单
                  const f = st.friends.find((x) => x.accountId === ctxMenu.accountId)
                  if (f === undefined) { setCtxMenu(null); return }
                  beginRemark(f)
                }}>
                {t('inbox.remark.menu')}
              </button>
            </div>,
            document.body,
          )
        : null}
    </div>
  )
}
