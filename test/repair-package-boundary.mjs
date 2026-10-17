// repair-package-boundary 单元测试：npm pack 内容边界（私有物不进包 / 公开契约与文档在包内 / lab 入口不进包）。
// 用法：node test/repair-package-boundary.mjs
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

let failures = 0
function assert(cond, msg) {
  if (cond) console.log(`  PASS ${msg}`)
  else { failures++; console.error(`  FAIL ${msg}`) }
}

const ROOT = fileURLToPath(new URL('..', import.meta.url))

let pack
try {
  const opts = { cwd: ROOT, encoding: 'utf8', timeout: 180_000 }
  const out = process.platform === 'win32'
    ? execFileSync('cmd.exe', ['/d', '/s', '/c', 'npm pack --dry-run --json'], opts)
    : execFileSync('npm', ['pack', '--dry-run', '--json'], opts)
  // npm 输出两种形态：数组 [{...}]（旧版）或对象 {"<name>": {...}}（新版）——都接受
  const parsed = JSON.parse(out.trim())
  pack = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0]
  if (!pack || !Array.isArray(pack.files)) throw new Error('unexpected npm pack JSON shape')
} catch (err) {
  console.error(`  FAIL npm pack --dry-run 失败: ${err.message}`)
  process.exit(1)
}

const files = pack.files.map((f) => f.path.replace(/\\/g, '/'))
console.log(`  (pack 共 ${files.length} 个文件，${pack.size} bytes)`)

// ① 私有物不进包
console.log('[package-boundary] 私有物不进包')
for (const bad of ['test/', 'tmp/', 'node_modules/', 'repair-account', '.local.md', '.tmp']) {
  const hit = files.filter((f) => f.includes(bad))
  assert(hit.length === 0, `不含 ${bad}${hit.length ? `（命中 ${hit.slice(0, 3).join(', ')}）` : ''}`)
}
assert(!files.some((f) => f.startsWith('scripts/') && f !== 'scripts/install-preset.js'), 'scripts/ 只含 install-preset.js（lab 入口不进包）')
assert(!files.includes('scripts/repair-lab-verify.mjs'), 'repair-lab-verify.mjs 不进包')
assert(!files.includes('scripts/repair-gen-package.mjs'), 'repair-gen-package.mjs 不进包')
assert(!files.some((f) => f.includes('repair-gen')), 'repair-gen 相关 lab 件不进包')
assert(!files.some((f) => f.includes('fixtures/repair')), '合成 fixtures 不进包')

// ② 公开契约/文档/源码在包内
console.log('[package-boundary] 公开面在包内')
for (const must of [
  'design/repair/repair-contract-v0.json',
  'design/repair/repair-policy-v0.json',
  'docs/repair-proposal-v0.md',
  'src/repair-contract.js',
  'src/repair-capture.js',
  'src/repair-store.js',
  'src/repair-ledger.js',
  'src/memory.js',
]) {
  assert(files.includes(must), `含 ${must}`)
}

// ③ 无 credential-like fixture 名称
console.log('[package-boundary] credential-like 命名')
assert(!files.some((f) => /(secret|credential|token|password)/i.test(f.split('/').pop())), '包内文件名不含 secret/credential/token/password')

if (failures === 0) console.log('\nALL PASS')
else { console.error(`\n${failures} FAILURES`); process.exit(1) }
