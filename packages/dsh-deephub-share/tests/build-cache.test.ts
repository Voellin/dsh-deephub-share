/** 整理结果的缓存与去重：指纹失效、在途只跑一次、失败的不留。 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { fingerprint, hit, look, remember, forget, _size, _clear } from '../src/build-cache.ts'
import type { BuildResponse } from '../src/shared/idea.ts'

const ev = (seq: number): { seq: number } => ({ seq })
const events = (n: number): never[] => Array.from({ length: n }, (_, i) => ev(i + 1)) as never[]
const resp = (llmOk: boolean): BuildResponse =>
  ({ doc: { v: 1, title: 't', goal: '', deps: { tools: [], connectors: [], capabilities: [] }, steps: [], forks: [], pitfalls: [], deliverables: [], raw: [] }, llmOk, route: null, files: [] })

beforeEach(() => { _clear() })

test('指纹：条数或最后一条的 seq 变了就是另一份', () => {
  assert.equal(fingerprint(events(3)), fingerprint(events(3)))
  assert.notEqual(fingerprint(events(3)), fingerprint(events(4)))
  assert.notEqual(fingerprint([ev(9)] as never[]), fingerprint([ev(10)] as never[]))
  assert.equal(fingerprint([]), '0:0')
})

test('成功的结果留下：同一指纹再问就是同一个 promise，不会再跑一次', async () => {
  const fp = fingerprint(events(2))
  let ran = 0
  const task = (async () => { ran += 1; return resp(true) })()
  remember('s1', fp, task)
  await task
  assert.equal(look('s1', fp), 'ready')
  const again = hit('s1', fp)
  assert.equal(again, task)
  await again
  assert.equal(ran, 1)
})

test('在途：还没跑完时是 running，第二个请求挂到同一个任务上', async () => {
  const fp = fingerprint(events(2))
  let resolve: ((r: BuildResponse) => void) | null = null
  const task = new Promise<BuildResponse>((r) => { resolve = r })
  remember('s2', fp, task)
  assert.equal(look('s2', fp), 'running')
  assert.equal(hit('s2', fp), task)
  resolve!(resp(true))
  await task
  assert.equal(look('s2', fp), 'ready')
})

test('会话有了新事件：旧缓存作废，重新算', async () => {
  const fp1 = fingerprint(events(2))
  const task = Promise.resolve(resp(true))
  remember('s3', fp1, task)
  await task
  assert.equal(look('s3', fingerprint(events(3))), 'none')
  assert.equal(hit('s3', fingerprint(events(3))), null)
})

test('模型那步没成的结果不留：下次打开还是"还没整理"', async () => {
  const fp = fingerprint(events(2))
  const task = Promise.resolve(resp(false))
  remember('s4', fp, task)
  await task
  assert.equal(look('s4', fp), 'none')
})

test('抛错的任务也不留', async () => {
  const fp = fingerprint(events(2))
  const task = Promise.reject(new Error('boom'))
  remember('s5', fp, task)
  await task.catch(() => {})
  await new Promise((r) => setTimeout(r, 0))
  assert.equal(look('s5', fp), 'none')
})

test('「重新整理」把缓存扔掉', async () => {
  const fp = fingerprint(events(2))
  const task = Promise.resolve(resp(true))
  remember('s6', fp, task)
  await task
  assert.equal(look('s6', fp), 'ready')
  forget('s6')
  assert.equal(look('s6', fp), 'none')
})

test('条数上限：最多留 20 条会话', async () => {
  const fp = fingerprint(events(1))
  for (let i = 0; i < 25; i++) {
    const task = Promise.resolve(resp(true))
    remember(`many-${i}`, fp, task)
    await task
  }
  assert.ok(_size() <= 20, `留了 ${_size()} 条`)
})
