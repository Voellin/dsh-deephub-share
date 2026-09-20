/**
 * 「朋友与收件箱」tab 的数据层：同源 `fetch` + 一个小小的共享状态。
 *
 * 为什么要共享状态：tab 的**标题**和 tab 的**内容**是两棵互不相干的 React 树
 * （dsh 的 `sidebar.right.pane.tab` 与 `sidebar.right.pane.tab.title` 两个 slot），
 * 标题上要显示未读数字，就得和内容看同一份数据。所以这里放一个模块级的小 store，
 * 两边都 `useSyncExternalStore` 订阅它——同一个 bundle，同一个模块实例。
 *
 * 轮询：**有人在看的时候才拉**，进来先拉一次，之后每 30 秒一次；
 * **页面被藏起来就跳过**（切到别的标签页、窗口最小化），切回来立刻补一次——
 * 所以你看到的永远是新的，人不在的时候一个请求都不发。没登录也只查一次本机登录态，不出网。
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react'
import type { FriendWithRemark } from '../shared/social.ts'

export type { Friend } from '@deephub/cloud-protocol'
export type { FriendWithRemark } from '../shared/social.ts'

const PREFIX = '/api/deephub-share'

/**
 * 轮询间隔 30 秒：四条查询共用这一个节奏——待收、好友请求这类东西迟到半分钟就已经让人觉得卡了。
 *
 * 记一笔以后要放慢时先动谁：这四条里**只有「我的名字」不会被别人改**（只有你自己能改，
 * 唯一的例外是你在 DeepHub 桌面端改了名），所以它是最该第一个放慢的。
 *
 * 浏览器对后台标签页的定时器本来就压到 ≥1 分钟，所以"30 秒"只在页面看得见时是真的 30 秒。
 */
export const POLL_MS = 30_000

/** 收件箱条目。**拒收之前只有这些**——标题在密文里，服务端自己也看不到。 */
export interface InboxItem {
  deliveryId: string
  kind: string
  /** 密文字节数 —— 收件箱里唯一能看出"这东西多大"的线索 */
  size: number
  attachments: number
  from: { shortId: string; displayName: string | null }
  /** Unix **秒**（服务端原样给的），不是毫秒 */
  createdAt: number
  /** Unix **秒** */
  expiresAt: number
}

/** 收下时能落到哪个工作区。Host 那边由 `workspaceRegistry` 给。 */
export interface WorkspaceChoice { id: string; path: string; title: string }

/** 落地成功之后的回执。`attachments.path` 是相对工作区根的。 */
export interface AcceptOk {
  ok: true
  sessionId: string
  workspace: WorkspaceChoice
  attachments: Array<{ name: string; path: string; size: number }>
}
/** 过去收下的一份思路落在哪条会话里。**不是台账**——每次都是从 dsh 的会话库现挑的，见 landed.ts。 */
export interface LandedIdea {
  sessionId: string
  title: string
  /** 落在哪个工作区（绝对路径）；拿不到就是 null */
  cwd: string | null
  /** 会话建立时间，Unix **毫秒**（dsh 给的；服务端那些字段是秒，别混） */
  createdAt: number
}

/** 收不下来的原因。前四种是取回/解密的，`malformed` 是解开了但里面不是一份能用的思路。 */
export type AcceptFailure = 'offline' | 'no_key' | 'not_found' | 'undecryptable' | 'malformed'
export type AcceptResult = AcceptOk | { ok: false; reason: AcceptFailure }

/** `createdAt` 同样是 Unix **秒**。 */
export interface IncomingRequest { requestId: string; shortId: string; createdAt: number }

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

/**
 * Host 那半装上了没有。浏览器半在挂任何界面之前先问这一下——
 * Host 炸了而界面还在，用户看到的是「按钮都在、点了永远转圈」，比什么都没有更糟。
 */
export async function hostAlive(): Promise<boolean> {
  try {
    const r = await fetch(`${PREFIX}/health`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    return r.ok
  } catch { return false }
}

export const inboxApi = {
  status: (probe = false) => call<{ loggedIn: boolean; reachable: boolean | null; shortId: string | null }>('account/status', { probe }),
  list: () => call<{ items: InboxItem[] }>('inbox/list'),
  rejectIdea: (deliveryId: string) => call<{ ok: boolean; reason?: string }>('inbox/reject', { deliveryId }),
  workspaces: () => call<{ list: WorkspaceChoice[] }>('inbox/workspaces'),
  /** 「已收下」清单。**不进轮询**：它不会自己变，点开那一下查一次就够。 */
  landed: () => call<{ list: LandedIdea[] }>('inbox/landed'),
  /** 收下：取回 + 解密 + 落成一条新会话。文案（标题模板、"未设置名字"）从这边传过去，Host 不管语言。 */
  acceptIdea: (deliveryId: string, o: { workspaceId?: string; titleFmt: string; unnamed: string }) =>
    call<AcceptResult>('inbox/accept', { deliveryId, ...o }),

  friends: () => call<{ friends: FriendWithRemark[] }>('social/friends'),
  requests: () => call<{ incoming: IncomingRequest[] }>('social/inbox'),
  request: (shortId: string) => call<{ ok: boolean; reason?: string }>('social/request', { shortId }),
  accept: (requestId: string) => call<{ ok: boolean; reason?: string }>('social/accept', { requestId }),
  rejectRequest: (requestId: string) => call<{ ok: boolean; reason?: string }>('social/reject', { requestId }),
  remove: (accountId: string) => call<{ ok: boolean; reason?: string }>('social/remove', { accountId }),
  profile: () => call<{ displayName: string | null }>('social/profile'),
  setName: (name: string) => call<{ ok: boolean }>('social/set-name', { name }),
  /** 给一个人起 / 清备注。`text` 传空串＝清掉。**改的是"我管他叫什么"，不是 setName 那个。** */
  setRemark: (accountId: string, text: string) =>
    call<{ ok: boolean }>('social/set-remark', { accountId, text }),
}

// ── 共享 store ──────────────────────────────────────────────────────────

export interface InboxSnapshot {
  /** null = 还没问出结果（"正在查"），不是"没登录" */
  loggedIn: boolean | null
  shortId: string | null
  displayName: string | null
  items: InboxItem[]
  friends: FriendWithRemark[]
  incoming: IncomingRequest[]
  /** 拉取失败的原话；拉成功就清掉 */
  error: string | null
  loading: boolean
}

const EMPTY: InboxSnapshot = {
  loggedIn: null, shortId: null, displayName: null,
  items: [], friends: [], incoming: [], error: null, loading: false,
}

let snapshot: InboxSnapshot = EMPTY
const subs = new Set<() => void>()
let viewers = 0
let timer: ReturnType<typeof setInterval> | undefined
let inFlight = false

function set(patch: Partial<InboxSnapshot>): void {
  snapshot = { ...snapshot, ...patch }
  for (const fn of subs) fn()
}

/** 拉一轮。登录了才拉朋友与收件箱；没登录只更新登录态。并发只允许一轮。 */
export async function refreshInbox(): Promise<void> {
  if (inFlight) return
  inFlight = true
  set({ loading: true })
  try {
    const st = await inboxApi.status()
    if (!st.loggedIn) {
      set({ loggedIn: false, shortId: st.shortId, items: [], friends: [], incoming: [], error: null, loading: false })
      return
    }
    const [items, friends, requests, profile] = await Promise.all([
      inboxApi.list(), inboxApi.friends(), inboxApi.requests(), inboxApi.profile(),
    ])
    set({
      loggedIn: true,
      shortId: st.shortId,
      displayName: profile.displayName,
      items: items.items,
      friends: friends.friends,
      incoming: requests.incoming,
      error: null,
      loading: false,
    })
    // 顺手把卡片那份备注缓存也刷了 —— 面板开着的时候它就是新的，不用自己再出一次网
    setRemarks(remarkMapOf(friends.friends))
  } catch (e) {
    // 只记原因、不动 loggedIn：我们确实不知道登不登录。界面那边靠 error 决定说什么，
    // 不能再一直显示「正在查云端状态…」——Host 半没装上时那会转到天荒地老
    set({ error: (e as Error).message, loading: false })
  } finally {
    inFlight = false
  }
}

/** 本地先把这条去掉，不等下一轮（拒收是服务端真删，不会又冒出来）。 */
export function dropItem(deliveryId: string): void {
  set({ items: snapshot.items.filter((x) => x.deliveryId !== deliveryId) })
}

/** 页面这会儿是不是被藏起来了。切标签页、最小化都算；"被别的窗口盖住"浏览器不保证报。 */
const isHidden = (): boolean => typeof document !== 'undefined' && document.visibilityState === 'hidden'

let wasHidden = false

/** 定时器每跳一次走这里。页面藏着就跳过——人没在看，查了也没人看得见。 */
export function _tick(): void { if (!isHidden()) void refreshInbox() }

/** 从"藏着"变回"看得见"时立刻补一次，所以切回来那一眼永远是新的。 */
export function _onVisibility(): void {
  const h = isHidden()
  const was = wasHidden
  wasHidden = h
  if (was && !h) void refreshInbox()
}

function subscribe(fn: () => void): () => void {
  subs.add(fn)
  viewers += 1
  if (viewers === 1) {
    wasHidden = isHidden()
    void refreshInbox()
    timer = setInterval(_tick, POLL_MS)
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', _onVisibility)
  }
  return () => {
    subs.delete(fn)
    viewers -= 1
    if (viewers === 0 && timer !== undefined) {
      clearInterval(timer)
      timer = undefined
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', _onVisibility)
    }
  }
}

/** 订阅这份数据；第一个订阅者到场时开始轮询，最后一个走了就停。 */
export function useInbox(): InboxSnapshot {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot)
}

/** 给测试看的当前快照。 */
export const _snapshot = (): InboxSnapshot => snapshot
/** 给测试用的归零。 */
export function _reset(): void {
  if (timer !== undefined) { clearInterval(timer); timer = undefined }
  subs.clear(); viewers = 0; inFlight = false; wasHidden = false; snapshot = EMPTY
  openSessionImpl = undefined
  remarkMap = null; remarkPull = null; remarkSubs.clear()
}

// ── 卡片要的那份备注 ──────────────────────────────────────────────────────
//
// 「收到的思路」卡片长在 dsh 的会话正文里，跟这个面板是**两棵互不相干的 React 树**，
// 而且它可能在面板从没打开过的情况下被渲染（翻开一条老会话就会）。
//
// 所以它**不订阅上面那个轮询 store** —— 订阅了就会顺带把 30 秒轮询也开起来，
// 一条躺在历史里的老卡片没有理由让插件一直出网。这里单放一份模块级缓存：
// 第一次有卡片要用才取一次，之后所有卡片共用；面板在轮询时会顺手把它刷新。
//
// 卡片显示的是**现在的**备注，所以它必须是活的，不能用事件里收下那天记下的那个
// 收下当天的名字。代价是缓存冷的时候，卡片会先显示对方自己设的名字、拿到备注后跳一下。

let remarkMap: Record<string, string> | null = null
let remarkPull: Promise<void> | null = null
const remarkSubs = new Set<() => void>()

const remarkMapOf = (list: readonly FriendWithRemark[]): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const f of list) if (f.remark) out[f.accountId] = f.remark
  return out
}

function setRemarks(m: Record<string, string>): void {
  remarkMap = m
  for (const fn of remarkSubs) fn()
}

/** 取一次备注；已经有了就不取。并发调用合流到同一个 promise。 */
export async function ensureRemarks(): Promise<void> {
  if (remarkMap !== null) return
  remarkPull ??= (async () => {
    try {
      setRemarks(remarkMapOf((await inboxApi.friends()).friends))
    } catch {
      // 拿不到就当没有备注 —— 卡片退回对方自己设的名字，不弹错（备注不是安全边界）
      setRemarks({})
    } finally {
      remarkPull = null
    }
  })()
  await remarkPull
}

/** 卡片用：我给这个人起的备注。`null` = 没起过，或者还没取回来。 */
export function useRemark(accountId: string): string | null {
  const subscribe = useCallback((fn: () => void) => {
    remarkSubs.add(fn)
    return () => { remarkSubs.delete(fn) }
  }, [])
  const get = useCallback(() => remarkMap?.[accountId] ?? null, [accountId])
  useEffect(() => { void ensureRemarks() }, [])
  return useSyncExternalStore(subscribe, get, get)
}


// ── 「跳到那条会话」这一下 ────────────────────────────────────────────────
//
// dsh 的 `uiWorkspace.openSession()` 能开会话、顺手把我们这个面板收起来，正是收下之后想要的。
// 但 `uiWorkspace` **不能写进 client 的 `inject`**（cordis 的 inject 没有"可选"一说，写了就是
// 硬依赖，哪天 profile 里少一个，整个浏览器半都装不上）。所以入口那边用 `ctx.get()` 探一下，
// 探到了就把这个小函数塞进来；探不到就保持 undefined —— 收下照样成功，只是不自动跳过去。

let openSessionImpl: ((sessionId: string) => boolean) | undefined

/** 入口在 apply() 里调一次。实现自己返回"跳成了没有"。 */
export function _setOpenSession(fn: ((sessionId: string) => boolean) | undefined): void {
  openSessionImpl = fn
}

/** 跳到某条会话。返回 false = 这份 dsh 跳不了（会话已经落好了，只是没自动切过去）。 */
export function openSession(sessionId: string): boolean {
  return openSessionImpl?.(sessionId) ?? false
}

// ── 小工具 ──────────────────────────────────────────────────────────────

export const fileSize = (n: number): string =>
  n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`

/**
 * ⚠️ `createdAt` / `expiresAt` 是**服务端给的 Unix 秒**（原样透传，不是毫秒）——
 * 当毫秒用会算出"20690 天前"。下面两个函数的入参都按秒。
 */
const DAY_S = 86_400
const nowS = (): number => Math.floor(Date.now() / 1000)

/** 收到多久了，只说到"天"——省得每分钟重渲染。返回 0 表示今天。 */
export const daysAgo = (createdAtS: number): number => Math.max(0, Math.floor((nowS() - createdAtS) / DAY_S))

/** 还剩几天过期；已过期返回 0。 */
export const daysLeft = (expiresAtS: number): number => Math.max(0, Math.ceil((expiresAtS - nowS()) / DAY_S))
