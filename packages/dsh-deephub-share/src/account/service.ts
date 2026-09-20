/**
 * 账号：起一个 `CloudService`，密钥走 `DshKeyStore`。
 *
 * 主密钥、恢复码、身份私钥都只在 Host 半的这个对象里，**永不进 HTTP 响应**——
 * 浏览器拿到的只有 `CloudStatus` 这类能安全显示的东西（与 DeepHub 渲染层同一条边界）。
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-credentials'
import { CloudService } from '@deephub/cloud-protocol'
import { DshKeyStore } from './keystore.ts'

export interface AccountConfig {
  /**
   * **只为测试存在**：让整套逻辑能打在本地起的同一份服务端代码上。
   * 生产路径一个都不传——走硬编码的 `https://deephub.cyou` 和硬编码的服务器签名公钥。
   */
  baseUrl?: string
  serverPubRaw?: string
}

export interface Cloud {
  svc: CloudService
  store: DshKeyStore
}

export async function openCloud(ctx: Context, config: AccountConfig = {}): Promise<Cloud> {
  const store = await DshKeyStore.open(ctx.credentials, (m) => { ctx.logger.warn(m) })
  // platform 报 'dsh'：同一台机器上 DeepHub 桌面端与本插件**各算一台设备**，设备列表里靠这个字段分清
  const opts: { baseUrl?: string; serverPubRaw?: string; platform: string } = { platform: 'dsh' }
  if (config.baseUrl) opts.baseUrl = config.baseUrl
  if (config.serverPubRaw) opts.serverPubRaw = config.serverPubRaw
  const svc = new CloudService(store, opts)
  return { svc, store }
}
