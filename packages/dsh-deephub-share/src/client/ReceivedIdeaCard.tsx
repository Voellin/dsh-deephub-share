/**
 * 会话里「收到的思路」那张卡片。
 *
 * 卡片下面永远还有一条折叠的「上下文注入」行——那是给模型看的正文（`land.ts` 追加的
 * `user/message`）。**卡片本身不进模型上下文**，它只是给人看的。
 */
import { useState } from 'react'
import type { PropsRuntime, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type { NS } from './locales.ts'
import type { LandedAttachment, ReceivedIdeaEvent } from '../events.ts'
import { useRemark } from './inbox-api.ts'
import css from './ReceivedIdeaCard.module.css'

type T = TranslateNS<typeof NS>

export type ReceivedIdeaCardProps =
  PropsRuntime<'conversation.chat.node', 'deephub-share/received'> & { t: T }

const cx = (...ks: Array<string | undefined | false>): string =>
  ks.filter((k): k is string => typeof k === 'string' && k.length > 0).join(' ')

const fileSize = (n: number): string =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`

function Section({ title, items }: { title: string; items: readonly string[] }) {
  if (items.length === 0) return null
  return (
    <section className={css.block}>
      <h4 className={css.h}>{title}</h4>
      <ol className={css.steps}>
        {items.map((x, i) => <li key={i}>{x}</li>)}
      </ol>
    </section>
  )
}

export function ReceivedIdeaCard({ node, t, openFile }: ReceivedIdeaCardProps) {
  const [rawOpen, setRawOpen] = useState(false)
  const d: ReceivedIdeaEvent = node.data
  // **活的备注**：卡片上显示我现在管他叫什么，不是收下那天记下的名字。
  // 拿不到（还没取回来 / 没起过备注）就退回事件里那个 —— 左栏那条会话的标题是收下当天
  // 写进日志的，改不了，所以改过备注之后这两处会对不上。这是选「活的」的已知代价。
  const remark = useRemark(d.from.accountId)
  const who = remark ?? d.from.displayName ?? t('inbox.unnamed')
  const deps = [...d.doc.deps.tools, ...d.doc.deps.connectors, ...d.doc.deps.capabilities]

  return (
    <article className={css.card} data-deephub-idea-card>
      <header className={css.head}>
        <span className={css.av}>{who.slice(0, 1).toUpperCase()}</span>
        <span className={css.headBody}>
          <span className={css.from}>{t('card.from', { who })}</span>
          <h3 className={css.title}>{d.doc.title}</h3>
        </span>
      </header>

      {d.doc.goal ? <p className={css.goal}>{d.doc.goal}</p> : null}

      {deps.length > 0 ? (
        <div className={css.chips}>
          {deps.map((x, i) => <span key={i} className={css.chip}>{x}</span>)}
        </div>
      ) : null}

      <Section title={t('card.steps')} items={d.doc.steps} />
      <Section title={t('card.forks')} items={d.doc.forks} />
      <Section title={t('card.pitfalls')} items={d.doc.pitfalls} />

      {d.doc.deliverables.length > 0 ? (
        <section className={css.block}>
          <h4 className={css.h}>{t('card.deliverables')}</h4>
          <ul className={css.plain}>
            {d.doc.deliverables.map((x, i) => <li key={i}>{x.title}</li>)}
          </ul>
        </section>
      ) : null}

      {d.attachments.length > 0 ? (
        <section className={css.block}>
          <h4 className={css.h}>{t('card.attachments', { n: d.attachments.length })}</h4>
          <ul className={css.files}>
            {d.attachments.map((f: LandedAttachment) => (
              <li key={f.path} className={css.file}>
                <span className={css.fileName}>{f.name}</span>
                <span className={css.dim}>{fileSize(f.size)}</span>
                <button type="button" className={css.open} onClick={() => { openFile(f.path) }}>
                  {t('card.open')}
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {d.doc.raw.length > 0 ? (
        <section className={css.block}>
          <button type="button" className={cx(css.rawToggle)} onClick={() => { setRawOpen((v) => !v) }}>
            {rawOpen ? t('card.raw.hide') : t('card.raw.show', { n: d.doc.raw.length })}
          </button>
          {rawOpen ? (
            <ol className={css.raw}>
              {d.doc.raw.map((r, i) => (
                <li key={i}>
                  <span className={css.rawRole}>{r.role}</span>
                  <span className={css.rawText}>{r.text}</span>
                </li>
              ))}
            </ol>
          ) : null}
        </section>
      ) : null}
    </article>
  )
}
