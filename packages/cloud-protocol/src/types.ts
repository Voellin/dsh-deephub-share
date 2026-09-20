/**
 * 协议客户端对外暴露的状态与结果类型。DeepHub 渲染层与 dsh 插件浏览器半都只看这些，
 * **不含主密钥、不含密码、不含恢复码。**
 */

/** 渲染层能看到的云端状态。**不含主密钥、不含密码、不含恢复码。** */
export interface CloudStatus {
  host: string
  loggedIn: boolean
  email: string | null
  accountId: string | null
  shortId: string | null
  deviceId: string | null
  /** 设备私钥是否受本机安全存储保护（false = 降级成了明文文件） */
  keyEncrypted: boolean
  /** 本机能否缓存主密钥 —— 决定"免密启动"能不能成立 */
  cacheAvailable: boolean
  /** 内存里是否已持有主密钥（免密启动成功 / 本次会话登录过） */
  unlocked: boolean
  /** 有一串恢复码尚未确认抄写 */
  pendingRecoveryCode: boolean
  /** null = 未探测或探测失败 */
  reachable: boolean | null
  skewSeconds: number | null
  quotaBytes: number | null
  usedBytes: number | null
  /**
   * 协议协商的结论。`'unknown'` = 没探到（离线是常态，不是错误），界面上什么都不必说。
   * `'client_too_old'` / `'client_deprecated'` 要给用户看人话；
   * `'server_too_old'` 一般只在开发期出现（本地服务端比客户端旧）。
   */
  protocol: 'ok' | 'client_too_old' | 'client_deprecated' | 'server_too_old' | 'unknown'
  /** 协商出来的版本；null = 没协商过 */
  protocolVersion: number | null
  /** 弃用窗口的截止时间（Unix 秒）；只在 `client_deprecated` 时有意义 */
  protocolSunset: number | null
}

/**
 * 失败原因归一化。UI 据此决定说什么，**不要把异常文本直接丢给用户**。
 * - `offline`  网络不通/超时/被代理插手。**不是业务结论**，本地照常干活
 * - `rejected` 服务端给出的、带合法签名的业务错误，可以下结论
 * - `insecure` 2xx 却没有合法签名 —— 连接可能被劫持
 * - `local`    本地问题（恢复码解不开信封、参数不合法等）
 */
export type CloudFailKind = 'offline' | 'rejected' | 'insecure' | 'local'

export interface CloudFail {
  ok: false
  kind: CloudFailKind
  code?: string
  status?: number
  message: string
}

/** 不带额外字段时直接写 `CloudResult`；`Record<string, never>` 与 `{ok:true}` 求交会塌成 never。 */
export type CloudResult<T = object> = ({ ok: true } & T) | CloudFail

/** 同步器状态。`offline` 不是故障，是常态之一。 */
export interface CloudSyncStatus {
  running: boolean
  lastPullAt: number | null
  lastPushAt: number | null
  lastError: string | null
  offline: boolean
  cursorSeq: number
  /** 还没传上去的会话数。**UI 必须显示它**——有东西卡在队列里却显示"已同步"就是在说假话。 */
  pending: number
  /** 本轮上行批次一开始有多少条。0 表示当前没有批次在跑。 */
  pushTotal: number
  /**
   * 本轮批次里已经处理完几条（传上去 / 判定没变 / 已删）。`pushDone / pushTotal` 就是进度。
   *
   * ⚠️ **不能拿 `pushTotal - pending` 当分子**：待传队列要到整批结束才收口
   *（同步器要到整批结束才收口，那是"批次期间新标脏的会话别被抹掉"换来的），
   * 批次跑到一半时 `pending` 还是满的，算出来的分子会一路停在 0、最后一跳到底。
   */
  pushDone: number
  /**
   * 本次登录（或本次换游标）以来已经拉回来多少个对象。
   *
   * ⚠️ **只有分子，没有分母。** 服务端的 `GET /api/v1/objects` 只回
   * `items / next_cursor / has_more`，从不说总共多少个——所以界面上只能说
   * 「正在拉回第 N 条」，给不出百分比。想要百分比得先给协议加一个能力。
   */
  pulled: number
}

export interface CloudDevice {
  id: string
  name: string | null
  platform: string | null
  status: 'active' | 'pending' | 'revoked'
  last_seen_at: number | null
  created_at: number
  is_current: boolean
}

/** 新设备登录时挂起的确认项。`code` 由老设备确认时原样回传，不经人手输入，也不展示。 */
export interface CloudPendingApproval {
  approval_id: string
  device_id: string
  code: string
  device_name: string | null
  platform: string | null
  expires_at: number
}
