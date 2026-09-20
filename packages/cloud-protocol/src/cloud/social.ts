import type { CloudService } from './service'
import { CloudApiError } from './client'
import { decryptObject, encryptObject, type EncryptedObject } from '../crypto/envelope'

/**
 * 朋友关系（按短 ID 直加）。
 *
 * 三条要记住的：
 * - 短 ID **只能发起请求**，建立关系必须收件方点同意。
 * - 发请求一律回 202，**不告诉你对方存不存在** —— 所以打错字在本地就要挡住，靠校验位。
 * - 同意之前拿不到对方的显示名与公钥。
 */

// ── 短 ID ─────────────────────────────────────────────────────────────
/**
 * Crockford Base32。**必须与服务端签发短 ID 用的字母表逐字符一致**，
 * 否则会出现"服务端认、客户端不认"这种极难查的错。
 */
const A32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

/**
 * 6 个随机字符 + 1 位校验。位置加权求和 mod 32——单字符错**和**相邻换位都能抓到。
 *
 * 为什么要本地校验：服务端对不存在的短 ID 也返回 202（否则它就是个账号存在性探针），
 * 所以"输错一位"在服务端是静默的黑洞。挡在本地是唯一能给出反馈的地方。
 */
function shortIdCheck(six: string): string | null {
  let sum = 0
  for (let i = 0; i < six.length; i++) {
    const v = A32.indexOf(six[i])
    if (v < 0) return null
    sum += v * (i + 1)
  }
  return A32[sum % 32]
}

/** 归一化：大小写、分隔符随便；按 Crockford 把易混字符折过去（I/L→1，O→0）。 */
function normShortId(input: string): string {
  const up = String(input || '').toUpperCase()
  let out = ''
  for (const ch of up) {
    if (ch === 'I' || ch === 'L') out += '1'
    else if (ch === 'O') out += '0'
    else if (A32.includes(ch)) out += ch
  }
  return out
}

/**
 * 校验并还原成标准写法 `DH-XXXX-XXX`；不合法返回 null。
 *
 * ⚠️ 早期签发的、不带校验位的短 ID 会被判为不合法。
 */
export function parseShortId(input: string): string | null {
  const s = normShortId(input)
  if (s.length !== 9 || !s.startsWith('DH')) return null
  const body = s.slice(2)
  if (shortIdCheck(body.slice(0, 6)) !== body[6]) return null
  return `DH-${body.slice(0, 4)}-${body.slice(4)}`
}

// ── 类型 ──────────────────────────────────────────────────────────────
export interface Friend {
  accountId: string
  shortId: string
  displayName: string | null
  /** base64 的 32 字节 X25519 公钥；对方还没登记时是 null */
  friendPub: string | null
  createdAt: number
}

export interface IncomingRequest {
  requestId: string
  /** 同意之前只知道短 ID，显示名与公钥都拿不到 */
  shortId: string
  createdAt: number
}

export interface OutgoingRequest {
  requestId: string
  shortId: string
  status: string
  createdAt: number
}

/**
 * 好友备注。
 *
 * 「我管这个人叫什么」是**我一个人的事**，别人看不到，服务端也不该看到 ——
 * 「A 把 B 备注成 X」本身就是社交关系情报。所以它跟会话、日程一个待遇：
 * **用主密钥加密成一个对象**再上服务端，走现成的 `/api/v1/objects/…` 通道。
 * 服务端只知道「这个账号存了个东西、多大、什么时候改的」。
 *
 * 为什么不存本地：存本地就意味着 Windows 上起的名字，Mac 和 dsh 插件都看不到 ——
 * 而这三处显示的是同一份朋友列表，名字对不上比没有名字更难受。
 *
 * 为什么不明文存服务端：那要给 `friendship` 表加一列、写读写接口，
 * 还把上面那条情报交了出去。加密对象反而是三个里**改动最小**的。
 */
export const FRIEND_NOTES_OBJ_ID = 'friend-notes'
export const OBJ_TYPE_FRIEND_NOTES = 'friend-notes'

/** 服务端上那个对象解开之后的样子。key 是 accountId。 */
export interface FriendNotes {
  v: 1
  /** accountId → 备注。空串视同没有，写入时就会被删掉，不会留下空壳。 */
  notes: Record<string, string>
}

interface WireFriend {
  account_id: string; short_id: string; display_name: string | null
  friend_pub: string | null; created_at: number
}

const toFriend = (f: WireFriend): Friend => ({
  accountId: f.account_id, shortId: f.short_id, displayName: f.display_name,
  friendPub: f.friend_pub, createdAt: f.created_at
})

/** 单条备注的长度上限。与「我的名片」里那个显示名同一个数，别让两处的手感不一样。 */
export const REMARK_MAX = 40

/** 最多记多少个人。防的是一个坏掉的对象把界面撑爆，不是业务上的限制。 */
const NOTES_MAX = 1000

/** 内存里那份最多吃多久。见 `remarks()` 的说明。 */
const NOTES_TTL_MS = 60_000

/**
 * 把服务端取回来的那份收拾成能用的形状。
 *
 * 这里**只看形状与长度**（是不是字符串、多长、几条），不判断内容 ——
 * 与收件那边 `sanitizeIdeaDoc` 同一条规矩。东西是自己写的、也是自己的主密钥解开的，
 * 但版本会变：老客户端读到新版本写的对象，宁可丢掉不认识的部分也不能崩。
 */
function saneNotes(p: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  const raw = (p as FriendNotes | null)?.notes
  if (typeof raw !== 'object' || raw === null) return out
  let n = 0
  for (const [k, v] of Object.entries(raw)) {
    if (n >= NOTES_MAX) break
    if (typeof k !== 'string' || k.length === 0 || k.length > 128) continue
    if (typeof v !== 'string') continue
    const t = v.trim().slice(0, REMARK_MAX)
    if (t.length === 0) continue
    out[k] = t
    n++
  }
  return out
}

/**
 * 朋友功能的客户端。
 *
 * 未登录时**所有方法都安静失败**（返回空列表 / `{ ok: false }`），不抛——
 * 面板可能在任何时候被打开，登录态不是它的责任。
 */
export class SocialClient {
  constructor(private readonly svc: CloudService) {}

  private ready(): string | null {
    const d = this.svc.status().deviceId
    return d && this.svc.masterKey() ? d : null
  }

  /** 我自己的对外资料。`displayName` 为 null = 从没设过，朋友看到的是"未设置名字"。 */
  async myProfile(): Promise<{ displayName: string | null }> {
    const deviceId = this.ready()
    if (!deviceId) return { displayName: null }
    const r = await this.svc.account.api.call<{ display_name: string | null }>({
      method: 'GET', target: '/api/v1/social/identity', deviceId
    })
    return { displayName: r.display_name ?? null }
  }

  /** 上报显示名。公钥由 `IdentityManager` 单独认领，这里不碰。 */
  async setDisplayName(name: string): Promise<{ ok: boolean }> {
    const deviceId = this.ready()
    if (!deviceId) return { ok: false }
    await this.svc.account.api.call({
      method: 'PUT', target: '/api/v1/social/identity', deviceId, body: { display_name: name }
    })
    return { ok: true }
  }

  /**
   * 按短 ID 发起加友请求。
   *
   * 返回 `sent` 只代表**请求已被服务端接受**，不代表对方存在——服务端刻意不区分。
   * 界面上的措辞必须是"已发出，等对方确认"，不能是"已找到某人"。
   */
  async request(shortIdInput: string): Promise<{ ok: boolean; reason?: 'bad_short_id' | 'offline' }> {
    const deviceId = this.ready()
    if (!deviceId) return { ok: false, reason: 'offline' }
    const short = parseShortId(shortIdInput)
    if (!short) return { ok: false, reason: 'bad_short_id' }
    await this.svc.account.api.call({
      method: 'POST', target: '/api/v1/social/requests', deviceId, body: { short_id: short }
    })
    return { ok: true }
  }

  async inbox(): Promise<{ incoming: IncomingRequest[]; outgoing: OutgoingRequest[] }> {
    const deviceId = this.ready()
    if (!deviceId) return { incoming: [], outgoing: [] }
    const r = await this.svc.account.api.call<{
      incoming: Array<{ request_id: string; short_id: string; created_at: number }>
      outgoing: Array<{ request_id: string; short_id: string; status: string; created_at: number }>
    }>({ method: 'GET', target: '/api/v1/social/requests', deviceId })
    return {
      incoming: (r.incoming || []).map((x) => ({ requestId: x.request_id, shortId: x.short_id, createdAt: x.created_at })),
      outgoing: (r.outgoing || []).map((x) => ({
        requestId: x.request_id, shortId: x.short_id, status: x.status, createdAt: x.created_at
      }))
    }
  }

  async accept(requestId: string): Promise<{ ok: boolean; friend?: Friend; reason?: 'not_ready' }> {
    const deviceId = this.ready()
    if (!deviceId) return { ok: false, reason: 'not_ready' }
    const r = await this.svc.account.api.call<{ friend: WireFriend }>({
      method: 'POST', target: `/api/v1/social/requests/${requestId}/accept`, deviceId, body: {}
    })
    return { ok: true, friend: toFriend(r.friend) }
  }

  /** `block: true` = 他再也不能给我发请求（短 ID 是长期凭据，这是唯一的止损）。 */
  async reject(requestId: string, block = false): Promise<{ ok: boolean; reason?: 'not_ready' }> {
    const deviceId = this.ready()
    if (!deviceId) return { ok: false, reason: 'not_ready' }
    await this.svc.account.api.call({
      method: 'POST', target: `/api/v1/social/requests/${requestId}/reject`, deviceId, body: { block }
    })
    return { ok: true }
  }

  async friends(): Promise<Friend[]> {
    const deviceId = this.ready()
    if (!deviceId) return []
    const r = await this.svc.account.api.call<{ friends: WireFriend[] }>({
      method: 'GET', target: '/api/v1/social/friends', deviceId
    })
    return (r.friends || []).map(toFriend)
  }

  /** 解除关系。服务端**双向删**，不会留下"他还以为你们是朋友"的错位状态。 */
  async remove(accountId: string): Promise<{ ok: boolean; reason?: 'not_ready' }> {
    const deviceId = this.ready()
    if (!deviceId) return { ok: false, reason: 'not_ready' }
    await this.svc.account.api.call({
      method: 'DELETE', target: `/api/v1/social/friends/${accountId}`, deviceId
    })
    return { ok: true }
  }

  /**
   * 换一个短 ID。老 ID 立即失效，**朋友关系不受影响**（关系锚在 account_id）。
   * 被人挂到群里持续骚扰时用。
   */
  async resetShortId(): Promise<{ ok: boolean; shortId?: string }> {
    const deviceId = this.ready()
    if (!deviceId) return { ok: false }
    const r = await this.svc.account.api.call<{ short_id: string }>({
      method: 'POST', target: '/api/v1/social/short-id/reset', deviceId, body: {}
    })
    // 落盘。不写的话下次启动界面上又是个 `—`（服务端已经换了，本地却不知道）
    this.svc.noteShortId(r.short_id)
    return { ok: true, shortId: r.short_id }
  }

  // ── 备注 ────────────────────────────────────────────────────────────

  /** 内存里那一份。`null` = 这辈子还没取过，**不是**「取回来是空的」。 */
  private notes: Record<string, string> | null = null
  /** 上一次真的问过服务端是什么时候。0 = 没问过。 */
  private notesAt = 0

  /**
   * 去服务端取一次。
   *
   * `ok` 的含义是**「这次真的问清楚了远端现在是什么样」**，不是「有没有备注」。
   * 写入前必须靠它挡一道：问不清楚就不许写，否则会拿一份过时的整体覆盖掉
   * 别的设备刚写进去的东西。
   */
  private async pullNotes(): Promise<{ ok: boolean; notes: Record<string, string> }> {
    const deviceId = this.ready()
    const MK = this.svc.masterKey()
    if (!deviceId || !MK) return { ok: false, notes: this.notes ?? {} }

    let env: EncryptedObject
    try {
      env = await this.svc.account.api.call<EncryptedObject>({
        method: 'GET', target: `/api/v1/objects/${FRIEND_NOTES_OBJ_ID}`, deviceId
      })
    } catch (e) {
      // 404 = 从来没设过备注；410 = 这个对象被删过（服务端留的墓碑，明确回 410 而不是 404）。
      // **两个都是正常状态，不是错**，而且都必须回 `ok: true` —— 否则下面的写入会被自己挡住，
      // 备注功能从此再也写不进去。下一次 PUT 会把墓碑盖回来。
      if (e instanceof CloudApiError && (e.status === 404 || e.status === 410)) return { ok: true, notes: {} }
      // 网络不通：保持上一次拿到的那份，别把界面上已经显示着的备注抹掉
      return { ok: false, notes: this.notes ?? {} }
    }

    try {
      return { ok: true, notes: saneNotes(decryptObject<FriendNotes>(MK, env)) }
    } catch {
      // 解不开：多半是「重置账号」换过主密钥之后留下的壳。
      //
      // **不当作冒充。** 思路那条路的规矩是「解不开就当冒充，直接失败」——因为思路是
      // 别人发来的，必须防冒充；备注是自己写给自己看的，解不开就退回对方自己设的名字
      // 这里还必须回 `ok: true`：否则这个壳会把备注功能**永久锁死**，
      // 用户再也写不进去。当作空的，下一次写入把它覆盖掉。
      return { ok: true, notes: {} }
    }
  }

  /**
   * 全部备注，`accountId → 备注`。取不到、解不开、没登录一律给空表，**不抛**。
   *
   * 内存里那份**最多吃 60 秒**。朋友列表每 30 秒重画一次，每次都打一个来回太费；
   * 但完全不过期又会出现「在 Windows 上改了备注，Mac 上这辈子都不更新」——
   * 这正是把备注放上服务端的理由，不能自己把它废掉。这个对象只有几百字节，一分钟一次不算什么。
   */
  async remarks(opts: { refresh?: boolean } = {}): Promise<Record<string, string>> {
    const fresh = this.notes !== null && Date.now() - this.notesAt < NOTES_TTL_MS
    if (fresh && opts.refresh !== true) return this.notes as Record<string, string>
    const r = await this.pullNotes()
    if (r.ok) {
      this.notes = r.notes
      this.notesAt = Date.now()
    }
    return r.notes
  }

  /**
   * 设 / 清一个人的备注。空串（或只剩空白）＝ 清掉，不留空壳。
   *
   * **冲突的规矩：时间戳大的赢，输的那边悄悄消失**。
   * 整份备注是一个对象，所以两台机器同时改**不同的人**也会互相覆盖 ——
   * 备注是很短的东西，不值得为它做逐条合并。`version` 用秒级时间戳，
   * 与日程（`pushSchedules`）同一手法：两端各写各的，谁后写谁算数。
   */
  async setRemark(accountId: string, text: string): Promise<{ ok: boolean }> {
    const deviceId = this.ready()
    const MK = this.svc.masterKey()
    if (!deviceId || !MK || !accountId) return { ok: false }

    // 先问清楚远端现在是什么样，再在它上面改那一条
    const base = await this.pullNotes()
    if (!base.ok) return { ok: false }

    const next = { ...base.notes }
    const t = String(text ?? '').trim().slice(0, REMARK_MAX)
    if (t.length === 0) delete next[accountId]
    else next[accountId] = t

    const now = Math.floor(Date.now() / 1000)
    const env = encryptObject(MK, FRIEND_NOTES_OBJ_ID, OBJ_TYPE_FRIEND_NOTES, { v: 1, notes: next } satisfies FriendNotes, {
      version: now, updatedAt: now
    })
    try {
      await this.svc.account.api.call({
        method: 'PUT', target: `/api/v1/objects/${FRIEND_NOTES_OBJ_ID}`, deviceId, body: env
      })
    } catch {
      // 没存上就别动内存里那份 —— 否则界面会显示"改好了"，其实服务端上还是老的
      return { ok: false }
    }
    this.notes = next
    this.notesAt = Date.now()
    return { ok: true }
  }

  /** 登出 / 换账号时扔掉内存里那份。**绝不能让下一个账号看到上一个账号的备注。** */
  resetRemarks(): void {
    this.notes = null
    this.notesAt = 0
  }
}
