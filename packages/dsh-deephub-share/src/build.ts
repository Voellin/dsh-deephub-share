/**
 * 一条会话 → 一份思路草稿。把 `extract` / `deliverables` / `llm` / `redact` 串起来。
 *
 * 模型不可用时不抛错，而是给一份**只有程序部分**的草稿——依赖清单和原始记录本身就有价值，
 * 不该因为模型抽风就分享不了。
 *
 * **标题一律用 dsh 自己的会话标题**（`sessionQuery.readTitle`，就是侧栏和会话头上那句），
 * 模型起的标题不采用：用户点「整理」之前就看得见标题，点完还是同一句，**界面上不会跳**。
 * 没有标题事件的会话退回第一条用户消息前 80 字。
 *
 * `peekIdea` 是**不花钱**的那半：读日志、取标题、数记录条数、看缓存里有没有现成结果。
 */
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import { extractRaw } from './extract.ts'
import { fingerprint, hit, look, remember, forget } from './build-cache.ts'
import { basenameOf, foldDeliverables } from './deliverables.ts'
import { emptyDoc, narrate, oneshot, resolveRoute, type Route } from './llm.ts'
import { redactStructural } from './redact.ts'
import type { BuildResponse } from './shared/idea.ts'

export interface BuildConfig {
  /** 会话没用过模型时的兜底路由 */
  provider?: string
  model?: string
  /** 每条工具结果最多带多少字，默认 4000 */
  maxToolChars?: number
  /** 单次模型调用超时，默认 120 秒 */
  llmTimeoutMs?: number
}

/** dsh 自己的会话标题；没有就退回第一条用户消息。两处都读不到才是"（无标题）"。 */
async function titleOf(ctx: Context, id: ReturnType<typeof SessionId>, firstUserLine: string): Promise<string> {
  try {
    const t = await ctx.sessionQuery.readTitle(id)
    if (t !== undefined && t.title.trim()) return t.title.trim()
  } catch { /* 读不到标题不该挡住整理 */ }
  return firstUserLine.slice(0, 80) || '（无标题）'
}

export interface PeekResponse {
  /** 会话标题（点整理之前就显示的那句） */
  title: string
  /** 会带走的原始记录条数 */
  rawCount: number
  /** none = 还没整理过；running = 已经在跑（比如你刚关掉的那次）；ready = 有现成结果 */
  state: 'none' | 'running' | 'ready'
  /** state 为 ready 时直接把结果带回去，省一次往返 */
  built?: BuildResponse
}

/** 打开对话框时问一句：这条会话叫什么、有多少记录、有没有现成的结果。**不调模型。** */
export async function peekIdea(ctx: Context, sessionId: string, config: BuildConfig = {}): Promise<PeekResponse> {
  const id = SessionId(sessionId)
  const { events } = await ctx.sessionQuery.readSession(id)
  const ex = extractRaw(events, config.maxToolChars !== undefined ? { maxToolChars: config.maxToolChars } : {})
  const title = await titleOf(ctx, id, ex.firstUserLine)
  const fp = fingerprint(events)
  const state = look(sessionId, fp)
  if (state !== 'ready') return { title, rawCount: ex.raw.length, state }
  const task = hit(sessionId, fp)
  // ready 说明任务早跑完了，这个 await 不会等
  return { title, rawCount: ex.raw.length, state, ...(task !== null ? { built: await task } : {}) }
}

export async function buildIdea(
  ctx: Context,
  sessionId: string,
  config: BuildConfig = {},
  signal?: AbortSignal,
  opts: { force?: boolean } = {},
): Promise<BuildResponse> {
  const id = SessionId(sessionId)
  const { session, events } = await ctx.sessionQuery.readSession(id)

  const fp = fingerprint(events)
  if (opts.force === true) forget(sessionId)
  else {
    const cached = hit(sessionId, fp)
    // 命中：可能是早就跑完的结果，也可能是正在跑的那次——后者挂上去一起等，不再发第二次
    if (cached !== null) return cached
  }
  const task = compute(ctx, id, session.cwd, events, config, signal)
  remember(sessionId, fp, task)
  return task
}

async function compute(
  ctx: Context,
  id: ReturnType<typeof SessionId>,
  cwd: string | undefined,
  events: Awaited<ReturnType<Context['sessionQuery']['readSession']>>['events'],
  config: BuildConfig,
  signal?: AbortSignal,
): Promise<BuildResponse> {
  const ex = extractRaw(events, config.maxToolChars !== undefined ? { maxToolChars: config.maxToolChars } : {})
  const produced = foldDeliverables(events, cwd)

  const doc = emptyDoc(await titleOf(ctx, id, ex.firstUserLine))
  doc.deps = ex.deps
  doc.raw = ex.raw
  doc.deliverables = produced.map((p) => ({ title: basenameOf(p.path), kind: 'file' as const }))

  const route: Route | null = resolveRoute(events, config)
  let llmOk = false
  let llmError: string | undefined
  let llmTruncated = false
  if (route !== null && ex.raw.length > 0) {
    try {
      const n = await narrate(
        // 不传 maxTokens：用 dsh 为这个模型配的默认上限。**别写死一个数**——思考 token
        // 与正文共用输出预算，写死的值会随会话变长或换个爱思考的模型而被截断
        (prompt) => oneshot(ctx, route, prompt, {
          sessionId: id,
          ...(config.llmTimeoutMs !== undefined ? { timeoutMs: config.llmTimeoutMs } : {}),
          ...(signal !== undefined ? { signal } : {}),
        }),
        ex.raw,
      )
      if (n !== null) {
        // n.title 故意不用：标题跟着 dsh 的会话标题走，点整理前后不跳
        doc.goal = n.goal
        doc.steps = n.steps
        doc.forks = n.forks
        doc.pitfalls = n.pitfalls
        llmOk = true
        llmTruncated = n.truncated
        if (n.truncated) console.log('[dsh-deephub-share] narrate: output was truncated; tail may be missing')
      } else {
        // 调通了，但每一块都没解析出 steps（模型答非所问 / JSON 坏了）
        llmError = 'no_steps'
        console.log('[dsh-deephub-share] narrate: model answered but no steps parsed')
      }
    } catch (e) {
      // 模型挂了也要能出草稿：下面照样返回程序那部分。
      // 原因既往控制台打（ctx.logger 在 dsh web 控制台看不见），也回给界面。
      llmError = (e as Error).message
      console.log(`[dsh-deephub-share] narrate failed: ${llmError}`)
      ctx.logger.warn(`deephub-share: narrate failed: ${llmError}`)
    }
  }

  // ① 层脱敏永远执行，不给开关
  return {
    doc: redactStructural(doc, cwd),
    llmOk,
    ...(llmError !== undefined ? { llmError } : {}),
    ...(llmTruncated ? { llmTruncated: true } : {}),
    route,
    files: produced.map((p) => p.path),
  }
}
