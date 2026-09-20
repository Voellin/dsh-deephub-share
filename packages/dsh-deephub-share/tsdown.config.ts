/**
 * 两个 face 的构建：
 *   lib/index.js  —— Host 半（Node，ESM）。生产依赖与 @deepseek-ai/* 保持 import，其余打进来。
 *   lib/client.js —— 浏览器半（CJS 闭包工厂）。格式必须与 dsh 的模块表一致：
 *                    `window.__ModuleLoader__.load({ id, factory: (require) => { ... } })`，
 *                    六个基线包走注入的 require，其余全部内联。
 *
 * 浏览器半的规则照抄 dsh 仓库 `packages/client/tsdown.client.ts`（该文件未发 npm）：
 *   - 基线外部包 = PLATFORM_MODULES（照抄自 `packages/client/web/src/platform.ts`，同样未发 npm）
 *   - 其余 @deepseek-ai/* 值导入一律报错（跨插件值导入禁止；type-only 导入会被擦除，不经过这道门）
 *   - `*.module.css` 用 lightningcss 编成 class map + 运行时注入 <style>
 */
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve as resolvePath } from 'node:path'
import { isBuiltin } from 'node:module'
import { transform } from 'lightningcss'
import type { UserConfig } from 'tsdown'
import manifest from './package.json' with { type: 'json' }

const ID = manifest.name

/** dsh Web 外壳共享进模块表的包（`packages/client/web/src/platform.ts` 的 PLATFORM_MODULES）。 */
const PLATFORM_MODULES: ReadonlySet<string> = new Set([
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
])

/** dsh 允许内联进浏览器 bundle 的纯契约层（照抄 INLINE_SAFE）。 */
const INLINE_SAFE = /^(?:@deepseek-ai\/dsh-(?:file-reference|session|llm|tools|brand|deque|output-retention|typert-protocol|util-crypto|util-values|util-workspace-path)(?:\/|$)|@deepseek-ai\/(cosmokit|schemastery)(\/|$))/

const production = new Set([
  ...Object.keys(manifest.peerDependencies ?? {}),
  ...Object.keys((manifest as { dependencies?: Record<string, string> }).dependencies ?? {}),
])
const isProduction = (specifier: string): boolean =>
  [...production].some(name => specifier === name || specifier.startsWith(`${name}/`))

const host: UserConfig = {
  name: ID,
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: isProduction,
    alwaysBundle: (specifier: string) => !isBuiltin(specifier) && !isProduction(specifier),
  },
}

const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'

function styleInjectionModule(fileId: string, css: string, classMap: Record<string, string>): string {
  return [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(`${ID}/${basename(fileId)}`)};`,
    "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {",
    "  const tag = document.createElement('style');",
    `  tag.dataset.plugin = ${JSON.stringify(ID)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
    `export default ${JSON.stringify(classMap)};`,
  ].join('\n')
}

const client: UserConfig = {
  name: `${ID}/client`,
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: (specifier: string) => PLATFORM_MODULES.has(specifier),
    alwaysBundle: (specifier: string) => !PLATFORM_MODULES.has(specifier),
  },
  inputOptions: {
    resolve: { conditionNames: ['production', 'browser', 'import', 'module', 'default'] },
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'import.meta.env.MODE': JSON.stringify('production'),
    'import.meta.env': JSON.stringify({ MODE: 'production' }),
  },
  plugins: [{
    name: 'dsh-client-bundle-purity',
    resolveId(source: string) {
      if (!source.startsWith('@deepseek-ai/')) return null
      if (PLATFORM_MODULES.has(source)) return null
      if (INLINE_SAFE.test(source)) return null
      throw new Error(
        `client bundle purity: "${source}" 既不在基线模块表里，也不是可内联的契约层——`
        + '跨插件值导入禁止；只用 import type，运行时通过 cordis 服务与 slot 协作',
      )
    },
  }, {
    name: 'dsh-css-modules-inline',
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith('.module.css')) return null
      const abs = importer !== undefined ? resolvePath(dirname(importer), source) : source
      return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
    },
    async load(virtualId: string) {
      if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
      const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
      this.addWatchFile(fileId)
      const { code, exports: cssExports } = transform({
        filename: fileId,
        code: await readFile(fileId),
        cssModules: { pattern: '[hash]_[local]' },
        minify: true,
      })
      const classMap: Record<string, string> = {}
      for (const [local, exp] of Object.entries(cssExports ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
        classMap[local] = exp.name
      }
      return styleInjectionModule(fileId, code.toString(), classMap)
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    sourcemapExcludeSources: false,
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default [host, client]
