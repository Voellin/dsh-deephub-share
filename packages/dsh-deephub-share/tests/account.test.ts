/**
 * 账号这半的单元测试：DshKeyStore 对着一个内存版凭据存储；恢复码归一化；邮箱粗判。
 * 真连服务端的那条路不在这里测——这几条只管纯逻辑。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { CredentialKey, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { DshKeyStore, type CredentialsLike } from '../src/account/keystore.ts'
import { looksLikeEmail, normalizeRecoveryCode, prettyRecoveryCode } from '../src/client/account-api.ts'

/** 内存版 ctx.credentials（只有 record 半的三个方法），记下每次写。 */
function fakeCredentials(): CredentialsLike & { records: Map<string, CredentialRecord>; writes: string[] } {
  const records = new Map<string, CredentialRecord>()
  const writes: string[] = []
  return {
    records, writes,
    async readRecord(key) { return records.get(key) },
    async modifyRecord(key, mutate) {
      const next = await mutate(records.get(key))
      if (next === undefined) records.delete(key); else records.set(key, next)
      writes.push(`set ${key}`)
      return next
    },
    async deleteRecord(key) { records.delete(key); writes.push(`del ${key}`) },
  }
}

const payloadOf = (c: ReturnType<typeof fakeCredentials>, id: string): Record<string, unknown> | undefined => {
  const r = c.records.get(`deephub-share/${id}` as CredentialKey)
  return r?.kind === 'grant' ? (r.payload as Record<string, unknown>) : undefined
}

test('首次：生成设备密钥并写两条记录；重开后读回同一把', async () => {
  const c = fakeCredentials()
  const s1 = await DshKeyStore.open(c)
  const d1 = s1.loadOrCreateDevice()
  await s1.flush()
  assert.equal(d1.deviceId, null)
  assert.equal(d1.encrypted, false)
  assert.deepEqual(c.writes, ['set deephub-share/device', 'set deephub-share/binding'])
  assert.ok(String(payloadOf(c, 'device')?.pem).includes('BEGIN PRIVATE KEY'))

  const s2 = await DshKeyStore.open(c)
  const d2 = s2.loadOrCreateDevice()
  assert.deepEqual(d2.keypair.rawPub, d1.keypair.rawPub) // 同一把
  assert.equal(c.writes.length, 2) // 没有再写
})

test('绑定：保存/清除/重置', async () => {
  const c = fakeCredentials()
  const s = await DshKeyStore.open(c)
  s.loadOrCreateDevice()
  s.saveDeviceBinding({ deviceId: 'dev1', accountId: 'acc1', email: 'a@b.co' })
  s.saveDeviceBinding({ shortId: 'DH-1' })
  await s.flush()
  assert.deepEqual(payloadOf(c, 'binding'), { v: 1, deviceId: 'dev1', accountId: 'acc1', email: 'a@b.co', shortId: 'DH-1' })
  assert.equal((await DshKeyStore.open(c)).loadOrCreateDevice().shortId, 'DH-1')

  s.clearDeviceBinding(); await s.flush()
  assert.deepEqual(payloadOf(c, 'binding'), { v: 1, deviceId: null, accountId: null, email: null, shortId: null })
  assert.ok(payloadOf(c, 'device')) // 退出登录保留设备密钥

  s.resetDevice(); await s.flush()
  assert.equal(payloadOf(c, 'device'), undefined)
  assert.equal(payloadOf(c, 'binding'), undefined)
})

test('主密钥与身份私钥：缓存、读回、清掉；非 32 字节当没缓存', async () => {
  const c = fakeCredentials()
  const s = await DshKeyStore.open(c)
  assert.equal(s.isCacheAvailable(), true)
  assert.equal(s.loadMasterKey(), null)
  const mk = Buffer.alloc(32, 7)
  assert.equal(s.cacheMasterKey(mk), true)
  assert.deepEqual(s.loadMasterKey(), mk)
  await s.flush()
  assert.equal(payloadOf(c, 'master-key')?.b64, mk.toString('base64'))
  assert.deepEqual((await DshKeyStore.open(c)).loadMasterKey(), mk)

  s.cacheIdentityKey(Buffer.alloc(32, 9)); await s.flush()
  assert.deepEqual((await DshKeyStore.open(c)).loadIdentityKey(), Buffer.alloc(32, 9))
  s.clearMasterKey(); s.clearIdentityKey(); await s.flush()
  assert.equal(payloadOf(c, 'master-key'), undefined)
  assert.equal(payloadOf(c, 'identity-key'), undefined)

  c.records.set('deephub-share/master-key' as CredentialKey, { kind: 'grant', payload: { v: 1, b64: Buffer.alloc(16).toString('base64') } })
  assert.equal((await DshKeyStore.open(c)).loadMasterKey(), null)
})

test('写失败不抛、记在 writeError；内存值照旧', async () => {
  const c = fakeCredentials()
  c.modifyRecord = async () => { throw new Error('disk full') }
  const s = await DshKeyStore.open(c)
  s.cacheMasterKey(Buffer.alloc(32, 1))
  await s.flush()
  assert.equal(s.writeError()?.message, 'disk full')
  assert.deepEqual(s.loadMasterKey(), Buffer.alloc(32, 1))
})

test('恢复码归一化与美化；邮箱粗判', () => {
  assert.equal(normalizeRecoveryCode(' rz08-w62q 8p1e_jf4q/eywp.hv0z '), 'RZ08W62Q8P1EJF4QEYWPHV0Z')
  assert.equal(normalizeRecoveryCode('oIlu'), '011V')
  assert.equal(prettyRecoveryCode('RZ08W62Q8P1EJF4QEYWPHV0Z'), 'RZ08-W62Q-8P1E-JF4Q-EYWP-HV0Z')
  assert.equal(looksLikeEmail('lin@example.com'), true)
  assert.equal(looksLikeEmail(' lin@example.com '), true)
  assert.equal(looksLikeEmail('lin@example'), false)
  assert.equal(looksLikeEmail('lin example@x.com'), false)
  assert.equal(looksLikeEmail('@x.com'), false)
  assert.equal(looksLikeEmail('a@b.'), false)
})
