/**
 * 整理结果的缓存与去重。
 *
 * 为什么要有它：**整理一次 = 调一次模型 = 一次钱。** 对话框每打开一次就整理一次的话，
 * 误点关掉再打开就是两份钱。缓存放浏览器那边不管用——刷新页面就没了，而且「关掉时正在跑的那次」
 * 重开时还没结果，照样会再发一次。所以缓存与去重都放在 Host 半：
 *
 * - **指纹**：事件条数 + 最后一条事件的 seq。会话没新事件 → 同一份结果照用；聊了几句 → 自动作废。
 * - **在途去重**：同一条会话同时只允许一个任务，后来的请求挂到同一个 promise 上等。
 * - **只缓存成功的**：模型那步没成的结果不留（下次打开就是"还没整理"，用户再点一次等于重试）。
 *
 * 缓存在进程内存里，`dsh web` 重启就没了；30 分钟过期，最多 20 条会话（按最后使用时间淘汰）。
 */
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { BuildResponse } from './shared/idea.ts'

const TTL_MS = 30 * 60_000
const MAX_ENTRIES = 20

interface Entry {
  fp: string
  /** 最后一次被用到的时间（淘汰按它） */
  at: number
  task: Promise<BuildResponse>
  /** 任务跑完并且 llmOk 为真才有值；在途时是 null */
  done: BuildResponse | null
}

const cache = new Map<string, Entry>()

/** 会话内容的指纹：条数 + 最后一条的 seq。两者都没变 = 这条会话没动过。 */
export function fingerprint(events: readonly SessionEvent[]): string {
  const last = events[events.length - 1]
  return `${events.length}:${last === undefined ? 0 : last.seq}`
}

function fresh(e: Entry | undefined, fp: string, now: number): e is Entry {
  return e !== undefined && e.fp === fp && now - e.at < TTL_MS
}

/** 这条会话此刻的状态：没有 / 在跑 / 已有结果。`peek` 路由用它，不会触发任何模型调用。 */
export function look(sessionId: string, fp: string, now = Date.now()): 'none' | 'running' | 'ready' {
  const e = cache.get(sessionId)
  if (!fresh(e, fp, now)) return 'none'
  return e.done === null ? 'running' : 'ready'
}

/** 命中就返回那个任务（可能还在跑，也可能早已完成）；没命中返回 null。 */
export function hit(sessionId: string, fp: string, now = Date.now()): Promise<BuildResponse> | null {
  const e = cache.get(sessionId)
  if (!fresh(e, fp, now)) return null
  e.at = now
  return e.task
}

/** 记下一个刚起的任务。成功且 llmOk 为真才留下，否则跑完就清掉。 */
export function remember(sessionId: string, fp: string, task: Promise<BuildResponse>, now = Date.now()): void {
  const entry: Entry = { fp, at: now, task, done: null }
  cache.set(sessionId, entry)
  evict()
  task.then(
    (r) => {
      if (cache.get(sessionId) !== entry) return // 期间被 force 或新任务顶掉了
      if (r.llmOk) entry.done = r
      else cache.delete(sessionId)
    },
    () => { if (cache.get(sessionId) === entry) cache.delete(sessionId) },
  )
}

/** 「重新整理」用：把这条会话的缓存扔了，下次一定重算。 */
export function forget(sessionId: string): void {
  cache.delete(sessionId)
}

/** 超过条数上限就淘汰最久没用的那条。 */
function evict(now = Date.now()): void {
  for (const [k, e] of cache) if (now - e.at >= TTL_MS) cache.delete(k)
  while (cache.size > MAX_ENTRIES) {
    let oldestKey: string | null = null
    let oldestAt = Infinity
    for (const [k, e] of cache) if (e.at < oldestAt) { oldestAt = e.at; oldestKey = k }
    if (oldestKey === null) break
    cache.delete(oldestKey)
  }
}

/** 只给测试用。 */
export function _size(): number { return cache.size }
export function _clear(): void { cache.clear() }
