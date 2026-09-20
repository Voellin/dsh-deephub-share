import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** 只对**相对路径**、只在对应 .ts 真的存在时补扩展名；其余一律原样抛回。 */
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context)
  } catch (e) {
    if ((e?.code !== 'ERR_MODULE_NOT_FOUND' && e?.code !== 'ERR_UNSUPPORTED_DIR_IMPORT')
      || !specifier.startsWith('.') || !context.parentURL) throw e
    const base = new URL(specifier, context.parentURL)
    for (const suffix of ['.ts', '/index.ts']) {
      const candidate = new URL(base.href + suffix)
      if (existsSync(fileURLToPath(candidate))) return next(candidate.href, context)
    }
    throw e
  }
}
