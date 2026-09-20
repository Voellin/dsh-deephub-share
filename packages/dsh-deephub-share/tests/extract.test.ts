/**
 * 合成一段 dsh 日志，验过滤 / 依赖清单 / 交付物 / 脱敏① / Markdown / 路由解析。
 * 跑法：`npm test`（node --experimental-strip-types --test）。真 dsh 的端到端见 README「验证」。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { extractRaw, countDeps, mcpServerOf } from '../src/extract.ts'
import { foldDeliverables, mutationPath } from '../src/deliverables.ts'
import { redactArgs, redactStructural, stripAbsolutePaths, applyDecisions } from '../src/redact.ts'
import { ideaToMarkdown, markdownFilename } from '../src/shared/markdown.ts'
import { resolveRoute, digest, emptyDoc } from '../src/llm.ts'

const CWD = '/home/lin/proj'
let seq = 0
const ev = (type: string, data: unknown, extra: Record<string, unknown> = {}): SessionEvent =>
  ({ type, seq: ++seq, time: 1000 + seq, data, ...extra }) as unknown as SessionEvent

const user = (text: string, source: unknown = { kind: 'user' }, extraBlocks: unknown[] = []) =>
  ev('user/message', { id: `m${seq}`, role: 'user', content: [{ type: 'text', text }, ...extraBlocks], source }, { surfaceOp: 'append' })
const assistant = (blocks: unknown[]) =>
  ev('assistant/message', { turn: 1, step: 1, message: { id: `a${seq}`, role: 'assistant', content: blocks, source: { kind: 'model', provider: 'p', model: 'm' } }, stream: [] }, { surfaceOp: 'append' })
const call = (callId: string, name: string, args: unknown) =>
  ev('tool/call', { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) })
const result = (callId: string, text: string, isError = false) =>
  ev('tool/result', { turn: 1, step: 1, message: { id: `r${seq}`, role: 'user', content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text }], isError }], source: { kind: 'tool', callId } } }, { surfaceOp: 'append' })

function sampleLog(): SessionEvent[] {
  seq = 0
  return [
    ev('request/header', { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } }, reason: 'initial' }),
    ev('system/message', { turn: 1, step: 1, message: { id: 's1', role: 'system', content: [{ type: 'text', text: 'SYSTEM PROMPT with AGENTS.md' }], source: { kind: 'plugin', plugin: 'dsh-system-prompt' } } }, { surfaceOp: 'append' }),
    user('帮我把 /home/lin/proj/notes.txt 整理成报告', { kind: 'user' }, [{ type: 'image', attachment: { id: 'img1' } }]),
    user('MEMORY: 用户喜欢简洁', { kind: 'plugin', plugin: 'dsh-memory', form: 'notice', summary: 'x' }),
    ev('turn/start', { turn: 1 }),
    assistant([
      { type: 'reasoning', text: 'SECRET THINKING' },
      { type: 'text', text: '好的，我先读文件。' },
      { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' },
    ]),
    call('c1', 'read', { file_path: '/home/lin/proj/notes.txt' }),
    result('c1', 'notes content\n'.repeat(3)),
    call('c2', 'write', { file_path: '/home/lin/proj/out/report.md', content: '# 报告', api_key: 'sk-abc' }),
    result('c2', 'wrote /home/lin/proj/out/report.md'),
    call('c3', 'write', { file_path: '/home/lin/proj/out/bad.md', content: 'x' }),
    result('c3', 'permission denied', true),
    call('c4', 'bash', { command: 'ls C:\\Users\\lin\\Desktop' }),
    result('c4', 'x'.repeat(10_000)),
    call('c5', 'mcp__feishu__send_doc', { doc: 'https://internal.example.com/doc/1' }),
    result('c5', 'sent'),
    call('c6', 'web_search', { query: 'markdown report' }),
    result('c6', '[]'),
    ev('assistant/attempt', { turn: 1, step: 2, stream: [] }),
    assistant([{ type: 'text', text: '报告写好了，在 /home/lin/proj/out/report.md。' }]),
    ev('deliverables/presented', { turn: 1, callId: 'c7', files: [{ path: 'out/report.md', description: '整理后的报告' }] }),
    ev('turn/end', { turn: 1, reason: 'stop' }),
  ]
}

test('过滤：system / 插件注入 / reasoning / attempt 不出门', () => {
  const ex = extractRaw(sampleLog())
  const all = JSON.stringify(ex.raw)
  assert.ok(!all.includes('SYSTEM PROMPT'))
  assert.ok(!all.includes('MEMORY:'))
  assert.ok(!all.includes('SECRET THINKING'))
  assert.equal(ex.raw.filter((r) => r.role === 'user').length, 1)
  assert.equal(ex.raw.filter((r) => r.role === 'agent').length, 2)
  assert.equal(ex.firstUserLine, '帮我把 /home/lin/proj/notes.txt 整理成报告')
  assert.equal(ex.hasImage, true)
})

test('工具结果截断到 maxToolChars，失败结果也带并标「（失败）」', () => {
  const ex = extractRaw(sampleLog(), { maxToolChars: 100 })
  const bash = ex.raw.find((r) => r.label === 'bash → 结果')
  assert.ok(bash && bash.text.length === 100)
  const bad = ex.raw.find((r) => r.label === 'write → 结果' && r.text.startsWith('（失败）'))
  assert.ok(bad)
})

test('依赖清单：归类合并、MCP 服务器进 connectors、联网 → 搜索、图片 → 视觉', () => {
  const ex = extractRaw(sampleLog())
  assert.deepEqual(ex.deps.tools, ['文件（read、write）', 'shell（bash）', '联网（web_search）', 'mcp__feishu__send_doc'])
  assert.deepEqual(ex.deps.connectors, ['feishu', '搜索'])
  assert.deepEqual(ex.deps.capabilities, ['视觉'])
  assert.equal(mcpServerOf('mcp__x__y'), 'x')
  assert.equal(mcpServerOf('mcp__x'), null)
  assert.equal(mcpServerOf('bash'), null)
  assert.deepEqual(countDeps(['read_image'], false).capabilities, ['视觉'])
})

test('交付物：只认成功的 write/edit/str_replace_editor，presented 描述覆盖上去', () => {
  const d = foldDeliverables(sampleLog(), CWD)
  assert.deepEqual(d.map((x) => x.path), ['/home/lin/proj/out/report.md']) // presented 的 out/report.md 是同一个文件
  assert.equal(d[0]?.presented, '整理后的报告')
  assert.equal(foldDeliverables(sampleLog()).length, 2) // 没 cwd 就按原样写法分开
  assert.equal(mutationPath('write', JSON.stringify({ file_path: 'a' })), null) // 没 content 不算
  assert.equal(mutationPath('edit', JSON.stringify({ file_path: 'a', old_string: 'x', new_string: 'x' })), null)
  assert.equal(mutationPath('str_replace_editor', JSON.stringify({ command: 'create', path: 'p', file_text: '' })), 'p')
  assert.equal(mutationPath('str_replace_editor', JSON.stringify({ command: 'view', path: 'p' })), null)
  assert.equal(mutationPath('bash', JSON.stringify({ command: 'x' })), null)
})

test('脱敏①：cwd 相对化、cwd 外只留文件名、凭据键剔值、Windows 路径', () => {
  assert.equal(stripAbsolutePaths('看 /home/lin/proj/src/a.ts 和 /home/lin/proj', CWD), '看 src/a.ts 和 .')
  assert.equal(stripAbsolutePaths('在 /tmp/x/y.txt 里', CWD), '在 y.txt 里')
  assert.equal(stripAbsolutePaths('在 C:\\Users\\lin\\Desktop\\b.txt 里'), '在 b.txt 里')
  assert.equal(stripAbsolutePaths('D:\\proj\\src\\a.ts', 'D:\\proj'), 'src\\a.ts')
  const args = redactArgs(JSON.stringify({ file_path: '/home/lin/proj/out/report.md', api_key: 'sk-abc', nested: { token: 't', ok: 'v' } }), CWD)
  assert.deepEqual(JSON.parse(args), { file_path: 'out/report.md', api_key: '「已剔除」', nested: { token: '「已剔除」', ok: 'v' } })
  assert.equal(redactArgs('not json /home/lin/proj/x', CWD), 'not json x')

  const ex = extractRaw(sampleLog())
  const doc = emptyDoc(ex.firstUserLine)
  doc.raw = ex.raw
  doc.steps = ['读 /home/lin/proj/notes.txt']
  const r = redactStructural(doc, CWD)
  const all = JSON.stringify(r)
  assert.ok(!all.includes('sk-abc'))
  assert.ok(!all.includes('/home/lin/proj'))
  assert.equal(r.title, '帮我把 notes.txt 整理成报告')
  assert.deepEqual(r.steps, ['读 notes.txt'])
  assert.deepEqual(redactStructural(r, CWD), r) // 幂等
})

test('脱敏②应用：长的先换，mask / placeholder', () => {
  const doc = emptyDoc('张三的报告')
  doc.steps = ['张三给 ACME 公司做的']
  const out = applyDecisions(doc, [
    { id: 'a', kind: 'person', text: '张三', action: 'mask' },
    { id: 'b', kind: 'company', text: 'ACME 公司', action: 'placeholder', replacement: '某客户' },
  ])
  assert.equal(out.title, '██的报告')
  assert.deepEqual(out.steps, ['██给 某客户做的'])
})

test('Markdown：上层各段 + 原始记录展开；文件名过滤非法字符', () => {
  const doc = emptyDoc('a/b:c*报告?')
  doc.goal = '目标'
  doc.deps = { tools: ['shell（bash）'], connectors: ['搜索'], capabilities: [] }
  doc.steps = ['一', '二']
  doc.pitfalls = ['坑']
  doc.deliverables = [{ title: 'report.md', kind: 'file' }]
  doc.raw = [{ role: 'user', text: '第一行\n第二行' }, { role: 'tool', label: 'bash', text: '{"command":"ls"}' }]
  const md = ideaToMarkdown(doc, { exportedAt: new Date('2026-09-14T00:00:00Z') })
  assert.ok(md.startsWith('# a/b:c*报告?\n\n目标'))
  assert.ok(md.includes('## 依赖清单\n\n- 工具：shell（bash）\n- 需要连：搜索'))
  assert.ok(md.includes('## 步骤\n\n- 一\n- 二'))
  assert.ok(!md.includes('关键岔路'))
  assert.ok(md.includes('## 原始记录（2 条）'))
  assert.ok(md.includes('**用户**\n\n> 第一行\n> 第二行'))
  assert.ok(md.includes('**工具 bash**'))
  assert.ok(md.includes('2026-09-14'))
  assert.equal(markdownFilename(doc), 'a b c 报告.md')
})

test('路由：会话用过的模型优先，其次配置，都没有 → null', () => {
  const log = sampleLog()
  assert.deepEqual(resolveRoute(log), { provider: 'deepseek-official', model: 'deepseek-flash' })
  assert.deepEqual(resolveRoute([], { provider: 'p', model: 'm' }), { provider: 'p', model: 'm' })
  assert.equal(resolveRoute([], { provider: 'p' }), null)
  assert.equal(resolveRoute([]), null)
})

test('digest：工具 300 字、对话 1200 字、总量封顶', () => {
  const raw = [{ role: 'user' as const, text: 'u'.repeat(5000) }, { role: 'tool' as const, label: 'bash', text: 't'.repeat(5000) }]
  const d = digest(raw, 100_000)
  assert.ok(d.startsWith('用户：' + 'u'.repeat(1200) + '\n[工具 bash] ' + 't'.repeat(300)))
  assert.equal(digest(raw, 10), '')
})
