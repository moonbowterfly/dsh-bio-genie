// dsh-bio-genie — A3 prompt fixtures 验收（req G-LOOP-20261015-D4-001）
// 覆盖（v0.2 §9 A3 fixtures 部分 + v0.3 §9 A3 强化）：
//  1) 四类 fixture 齐全（complete-reference-case / missing-medium / gem-strain-mismatch /
//     structural-only）+ manifest.fixture_version 与各文件版本一致；
//  2) 每类含 prompt 正文 + 预期终态预登记（expected status/reason 非空 + 查证引用
//     file:line 或规格节号，照 design/failure-matrix.json 先例）；
//  3) 负扫描：prompt 正文（「prompt 正文」段至「预期终态预登记」段之间）不含任何
//     注册工具名（src/tools.js 注册表实取）/ skill 名（src/skills.js SKILL_MANIFEST +
//     GUIDE_MANIFEST + 主 skill 实取），亦无 bio_*/design_* 名称模式；
//  4) manifest 字段齐备 + config_hash 对可固化字段可复算一致（dsh_version 取 package.json、
//     preset digest 取 preset/bio-genie 两文件、skill_registry_digest 取 skills.js 清单）；
//  5) 每条预期终态 ∈ 状态词表（词表来源：design/failure-matrix.json#expected_status_vocab）。
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { registerTools } from '../src/tools.js'
import { SKILL_MANIFEST, GUIDE_MANIFEST, GENIE_SKILL } from '../src/skills.js'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const FX = join(ROOT, 'design', 'prompt-fixtures')
const MANIFEST = JSON.parse(readFileSync(join(FX, 'manifest.json'), 'utf8'))
const home = process.env.USERPROFILE || process.env.HOME
const VENV = process.env.DSH_BIO_PYTHON || join(home, '.dsh', 'dsh-bio-genie', 'python-env', 'Scripts', 'python.exe')

let pass = 0
let fail = 0
function check(name, actual, detail = '') {
  if (actual) { pass += 1; console.log('  PASS ' + name) }
  else { fail += 1; console.log('  FAIL ' + name + (detail ? ' :: ' + detail : '')) }
}
const sha256 = (b) => createHash('sha256').update(b).digest('hex')

// ── 工具名 / skill 名清单提取（报告披露：实取注册表与 skills.js 清单）────────
function toolNames() {
  const names = []
  const ctx = { tools: { register: (t) => { names.push(t.name); return () => {} } } }
  registerTools(ctx, { enableLog: false, pythonPath: VENV })
  return names
}
const TOOLS = toolNames()
const SKILLS = [...SKILL_MANIFEST.map((s) => s.name), ...GUIDE_MANIFEST.map((g) => g.name), GENIE_SKILL.name]

// ── 1) 四类齐全 + 版本一致 ───────────────────────────────────────────────
{
  const files = MANIFEST.fixtures.map((f) => f.file)
  check('manifest fixtures 四类齐全且文件存在',
    MANIFEST.fixtures.length === 4
    && new Set(MANIFEST.fixtures.map((f) => f.category)).size === 4
    && files.every((f) => existsSync(join(ROOT, f))))
  check('四类类别 = v0.2 §9 A3 指定类',
    ['complete-reference-case', 'missing-medium', 'gem-strain-mismatch', 'structural-only']
      .every((c) => MANIFEST.fixtures.some((f) => f.category === c)))
  const versioned = files.every((f) => {
    const head = readFileSync(join(ROOT, f), 'utf8').split('\n').slice(0, 4).join('\n')
    return head.includes('fixture_version: ' + MANIFEST.fixture_version)
      && head.includes('fixture_id: ' + MANIFEST.fixtures.find((x) => x.file === f).fixture_id)
  })
  check('版本一致：manifest.fixture_version 与四文件头一致（prompt-fixtures@1）', versioned)
}

// ── 2) 每类含 prompt + 预期终态登记（含查证引用）─────────────────────────
{
  const ok = MANIFEST.fixtures.every((f) => {
    const text = readFileSync(join(ROOT, f.file), 'utf8')
    const body = text.split('## 预期终态预登记')[0] ?? ''
    const expected = text.split('## 预期终态预登记')[1] ?? ''
    return body.includes('## prompt 正文')
      && body.replace('## prompt 正文', '').trim().length > 50
      && expected.includes('expected_status')
      && expected.includes('expected_reason')
      && expected.includes('查证引用')
      && /\.(py|js|mjs):\d+/.test(expected) // file:line 引用
      && /§\d/.test(expected)               // 规格节号引用
  })
  check('每类含 prompt 正文 + 预期终态登记 + 查证引用（file:line + §节号）', ok)
}

// ── 3) 负扫描：prompt 正文不含注册工具名/skill 名 ────────────────────────
{
  const hits = []
  const pat = /bio_[a-z_]+|design_[a-z_]+/
  for (const f of MANIFEST.fixtures) {
    const text = readFileSync(join(ROOT, f.file), 'utf8')
    const body = text.split('## prompt 正文')[1]?.split('## 预期终态预登记')[0] ?? ''
    for (const n of TOOLS) if (body.includes(n)) hits.push(f.fixture_id + '::tool:' + n)
    for (const n of SKILLS) if (body.includes(n)) hits.push(f.fixture_id + '::skill:' + n)
    if (pat.test(body)) hits.push(f.fixture_id + '::pattern:' + (body.match(pat) || [])[0])
  }
  check('负扫描：prompt 正文零注册工具名/skill 名/bio_*|design_* 模式',
    hits.length === 0, hits.slice(0, 5).join(', '))
  check('扫描集非空（工具名 ' + TOOLS.length + ' + skill 名 ' + SKILLS.length + '）',
    TOOLS.length >= 50 && SKILLS.length >= 40)
}

// ── 4) manifest 字段 + config_hash 可复算 ────────────────────────────────
{
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  const presetFiles = ['preset/bio-genie/agent.cordis.yml', 'preset/bio-genie/preset.yml']
  const presetDigest = sha256(presetFiles.map((f) => sha256(readFileSync(join(ROOT, f)))).join(''))
  const skills = SKILL_MANIFEST.map((s) => ({ name: s.name, category: s.category }))
  const guides = GUIDE_MANIFEST.map((g) => ({ name: g.name, category: g.category }))
  const skillDigest = sha256(JSON.stringify({ skills, guides }, Object.keys({ skills, guides }).sort()))
  const fp = {
    fixture_version: MANIFEST.fixture_version,
    dsh_version: pkg.version,
    preset: { name: 'bio-genie', digest_sha256: presetDigest },
    skill_registry_digest: { value: skillDigest },
  }
  const hash = sha256(JSON.stringify(fp, Object.keys(fp).sort()))

  check('manifest.dsh_version == package.json.version（' + pkg.version + '）',
    MANIFEST.config_fingerprint.dsh_version.value === pkg.version)
  check('preset digest 可复算一致（preset/bio-genie 两文件）',
    MANIFEST.config_fingerprint.preset.digest_sha256 === presetDigest)
  check('skill_registry_digest 可复算一致（skills.js 清单）',
    MANIFEST.config_fingerprint.skill_registry_digest.value === skillDigest)
  check('config_hash 可复算一致（仅可固化字段 canonical JSON）', MANIFEST.config_hash.value === hash)
  check('config_hash canonical_fields 与复算字段集一致',
    JSON.stringify(MANIFEST.config_hash.canonical_fields.sort())
    === JSON.stringify(Object.keys(fp).sort()))
  check('model 字段登记来源 + pending 标记（未编造当前值）',
    MANIFEST.config_fingerprint.model.pending === true
    && typeof MANIFEST.config_fingerprint.model.source === 'string'
    && MANIFEST.config_fingerprint.model.source.length > 0)
}

// ── 5) 预期终态 ∈ 状态词表 ───────────────────────────────────────────────
{
  const vocab = JSON.parse(readFileSync(join(ROOT, 'design', 'failure-matrix.json'), 'utf8')).expected_status_vocab
  const ok = MANIFEST.fixtures.every((f) =>
    vocab.includes(f.expected_status) && vocab.includes(f.expected_reason))
  check('每条预期终态 status/reason ∈ 状态词表（来源：failure-matrix.json#expected_status_vocab）', ok)
}

console.log(`design-prompt-fixtures: ${pass} passed, 0 skipped, ${fail} failed`)
if (fail) process.exit(1)
