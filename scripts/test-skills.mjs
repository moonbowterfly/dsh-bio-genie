// skills 清单校验：所有 SKILL_MANIFEST 文件存在；协议文件 frontmatter 字段完整。
// 用法：node scripts/test-skills.mjs
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SKILL_MANIFEST, GUIDE_MANIFEST } from '../src/skills.js'

let failures = 0
function assert(cond, msg) {
  if (cond) console.log(`  PASS ${msg}`)
  else { failures++; console.error(`  FAIL ${msg}`) }
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const skillsDir = join(repoRoot, 'skills')
const guidesDir = join(repoRoot, 'docs', 'agent-guide')
const protocols = SKILL_MANIFEST.filter((s) => s.file.startsWith('protocols/'))
const domain = SKILL_MANIFEST.filter((s) => !s.file.startsWith('protocols/'))

console.log(`[skills] ${SKILL_MANIFEST.length} 个 skill（${domain.length} 领域 + ${protocols.length} 协议）+ ${GUIDE_MANIFEST.length} 个指南`)
assert(protocols.length === 17, `协议数 = 17（实际 ${protocols.length}）`)
assert(GUIDE_MANIFEST.length === 8, `指南数 = 8（实际 ${GUIDE_MANIFEST.length}）`)

for (const g of GUIDE_MANIFEST) {
  const p = join(guidesDir, g.file)
  assert(existsSync(p), `指南文件存在: docs/agent-guide/${g.file}`)
  if (existsSync(p)) {
    const text = readFileSync(p, 'utf8')
    assert(text.length > 500, `指南内容非空且完整: ${g.name}（${text.length} 字符）`)
    assert(!text.includes('[SKILL_PRUNED]'), `指南未被裁剪: ${g.name}`)
  }
}

for (const s of SKILL_MANIFEST) {
  const p = join(skillsDir, s.file)
  assert(existsSync(p), `文件存在: ${s.file}`)
  if (!existsSync(p)) continue
  const text = readFileSync(p, 'utf8')
  if (s.file.startsWith('protocols/')) {
    for (const field of ['name:', 'domain:', 'inputs:', 'outputs:', 'requires_network:']) {
      assert(text.includes(field), `${s.file} frontmatter 含 ${field}`)
    }
    assert(text.startsWith('---'), `${s.file} 以 frontmatter 开头`)
    // 协议必须含可执行内容：python 代码模板 或 语义化工具调用序列（两者其一）
    assert(text.includes('```python') || text.includes('工具调用序列'), `${s.file} 含可执行内容`)
  }
}

if (failures === 0) console.log('\nALL PASS')
else { console.error(`\n${failures} FAILURES`); process.exit(1) }
