/**
 * 把 package.json 的版本同步进浏览器端面板的 META.version。
 *
 * 背景：lib/client.js 是直接投给浏览器的静态脚本（无 require 能力），无法在
 * 运行时读 package.json，因此历史上版本号被手抄成两处。test-doc-counts.mjs
 * 会抓不一致，但它只能报错——修起来仍要手工改，容易在下一次 bump 时漏改。
 *
 * 本脚本让 package.json 成为唯一真值源：bump 后跑一次即可同步。
 * 用法：node scripts/sync-client-version.mjs [--check]
 *   --check只校验不写入，不一致时 exit 1（可用于 CI / prebump 检查）
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkgPath = join(repoRoot, 'package.json')
const clientPath = join(repoRoot, 'lib', 'client.js')

const version = JSON.parse(readFileSync(pkgPath, 'utf8')).version
const source = readFileSync(clientPath, 'utf8')
// 只替换 META 里的那一处 version:'x.y.z'，避免误伤其它同形字符串。
const pattern = /(pluginName:\s*'@dsh-bio\/dsh-bio-genie',\s*\n\s*version:\s*')[^']+(')/

if (!pattern.test(source)) {
  console.error('sync-client-version: 未在 lib/client.js 里找到 META.version，无法定位替换点。')
  process.exit(1)
}

const matched = pattern.exec(source)
const existing = matched[0].match(/version:\s*'([^']+)'/)[1]

if (existing === version) {
  console.log(`sync-client-version: lib/client.js 已是 ${version}，无需改动。`)
  process.exit(0)
}

if (process.argv.includes('--check')) {
  console.error(`sync-client-version: 不一致 —— lib/client.js=${existing}，package.json=${version}`)
  process.exit(1)
}

writeFileSync(clientPath, source.replace(pattern, `$1${version}$2`), 'utf8')
console.log(`sync-client-version: lib/client.js ${existing} → ${version}`)