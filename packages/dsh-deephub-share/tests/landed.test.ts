/**
 * 「已收下」清单是**现从 dsh 会话库里挑的**，不是台账。
 *
 * 这几条守的是那个"挑"字：id 前缀只是粗筛，**真凭据是第 0 条事件**；
 * 读不出来的一概不算数，绝不因为名字像就把一条不相干的会话列进来。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { Context } from '@deepseek-ai/cordis'
import { landedIdeas } from '../src/inbox/landed.ts'

interface FakeSession {
  id: string
  /** undefined = 这条会话没有 cwd（dsh 的 header 里 cwd 是可选的） */
  cwd: string | undefined
  createdAt: number
  /** 第 0 条事件的类型；'throw' 表示读事件时抛错 */
  firstType: string
  /** undefined = 日志里没有标题事件；'throw' = 读标题时抛错 */
  title: string | undefined | 'throw'
}

/** 攒一个只长着我们用到的那几个方法的 sessionQuery。 */
const fakeCtx = (sessions: FakeSession[]): Context => ({
  sessionQuery: {
    listSessions: async () => sessions.map((s) => ({
      header: { id: s.id, createdAt: s.createdAt, ...(s.cwd === undefined ? {} : { cwd: s.cwd }) },
      live: false,
      persisted: true,
    })),
    listEvents: async (id: string) => {
      const s = sessions.find((x) => x.id === String(id))
      if (s === undefined || s.firstType === 'throw') throw new Error('读不到')
      return [{ sessionId: id, seq: 0, type: s.firstType, time: 0 }]
    },
    readTitle: async (id: string) => {
      const s = sessions.find((x) => x.id === String(id))
      if (s?.title === 'throw') throw new Error('标题读不到')
      return s?.title === undefined ? undefined : { title: s.title }
    },
  },
} as unknown as Context)

const ours = (id: string, extra: Partial<FakeSession> = {}): FakeSession => ({
  id, createdAt: 1_700_000_000_000, firstType: 'deephub-share/received',
  cwd: '/work/space', title: `测试用户甲 分享了思路：${id}`, ...extra,
})

test('只挑我们落的那些，别人的会话一条都不带', async () => {
  const list = await landedIdeas(fakeCtx([
    ours('idea-1'),
    { id: 'session-abc', createdAt: 1, cwd: '/work/space', firstType: 'session/title', title: '整理笔记' },
    ours('idea-2'),
  ]))
  assert.deepEqual(list.map((x) => x.sessionId), ['idea-1', 'idea-2'])
  assert.equal(list[0]?.title, '测试用户甲 分享了思路：idea-1')
  assert.equal(list[0]?.cwd, '/work/space')
  assert.equal(list[0]?.createdAt, 1_700_000_000_000)
})

test('名字像但第 0 条事件不是我们的 —— 不算数', async () => {
  const list = await landedIdeas(fakeCtx([
    { id: 'idea-假的', createdAt: 1, cwd: '/work/space', firstType: 'user/message', title: '看起来像' },
    ours('idea-真的'),
  ]))
  assert.deepEqual(list.map((x) => x.sessionId), ['idea-真的'])
})

test('读事件读不出来的那条，跳过而不是猜', async () => {
  const list = await landedIdeas(fakeCtx([
    { id: 'idea-坏的', createdAt: 1, cwd: '/work/space', firstType: 'throw', title: undefined },
    ours('idea-好的'),
  ]))
  assert.deepEqual(list.map((x) => x.sessionId), ['idea-好的'])
})

test('标题读不到不该让这条从清单里消失，标题留空就是了', async () => {
  const list = await landedIdeas(fakeCtx([
    ours('idea-1', { title: 'throw' }),
    ours('idea-2', { title: undefined }),
  ]))
  assert.deepEqual(list.map((x) => x.sessionId), ['idea-1', 'idea-2'])
  assert.equal(list[0]?.title, '')
  assert.equal(list[1]?.title, '')
})

test('最多 50 条，顺序跟着 dsh（新的在前）', async () => {
  const many = Array.from({ length: 80 }, (_, i) => ours(`idea-${i}`))
  const list = await landedIdeas(fakeCtx(many))
  assert.equal(list.length, 50)
  assert.equal(list[0]?.sessionId, 'idea-0')
  assert.equal(list[49]?.sessionId, 'idea-49')
})

test('没有工作区路径时 cwd 是 null，不是 undefined（要过 JSON）', async () => {
  const list = await landedIdeas(fakeCtx([ours('idea-1', { cwd: undefined })]))
  assert.equal(list[0]?.cwd, null)
})
