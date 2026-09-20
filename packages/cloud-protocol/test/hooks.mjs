// 测试用的模块解析钩子。
//
// 本包的源码是**写给打包器**的：相对导入一律不带扩展名（`./kdf`、`./registry`），
// 因为 vite / tsdown / tsc 都认得。Node 直接跑 .ts（类型擦除模式）按 ESM 规矩办事，
// 要求写全 `./kdf.ts`。两边都要伺候，所以补一个解析钩子，而不是去改源码里的几十处导入——
// 改源码会连带踩到另外两个坑：编译成 CommonJS 的那条路不认 `.ts` 扩展名（TS5097），
// 而插件的 `types:cloud-protocol` 又是 emitDeclarationOnly。
//
// 与 dsh 插件 `tests/hooks.mjs` 同款（那边先踩的这个坑）。
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

register(new URL('./hooks-resolve.mjs', import.meta.url), pathToFileURL('./'))
