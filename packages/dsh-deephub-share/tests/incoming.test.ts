/**
 * 别人机器上做出来的思路进我们这边之前那道筛子（`sanitizeIdeaDoc`），
 * 以及附件名的消毒（`safeName`）。
 *
 * 这两件事守的是同一条线：**收件路径上的一切都当作不可信**——
 * 老版本发来的、被人手改过的、故意撑大的，都不能把日志撑坏、把界面顶出屏幕、更不能写出工作区。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sanitizeIdeaDoc } from '../src/inbox/incoming.ts'
import { safeName } from '../src/land.ts'

/** 一份合格的思路，各条测试在它上面改一处。 */
const good = (): Record<string, unknown> => ({
  v: 1,
  title: '给 Chrome 扩展加一个右键菜单',
  goal: '让用户选中文字后能直接发给后台',
  deps: { tools: ['文件（read、write）'], connectors: ['chrome'], capabilities: [] },
  steps: ['读 manifest v3 的 contextMenus 权限'],
  forks: ['一开始想用 executeScript，改成让 content script 回传'],
  pitfalls: ['SW 每次唤醒重复 create 会报 duplicate id'],
  deliverables: [{ title: 'manifest.json', kind: 'file' }],
  raw: [{ role: 'user', text: '帮我加个右键菜单' }],
})

test('合格的一份原样过', () => {
  const doc = sanitizeIdeaDoc(good())
  assert.ok(doc !== null)
  assert.equal(doc.title, '给 Chrome 扩展加一个右键菜单')
  assert.deepEqual(doc.steps, ['读 manifest v3 的 contextMenus 权限'])
  assert.deepEqual(doc.deliverables, [{ title: 'manifest.json', kind: 'file' }])
  assert.equal(doc.raw.length, 1)
})

test('不是对象、v 不对、标题空 —— 这三种直接不收', () => {
  assert.equal(sanitizeIdeaDoc(null), null)
  assert.equal(sanitizeIdeaDoc('一份思路'), null)
  assert.equal(sanitizeIdeaDoc([1, 2]), null)
  assert.equal(sanitizeIdeaDoc({ ...good(), v: 2 }), null)
  assert.equal(sanitizeIdeaDoc({ ...good(), title: '   ' }), null)
  assert.equal(sanitizeIdeaDoc({ ...good(), title: 42 }), null)
})

test('少给字段不该让整份收不下来：缺的补成空的', () => {
  const doc = sanitizeIdeaDoc({ v: 1, title: '只有标题' })
  assert.ok(doc !== null)
  assert.equal(doc.goal, '')
  assert.deepEqual(doc.steps, [])
  assert.deepEqual(doc.deps, { tools: [], connectors: [], capabilities: [] })
  assert.deepEqual(doc.raw, [])
})

test('数组里混进来的非字符串丢掉，空串也丢掉', () => {
  const doc = sanitizeIdeaDoc({
    ...good(),
    steps: [{ title: '对象不是字符串' }, '这条是好的', '', null, 7],
    forks: null,
    pitfalls: 'not an array',
    deps: { tools: ['ok', 123, null], connectors: 'nope', capabilities: [] },
  })
  assert.ok(doc !== null)
  assert.deepEqual(doc.steps, ['这条是好的'])
  assert.deepEqual(doc.forks, [])
  assert.deepEqual(doc.pitfalls, [])
  assert.deepEqual(doc.deps.tools, ['ok'])
  assert.deepEqual(doc.deps.connectors, [])
})

test('超长的截断、超量的截掉', () => {
  const doc = sanitizeIdeaDoc({
    ...good(),
    title: 'x'.repeat(400),
    goal: 'g'.repeat(9000),
    steps: Array.from({ length: 500 }, (_, i) => `第 ${i} 步` + 'y'.repeat(9000)),
    raw: Array.from({ length: 900 }, () => ({ role: 'user', text: 'z' })),
  })
  assert.ok(doc !== null)
  assert.equal(doc.title.length, 200)
  assert.equal(doc.goal.length, 4000)
  assert.equal(doc.steps.length, 200)
  assert.equal(doc.steps[0]?.length, 4000)
  assert.equal(doc.raw.length, 500)
})

test('交付物：认不得的种类退回 file，不是对象的丢掉，没标题的丢掉', () => {
  const doc = sanitizeIdeaDoc({
    ...good(),
    deliverables: [{ title: '报告', kind: '不认识的种类' }, 'x', { kind: 'file' }, { title: '表', kind: 'sheet' }],
  })
  assert.ok(doc !== null)
  assert.deepEqual(doc.deliverables, [{ title: '报告', kind: 'file' }, { title: '表', kind: 'sheet' }])
})

test('原始记录：角色认不得退回 agent，正文空的丢掉，label 留着', () => {
  const doc = sanitizeIdeaDoc({
    ...good(),
    raw: [
      { role: '???', text: '角色不认识' },
      { role: 'user', text: '' },
      { role: 'tool', text: '{"ok":1}', label: 'read → 结果' },
    ],
  })
  assert.ok(doc !== null)
  assert.deepEqual(doc.raw, [
    { role: 'agent', text: '角色不认识' },
    { role: 'tool', text: '{"ok":1}', label: 'read → 结果' },
  ])
})

test('收拾完还是过大 —— 不收（这份要永久写进会话日志）', () => {
  // 200 条 × 4000 字 = 80 万字符，UTF-8 下远超 2 MB
  const huge = { ...good(), steps: Array.from({ length: 200 }, () => '啊'.repeat(4000)) }
  assert.equal(sanitizeIdeaDoc(huge), null)
})

// ── 附件名 ──────────────────────────────────────────────────────────────

test('附件名只取最后一段，穿越不出工作区', () => {
  assert.equal(safeName('../../etc/passwd'), 'passwd')
  assert.equal(safeName('..\\..\\Windows\\System32\\drivers\\etc\\hosts'), 'hosts')
  assert.equal(safeName('/etc/shadow'), 'shadow')
  assert.equal(safeName('..'), '_')
  assert.equal(safeName('.ssh'), '_ssh')
})

test('附件名：Windows 不许用的字符和控制字符换成下划线；空的给个兜底名', () => {
  assert.equal(safeName('a<b>c:d"e|f?g*h'), 'a_b_c_d_e_f_g_h')
  assert.equal(safeName(`bad${String.fromCharCode(10)}name`), 'bad_name')
  assert.equal(safeName(''), 'file')
  assert.equal(safeName('   '), 'file')
  assert.equal(safeName('x'.repeat(300)).length, 120)
})
