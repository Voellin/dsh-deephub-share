/** 输出被上限截断时，半截里能捞出步骤就用（`TruncatedOutput`）。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { narrate, TruncatedOutput } from '../src/llm.ts'
import type { IdeaRawItem } from '../src/shared/idea.ts'

const raw = (text: string): IdeaRawItem[] => [{ role: 'user', text }]
const JSON_OK = JSON.stringify({ title: '标题', goal: '目标', steps: ['一', '二'], forks: ['岔'], pitfalls: [] })

test('正常一块：拼出叙述，truncated 为 false', async () => {
  const n = await narrate(async () => JSON_OK, raw('随便一句'))
  assert.equal(n?.title, '标题')
  assert.deepEqual(n?.steps, ['一', '二'])
  assert.equal(n?.truncated, false)
})

test('截断但 JSON 已经写完（后面的解释被砍掉）：照用，标成 truncated', async () => {
  const n = await narrate(async () => { throw new TruncatedOutput(JSON_OK + '\n以上就是整理结果，另外还想说明') }, raw('x'))
  assert.deepEqual(n?.steps, ['一', '二'])
  assert.equal(n?.truncated, true)
})

test('截断且捞不出步骤：把截断这个原因抛出去，不装作成功', async () => {
  await assert.rejects(
    () => narrate(async () => { throw new TruncatedOutput('{"title":"标题","steps":["一半的句') }, raw('x')),
    (e: unknown) => e instanceof TruncatedOutput,
  )
})

test('没截断但模型答非所问：返回 null（走 no_steps 那条路）', async () => {
  const n = await narrate(async () => '好的，我看完了。', raw('x'))
  assert.equal(n, null)
})

test('多块时一块截断捞不着、另一块正常：仍然出结果', async () => {
  // digest 把每条用户消息砍到 1200 字、一行不拆，所以要用多条凑够 24000 字才切得出两块
  const many: IdeaRawItem[] = Array.from({ length: 30 }, () => ({ role: 'user' as const, text: 'a'.repeat(1000) }))
  let call = 0
  const n = await narrate(async () => {
    call += 1
    if (call === 1) throw new TruncatedOutput('没写完的 {')
    return JSON_OK
  }, many)
  assert.equal(call, 2)
  assert.deepEqual(n?.steps, ['一', '二'])
  assert.equal(n?.truncated, false) // 用上的那块没被截断
})

test('模型要调工具那种错原样抛出，不当成截断', async () => {
  await assert.rejects(
    () => narrate(async () => { throw new Error('deephub-share: model unexpectedly requested a tool') }, raw('x')),
    /requested a tool/,
  )
})
