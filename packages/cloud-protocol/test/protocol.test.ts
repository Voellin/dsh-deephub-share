import { test } from 'node:test'
import assert from 'node:assert/strict'
import { checkProtocol, parseServerProtocol, shouldNegotiate, type ServerProtocol } from '../src/cloud/protocol.ts'
import { CLIENT_MIN_SERVER, PROTOCOL_VERSION } from '../src/protocol/version.ts'

const wire = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  current: 1, min_supported: 0, deprecated_below: 0, sunset: null, capabilities: ['base'], ...over
})
const srv = (over: Partial<ServerProtocol> = {}): ServerProtocol => ({
  current: 1, minSupported: 0, deprecatedBelow: 0, sunset: null, capabilities: ['base'], ...over
})

// ══ 解析：这是防「借签名」攻击的唯一一道防线 ══════════════════════════
test('合格的一份原样解析出来', () => {
  assert.deepEqual(parseServerProtocol(wire()), srv())
})

test('**借签名攻击**：把 /account/kdf 的合法应答塞回来 → null，绝不落 ok', () => {
  // open 路由不消耗 nonce，响应签名又不绑定 method/target，
  // 所以中间人能把我们的 nonce 转发到别的 open 路由，拿回一个**签名合法**的 200。
  const kdfResponse = { kdf: { alg: 'scrypt', N: 65536, r: 8, p: 1, salt: 'XtV7baLPizSc1+ciI68tJw==' } }
  assert.equal(parseServerProtocol(kdfResponse), null)
  assert.deepEqual(checkProtocol(parseServerProtocol(kdfResponse)), { kind: 'unknown' })
})

test('其它 open 路由的应答同样落空', () => {
  for (const body of [{ ok: true, service: 'deephub-api', stage: 'x', server_time: 1789 }, // /api/health
    { message: 'verification_sent' }, { error: 'rate_limited' }, { pubkey: 'x', note: 'advisory_only' }]) {
    assert.equal(parseServerProtocol(body), null, JSON.stringify(body))
  }
})

test('不是对象的一律 null', () => {
  for (const x of [null, undefined, 0, 1, '', 'ok', true, [], [1, 2], () => 0]) {
    assert.equal(parseServerProtocol(x), null, String(x))
  }
})

test('缺字段 → null（不补默认值）', () => {
  for (const k of ['current', 'min_supported', 'deprecated_below', 'sunset', 'capabilities']) {
    const w = wire(); delete w[k]
    assert.equal(parseServerProtocol(w), null, `缺 ${k}`)
  }
})

test('类型不对 → null', () => {
  assert.equal(parseServerProtocol(wire({ current: '1' })), null, 'current 是字符串')
  assert.equal(parseServerProtocol(wire({ current: 1.5 })), null, 'current 是小数')
  assert.equal(parseServerProtocol(wire({ current: -1 })), null, 'current 是负数')
  assert.equal(parseServerProtocol(wire({ current: NaN })), null, 'current 是 NaN')
  assert.equal(parseServerProtocol(wire({ min_supported: null })), null)
  assert.equal(parseServerProtocol(wire({ sunset: '1800000000' })), null, 'sunset 是字符串')
  assert.equal(parseServerProtocol(wire({ sunset: 1.5 })), null)
  assert.equal(parseServerProtocol(wire({ capabilities: 'base' })), null, 'capabilities 不是数组')
  assert.equal(parseServerProtocol(wire({ capabilities: ['base', 7] })), null, '数组里混了非字符串')
})

test('自相矛盾 → null（min > current、弃用线 > current）', () => {
  assert.equal(parseServerProtocol(wire({ current: 1, min_supported: 2 })), null)
  assert.equal(parseServerProtocol(wire({ current: 1, deprecated_below: 3 })), null)
})

test('多出来的字段要**容忍** —— 将来的服务端会加字段，不能因此判死', () => {
  const r = parseServerProtocol(wire({ future_field: 'whatever', another: [1, 2, 3] }))
  assert.deepEqual(r, srv())
})

test('sunset 可以是 null，也可以是非负整数', () => {
  assert.equal(parseServerProtocol(wire({ sunset: null }))?.sunset, null)
  assert.equal(parseServerProtocol(wire({ sunset: 1800000000 }))?.sunset, 1800000000)
  assert.equal(parseServerProtocol(wire({ sunset: 0 }))?.sunset, 0)
})

// ══ 判定 ════════════════════════════════════════════════════════════
test('探不到 → unknown（离线是常态，不是错误）', () => {
  assert.deepEqual(checkProtocol(null), { kind: 'unknown' })
})

test('版本对得上 → ok，并给出能力集', () => {
  const r = checkProtocol(srv({ current: PROTOCOL_VERSION }))
  assert.equal(r.kind, 'ok')
  if (r.kind === 'ok') {
    assert.equal(r.version, PROTOCOL_VERSION)
    assert.ok(r.caps.has('base'))
  }
})

test('**能力集来自本地表，不采信服务端广播的那一份**', () => {
  // 采信服务端 = 让它（或冒充它的人）决定我们以为自己能做什么，
  // 而我们真正能做的只有本地代码实现了的那些。
  const r = checkProtocol(srv({ capabilities: ['base', '服务端编出来的能力'] }))
  assert.equal(r.kind, 'ok')
  if (r.kind === 'ok') assert.equal(r.caps.has('服务端编出来的能力'), false)
})

test('我低于服务端下限 → client_too_old', () => {
  const r = checkProtocol(srv({ current: PROTOCOL_VERSION + 2, minSupported: PROTOCOL_VERSION + 1 }))
  assert.equal(r.kind, 'client_too_old')
  if (r.kind === 'client_too_old') assert.equal(r.mine, PROTOCOL_VERSION)
})

test('服务端低于我的下限 → server_too_old', () => {
  // 本端下限是 0 时这一支进不来（任何非负 current 都 ≥ 0），所以直接测 negotiate 的语义边界
  const r = checkProtocol(srv({ current: Math.max(0, CLIENT_MIN_SERVER - 1) }))
  assert.equal(r.kind, CLIENT_MIN_SERVER > 0 ? 'server_too_old' : 'ok')
})

test('在弃用窗口里 → client_deprecated，带 sunset', () => {
  const r = checkProtocol(srv({ current: PROTOCOL_VERSION + 3, deprecatedBelow: PROTOCOL_VERSION + 1, sunset: 1800000000 }))
  assert.equal(r.kind, 'client_deprecated')
  if (r.kind === 'client_deprecated') assert.equal(r.sunset, 1800000000)
})

test('**client_deprecated 必须照样带 version 和 caps** —— 它是"仍受支持"的一种', () => {
  // 只给 ok 灌协商结果的话，一个"已弃用但仍可用"的客户端会退回最保守行为，
  // 而服务端按它声明的版本应答，两边就错开了（v1 阶段无感，v2 会咬人）
  const r = checkProtocol(srv({ current: PROTOCOL_VERSION + 3, deprecatedBelow: PROTOCOL_VERSION + 1, sunset: null }))
  assert.equal(r.kind, 'client_deprecated')
  if (r.kind === 'client_deprecated') {
    assert.equal(r.version, PROTOCOL_VERSION, '取双方较小者')
    assert.ok(r.caps.has('base'), '能力集不能是空的')
    const ok = checkProtocol(srv({ current: PROTOCOL_VERSION }))
    if (ok.kind === 'ok') assert.deepEqual([...r.caps], [...ok.caps], '与 ok 走同一张本地表')
  }
})

test('**client_too_old 优先于 client_deprecated** —— 已经进不去了就别只说"即将弃用"', () => {
  const r = checkProtocol(srv({
    current: PROTOCOL_VERSION + 3, minSupported: PROTOCOL_VERSION + 1, deprecatedBelow: PROTOCOL_VERSION + 2
  }))
  assert.equal(r.kind, 'client_too_old')
})

test('**协商不得降低本端自己的下限**', () => {
  const before = CLIENT_MIN_SERVER
  checkProtocol(srv({ current: 99, minSupported: 99, deprecatedBelow: 99 }))
  checkProtocol(parseServerProtocol(wire({ current: 99, min_supported: 99, deprecated_below: 99 })))
  assert.equal(CLIENT_MIN_SERVER, before)
})

// ══ 重新协商的节流 ══════════════════════════════════════════════════
const TTL = 30 * 60_000

test('从没协商成功过 → **总是重试**，不受 TTL 限制', () => {
  // 离线是常态。上一次没探到，不该让客户端接下来半小时都「不知道」。
  assert.equal(shouldNegotiate('unknown', 0, 0, TTL), true)
  assert.equal(shouldNegotiate('unknown', 1_000_000, 1_000_001, TTL), true)
})

test('协商过、还新鲜 → 不重来（面板开着是 10 秒一次 probe）', () => {
  assert.equal(shouldNegotiate('ok', 1_000_000, 1_000_000 + 10_000, TTL), false)
  assert.equal(shouldNegotiate('client_too_old', 1_000_000, 1_000_000 + TTL - 1, TTL), false)
  assert.equal(shouldNegotiate('client_deprecated', 1_000_000, 1_000_000 + 1, TTL), false)
})

test('协商过、过期了 → 重来', () => {
  assert.equal(shouldNegotiate('ok', 1_000_000, 1_000_000 + TTL, TTL), true)
  assert.equal(shouldNegotiate('ok', 1_000_000, 1_000_000 + TTL + 1, TTL), true)
})

test('时钟倒退也不会把自己卡死', () => {
  // 系统时间被往回拨：now - lastAt 是负数，于是暂时不重协商——这是安全的那一侧
  // （最坏是多用一会儿旧结论），而且下一次时钟正常就自愈。不能因此进入死循环或抛错。
  assert.equal(shouldNegotiate('ok', 2_000_000, 1_000_000, TTL), false)
  assert.equal(shouldNegotiate('unknown', 2_000_000, 1_000_000, TTL), true)
})
