import { randomBytes } from 'node:crypto'
import { open, seal, type Box, type EncryptedObject } from '../crypto/envelope'
import { PURPOSE_IDEA, sharedKey } from './identity'
import type { CloudService } from './service'

/**
 * 思路投递。
 *
 * 走的是**收件箱**模型，不是"直接写进对方的对象空间"：别人不能单方面往你名下
 * 写东西（与「短 ID 只能发起请求」同一条原则）。
 *
 * 三条要记住的：
 * - **收件箱只有元数据。** 拒收之前看不到标题——标题要能预览就得明文存服务器，
 *   那就不是零知识了。界面上必须如实说，不能假装能预览。
 * - **发件人身份以服务端登记的公钥为准**，不看信封里的自称。解不开就是冒充。
 * - **附件不参与脱敏**，那是 UI 层要显式提示的事。
 */

/**
 * 一份思路里附件的**合计**上限（单个附件同此）。
 *
 * ⚠️ 不是拍脑袋定的，而且**要算两层 base64**：
 *   明文附件 P → 进 JSON 载荷先 base64（×1.33）→ 整个载荷加密后 `ct` 再 base64（×1.33）
 *   → 请求体 ≈ 1.78 × P；服务端另有"单份密文 ≤ 22 MB"的上限（密文 ≈ 1.33 × P）。
 * 由后者反推：P ≤ 16.5 MB。取 15 MB 给思路正文和 JSON 结构留余量。
 * 以前写 20 MB 只算了一层：16.5–20 MB 的附件必失败，18 MB 以上还会撞上 32 MB 的
 * 请求体上限、被当成"云端连不上"。
 */
export const ATTACH_TOTAL_MAX = 15 * 1024 * 1024
export const ATTACH_ONE_MAX = ATTACH_TOTAL_MAX

export interface Attachment {
  name: string
  /** 原文字节。**内容不做任何检查** —— 脱敏扫的是文字，扫不进文件里 */
  data: Buffer
  mime?: string
}

/** 投递的明文载荷。`idea` 的内部结构由上层定义，这一层只当它是一坨可序列化的东西。 */
export interface DeliveryPayload {
  v: 1
  idea: unknown
  attachments: Array<{ name: string; mime?: string; b64: string }>
}

export interface InboxItem {
  deliveryId: string
  kind: string
  /** 密文字节数 —— 收件箱里唯一能看出"这东西多大"的线索 */
  size: number
  attachments: number
  from: { shortId: string; displayName: string | null }
  createdAt: number
  expiresAt: number
}

export interface ReceivedDelivery {
  deliveryId: string
  from: { accountId: string; shortId: string; displayName: string | null }
  idea: unknown
  attachments: Array<{ name: string; mime?: string; data: Buffer }>
  createdAt: number
}

interface WireEnvelope extends Omit<EncryptedObject, 'wrappedDK'> {
  /** 与对象存储不同：这里的 DK 是用**双方共享密钥**包的，不是 MK */
  wrappedDK: Box
}

export class DeliveryClient {
  constructor(private readonly svc: CloudService) {}

  private ready(): string | null {
    const d = this.svc.status().deviceId
    return d && this.svc.masterKey() ? d : null
  }

  /**
   * 把一份思路发给某个朋友。
   *
   * **对方公钥只从朋友列表取**（那是服务端登记的、不可静默替换的那把），
   * 不接受调用方传进来 —— 传得进来就等于给冒充留了口子。
   */
  async send(
    toAccountId: string,
    idea: unknown,
    attachments: Attachment[] = []
  ): Promise<{ ok: boolean; deliveryId?: string; reason?: 'offline' | 'not_friend' | 'no_key' | 'peer_no_key' | 'too_large' | 'inbox_full' | 'too_many_pending' | 'no_space' }> {
    const deviceId = this.ready()
    if (!deviceId) return { ok: false, reason: 'offline' }
    // no_key = **我自己的**身份密钥没就绪；peer_no_key = 对方没登记公钥。
    // 两者混用一个错误码，界面就会把我的问题说成"对方还没准备好"
    const me = this.svc.identityKey()
    if (!me) return { ok: false, reason: 'no_key' }

    const friend = (await this.svc.social.friends()).find((f) => f.accountId === toAccountId)
    if (!friend) return { ok: false, reason: 'not_friend' }
    if (!friend.friendPub) return { ok: false, reason: 'peer_no_key' }   // 对方还没登录过，没登记公钥

    for (const a of attachments) if (a.data.length > ATTACH_ONE_MAX) return { ok: false, reason: 'too_large' }
    const total = attachments.reduce((n, a) => n + a.data.length, 0)
    if (total > ATTACH_TOTAL_MAX) return { ok: false, reason: 'too_large' }

    const payload: DeliveryPayload = {
      v: 1, idea,
      attachments: attachments.map((a) => ({ name: a.name, mime: a.mime, b64: a.data.toString('base64') }))
    }

    // 信封：随机 DK 加正文，DK 用"我的私钥 + 对方公钥"派生的共享密钥包一层。
    // 换收件人只需重包 DK，正文一个字节都不用重加密（与 envelope.ts 的 MK/DK 分层同思路）。
    const DK = randomBytes(32)
    const id = 'idea_' + randomBytes(8).toString('hex')
    const aad = `${id}|idea|zk-v1`
    const body = seal(DK, Buffer.from(JSON.stringify(payload), 'utf8'), aad)
    const key = sharedKey(me.privateKey, Buffer.from(friend.friendPub, 'base64'), PURPOSE_IDEA)
    const env: WireEnvelope = {
      id, type: 'idea', keyScheme: 'zk-v1', v: 1, alg: 'A256GCM',
      iv: body.iv, ct: body.ct, tag: body.tag,
      wrappedDK: seal(key, DK),
      version: 1, updated_at: Math.floor(Date.now() / 1000)
    }

    try {
      const r = await this.svc.account.api.call<{ delivery_id: string }>({
        method: 'POST', target: '/api/v1/deliveries', deviceId,
        body: { to: toAccountId, kind: 'idea', n_attachments: attachments.length, envelope: env }
      })
      return { ok: true, deliveryId: r.delivery_id }
    } catch (e) {
      const st = (e as { status?: number }).status
      const code = (e as { code?: string }).code
      if (st === 404) return { ok: false, reason: 'not_friend' }     // 也可能是刚被对方解除
      // 409 有两种，别混成一句话：收件人整体满了，还是**你**压给他的没收走够多了
      if (st === 409) return { ok: false, reason: code === 'too_many_pending' ? 'too_many_pending' : 'inbox_full' }
      if (st === 413) return { ok: false, reason: 'too_large' }
      if (st === 507) return { ok: false, reason: 'no_space' }       // 服务端磁盘闸门置位，等运维腾地方
      throw e
    }
  }

  /** 收件箱。**只有元数据** —— 谁发的、多大、几个附件、什么时候。标题在密文里。 */
  async inbox(): Promise<InboxItem[]> {
    const deviceId = this.ready()
    if (!deviceId) return []
    const r = await this.svc.account.api.call<{
      items: Array<{
        delivery_id: string; kind: string; size: number; n_attachments: number
        from: { short_id: string; display_name: string | null }
        created_at: number; expires_at: number
      }>
    }>({ method: 'GET', target: '/api/v1/deliveries', deviceId })
    return (r.items || []).map((x) => ({
      deliveryId: x.delivery_id, kind: x.kind, size: x.size, attachments: x.n_attachments,
      from: { shortId: x.from.short_id, displayName: x.from.display_name },
      createdAt: x.created_at, expiresAt: x.expires_at
    }))
  }

  /**
   * 取一份思路并解开。
   *
   * **解不开就当作冒充，直接失败，不做任何降级。** 共享密钥用的是服务端登记的
   * 发件人公钥（`from.friend_pub`）；伪造 `from` 的人算不出同一把密钥。
   */
  async fetch(deliveryId: string): Promise<{ ok: boolean; delivery?: ReceivedDelivery; reason?: 'offline' | 'no_key' | 'not_found' | 'undecryptable' }> {
    const deviceId = this.ready()
    if (!deviceId) return { ok: false, reason: 'offline' }
    const me = this.svc.identityKey()
    if (!me) return { ok: false, reason: 'no_key' }

    let r: {
      delivery_id: string; n_attachments: number; created_at: number
      from: { account_id: string; short_id: string; display_name: string | null; friend_pub: string | null }
      envelope: WireEnvelope
    }
    try {
      r = await this.svc.account.api.call({ method: 'GET', target: `/api/v1/deliveries/${deliveryId}`, deviceId })
    } catch (e) {
      if ((e as { status?: number }).status === 404) return { ok: false, reason: 'not_found' }
      throw e
    }
    if (!r.from.friend_pub) return { ok: false, reason: 'undecryptable' }

    try {
      const key = sharedKey(me.privateKey, Buffer.from(r.from.friend_pub, 'base64'), PURPOSE_IDEA)
      const DK = open(key, r.envelope.wrappedDK)
      const aad = `${r.envelope.id}|${r.envelope.type}|zk-v1`
      const plain = open(DK, { iv: r.envelope.iv, ct: r.envelope.ct, tag: r.envelope.tag }, aad)
      const p = JSON.parse(plain.toString('utf8')) as DeliveryPayload
      return {
        ok: true,
        delivery: {
          deliveryId: r.delivery_id,
          from: { accountId: r.from.account_id, shortId: r.from.short_id, displayName: r.from.display_name },
          idea: p.idea,
          attachments: (p.attachments || []).map((a) => ({ name: a.name, mime: a.mime, data: Buffer.from(a.b64, 'base64') })),
          createdAt: r.created_at
        }
      }
    } catch {
      // 密钥不对 / 密文被改 / AAD 不匹配，三种都在这里，**不区分**（不给攻击者信息）
      return { ok: false, reason: 'undecryptable' }
    }
  }

  /** 拒收。服务端会**真删密文**，不是打个标记。 */
  async reject(deliveryId: string): Promise<{ ok: boolean; reason?: 'not_ready' | 'not_found' }> {
    const deviceId = this.ready()
    if (!deviceId) return { ok: false, reason: 'not_ready' }
    try {
      await this.svc.account.api.call({ method: 'DELETE', target: `/api/v1/deliveries/${deliveryId}`, deviceId })
      return { ok: true }
    } catch (e) {
      if ((e as { status?: number }).status === 404) return { ok: false, reason: 'not_found' }
      throw e
    }
  }
}
