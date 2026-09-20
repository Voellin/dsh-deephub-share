import { useState } from 'react'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { NS } from './locales.ts'
import { ShareModal } from './ShareModal.tsx'
import css from './ShareAction.module.css'

/** 会话头「分享思路」动作的完整 props：slot 标准席位 + 本插件词典。 */
export type ShareActionProps =
  PropsRuntime<'conversation.session.header.actions'> & PropsLocale<typeof NS>

/** 往上分享那一枚，按 dsh 的线条粗细画（stroke-width 2，圆角端点）。 */
function ShareIcon() {
  return (
    <svg className={css.icon} width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" />
      <path d="M12 3v13" />
      <path d="m7 8 5-5 5 5" />
    </svg>
  )
}

/**
 * 会话头的按钮：点开分享一屏。`props.sessionId` 由 slot 的 session 作用域自动提供。
 *
 * 没用 `Button` 原语：这一颗要的是「品牌色浅底 + 彩字 + 图标」，
 * 原语没有这个变体，样式全在 `ShareAction.module.css` 里。
 */
export function ShareAction({ t, sessionId }: ShareActionProps) {
  const [open, setOpen] = useState(false)
  return (
    <span className={css.root} data-deephub-share-action data-session-id={sessionId}>
      <button type="button" className={css.share} onClick={() => { setOpen(true) }}>
        <ShareIcon />
        {t('action.share')}
      </button>
      <ShareModal open={open} onClose={() => { setOpen(false) }} sessionId={String(sessionId)} t={t} />
    </span>
  )
}
