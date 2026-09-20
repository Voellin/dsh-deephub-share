/**
 * `ctx.connection.fetch` 路由的小工具：JSON 应答、读 JSON 请求体、结构化的 connection 类型。
 * 与 session-log-export 同样的做法：不引 `@deepseek-ai/dsh-client-connection` 的类型，本地写个结构。
 */
import type { Context } from '@deepseek-ai/cordis'

export interface ConnectionLike {
  readonly fetch: {
    register(route: {
      readonly path: string
      readonly methods: readonly ('GET' | 'HEAD' | 'POST')[]
      readonly requestBody: 'buffered'
      readonly fetch: (request: Request) => Promise<Response>
    }): () => Promise<void>
  }
}

export const connectionOf = (ctx: Context): ConnectionLike => Reflect.get(ctx, 'connection') as ConnectionLike

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8' } })

export type Body = Record<string, unknown>

export async function bodyOf(request: Request): Promise<Body | null> {
  try {
    const v: unknown = await request.json()
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Body) : null
  } catch { return null }
}

export const str = (b: Body | null, k: string): string => {
  const v = b?.[k]
  return typeof v === 'string' ? v : ''
}

/**
 * 注册一组 `POST <prefix>/<op>` 路由。处理函数抛错 → 500 JSON；返回值直接 JSON 化。
 * register 本身挂在调用方的 scope 上（connection 用 owner.effect），插件卸载时自动撤掉。
 */
export function registerOps(
  ctx: Context,
  prefix: string,
  ops: Record<string, (body: Body | null, request: Request) => Promise<unknown>>,
): void {
  const connection = connectionOf(ctx)
  for (const [op, handler] of Object.entries(ops)) {
    connection.fetch.register({
      path: `${prefix}/${op}`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const out = await handler(await bodyOf(request), request)
          return out instanceof Response ? out : json(out)
        } catch (e) {
          const err = e as Error & { code?: string }
          ctx.logger.warn(`deephub-share: ${op} failed: ${err.message}`)
          return json({ error: err.message, ...(err.code ? { code: err.code } : {}) }, 500)
        }
      },
    })
  }
}
