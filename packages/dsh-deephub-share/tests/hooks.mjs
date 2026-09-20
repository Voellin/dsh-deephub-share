// 测试用的模块解析钩子：共享包 @deephub/cloud-protocol 的源码是给打包器写的（相对导入不带扩展名），
// Node 直接跑 .ts 需要把 `./keystore` 补成 `./keystore.ts`。只对相对路径、只在 .ts 文件存在时补。
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

register(new URL('./hooks-resolve.mjs', import.meta.url), pathToFileURL('./'))
