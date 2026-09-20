/**
 * 推送闸门：协议改了、线上服务端还没跟上，就别推出去。
 *
 * 为什么是「推送」这一刻而不是提交：**git 历史是公开的、永远的。** 一个还没在服务端部署的
 * 协议改动被推出去，任何人读到那次提交就知道「这里有个洞、线上还没堵」。
 * pin 防的错误可逆（漂了改回来就行），这一条防的错误不可逆——赌注不对称，所以要机器拦。
 *
 * 两类文件，两种判法：
 *
 *   registry.ts —— 能自动判。`PROTOCOL.md` 的规矩是「**加版本＝服务端先**」，
 *                  所以线上 /api/v1/protocol 的 current 必须**已经 ≥** 本地的 current。
 *                  只改注释、current 没变的，放行（比的是解析出来的数，不是文件哈希）。
 *
 *   canon.ts / sign.ts —— **自动判不了**。服务端不回待签字节格式的指纹，没有任何接口能证明
 *                  它那半已经换过。所以硬停，让人自己确认服务端已经同步部署。
 *
 * 过不去又确实该推：`git push --no-verify`。
 */
const files = process.argv.slice(2)
const HOST = process.env.DH_PROTOCOL_HOST ?? 'https://deephub.cyou'
const REGISTRY = 'packages/cloud-protocol/src/protocol/registry.ts'
const CANON = ['packages/cloud-protocol/src/cloud/canon.ts', 'packages/cloud-protocol/src/cloud/sign.ts']
const R = '\x1b[31m', D = '\x1b[2m', X = '\x1b[0m'

const die = (title, lines) => {
  console.error(`\n${R}✖ 推送被拦下：${title}${X}`)
  for (const l of lines) console.error(`${D}   ${l}${X}`)
  console.error(`${D}\n   确认线上已经跟上了，就用 git push --no-verify。${X}\n`)
  process.exit(1)
}

const touchedCanon = CANON.filter((f) => files.includes(f))
if (touchedCanon.length > 0) {
  die('待签字节的定义变了，而这件事机器验不了', [
    `改到的文件：${touchedCanon.join('、')}`,
    '服务端不回待签格式的指纹，没有任何接口能证明它那半也换过了。',
    '差一个字节 = 全部请求 401，而服务端刻意不区分失败原因，极难排查。',
    '请先确认服务端对应的那份实现已经部署上去。',
  ])
}

if (!files.includes(REGISTRY)) process.exit(0)

const { readFileSync } = await import('node:fs')
const src = readFileSync(REGISTRY, 'utf8')
const m = src.match(/current:\s*(\d+)/)
if (m === null) die('读不出本地 registry.ts 的 current', [`文件：${REGISTRY}`, '格式变了？闸门需要跟着改。'])
const mine = Number(m[1])

let live
try {
  const res = await fetch(`${HOST}/api/v1/protocol`, { signal: AbortSignal.timeout(8000) })
  live = (await res.json()).current
} catch (e) {
  die('协议版本表变了，但线上问不到当前版本', [
    `${HOST}/api/v1/protocol：${e.message}`,
    '网络不通就先别推——没法确认服务端是不是已经支持这一版。',
  ])
}

if (typeof live !== 'number') die('线上回的 current 不是数字', [`收到：${JSON.stringify(live)}`])
if (live < mine) {
  die('协议升到了新版本，但服务端还没部署', [
    `本地 registry.ts current = ${mine}，线上 = ${live}`,
    'PROTOCOL.md 的规矩：加版本＝服务端先。先部署服务端，再推这个提交。',
  ])
}
console.error(`${D}  协议闸门：registry.ts current=${mine}，线上=${live} ✓${X}`)
