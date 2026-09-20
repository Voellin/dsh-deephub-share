/**
 * dsh-deephub-share · 浏览器半。
 *
 * 一共往 dsh 的界面上挂四处：
 *   - 会话头：一个「分享思路」按钮；
 *   - 设置：一个「DeepHub 账号」分区；
 *   - 左栏：「朋友与收件箱」一级面板（图标行 + 主区整页）；
 *   - 会话流：认领「收到的思路」事件，画成一张卡片。
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import { ShareAction } from './ShareAction.tsx'
import { AccountSection } from './AccountSection.tsx'
import { InboxPanel, PanelIcon } from './InboxPanel.tsx'
import { _setOpenSession, hostAlive } from './inbox-api.ts'
import { CLIENT_REQUIRED, bailOut, guard } from '../compat.ts'
import { ReceivedIdeaCard } from './ReceivedIdeaCard.tsx'
import { receivedIdeaDefinition, RECEIVED_KIND } from './received-idea-definition.ts'
import { en, NS, zh, type DeephubShareKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** dsh-deephub-share 的界面文案。 */
    'deephub-share': DeephubShareKey
  }
}

export const name = 'deephub-share-client'

/** 词典注册要 locale，挂 slot 要 slots。 */
export const inject = ['slots', 'locale']

/**
 * 一级面板的 id。左栏图标行（`sidebar.panellist`）与主区那一页（`main`）用**同一个 id**：
 * dsh 靠它把"点了哪个图标"和"主区画哪一页"对上。
 */
const PANEL_ID = 'dsh-deephub-share/inbox' as unknown as MainPanelId

/** 与 package.json 手动对齐；只用在装不上时那段话里。 */
const VERSION = '0.0.18'

/**
 * 浏览器半的入口。两层保护：
 *
 *   1. **外面包一层**——这里抛一个错，整个 dsh 界面会变成一页 "Failed to load plugins"，
 *      会话列表、工作区全没。所以炸了只打印、什么都不挂。
 *   2. **挂界面之前先问一句 Host 在不在**——两半是分开装载的，Host 那半没起来而按钮还在，
 *      用户点进去是「永远转圈」，比什么都没有更糟。见 compat.ts 顶部。
 */
export function apply(ctx: ClientContext): void {
  guard('client', VERSION, ctx, CLIENT_REQUIRED, () => {
    ctx.effect(() => {
      let disposed = false
      void (async () => {
        // 同源本地请求，失败基本只可能是"Host 半没装上"；仍然给一次重试，免得启动那一瞬的抖动误杀
        const alive = await hostAlive() || await hostAlive()
        if (disposed) return
        if (!alive) {
          bailOut('client', VERSION, 'Host 半没有响应（/api/deephub-share/health）——它多半没装上，所以界面也不挂了')
          return
        }
        try { register(ctx) } catch (e) { bailOut('client', VERSION, (e as Error).message) }
      })()
      return () => { disposed = true }
    }, 'dsh-deephub-share: host probe')
  })
}

/** 真正挂界面的那一段。只有探到 Host 才会被调用。 */
function register(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-deephub-share: dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.slots.inject(
    'conversation.session.header.actions',
    () => ctx.slots.register({
      name: 'conversation.session.header.actions',
      id: 'deephub-share',
      // 排在 dsh 自带的日程(10)、后台任务(20)之后。
      order: 30,
      locale: NS,
    }, ShareAction),
  )
  ctx.slots.inject(
    'settings.section',
    () => ctx.slots.register({
      name: 'settings.section',
      id: 'deephub-account',
      // dsh 自带：模型 10、插件 15；账号排在它们后面
      order: 40,
      label: () => t('acct.nav'),
      locale: NS,
    }, AccountSection),
  )

  // 左栏「朋友与收件箱」一级面板：图标行 + 主区整页，两处同一个 id。
  // 行本身（按钮、文字、选中态）归 dsh 画，我们只给图标；**未读数字只能挂在图标上**——
  // 那一行的文字是注册时给的一个字符串，跟着语言走、不跟着数据走。
  ctx.slots.inject(
    'sidebar.panellist',
    () => ctx.slots.register({
      name: 'sidebar.panellist',
      id: PANEL_ID,
      // dsh 自己一个全局面板都没注册，这个 order 现在没有邻居
      order: 50,
      label: () => t('inbox.tab'),
      locale: NS,
    }, PanelIcon),
  )
  ctx.slots.inject(
    'main',
    () => ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, InboxPanel),
  )

  // 收下之后跳到那条新会话。`uiWorkspace.openSession()` 顺手把这个面板收起来，正合适。
  // 同样**不写进上面的 `inject`**：cordis 的 inject 没有"可选"一说，写进去就是硬依赖。
  // 探不到就不跳，收下照样成功——会话已经在工作区里了。
  ctx.effect(() => {
    // **每次点的时候才去拿**，不在这里拿一次就存住：装插件的这一刻 `get()` 还是 undefined，
    // uiWorkspace 要晚一点才登记；点「收下」的时候它早就在了。
    _setOpenSession((id) => {
      const uiWorkspace = (ctx as unknown as { get(name: string): unknown }).get('uiWorkspace') as
        { openSession(sessionId: string): void } | undefined
      if (uiWorkspace === undefined) return false
      uiWorkspace.openSession(id)
      return true
    })
    return () => { _setOpenSession(undefined) }
  }, 'dsh-deephub-share: open-session bridge')

  // 会话里「收到的思路」那张卡片：定义认事件、渲染器画卡片，靠 kind 对上。
  // `uiConversation` 同样不写进上面的 inject（硬依赖），用 ctx.inject 单独等它：
  // 缺了只是不画卡片，会话与面板照常。
  ctx.inject(['uiConversation'], (cardCtx) => {
    cardCtx.effect(
      () => cardCtx.uiConversation.events.register(receivedIdeaDefinition),
      'dsh-deephub-share: received-idea definition',
    )
    cardCtx.slots.inject(
      'conversation.chat.node',
      () => cardCtx.slots.register({ name: 'conversation.chat.node', key: RECEIVED_KIND, locale: NS }, ReceivedIdeaCard),
    )
  })
}
