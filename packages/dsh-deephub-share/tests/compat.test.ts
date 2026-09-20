/**
 * 装载期的护栏。守的是一条很具体的事实——
 * **dsh 的加载器一棵树里任何一个插件装不上，整棵树就失败**：Host 半抛错 `dsh web` 进程直接退出，
 * 浏览器半抛错整个界面变成一页错误。所以插件自己得兜住。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CLIENT_REQUIRED, HOST_REQUIRED, guard, probe } from '../src/compat.ts'

/** 按路径造一个"长着这些方法"的假 ctx。 */
function ctxWith(paths: readonly string[]): Record<string, unknown> {
  const root: Record<string, unknown> = {}
  for (const p of paths) {
    const parts = p.split('.')
    let cur = root
    parts.forEach((k, i) => {
      if (i === parts.length - 1) cur[k] = () => undefined
      else { cur[k] = (cur[k] as Record<string, unknown>) ?? {}; cur = cur[k] as Record<string, unknown> }
    })
  }
  return root
}

test('口子齐全时探测通过', () => {
  assert.deepEqual(probe(ctxWith(HOST_REQUIRED), HOST_REQUIRED), { ok: true, missing: [] })
  assert.deepEqual(probe(ctxWith(CLIENT_REQUIRED), CLIENT_REQUIRED), { ok: true, missing: [] })
})

test('缺哪个就点名哪个，不含糊', () => {
  const r = probe(ctxWith(HOST_REQUIRED.filter((p) => p !== 'llm.stream')), HOST_REQUIRED)
  assert.equal(r.ok, false)
  assert.deepEqual(r.missing, ['llm.stream'])
})

test('整个服务没了也认得出来（不是只看最后一段）', () => {
  const r = probe({}, ['connection.fetch.register', 'llm.stream'])
  assert.deepEqual(r.missing, ['connection.fetch.register', 'llm.stream'])
})

test('名字在但不是函数 —— 同样算缺', () => {
  const r = probe({ llm: { stream: 'not a function' } }, ['llm.stream'])
  assert.equal(r.ok, false)
})

test('探测过了就真的跑，返回 true', () => {
  let ran = false
  const ok = guard('host', '0.0.0', ctxWith(['a.b']), ['a.b'], () => { ran = true })
  assert.equal(ok, true)
  assert.equal(ran, true)
})

test('探测没过就**根本不跑**那段装载逻辑', () => {
  let ran = false
  const ok = guard('host', '0.0.0', {}, ['a.b'], () => { ran = true })
  assert.equal(ok, false)
  assert.equal(ran, false, '口子都不全还去注册，正是会把 dsh 带走的那条路')
})

test('装载中途抛错 —— 吞掉、返回 false，绝不往外抛', () => {
  let ok: boolean | undefined
  assert.doesNotThrow(() => {
    ok = guard('client', '0.0.0', ctxWith(['a.b']), ['a.b'], () => { throw new Error('接口改名了') })
  })
  assert.equal(ok, false)
})
