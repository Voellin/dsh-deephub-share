/** 收件箱共享 store：没登录、登录、拉失败、拒收后就地去掉。 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { _onVisibility, _reset, _snapshot, _tick, daysAgo, daysLeft, dropItem, fileSize, refreshInbox } from '../src/client/inbox-api.ts'

type Reply = Record<string, unknown> | { __status: number; error: string }

/** 把 fetch 换成按 op 查表；返回这轮被调过的 op（用来数请求次数）。 */
function mockFetch(table: Record<string, Reply>): string[] {
  const seen: string[] = []
  globalThis.fetch = (async (url: string | URL | Request) => {
    const op = String(url).replace('/api/deephub-share/', '')
    seen.push(op)
    const body = table[op]
    if (body === undefined) return new Response('{"error":"no route"}', { status: 500 })
    if ('__status' in body) return new Response(JSON.stringify({ error: body.error }), { status: body.__status as number })
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as typeof fetch
  return seen
}

const ITEM = {
  deliveryId: 'd1', kind: 'idea', size: 2048, attachments: 2,
  from: { shortId: 'DH-5NHS-0XM', displayName: '测试用户甲' },
  createdAt: Math.floor(Date.now() / 1000) - 86_400, expiresAt: Math.floor(Date.now() / 1000) + 30 * 86_400,
}
const FULL = {
  'account/status': { loggedIn: true, reachable: true, shortId: 'DH-7R5H-N0K' },
  'inbox/list': { items: [ITEM] },
  'social/friends': { friends: [{ accountId: 'a1', shortId: 'DH-5NHS-0XM', displayName: '测试用户甲', friendPub: 'k', createdAt: 1 }] },
  'social/inbox': { incoming: [{ requestId: 'r1', shortId: 'DH-AAAA-BBB', createdAt: 2 }] },
  'social/profile': { displayName: '我' },
}

beforeEach(() => { _reset() })

test('没登录：只问一次状态，不去拉朋友和收件箱', async () => {
  const seen = mockFetch({ 'account/status': { loggedIn: false, reachable: true, shortId: null } })
  await refreshInbox()
  assert.deepEqual(seen, ['account/status'])
  const s = _snapshot()
  assert.equal(s.loggedIn, false)
  assert.deepEqual(s.items, [])
  assert.equal(s.error, null)
})

test('登录：四条一起拉，收件箱、朋友、请求、显示名都进来', async () => {
  const seen = mockFetch(FULL)
  await refreshInbox()
  assert.equal(seen.length, 5)
  const s = _snapshot()
  assert.equal(s.loggedIn, true)
  assert.equal(s.shortId, 'DH-7R5H-N0K')
  assert.equal(s.displayName, '我')
  assert.equal(s.items.length, 1)
  assert.equal(s.friends.length, 1)
  assert.equal(s.incoming.length, 1)
  assert.equal(s.loading, false)
})

test('拉失败：留住原话，不把已有的表清掉', async () => {
  mockFetch(FULL)
  await refreshInbox()
  mockFetch({ 'account/status': { __status: 500, error: 'boom' } })
  await refreshInbox()
  const s = _snapshot()
  assert.equal(s.error, 'boom')
  assert.equal(s.items.length, 1, '拉失败不该把上一轮的结果抹掉')
  assert.equal(s.loading, false)
})

test('并发只跑一轮', async () => {
  const seen = mockFetch(FULL)
  await Promise.all([refreshInbox(), refreshInbox(), refreshInbox()])
  assert.equal(seen.filter((x) => x === 'account/status').length, 1)
})

test('拒收之后就地去掉那一条，不等下一轮', async () => {
  mockFetch(FULL)
  await refreshInbox()
  dropItem('d1')
  assert.deepEqual(_snapshot().items, [])
})

test('小工具：字节、几天前、还剩几天（时间都按 Unix 秒）', () => {
  assert.equal(fileSize(512), '512 B')
  assert.equal(fileSize(2048), '2 KB')
  assert.equal(fileSize(3 * 1048576), '3.0 MB')
  const s = Math.floor(Date.now() / 1000)
  assert.equal(daysAgo(s), 0)
  assert.equal(daysAgo(s - 2 * 86_400), 2)
  // 单位搞错的回归闸门：服务端给的是 Unix **秒**，当成毫秒会显示成「20690 天前」。
  // 现在两个函数都按秒，未来若有人改回毫秒，下面这条会立刻变成一个荒唐的数。
  assert.ok(daysAgo(s - 86_400) === 1 && daysAgo(s - 30 * 86_400) === 30, '秒进来就该是个人看得懂的天数')
  assert.equal(daysAgo(Date.now()), 0, '毫秒（未来时刻）不能算出负数')
  assert.equal(daysLeft(s - 10), 0, '过期了就是 0，不能是负数')
  assert.equal(daysLeft(s + 3 * 86_400), 3)
})

// ── 页面藏起来就不查 ──────────────────────────────────────────────────

/**
 * ⚠️ 这个文件 import 的是 **`node:assert/strict`**，那里的 `deepEqual` 就是 `deepStrictEqual`，
 * 而它的类型是 `asserts actual is T`——所以 `assert.deepEqual(seen, [])` 会把 `seen` 收窄成 `never[]`，
 * 后面再 `seen.includes(...)` 就直接编译不过。**要断言「空」请用 `seen.length`**，
 * 它收窄的是那个表达式，动不到 `seen` 本身。（普通 `node:assert` 没这毛病，别被误导。）
 */

/** Node 里没有 document，自己造一个最小的。 */
function fakeDocument(state: 'visible' | 'hidden'): { set: (s: 'visible' | 'hidden') => void } {
  const d = { visibilityState: state, addEventListener() {}, removeEventListener() {} }
  ;(globalThis as { document?: unknown }).document = d
  return { set: (x) => { d.visibilityState = x } }
}

test('页面藏着（切走标签页 / 最小化）时，定时器那一跳一个请求都不发', async () => {
  const seen = mockFetch(FULL)
  const doc = fakeDocument('hidden')
  _tick()
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(seen.length, 0, '人没在看，查了也没人看得见')
  doc.set('visible')
  _tick()
  await new Promise((r) => setTimeout(r, 10))
  assert.ok(seen.includes('account/status'), '看得见就照常查')
  delete (globalThis as { document?: unknown }).document
})

test('从藏着切回看得见：立刻补一次，不等下一跳', async () => {
  const doc = fakeDocument('hidden')
  _onVisibility()                       // 先把"藏着"记下来
  const seen = mockFetch(FULL)
  doc.set('visible')
  _onVisibility()
  await new Promise((r) => setTimeout(r, 10))
  assert.ok(seen.includes('account/status'), '切回来那一眼必须是新的')
  delete (globalThis as { document?: unknown }).document
})

test('一直看得见时，visibilitychange 不该白查一次', async () => {
  const doc = fakeDocument('visible')
  _onVisibility()
  const seen = mockFetch(FULL)
  doc.set('visible')
  _onVisibility()
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(seen.length, 0, '没有"藏着→看得见"这个变化就不该补')
  delete (globalThis as { document?: unknown }).document
})
