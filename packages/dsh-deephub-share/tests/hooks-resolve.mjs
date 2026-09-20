import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context)
  } catch (e) {
    if ((e?.code !== 'ERR_MODULE_NOT_FOUND' && e?.code !== 'ERR_UNSUPPORTED_DIR_IMPORT') || !specifier.startsWith('.') || !context.parentURL) throw e
    const base = new URL(specifier, context.parentURL)
    for (const suffix of ['.ts', '/index.ts']) {
      const candidate = new URL(base.href + suffix)
      if (existsSync(fileURLToPath(candidate))) return next(candidate.href, context)
    }
    throw e
  }
}
