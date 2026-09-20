/** 附件候选的路径判定（纯函数部分）：哪些文件能当候选、哪些一律不列。 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sep } from 'node:path'
import { isInside, resolveCandidates } from '../src/attachments.ts'

const win = process.platform === 'win32'
const CWD = win ? 'C:\\work\\proj' : '/work/proj'
const j = (...p: string[]): string => p.join(sep)

test('isInside：等于、子路径算在内；兄弟目录、前缀相同但不是子目录的不算', () => {
  assert.equal(isInside(CWD, CWD), true)
  assert.equal(isInside(CWD, j(CWD, 'out', 'a.md')), true)
  assert.equal(isInside(CWD, CWD + '2'), false)          // /work/proj2
  assert.equal(isInside(CWD, j(CWD, '..', 'other', 'x')), false)
  assert.equal(isInside(CWD, j(CWD, 'out', '..', '..', 'x')), false)
})

test('resolveCandidates：相对路径按 cwd 解析、越界的丢、重复合并、没 cwd 就空', () => {
  const out = resolveCandidates(CWD, ['out/a.md', j(CWD, 'out', 'a.md'), '../secret.txt', j(CWD, 'b.txt'), 'b.txt'])
  assert.deepEqual(out, [j(CWD, 'out', 'a.md'), j(CWD, 'b.txt')])
  assert.deepEqual(resolveCandidates(undefined, ['a.md']), [])
  if (win) assert.deepEqual(resolveCandidates(CWD, ['OUT\\A.md', 'out\\a.md']).length, 1)
})
