/**
 * 好友备注。
 *
 * 这一组守两件事：
 *   1. **三级回退的顺序**——我的备注 → 他自己设的 → 兜底。六处地方显示朋友的名字，
 *      规则只写在 `shared/social.ts` 这一处，所以它错了就是六处一起错。
 *   2. **卡片那份缓存不许把轮询带起来**。卡片长在会话正文里，可能在面板从没打开过的
 *      情况下被渲染；它只该取一次，之后所有卡片共用。
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { friendName } from '../src/shared/social.ts'
import { _reset, _snapshot, ensureRemarks, refreshInbox } from '../src/client/inbox-api.ts'

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

const friend = (o: Partial<{ accountId: string; shortId: string; displayName: string | null; remark: string | null }> = {}) => ({
  accountId: 'a1', shortId: 'DH-5NHS-0XM', displayName: '测试用户甲', remark: null, friendPub: 'k', createdAt: 1, ...o,
})

const FULL = {
  'account/status': { loggedIn: true, reachable: true, shortId: 'DH-7R5H-N0K' },
  'inbox/list': { items: [] },
  'social/friends': { friends: [friend({ remark: '测试用户甲的备注' }), friend({ accountId: 'a2', shortId: 'DH-3F8A-2BC', displayName: '测试用户乙' })] },
  'social/inbox': { incoming: [] },
  'social/profile': { displayName: '我' },
}

beforeEach(() => { _reset() })

// ── 三级回退 ──────────────────────────────────────────────────────────

test('有备注就用备注，哪怕对方也设了名字', () => {
  assert.equal(friendName({ remark: '测试用户甲的备注', displayName: '测试用户甲' }, '未设置名字'), '测试用户甲的备注')
})

test('没备注就用他自己设的', () => {
  assert.equal(friendName({ remark: null, displayName: '测试用户乙' }, '未设置名字'), '测试用户乙')
})

test('两个都没有才轮到兜底', () => {
  assert.equal(friendName({ remark: null, displayName: null }, '未设置名字'), '未设置名字')
})

test('remark 字段压根没有时（老数据）也不该炸，等同于没备注', () => {
  assert.equal(friendName({ displayName: '测试用户甲' }, '未设置名字'), '测试用户甲')
})

test('空串 / 全空白的备注不算备注 —— 否则"清除备注"会让列表变成一片空白', () => {
  // 写入那一侧已经把空串删掉了（共享包 social.ts 的 setRemark），这条守的是万一漏网：
  // `??` 只挡 null，空串会原样显示出来，列表里就是一行没有名字的空位
  assert.equal(friendName({ remark: '', displayName: '测试用户甲' }, '未设置名字'), '测试用户甲')
  assert.equal(friendName({ remark: '   ', displayName: '测试用户甲' }, '未设置名字'), '测试用户甲')
  assert.equal(friendName({ remark: '', displayName: '' }, '未设置名字'), '未设置名字')
})

test('备注两头的空白不进界面', () => {
  assert.equal(friendName({ remark: '  测试用户甲的备注  ', displayName: '测试用户甲' }, '未设置名字'), '测试用户甲的备注')
})

// ── 卡片那份缓存 ──────────────────────────────────────────────────────

test('面板轮询一轮之后，卡片那份缓存已经是新的，不再单独出网', async () => {
  const seen = mockFetch(FULL)
  await refreshInbox()
  const after = seen.length
  await ensureRemarks()
  assert.equal(seen.length, after, 'ensureRemarks 不该再打一次 social/friends')
})

test('面板没开过时，卡片自己取一次；再问不重复取', async () => {
  const seen = mockFetch(FULL)
  await ensureRemarks()
  assert.deepEqual(seen, ['social/friends'])
  await ensureRemarks()
  assert.deepEqual(seen, ['social/friends'], '第二次该吃缓存')
})

test('并发的几张卡片只合出一个请求', async () => {
  const seen = mockFetch(FULL)
  await Promise.all([ensureRemarks(), ensureRemarks(), ensureRemarks()])
  assert.deepEqual(seen, ['social/friends'])
})

test('取不到就当没备注 —— 不抛，卡片退回对方自己设的名字', async () => {
  mockFetch({ 'social/friends': { __status: 500, error: '炸了' } })
  await ensureRemarks()
  // 没抛就是通过；再问一次也不该重试（已经定论为"没有备注"）
  const seen = mockFetch(FULL)
  await ensureRemarks()
  assert.deepEqual(seen, [])
})

test('备注跟着朋友列表一起进快照，不另开一个请求', async () => {
  const seen = mockFetch(FULL)
  await refreshInbox()
  assert.equal(seen.filter((x) => x === 'social/friends').length, 1)
  assert.equal(_snapshot().friends[0]?.remark, '测试用户甲的备注')
  assert.equal(_snapshot().friends[1]?.remark, null)
})
