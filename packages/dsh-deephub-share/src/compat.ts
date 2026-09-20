/**
 * 「这份 dsh 跟我们对得上吗」——装载前的一次能力探测，以及装不上时的护栏。
 *
 * 为什么要有这个：**dsh 的加载器是一棵树，任何一个插件装不上，整棵树就失败**
 * （`plugin tree failed to load`）。两种后果：
 *   - Host 半抛错 → `dsh web` **进程直接退出，端口都不开**，用户的 dsh 打不开；
 *   - 浏览器半抛错 → **整个界面变成一页 "Failed to load plugins"**，会话列表全没。
 * 也就是说，一个第三方插件的任何装载期 bug，在用户眼里都是「dsh 坏了」。不可接受，
 * 所以两半都在最外层包一层：**炸了就说清楚、什么都不注册，让 dsh 正常起来。**
 *
 * 探测**只看我们真正要用的那几个方法在不在**，不比版本号——版本号只是代理指标，
 * 真正决定能不能跑的是"口子还在不在"。
 *
 * 管不到的一种情况，如实写在这儿：如果 dsh 把 `inject` 里的某个服务整个删掉，
 * cordis 会让插件**一直等**、根本不调用 `apply`，我们的代码压根没跑，护栏也就无从谈起。
 */

/** 一次探测的结果。`missing` 里是缺了的东西，给人看的。 */
export interface ProbeResult {
  ok: boolean
  missing: string[]
}

type Anything = Record<string, unknown>

const get = (root: unknown, path: string): unknown =>
  path.split('.').reduce<unknown>((acc, k) => (typeof acc === 'object' && acc !== null ? (acc as Anything)[k] : undefined), root)

/**
 * 这几个方法缺一个，我们就跑不起来。路径是相对 `ctx` 的。
 *
 * ⚠️ **只列代码里真正调用的方法。** 清单里多一个 dsh 上不存在的名字，护栏就会把自己拦下来，
 * 一个本来能跑的插件因此装不上——**探测清单写错比不探还糟**。
 * 加一条之前，先去代码里核一遍谁在调它。
 */
export const HOST_REQUIRED = [
  'connection.fetch.register',
  'sessionQuery.readSession',
  'sessionQuery.listSessions',
  'sessionQuery.listEvents',
  'sessionQuery.readTitle',
  'llm.stream',
  'credentials.readRecord',
  'credentials.modifyRecord',
] as const

/** 浏览器半要用的。`slots.register` 没了就一个界面都挂不上。 */
export const CLIENT_REQUIRED = [
  'slots.register',
  'slots.inject',
  'locale.register',
  'locale.bind',
] as const

/** 挨个看这些路径上是不是函数。 */
export function probe(ctx: unknown, required: readonly string[]): ProbeResult {
  const missing = required.filter((p) => typeof get(ctx, p) !== 'function')
  return { ok: missing.length === 0, missing }
}

/**
 * 装不上时往控制台打的那段话。**写给人看**：说清是谁、为什么、下一步做什么。
 * 不用 `ctx.logger`——`dsh web` 的控制台不显示它的 info。
 */
export function bailOut(where: 'host' | 'client', version: string, detail: string): void {
  const lines = [
    '',
    `  ⚠ dsh-deephub-share ${version} 这次没装上，已跳过（dsh 其余部分照常）。`,
    `     位置：${where === 'host' ? 'Host 半' : '浏览器半'}`,
    `     原因：${detail}`,
    '     多半是 dsh 版本对不上。去「设置 → 插件」卸载它，或者换一个与这版 dsh 匹配的版本。',
    '',
  ]
  for (const l of lines) console.log(l)
}

/**
 * 把一段装载逻辑包起来：先探口子，再跑；任何一步出事都只打印、不抛。
 * @returns 真的装上了没有——浏览器半要拿它决定挂不挂界面。
 */
export function guard(
  where: 'host' | 'client',
  version: string,
  ctx: unknown,
  required: readonly string[],
  run: () => void,
): boolean {
  const p = probe(ctx, required)
  if (!p.ok) {
    bailOut(where, version, `这份 dsh 上找不到：${p.missing.join('、')}`)
    return false
  }
  try {
    run()
    return true
  } catch (e) {
    bailOut(where, version, (e as Error).message)
    return false
  }
}
