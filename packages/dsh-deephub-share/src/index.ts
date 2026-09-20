/**
 * dsh-deephub-share · Host 半（Node）。
 *
 * 路由都走 `ctx.connection.fetch`（在 /api 的鉴权与同源检查之后），**不用 Typert `@Remote`**：
 * 它的生成器只认 `<根>/packages/` 下的包，树外插件用不了。dsh 自带的 `session-log-export` 是同样的写法。
 *
 *   POST /api/deephub-share/{peek,build,export,attachments,scan,send}  见 share.ts
 *   POST /api/deephub-share/account/<op>                            见 account/routes.ts
 *   POST /api/deephub-share/social/<op>                             见 social/routes.ts
 *   POST /api/deephub-share/inbox/<op>                              见 inbox/routes.ts
 *
 * 主密钥、恢复码、身份私钥只在 Host 半的 `CloudService` 里，永不进 HTTP 响应。
 *
 * 已登录时**启动会往 deephub.cyou 探一次活**（预热，见下面的 warm-up）；没登录一个请求都不发。
 */
import type { Context } from '@deepseek-ai/cordis'
import type { BuildConfig } from './build.ts'
import { openCloud, type AccountConfig, type Cloud } from './account/service.ts'
import { registerAccountRoutes } from './account/routes.ts'
import { registerShareRoutes } from './share.ts'
import { registerSocialRoutes } from './social/routes.ts'
import { registerInboxRoutes } from './inbox/routes.ts'
import { guard, HOST_REQUIRED } from './compat.ts'
import { registerOps } from './routes.ts'

export const name = 'deephub-share'
export const inject = ['sessionQuery', 'llm', 'connection', 'credentials']

export type Config = BuildConfig & AccountConfig

/** 这一版的版本号，只用在装不上时那段话里；与 package.json 手动对齐。 */
const VERSION = '0.0.18'

/**
 * 入口。**外面包了一层护栏**：先探一遍要用的口子在不在，再跑真正的装载；任何一步出事
 * 都只打印说明、什么都不注册，**绝不让 dsh 起不来**——dsh 的加载器是一棵树，
 * 这里抛一个错，`dsh web` 进程直接退出、端口都不开。理由详见 compat.ts 顶部。
 */
export function apply(ctx: Context, config: Config = {}): void {
  guard('host', VERSION, ctx, HOST_REQUIRED, () => { applyInner(ctx, config) })
}

function applyInner(ctx: Context, config: Config = {}): void {
  // 账号：凭据预读是异步的，路由先挂上，每个请求等它就绪
  const cloudReady: Promise<Cloud> = openCloud(ctx, config)
  cloudReady.then(
    async ({ svc }) => {
      const st = svc.status()
      console.log(`[dsh-deephub-share] cloud ready: ${st.loggedIn ? 'logged in as ' + st.email : 'not logged in'}`)
      // 免密启动后身份密钥要有人去认领：本机有缓存就是纯本地操作，没缓存才会去服务端取。
      // 失败不影响别的，发送前还会再试一次
      if (st.loggedIn && st.unlocked) await svc.ensureIdentityKey()

      // **启动就把去云端的这条路走通。** 不预热的话，第一次 DNS + TLS + 两次往返全摊在用户
      // 点开界面的那一下，「确认发送」会灰着不动好几秒。
      // 不 await、失败吞掉：它只是预热，界面自己还会再探一次。
      if (st.loggedIn) {
        const t0 = Date.now()
        void svc.probe().then(
          (p) => { console.log(`[dsh-deephub-share] cloud warm-up: ${p.reachable === false ? 'unreachable' : 'ok'} ${Date.now() - t0}ms`) },
          (e: unknown) => { console.log(`[dsh-deephub-share] cloud warm-up failed: ${(e as Error).message} ${Date.now() - t0}ms`) },
        )
      }
    },
    (e: unknown) => { ctx.logger.warn(`deephub-share: cloud init failed: ${(e as Error).message}`) },
  )

  // 浏览器半靠这条判断 Host 这边到底有没有装上：装上了才挂界面，免得按钮在、点了没反应
  registerOps(ctx, '/api/deephub-share', {
    'health': async () => ({ ok: true, version: VERSION }),
  })

  registerShareRoutes(ctx, cloudReady, config)
  registerAccountRoutes(ctx, cloudReady)
  registerSocialRoutes(ctx, cloudReady)
  registerInboxRoutes(ctx, cloudReady)

  // `dsh web` 的控制台不显示 ctx.logger 的 info，启动可见性只能靠 console.log
  console.log('[dsh-deephub-share] host loaded: POST /api/deephub-share/{peek,build,export,attachments,scan,send,account/*,social/*,inbox/*}')
  ctx.effect(() => () => {
    console.log('[dsh-deephub-share] host unloaded')
  })
}
