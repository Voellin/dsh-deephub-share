import { test } from 'node:test'
import assert from 'node:assert/strict'
import { REGISTRY } from '../src/protocol/registry.ts'
import { PROTOCOL_VERSION, CLIENT_MIN_SERVER, capabilitiesFor, negotiate } from '../src/protocol/version.ts'

test('登记簿的形状合法', () => {
  assert.equal(typeof REGISTRY.current, 'number')
  assert.ok(Number.isInteger(REGISTRY.current) && REGISTRY.current >= 1)
  for (const [at, names] of Object.entries(REGISTRY.added)) {
    assert.match(at, /^\d+$/, `版本键必须是数字字符串，实际是 ${at}`)
    assert.ok(Array.isArray(names) && names.every((n) => typeof n === 'string'))
  }
  assert.ok(String(REGISTRY.current) in REGISTRY.added, 'current 必须在 added 里有条目')
})

test('PROTOCOL_VERSION 就是登记簿里的 current', () => {
  assert.equal(PROTOCOL_VERSION, REGISTRY.current)
})

test('capabilitiesFor 是**累积**并集，不是某一版单独加的那些', () => {
  assert.deepEqual([...capabilitiesFor(0)], [])
  assert.deepEqual([...capabilitiesFor(1)], ['base'])
  // 将来版本必须包含所有历史能力——这条钉住「下线只能靠抬下限，不能从 added 里删」
  for (const c of capabilitiesFor(PROTOCOL_VERSION)) {
    assert.ok(capabilitiesFor(PROTOCOL_VERSION + 5).has(c), `${c} 在更高版本里消失了`)
  }
})

test('negotiate：相等时取那一版', () => {
  assert.deepEqual(negotiate({ current: 1, min: 0 }, { current: 1, min: 0 }), { kind: 'ok', version: 1 })
})

test('negotiate：**我比服务端新不是错误**，按较小者说话', () => {
  assert.deepEqual(negotiate({ current: 3, min: 0 }, { current: 1, min: 0 }), { kind: 'ok', version: 1 })
})

test('negotiate：服务端比我新，也按较小者说话', () => {
  assert.deepEqual(negotiate({ current: 1, min: 0 }, { current: 3, min: 0 }), { kind: 'ok', version: 1 })
})

test('negotiate：我低于服务端的下限 → client_too_old', () => {
  assert.deepEqual(negotiate({ current: 1, min: 0 }, { current: 3, min: 2 }),
    { kind: 'client_too_old', serverMin: 2, mine: 1 })
})

test('negotiate：服务端低于我的下限 → server_too_old', () => {
  assert.deepEqual(negotiate({ current: 3, min: 2 }, { current: 1, min: 0 }),
    { kind: 'server_too_old', serverCurrent: 1, myMin: 2 })
})

test('negotiate：两边都不满足时，server_too_old 先判', () => {
  // 顺序是定死的：先看「服务端够不够新」，再看「我够不够新」。
  // 两条都不满足说明双方差得太远，报哪个都对，但必须**稳定**——否则用户看到的提示会飘。
  assert.equal(negotiate({ current: 1, min: 5 }, { current: 2, min: 9 }).kind, 'server_too_old')
})

test('CLIENT_MIN_SERVER 是本端自己的下限，不受协商影响', () => {
  assert.equal(typeof CLIENT_MIN_SERVER, 'number')
  assert.ok(Number.isInteger(CLIENT_MIN_SERVER) && CLIENT_MIN_SERVER >= 0)
  const before = CLIENT_MIN_SERVER
  negotiate({ current: PROTOCOL_VERSION, min: CLIENT_MIN_SERVER }, { current: 99, min: 99 })
  assert.equal(CLIENT_MIN_SERVER, before, '协商绝不能改写本端的下限')
})
