// dsh-bio-genie — cordis.patch.yml freshness gate（req G-LOOP-20261015-E1-001）
// 驱动 scripts/build-preset-patch.mjs --check（无写入、逐字节比对）并断言 exit 0。
// fail-closed：builder 崩溃（status null）/ 非零退出 / 输出缺失 → FAIL。
import { spawnSync } from 'node:child_process'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const BUILDER = join(ROOT, 'scripts', 'build-preset-patch.mjs')

const r = spawnSync(process.execPath, [BUILDER, '--check'], { encoding: 'utf8', cwd: ROOT, timeout: 120_000 })
const out = (r.stdout || '') + (r.stderr || '')
let pass = 0
let fail = 0
const check = (name, ok, detail = '') => {
  if (ok) { pass += 1; console.log('  PASS ' + name) }
  else { fail += 1; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
}
check('builder 进程正常退出（无崩溃）', r.status !== null && r.error === undefined, String(r.error || '').slice(0, 120))
check('--check exit 0（fresh：cordis.patch.yml 与生成内容逐字节一致）',
  r.status === 0 && /fresh/.test(out), out.slice(0, 300))
check('check 模式输出含 fresh 标记（无写入式生成器验收）', /fresh:.*逐字节一致/.test(out))
check('输出完整（builder 未静默截断）', out.length > 20)

console.log(`test-cordis-patch-freshness: ${pass} passed, 0 skipped, ${fail} failed`)
if (fail) process.exit(1)
