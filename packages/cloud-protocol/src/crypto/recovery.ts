import { createHash, randomBytes } from 'node:crypto'

/**
 * 恢复码：忘密码 **且** 所有设备都没了时，唯一能解开数据的东西。
 *
 * 格式：Crockford Base32，23 位数据（112 bit 熵）+ 1 位校验，显示为 6 组 4 字符。
 * 例：RZ08-W62Q-8P1E-JF4Q-EYWP-HV0Z
 *
 * 选 Crockford 而不是标准 Base32：它的字母表去掉了 I L O U，
 * 天然免疫手抄时的 0/O、1/I/L 混淆；解析时再把这几个字符映射回去。
 *
 * 恢复码熵已足够（112 bit），派生时**只用 HKDF、不用 scrypt** —— 没必要让用户干等。
 */

const C32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
/** 数据位长度（字符数）。23 字符 × 5 bit = 115 bit，承载 14 字节 = 112 bit。 */
const DATA_CHARS = 23
const RAW_BYTES = 14
export const RECOVERY_CODE_LENGTH = DATA_CHARS + 1

function encode32(buf: Buffer): string {
  let bits = 0
  let val = 0
  let out = ''
  for (const byte of buf) {
    val = (val << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += C32[(val >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += C32[(val << (5 - bits)) & 31]
  return out
}

function decode32(str: string): Buffer {
  let bits = 0
  let val = 0
  const out: number[] = []
  for (const ch of str) {
    const i = C32.indexOf(ch)
    if (i < 0) throw new Error(`恢复码含非法字符：${ch}`)
    val = (val << 5) | i
    bits += 5
    if (bits >= 8) {
      out.push((val >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

const checkChar = (body: string): string => C32[createHash('sha256').update(body, 'utf8').digest()[0] & 31]

export interface RecoveryCode {
  /** 14 字节原始熵，用来派生恢复 KEK */
  raw: Buffer
  /** 24 个字符，无分隔 */
  code: string
  /** 给用户看的：6 组 4 字符，中间连字符 */
  pretty: string
}

export function newRecoveryCode(): RecoveryCode {
  const raw = randomBytes(RAW_BYTES)
  const body = encode32(raw).slice(0, DATA_CHARS)
  const code = body + checkChar(body)
  return { raw, code, pretty: (code.match(/.{1,4}/g) ?? []).join('-') }
}

/**
 * 归一化用户抄写的码并验校验位。
 *
 * 容错：大小写、任意分隔符、以及 Crockford 规定的等价映射（O→0、I/L→1、U→V）。
 * 抄错一位会在这里当场被校验位抓出来，而不是等到解密失败——错误提示能准确得多。
 */
export function parseRecoveryCode(input: string): Buffer {
  const s = String(input)
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1')
    .replace(/U/g, 'V')
  if (s.length !== RECOVERY_CODE_LENGTH) {
    throw new Error(`恢复码长度不对：应为 ${RECOVERY_CODE_LENGTH} 位，实际 ${s.length} 位`)
  }
  if (checkChar(s.slice(0, DATA_CHARS)) !== s[DATA_CHARS]) {
    throw new Error('恢复码校验位不匹配（多半是抄错了某一位）')
  }
  return decode32(s.slice(0, DATA_CHARS)).subarray(0, RAW_BYTES)
}
