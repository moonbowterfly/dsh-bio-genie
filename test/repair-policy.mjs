// repair-policy 单元测试：策略镜像防漂移 + 变更面拒绝性用例（allowlist/deny 兜底/预算）。
// 用法：node test/repair-policy.mjs
import { readFileSync } from 'node:fs'
import { DEFAULT_POLICY, validateProposalFiles } from '../src/repair-contract.js'

let failures = 0
function assert(cond, msg) {
  if (cond) console.log(`  PASS ${msg}`)
  else { failures++; console.error(`  FAIL ${msg}`) }
}

// ── 机读策略镜像防漂移 ──
console.log('[policy] 机读镜像')
const pj = JSON.parse(readFileSync(new URL('../design/repair/repair-policy-v0.json', import.meta.url), 'utf8'))
assert(pj.schema === DEFAULT_POLICY.schema && pj.mode === DEFAULT_POLICY.mode && pj.plugin_id === DEFAULT_POLICY.plugin_id, 'schema/mode/plugin_id 一致')
assert(JSON.stringify(pj.capture) === JSON.stringify(DEFAULT_POLICY.capture), 'capture 段一致')
assert(JSON.stringify(pj.proposal.exact_deny) === JSON.stringify(DEFAULT_POLICY.proposal.exact_deny), 'exact_deny 一致')
assert(JSON.stringify(pj.proposal.prefix_deny) === JSON.stringify(DEFAULT_POLICY.proposal.prefix_deny), 'prefix_deny 一致')
assert(JSON.stringify(pj.proposal.suffix_deny) === JSON.stringify(DEFAULT_POLICY.proposal.suffix_deny), 'suffix_deny 一致')
assert(JSON.stringify(pj.limits) === JSON.stringify(DEFAULT_POLICY.limits), 'limits 一致')
assert(pj.proposal.enabled === false && Array.isArray(pj.proposal.allowed_files), 'v0 proposal.enabled=false 且 allowlist 初始为空')

const allowPol = (files) => ({ ...DEFAULT_POLICY, proposal: { ...DEFAULT_POLICY.proposal, allowed_files: files } })

// ── 通过面 ──
console.log('[policy] 通过面')
assert(validateProposalFiles([{ path: 'src/foo.js', kind: 'modify' }], allowPol(['src/foo.js'])).ok, '纯逻辑文件在精确 allowlist 内：通过')
assert(validateProposalFiles([{ path: 'src/b.js', kind: 'rename', from: 'src/a.js' }], allowPol(['src/a.js', 'src/b.js'])).ok, '合法 rename：通过')
{
  const r = validateProposalFiles([{ path: 'src/foo.js', kind: 'modify' }])
  assert(!r.ok && r.rejects[0].reason === 'NOT_ON_ALLOWLIST', '默认策略（空 allowlist）一律拒绝')
}

// ── 拒绝面（必须杀死全部禁类） ──
console.log('[policy] 拒绝性用例')
const cases = [
  [[{ path: 'package.json', kind: 'modify' }], 'EXACT_DENY', 'package.json'],
  [[{ path: 'Package.JSON', kind: 'modify' }], 'EXACT_DENY', '大小写绕过'],
  [[{ path: 'pnpm-lock.yaml', kind: 'modify' }], 'EXACT_DENY', 'lockfile'],
  [[{ path: 'src/index.js', kind: 'modify' }], 'EXACT_DENY', 'src/index.js'],
  [[{ path: '.npmrc', kind: 'modify' }], 'EXACT_DENY', '.npmrc'],
  [[{ path: 'cordis.patch.yml', kind: 'modify' }], 'EXACT_DENY', 'cordis.patch.yml'],
  [[{ path: '.gitmodules', kind: 'modify' }], 'EXACT_DENY', 'submodule 声明'],
  [[{ path: 'scripts/x.mjs', kind: 'add' }], 'PREFIX_DENY', 'scripts/**'],
  [[{ path: '.github/workflows/ci.yml', kind: 'add' }], 'PREFIX_DENY', '.github/**'],
  [[{ path: 'preset/bio-genie/x.yml', kind: 'modify' }], 'PREFIX_DENY', 'preset/**'],
  [[{ path: 'skills/bio-core.md', kind: 'modify' }], 'PREFIX_DENY', 'skills/**'],
  [[{ path: 'test/repair-store.mjs', kind: 'modify' }], 'PREFIX_DENY', '冻结测试面'],
  [[{ path: 'src/x.exe', kind: 'add' }], 'SUFFIX_DENY', '二进制'],
  [[{ path: 'src/x.pyc', kind: 'add' }], 'SUFFIX_DENY', '编译产物'],
  [[{ path: '../x.js', kind: 'modify' }], 'DOT_SEGMENT', '路径穿越'],
  [[{ path: '/abs/x.js', kind: 'modify' }], 'ABSOLUTE_PATH', '绝对路径'],
  [[{ path: 'src\\x.js', kind: 'modify' }], 'BACKSLASH_PATH', '反斜杠'],
  [[{ path: 'src/x.js:ads', kind: 'modify' }], 'COLON_ADS_OR_DRIVE', 'ADS'],
  [[{ path: 'src/x.js. ', kind: 'modify' }], 'TRAILING_DOT_OR_SPACE', '尾空格/点'],
  [[{ path: 'a/node_modules/x.js', kind: 'modify' }], 'VCS_OR_MODULES_SEGMENT', 'node_modules'],
  [[{ path: 'a/.git/config', kind: 'modify' }], 'VCS_OR_MODULES_SEGMENT', '.git'],
]
for (const [changes, expect, label] of cases) {
  const r = validateProposalFiles(changes, allowPol(['src/x.js', 'src/foo.js', '.npmrc', 'cordis.patch.yml']))
  assert(!r.ok && r.rejects.some((x) => x.reason === expect), `${label} → ${expect}`)
}
{
  const r = validateProposalFiles([{ path: 'src/a.js', kind: 'rename', from: 'src/A.js' }], allowPol(['src/a.js', 'src/A.js']))
  assert(!r.ok && r.rejects.some((x) => x.reason === 'CASE_ONLY_RENAME'), '仅大小写 rename 拒绝')
}
{
  const many = Array.from({ length: 65 }, (_, i) => ({ path: `src/f${i}.js`, kind: 'modify' }))
  const r = validateProposalFiles(many, allowPol(many.map((m) => m.path)))
  assert(!r.ok && r.rejects.some((x) => x.reason === 'TOO_MANY_CHANGES'), '变更预算（>64）拒绝')
}
{
  const r = validateProposalFiles([{ path: 'design/repair/repair-contract-v0.json', kind: 'modify' }], allowPol(['design/repair/repair-contract-v0.json']))
  assert(!r.ok && r.rejects.some((x) => x.reason === 'EXACT_DENY'), '契约/策略文件即使进 allowlist 仍被 deny 兜底')
}
{
  const r = validateProposalFiles([])
  assert(!r.ok && r.rejects[0].reason === 'EMPTY_CHANGES', '空变更集拒绝')
}

if (failures === 0) console.log('\nALL PASS')
else { console.error(`\n${failures} FAILURES`); process.exit(1) }
