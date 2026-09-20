/**
 * 分享流程的 Host 半路由：
 *
 * | op | 入参 | 出参 |
 * |---|---|---|
 * | peek | `{ sessionId }` | `{ title, rawCount, state, built? }`——打开对话框先问这一句，**不调模型** |
 * | build | `{ sessionId, force? }` | `BuildResponse`。同一条会话没变过就复用 Host 缓存；`force` 是「重新整理」 |
 * | export | `{ doc, decisions? }` | `text/markdown`。**不登录也能用**；同样过 `decisions`，导出与发送看到的是同一份 |
 * | attachments | `{ sessionId }` | `{ files: [{path,name,size,tooBig}], totalMax }` |
 * | scan | `{ doc, route }` | `{ ok, candidates }` 或 `{ ok:false, reason }`（脱敏②，LLM 分块全扫；失败整体失败） |
 * | send | `{ sessionId, toAccountId, doc, paths, decisions }` | `{ ok, deliveryId }` 或 `{ ok:false, reason }` |
 *
 * `send` 的三道闸：doc 再过一遍脱敏①（幂等）；`decisions` 只认 keep/mask/placeholder；`paths` 必须在
 * Host 此刻重新算出的候选里（`attachments.ts`）。对方公钥只从朋友列表取（`DeliveryClient` 自己管）。
 */
import type { Context } from '@deepseek-ai/cordis'
import { applyDecisions, redactStructural, scanSemantic } from './redact.ts'
import { buildIdea, peekIdea, type BuildConfig } from './build.ts'
import { listAttachments, readAttachments } from './attachments.ts'
import { oneshot, type Route } from './llm.ts'
import { ideaToMarkdown, markdownFilename } from './shared/markdown.ts'
import type { IdeaDoc, RedactCandidate } from './shared/idea.ts'
import { json, registerOps, str, type Body } from './routes.ts'
import type { Cloud } from './account/service.ts'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'

export const SHARE_PREFIX = '/api/deephub-share'

/** 只认自己生成的形状：v 必须是 1，几个数组字段必须是数组。深度校验是收件路径的事，见 `inbox/incoming.ts`。 */
export function isIdeaDoc(v: unknown): v is IdeaDoc {
  if (typeof v !== 'object' || v === null) return false
  const x = v as Record<string, unknown>
  return x.v === 1 && typeof x.title === 'string' && typeof x.goal === 'string'
    && Array.isArray(x.steps) && Array.isArray(x.forks) && Array.isArray(x.pitfalls)
    && Array.isArray(x.deliverables) && Array.isArray(x.raw)
    && typeof x.deps === 'object' && x.deps !== null
}

const ACTIONS = new Set(['keep', 'mask', 'placeholder'])

/** 浏览器传来的脱敏决定：只留形状合法的；`text` 空的丢掉（applyDecisions 里空串会把全文切碎）。 */
function decisionsOf(v: unknown): RedactCandidate[] {
  if (!Array.isArray(v)) return []
  const out: RedactCandidate[] = []
  for (const d of v) {
    if (typeof d !== 'object' || d === null) continue
    const x = d as Record<string, unknown>
    if (typeof x.text !== 'string' || !x.text || typeof x.action !== 'string' || !ACTIONS.has(x.action)) continue
    out.push({
      id: typeof x.id === 'string' ? x.id : '',
      kind: 'other',
      text: x.text,
      action: x.action as RedactCandidate['action'],
      ...(typeof x.replacement === 'string' ? { replacement: x.replacement } : {}),
    })
  }
  return out
}

function routeOf(b: Body | null): Route | null {
  const r = b?.route
  if (typeof r !== 'object' || r === null) return null
  const x = r as Record<string, unknown>
  return typeof x.provider === 'string' && x.provider && typeof x.model === 'string' && x.model
    ? { provider: x.provider, model: x.model }
    : null
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

export function registerShareRoutes(ctx: Context, cloudReady: Promise<Cloud>, config: BuildConfig): void {
  registerOps(ctx, SHARE_PREFIX, {
    'peek': async (b) => {
      const sessionId = str(b, 'sessionId')
      if (!sessionId.trim()) return json({ error: 'sessionId required' }, 400)
      try {
        return await peekIdea(ctx, sessionId, config)
      } catch (e) {
        const err = e as Error & { code?: string }
        if (err.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return json({ error: err.message, code: err.code }, 404)
        throw e
      }
    },

    'build': async (b, request) => {
      const sessionId = str(b, 'sessionId')
      if (!sessionId.trim()) return json({ error: 'sessionId required' }, 400)
      try {
        return await buildIdea(ctx, sessionId, config, request.signal, { force: b?.force === true })
      } catch (e) {
        const err = e as Error & { code?: string }
        if (err.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return json({ error: err.message, code: err.code }, 404)
        throw e
      }
    },

    'export': async (b) => {
      const doc = b?.doc
      if (!isIdeaDoc(doc)) return json({ error: 'doc (IdeaDoc v1) required' }, 400)
      // 用户在扫描里打的码，导出也要认（否则"打码后导出"拿到的还是原文）
      const md = ideaToMarkdown(applyDecisions(doc, decisionsOf(b?.decisions)), { exportedAt: new Date() })
      return new Response(md, {
        status: 200,
        headers: {
          'content-type': 'text/markdown; charset=utf-8',
          'content-disposition': `attachment; filename="idea.md"; filename*=UTF-8''${encodeURIComponent(markdownFilename(doc))}`,
        },
      })
    },

    'attachments': async (b) => {
      const sessionId = str(b, 'sessionId')
      if (!sessionId.trim()) return json({ error: 'sessionId required' }, 400)
      return listAttachments(ctx, sessionId)
    },

    'scan': async (b, request) => {
      const doc = b?.doc
      if (!isIdeaDoc(doc)) return json({ error: 'doc (IdeaDoc v1) required' }, 400)
      const route = routeOf(b)
      if (route === null) return { ok: false, reason: 'no_route' }
      try {
        const candidates = await scanSemantic(doc, {
          oneshot: (prompt, o) => oneshot(ctx, route, prompt, {
            // 上限同样交给适配器默认；扫描结果被截断会让整次扫描失败，不给半份
            ...(o?.maxTokens !== undefined ? { maxTokens: o.maxTokens } : {}),
            signal: request.signal,
            ...(config.llmTimeoutMs !== undefined ? { timeoutMs: config.llmTimeoutMs } : {}),
          }),
        })
        return { ok: true, candidates }
      } catch (e) {
        // 半份结果比不扫更糟（用户会以为"扫过了没问题"），所以整体失败
        return { ok: false, reason: (e as Error).message }
      }
    },

    'send': async (b) => {
      const sessionId = str(b, 'sessionId')
      const toAccountId = str(b, 'toAccountId')
      const doc = b?.doc
      if (!sessionId.trim() || !toAccountId.trim()) return json({ error: 'sessionId and toAccountId required' }, 400)
      if (!isIdeaDoc(doc)) return json({ error: 'doc (IdeaDoc v1) required' }, 400)
      const { session } = await ctx.sessionQuery.readSession(SessionId(sessionId))
      // ① 层脱敏再过一遍（幂等）；② 层按用户逐条的决定
      const finalDoc = applyDecisions(redactStructural(doc, session.cwd), decisionsOf(b?.decisions))
      const atts = await readAttachments(ctx, sessionId, strings(b?.paths))
      const { svc } = await cloudReady
      await svc.ensureIdentityKey() // 幂等；重启后没认领过的话这里补上，否则 send 会报 no_key
      const r = await svc.delivery.send(toAccountId, finalDoc, atts)
      return r.ok ? { ok: true, deliveryId: r.deliveryId ?? null, attachments: atts.length } : { ok: false, reason: r.reason ?? 'other' }
    },
  })
}
