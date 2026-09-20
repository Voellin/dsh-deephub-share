/**
 * 分享一屏。与 DeepHub 桌面端同一套流程，只留「从会话进来」这一个入口：
 *
 *   ① 发给 —— 选人；名单为空就**原地变成输入框加人**，页面不跳
 *   ② 内容 —— 一打开就整理，标题 + 一行数量摘要，全文默认收起、点开在原地长出来
 *   ③ 扫描 —— **手动点**，扫完按钮原地变结果
 *   ④ 附件 —— 默认不带，逐个勾，**勾了才出那行警告**
 *
 * 四条规矩：全文永远和发送键同框；没跑扫描绝不出现"已检查"字样；附件没有全选总开关；
 * 扫描失败不挡分享。另加一条 dsh 独有的：**不登录也能导出 Markdown**。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, Input, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { NS } from './locales.ts'
import type { DeephubShareKey } from './locales.ts'
import {
  fileSize, shareApi as api,
  type AttachmentInfo, type BuildResponse, type FriendWithRemark, type IdeaDoc, type PeekResponse, type RedactCandidate, type SendReason,
} from './share-api.ts'
import { friendName } from '../shared/social.ts'
import css from './ShareModal.module.css'

const cx = (...ks: Array<string | undefined | false>): string => ks.filter((k): k is string => typeof k === 'string' && k.length > 0).join(' ')

type T = TranslateNS<typeof NS>
type Msg = { kind: 'ok' | 'bad' | 'warn'; text: string } | null

const KIND_KEY: Record<RedactCandidate['kind'], DeephubShareKey> = {
  person: 'share.kind.person', company: 'share.kind.company', client: 'share.kind.client',
  money: 'share.kind.money', internal: 'share.kind.internal', link: 'share.kind.link', other: 'share.kind.other',
}
const REASON_KEY: Record<SendReason, DeephubShareKey> = {
  not_friend: 'share.reason.not_friend', peer_no_key: 'share.reason.peer_no_key', no_key: 'share.reason.no_key',
  too_large: 'share.reason.too_large', inbox_full: 'share.reason.inbox_full', offline: 'share.reason.offline',
  too_many_pending: 'share.reason.too_many_pending', no_space: 'share.reason.no_space',
  other: 'share.reason.other',
}

export interface ShareModalProps {
  open: boolean
  onClose: () => void
  sessionId: string
  t: T
}

export function ShareModal({ open, onClose, sessionId, t }: ShareModalProps) {
  // 云端状态
  const [loggedIn, setLoggedIn] = useState<boolean | null>(null)
  const [offline, setOffline] = useState(false)
  const [myShortId, setMyShortId] = useState<string | null>(null)
  const [friends, setFriends] = useState<FriendWithRemark[]>([])
  const [to, setTo] = useState('')
  const [pickPerson, setPickPerson] = useState(false)
  const [addInput, setAddInput] = useState('')
  const [addMsg, setAddMsg] = useState<Msg>(null)
  const [copied, setCopied] = useState(false)
  // 云端状态是异步的：回来之前这一屏不能一片空白配一个灰键
  const [cloudErr, setCloudErr] = useState<string | null>(null)
  const [cloudSlow, setCloudSlow] = useState(false)
  const cloudTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 内容
  const [peeked, setPeeked] = useState<PeekResponse | null>(null)
  const [built, setBuilt] = useState<BuildResponse | null>(null)
  const [building, setBuilding] = useState(false)
  const [buildErr, setBuildErr] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  // 扫描
  const [scanned, setScanned] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [cands, setCands] = useState<RedactCandidate[]>([])

  // 附件
  const [files, setFiles] = useState<AttachmentInfo[]>([])
  const [totalMax, setTotalMax] = useState(15 * 1024 * 1024)
  const [picked, setPicked] = useState<Set<string>>(new Set())

  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [sent, setSent] = useState(false)
  const seq = useRef(0)

  const reset = (): void => {
    setCloudErr(null); setCloudSlow(false)
    setPeeked(null); setBuilt(null); setBuildErr(null); setExpanded(false)
    setScanned(false); setCands([]); setFiles([]); setPicked(new Set())
    setErr(null); setSent(false); setTo(''); setPickPerson(false); setAddInput(''); setAddMsg(null)
  }

  const loadCloud = useCallback(async (mine: number): Promise<void> => {
    if (cloudTimer.current !== null) clearTimeout(cloudTimer.current)
    setCloudErr(null); setCloudSlow(false)
    // 10 秒还没回来就别让人干等：换成「云端状态没回来」+ 重试
    cloudTimer.current = setTimeout(() => { if (mine === seq.current) setCloudSlow(true) }, 10_000)
    try {
      const s = await api.status(true)
      if (mine !== seq.current) return
      setLoggedIn(s.loggedIn)
      setOffline(s.reachable === false)
      setMyShortId(s.shortId)
      if (s.loggedIn && s.reachable !== false) {
        const f = await api.friends()
        if (mine !== seq.current) return
        setFriends(f.friends)
        // 名单里只有一个能收的人：替他选中
        const ready = f.friends.filter((x) => x.friendPub !== null)
        if (ready.length === 1 && ready[0]) setTo((cur) => cur || ready[0]!.accountId)
      }
    } catch (e) {
      if (mine === seq.current) setCloudErr((e as Error).message)
    } finally {
      if (cloudTimer.current !== null) { clearTimeout(cloudTimer.current); cloudTimer.current = null }
      if (mine === seq.current) setCloudSlow(false)
    }
  }, [])

  /** 真正的整理：一次模型调用一份钱，只在用户点了、或 Host 说"已经在跑"时才调。 */
  const build = useCallback(async (mine: number, force = false): Promise<void> => {
    setBuilding(true); setBuildErr(null)
    try {
      const b = await api.build(sessionId, force)
      if (mine !== seq.current) return
      setBuilt(b)
    } catch (e) {
      if (mine === seq.current) setBuildErr((e as Error).message)
    } finally {
      if (mine === seq.current) setBuilding(false)
    }
  }, [sessionId])

  /** 打开时问一句：标题、记录条数、Host 那边有没有现成的结果。不调模型。 */
  const start = useCallback(async (mine: number): Promise<void> => {
    try {
      const p = await api.peek(sessionId)
      if (mine !== seq.current) return
      setPeeked(p)
      if (p.state === 'ready' && p.built !== undefined) setBuilt(p.built)
      // 上次点了整理、人却把对话框关了：那次还在 Host 上跑，挂上去一起等，不再发第二次
      else if (p.state === 'running') void build(mine)
    } catch (e) {
      if (mine === seq.current) setBuildErr((e as Error).message)
    }
  }, [sessionId, build])

  /** 附件只是看一眼工作目录，不花钱，照常先列出来。 */
  const loadFiles = useCallback(async (mine: number): Promise<void> => {
    try {
      const a = await api.attachments(sessionId)
      if (mine !== seq.current) return
      setFiles(a.files); setTotalMax(a.totalMax)
    } catch { /* 附件列不出来不挡整理与发送 */ }
  }, [sessionId])

  // 打开时只做不花钱的事：探云端状态、问 Host 有没有现成结果、列附件
  useEffect(() => {
    if (!open) return
    const mine = ++seq.current
    reset()
    void loadCloud(mine)
    void start(mine)
    void loadFiles(mine)
    return () => {
      seq.current++
      if (cloudTimer.current !== null) { clearTimeout(cloudTimer.current); cloudTimer.current = null }
    }
  }, [open, sessionId, loadCloud, start, loadFiles])

  const doc: IdeaDoc | null = built?.doc ?? null
  // 整理之前用 dsh 的会话标题，整理之后 doc.title 也是同一句（build.ts 不采用模型起的标题）
  const title = doc?.title ?? peeked?.title ?? ''
  const friend = friends.find((f) => f.accountId === to)
  const noFriends = loggedIn === true && !offline && friends.length === 0
  const pickedSize = files.filter((f) => picked.has(f.path)).reduce((n, f) => n + f.size, 0)
  const overTotal = pickedSize > totalMax
  const canSend = !!doc && !!to && loggedIn === true && !offline && !overTotal && !busy && !building

  const scan = async (): Promise<void> => {
    if (!doc || !built?.route) return
    setScanning(true); setErr(null)
    try {
      const r = await api.scan(doc, built.route)
      if (!r.ok) setErr(t('share.scan.fail'))
      else { setCands(r.candidates); setScanned(true) }
    } catch { setErr(t('share.scan.fail')) } finally { setScanning(false) }
  }

  const setAction = (id: string, action: RedactCandidate['action'], replacement?: string): void =>
    setCands((cs) => cs.map((c) => (c.id === id
      ? { ...c, action, ...(replacement !== undefined ? { replacement } : {}) }
      : c)))

  const toggle = (p: string): void =>
    setPicked((s) => { const n = new Set(s); if (n.has(p)) n.delete(p); else n.add(p); return n })

  const addFriend = async (): Promise<void> => {
    setBusy(true); setAddMsg(null)
    try {
      const r = await api.request(addInput.trim())
      // ⚠️ 不能说"已找到 XXX" —— 服务端对不存在的短 ID 也返回成功
      if (r.ok) { setAddInput(''); setAddMsg({ kind: 'ok', text: t('share.add.ok') }) }
      else if (r.reason === 'bad_short_id') setAddMsg({ kind: 'bad', text: t('share.add.badId') })
      else setAddMsg({ kind: 'warn', text: t('share.needLogin') })
      const f = await api.friends(); setFriends(f.friends)
    } catch (e) { setAddMsg({ kind: 'bad', text: (e as Error).message }) } finally { setBusy(false) }
  }

  const copyMyId = async (): Promise<void> => {
    if (!myShortId) return
    try { await navigator.clipboard.writeText(myShortId); setCopied(true); setTimeout(() => { setCopied(false) }, 1600) } catch { /* 剪贴板不可用就算了 */ }
  }

  const send = async (): Promise<void> => {
    if (!doc || !to) return
    setBusy(true); setErr(null)
    try {
      const r = await api.send(sessionId, to, doc, [...picked], cands)
      if (r.ok) setSent(true)
      else setErr(t(REASON_KEY[r.reason] ?? 'share.reason.other'))
    } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  const exportMd = async (): Promise<void> => {
    if (!doc) return
    setBusy(true); setErr(null)
    try { await api.exportMarkdown(doc, cands) } catch (e) { setErr((e as Error).message) } finally { setBusy(false) }
  }

  const tryClose = (): void => { if (!busy) onClose() }
  const sep = t('share.deps.sep')
  const summary = doc
    ? [
      doc.deps.tools.length + doc.deps.connectors.length + doc.deps.capabilities.length ? t('share.sum.deps') : '',
      doc.steps.length ? t('share.sum.steps', { n: doc.steps.length }) : '',
      doc.forks.length ? t('share.sum.forks', { n: doc.forks.length }) : '',
      doc.raw.length ? t('share.sum.raw', { n: doc.raw.length }) : '',
    ].filter(Boolean).join(' · ')
    : ''

  if (!open) return null

  if (sent) {
    return (
      <Modal open onClose={onClose} title={t('modal.title')} closeLabel={t('modal.close')} className={cx(css.dialogNarrow)}
        footer={<div className={css.footer}><Button variant="primary" size="sm" onClick={onClose}>{t('share.ok')}</Button></div>}>
        <p className={css.ok}>{t('share.done')}</p>
        <p className={css.dim}>{t('share.done.sub')}</p>
      </Modal>
    )
  }

  return (
    <Modal open onClose={tryClose} title={t('modal.title')} closeLabel={t('modal.close')}
      className={cx(css.dialog)} contentClassName={cx(css.content)}
      footer={(
        <div className={css.footer}>
          <span className={cx(css.dim, css.footerHint)}>{t('share.attach.toWhom')}</span>
          <span className={css.grow} />
          <Button variant="outline" size="sm" disabled={!doc || busy} onClick={() => { void exportMd() }}>{t('share.export')}</Button>
          <Button variant="primary" size="sm" disabled={!canSend} onClick={() => { void send() }}>{busy ? t('share.sending') : t('share.send')}</Button>
        </div>
      )}>
      <div className={css.body} data-deephub-share-modal>
        {offline && <p className={cx(css.note, css.warn)}>{t('share.offline')}</p>}
        {loggedIn === false && <p className={cx(css.note, css.warn)}>{t('share.needLogin')}</p>}

        {/* 云端状态还没回来：占住「发给」这一行，别留一片空白配一个灰掉的发送键 */}
        {loggedIn === null && (
          <div className={css.split}>
            <span className={cx(css.dim, css.grow)}>
              {cloudErr !== null || cloudSlow ? t('share.cloud.stuck') : t('share.cloud.checking')}
              {cloudErr !== null && <span className={css.dim}> {cloudErr}</span>}
            </span>
            {(cloudErr !== null || cloudSlow) && (
              <Button variant="outline" size="sm" onClick={() => { void loadCloud(seq.current) }}>{t('share.retry')}</Button>
            )}
          </div>
        )}

        {/* ── ① 发给 ── */}
        {loggedIn === true && (
          <div className={css.row}>
            <span className={css.label}>{t('share.to')}</span>
            {noFriends ? (
              <div className={css.addWrap}>
                <div className={css.addLine}>
                  <Input className={cx(css.input, css.mono)} value={addInput} placeholder={t('share.add.placeholder')} spellCheck={false}
                    onChange={(e) => { setAddInput(e.target.value); setAddMsg(null) }}
                    onKeyDown={(e) => { if (e.key === 'Enter' && addInput.trim() && !busy) void addFriend() }} />
                  <Button variant="outline" size="sm" disabled={busy || !addInput.trim()} onClick={() => { void addFriend() }}>{t('share.add.send')}</Button>
                </div>
                <div className={css.dim}>
                  {t('share.pick.myIdLabel')}<b className={css.mono}>{myShortId ?? '—'}</b>{' '}
                  <Button variant="ghost" size="sm" disabled={!myShortId} onClick={() => { void copyMyId() }}>{copied ? t('share.copied') : t('share.copy')}</Button>
                </div>
              </div>
            ) : friend ? (
              <>
                <span className={css.who}>{friendName(friend, friend.shortId)}</span>
                <Button variant="ghost" size="sm" onClick={() => { setPickPerson((v) => !v) }}>{t('share.switch')}</Button>
              </>
            ) : (
              <Button variant="outline" size="sm" onClick={() => { setPickPerson(true) }}>{t('share.choosePerson')}</Button>
            )}
          </div>
        )}
        {pickPerson && !noFriends && (
          <ul className={css.list}>
            {friends.map((f) => {
              const ready = f.friendPub !== null
              return (
                <li key={f.accountId}>
                  <button type="button" className={cx(css.pick, to === f.accountId && css.on, !ready && css.off)} disabled={!ready}
                    onClick={() => { setTo(f.accountId); setPickPerson(false) }}>
                    <span className={css.grow}>{friendName(f, t('share.unnamed'))}</span>
                    <span className={cx(css.dim, css.mono)}>{ready ? f.shortId : t('share.pick.notReady')}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
        {addMsg && <p className={cx(css.note, css[addMsg.kind])}>{addMsg.text}</p>}

        {/* ── ② 内容 ── */}
        {/* 标题从打开那一刻就在：用的是 dsh 自己的会话标题，整理前后同一句，不跳 */}
        {title !== '' && <h3 className={css.h1}>{title}</h3>}
        {!doc ? (
          // 还没整理（或整理失败）：左边说现状，右边是那颗要花钱的按钮
          <div className={css.split}>
            <span className={cx(css.dim, css.grow)}>
              {building
                ? t('share.building')
                : buildErr !== null
                  ? `${t('share.buildFail')} ${buildErr}`
                  : t('share.notBuilt', { n: String(peeked?.rawCount ?? 0) })}
            </span>
            <Button variant="outline" size="sm" disabled={building} onClick={() => { void build(++seq.current) }}>
              {building ? t('share.build.running') : buildErr !== null ? t('share.retry') : t('share.build.btn')}
            </Button>
          </div>
        ) : (
          <>
            {/* 摘要与两颗按钮同一行：左边说这是什么，右边是能点的——与页脚同一个句式 */}
            <div className={css.split}>
              <p className={cx(css.dim, css.grow)}>
                {summary}
                {built && !built.llmOk && <span> · {t('share.sum.missing')}</span>}
                {built?.llmTruncated === true && <span> · {t('share.sum.truncated')}</span>}
              </p>
              <span className={css.ops}>
                <Button variant="ghost" size="sm" disabled={building} onClick={() => { void build(++seq.current, true) }}>
                  {building ? t('share.build.running') : t('share.rebuild')}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => { setExpanded((v) => !v) }}>{expanded ? t('share.full.hide') : t('share.full.show')}</Button>
              </span>
            </div>
            {built && !built.llmOk && (
              <div className={cx(css.note, css.warn, css.inline)}>
                <span className={css.grow}>
                  {t('share.review.llmFail')}
                  {built.llmError !== undefined && (
                    <span className={css.dim}> {built.llmError === 'no_steps' ? t('share.llmErr.noSteps') : built.llmError}</span>
                  )}
                </span>
                <Button variant="ghost" size="sm" disabled={building} onClick={() => { void build(++seq.current) }}>{t('share.retry')}</Button>
              </div>
            )}
            {expanded && (
              <div className={css.card}>
                {doc.goal && <p className={css.goal}>{doc.goal}</p>}
                <Sec title={t('share.sec.deps')} items={[
                  doc.deps.tools.length ? t('share.deps.tools', { list: doc.deps.tools.join(sep) }) : '',
                  doc.deps.connectors.length ? t('share.deps.connectors', { list: doc.deps.connectors.join(sep) }) : '',
                  doc.deps.capabilities.length ? t('share.deps.capabilities', { list: doc.deps.capabilities.join(sep) }) : '',
                ].filter(Boolean)} />
                <Sec title={t('share.sec.steps')} items={doc.steps} />
                <Sec title={t('share.sec.forks')} items={doc.forks} />
                <Sec title={t('share.sec.pitfalls')} items={doc.pitfalls} />
                <Sec title={t('share.sec.deliverables')} items={doc.deliverables.map((d) => d.title)} />
                <details className={css.raw}>
                  <summary>{t('share.raw.summary', { n: doc.raw.length })}</summary>
                  {doc.raw.map((r, i) => (
                    <div key={i} className={css.rawRow}>
                      <span className={css.tag}>{r.label ?? t(r.role === 'user' ? 'share.raw.user' : r.role === 'agent' ? 'share.raw.agent' : 'share.raw.tool')}</span>
                      <span className={css.rawText}>{r.text.length > 600 ? r.text.slice(0, 600) + '…' : r.text}</span>
                    </div>
                  ))}
                </details>
              </div>
            )}

            {/* ── ③ 扫描 ── */}
            <div className={css.sep} />
            {!scanned ? (
              <div className={css.split}>
                <span className={cx(css.dim, css.grow)}>{t('share.scan.hint')}</span>
                <Button variant="outline" size="sm" disabled={scanning || !built?.route} onClick={() => { void scan() }}>
                  {scanning ? t('share.scan.running') : t('share.scan.btn')}
                </Button>
              </div>
            ) : cands.length === 0 ? (
              <div className={css.split}><span className={cx(css.dim, css.grow)}>{t('share.scan.clean')}</span></div>
            ) : (
              <div className={css.block}>
                <p className={css.dim}>{t('share.scan.found', { n: cands.length })}</p>
                  {cands.map((c) => (
                    <div key={c.id} className={css.cand}>
                      <span className={css.kind}>{t(KIND_KEY[c.kind])}</span>
                      <b className={css.candText}>{c.text}</b>
                      <span className={css.ops}>
                        {(['keep', 'mask', 'placeholder'] as const).map((a) => (
                          <button key={a} type="button" className={cx(css.chip, c.action === a && css.on)}
                            onClick={() => { setAction(c.id, a, a === 'placeholder' ? (c.replacement || t('share.placeholder.default')) : undefined) }}>
                            {t(a === 'keep' ? 'share.act.keep' : a === 'mask' ? 'share.act.mask' : 'share.act.placeholder')}
                          </button>
                        ))}
                        {c.action === 'placeholder' && (
                          <Input className={cx(css.inputSm)} value={c.replacement ?? ''} placeholder={t('share.act.replaceHint')}
                            onChange={(e) => { setAction(c.id, 'placeholder', e.target.value) }} />
                        )}
                      </span>
                    </div>
                  ))}
              </div>
            )}

          </>
        )}

        {/* ── ④ 附件 ── 只是看一眼工作目录，不花钱，整理没整理都列出来 */}
        {files.length > 0 && <div className={css.sep} />}
        {files.length > 0 && (
          <div className={css.block}>
            <div className={css.label}>
              {t('share.attach')}{' '}
              <span className={css.dim}>{picked.size ? t('share.attach.picked', { n: picked.size }) : t('share.attach.default')}</span>
            </div>
            {files.map((f) => (
              <label key={f.path} className={cx(css.file, f.tooBig && css.off)}>
                <input type="checkbox" disabled={f.tooBig} checked={picked.has(f.path)} onChange={() => { toggle(f.path) }} />
                <span className={css.grow}>{f.name}</span>
                <span className={css.dim}>{fileSize(f.size)}{f.tooBig && ` · ${t('share.attach.tooBig', { max: fileSize(totalMax) })}`}</span>
              </label>
            ))}
            {picked.size > 0 && <p className={cx(css.note, css.warn)}>{t('share.attach.warn')}</p>}
            {overTotal && <p className={cx(css.note, css.bad)}>{t('share.attach.over', { picked: fileSize(pickedSize), max: fileSize(totalMax) })}</p>}
          </div>
        )}

        {err && <p className={cx(css.note, css.bad)}>{err}</p>}
      </div>
    </Modal>
  )
}

function Sec({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null
  return (
    <div className={css.sec}>
      <div className={css.h2}>{title}</div>
      <ul className={css.ul}>{items.map((s, i) => <li key={i}>{s}</li>)}</ul>
    </div>
  )
}
