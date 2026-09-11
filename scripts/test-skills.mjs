// skills 清单校验：所有 SKILL_MANIFEST 文件存在；协议文件 frontmatter 字段完整；
// 目录预算 / description 可区分性 lint；Python 代码块语法与 import 可解析（静态质量门）。
// 用法：node scripts/test-skills.mjs
//
// 静态质量门（2026-09-11 引入，来源：外部评审裁决 v2 + aipoch MedSkillAudit 思路）：
//   ① frontmatter: name/description/language 齐备（协议另需 domain/inputs/outputs/requires_network）
//   ② description ≤ 120 字符（单条）
//   ③ 目录字符预算：注入 agent 的 skill 目录整块 ≤ 9000 字符
//   ④ 主词唯一性：同一条目集内 description 首句引导词不得重复
//   ⑤ Python 代码块 ast.parse 通过 + import 在本机自举环境可解析（第二层依赖可接受缺失）
import { readFileSync, existsSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'
import { SKILL_MANIFEST, GUIDE_MANIFEST, GENIE_SKILL } from '../src/skills.js'
import { EXTRA_DEPS, ADDON_MODULES } from '../src/extra-deps.js'

// 质量门棘轮基线：登记「尚未补齐标准」的存量 skill（只 WARN）。不在表内的 skill 强制达标。
const BASELINE = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'skill-standards-baseline.json'), 'utf8'))
const GRANDFATHERED = new Set(BASELINE.missing_acceptance_criteria || [])

let failures = 0
let warnings = 0
const acceptancePending = []
const acceptanceFilled = []
function assert(cond, msg) {
  if (cond) console.log(`  PASS ${msg}`)
  else { failures++; console.error(`  FAIL ${msg}`) }
}
function warn(msg) {
  warnings++
  console.warn(`  WARN ${msg}`)
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const skillsDir = join(repoRoot, 'skills')
const guidesDir = join(repoRoot, 'docs', 'agent-guide')
const protocols = SKILL_MANIFEST.filter((s) => s.file.startsWith('protocols/'))
const domain = SKILL_MANIFEST.filter((s) => !s.file.startsWith('protocols/'))

console.log(`[skills] ${SKILL_MANIFEST.length} 个 skill（${domain.length} 领域/研究 + ${protocols.length} 协议）+ ${GUIDE_MANIFEST.length} 个指南`)

// ---- 语言标注约定（用户 2026-08-17）：所有 skill 开头 frontmatter 必须含 language 字段 ----
// R 引擎已移除（2026-08-25）：language 合法值不再含 'r'。
const NL = String.fromCharCode(10)
const VALID_LANGUAGES = ['python', 'mixed', 'none']

/** 解析 frontmatter 里的 language 字段；无 frontmatter 或无字段返回 null。 */
function frontmatterLanguage(text) {
  if (!text.startsWith('---' + NL)) return null
  const end = text.indexOf(NL + '---', 4)
  if (end < 0) return null
  for (const line of text.slice(4, end).split(NL)) {
    const t = line.trim()
    if (t.startsWith('language:')) return t.slice('language:'.length).trim()
  }
  return null
}

function assertLanguage(label, text) {
  const lang = frontmatterLanguage(text)
  if (!lang) {
    assert(false, `${label} 缺 language 标注（python/mixed/none）`)
    return
  }
  assert(VALID_LANGUAGES.includes(lang), `${label} language 值合法（${lang}）`)
}

for (const g of GUIDE_MANIFEST) {
  const p = join(guidesDir, g.file)
  assert(existsSync(p), `指南文件存在: docs/agent-guide/${g.file}`)
  if (existsSync(p)) {
    const text = readFileSync(p, 'utf8')
    assert(text.length > 500, `指南内容非空且完整: ${g.name}（${text.length} 字符）`)
    assert(!text.includes('[SKILL_PRUNED]'), `指南未被裁剪: ${g.name}`)
    assertLanguage(`指南 ${g.name}`, text)
  }
}

for (const s of SKILL_MANIFEST) {
  const p = join(skillsDir, s.file)
  assert(existsSync(p), `文件存在: ${s.file}`)
  if (!existsSync(p)) continue
  const text = readFileSync(p, 'utf8')
  assertLanguage(`skill ${s.name}`, text)
  if (s.file.startsWith('protocols/')) {
    for (const field of ['name:', 'domain:', 'inputs:', 'outputs:', 'requires_network:']) {
      assert(text.includes(field), `${s.file} frontmatter 含 ${field}`)
    }
    assert(text.startsWith('---'), `${s.file} 以 frontmatter 开头`)
    // 协议必须含可执行内容：python 代码模板 或 语义化工具调用序列（两者其一）
    assert(text.includes('```python') || text.includes('工具调用序列'), `${s.file} 含可执行内容`)
  }
  // 每个 skill 正文须有验收标准节（静态门 #2）；存量未达标走棘轮基线，只 WARN
  const hasAcceptance = /##\s*验收标准/.test(text)
  if (hasAcceptance) {
    if (GRANDFATHERED.has(s.name)) acceptanceFilled.push(s.name)
  } else if (GRANDFATHERED.has(s.name)) {
    acceptancePending.push(s.name)
  } else {
    assert(false, `${s.name} 含「验收标准」节（新增/改动的 skill 不得豁免）`)
  }
}

// ─────────────────────────────────────────────────────────────
// 纪律 A · 目录预算 + description 可区分性（外部评审裁决 v2，2026-09-11）
// ─────────────────────────────────────────────────────────────
// 计量口径（实测可复现）：agent 侧 skill 目录 = 一行一条 `- \`name\`: description`，
// 单条字符数 = name + description + 6（减号、空格、反引号、冒号、空格、换行）。
// 整块 = 条目行 + 外壳文字（FRAME_CHARS，实测取自真实会话 session-fe7dd226 的
// <system-reminder> 块：6454 整块 − 5717 条目行 = 737）。
const DESC_MAX_LEN = 120
const CATALOG_BUDGET = 9000
const FRAME_CHARS = 737
// 同装插件的目录占用预算（实测 2026-09-11：gem-expert 154 + kimi-webbridge 520 +
// user-style-preferences 84 = 758，取 800 留余量）。宿主侧/第三方 skill 变化时重测。
const FOREIGN_BUDGET = 800
const entryChars = (name, desc) => name.length + desc.length + 6

console.log('\n[目录预算]')
{
  const entries = [
    { name: 'dsh-bio-genie', description: GENIE_SKILL.description },
    ...SKILL_MANIFEST.map(({ name, description }) => ({ name, description })),
    ...GUIDE_MANIFEST.map(({ name, description }) => ({ name, description })),
  ]
  const own = entries.reduce((n, e) => n + entryChars(e.name, e.description), 0)
  const estimate = own + FRAME_CHARS + FOREIGN_BUDGET
  console.log(`  自注册条目 ${entries.length} 个 / ${own} 字符（+外壳 ${FRAME_CHARS} +同装插件 ${FOREIGN_BUDGET} ≈ ${estimate}）`)
  assert(estimate <= CATALOG_BUDGET, `目录整块估算 ${estimate} ≤ 预算 ${CATALOG_BUDGET}（余量 ${CATALOG_BUDGET - estimate}）`)

  const over = entries.filter((e) => e.description.length > DESC_MAX_LEN)
  assert(over.length === 0, `description 单条 ≤ ${DESC_MAX_LEN} 字符（超限 ${over.length} 条${over.length ? ' → ' + over.map((e) => `${e.name}(${e.description.length})`).join(', ') : ''}）`)

  // 主词唯一性：description 首句引导词不得重复（两个 skill 说不出差别 = 该合并）
  const lead = (s) => s.split(/[：:，,（(。；;]/)[0].trim().slice(0, 14)
  const byLead = new Map()
  for (const e of entries) {
    const k = lead(e.description)
    if (!byLead.has(k)) byLead.set(k, [])
    byLead.get(k).push(e.name)
  }
  const dup = [...byLead.entries()].filter(([, v]) => v.length > 1)
  assert(dup.length === 0, `主词唯一性（重复 ${dup.length} 组${dup.length ? ' → ' + dup.map(([k, v]) => `「${k}」${v.join('/')}`).join('; ') : ''}）`)
}

// ─────────────────────────────────────────────────────────────
// 纪律 C · 静态质量门：Python 代码块语法 + import 可解析
// ─────────────────────────────────────────────────────────────
console.log('\n[代码块静态检查]')
{
  const files = []
  const walk = (dir, prefix) => {
    for (const name of readdirSync(join(dir, prefix ? prefix : ''))) {
      const rel = prefix ? `${prefix}/${name}` : name
      const full = join(dir, rel)
      if (statSync(full).isDirectory()) walk(dir, rel)
      else if (name.endsWith('.md')) files.push(rel)
    }
  }
  walk(skillsDir, '')
  for (const g of GUIDE_MANIFEST) files.push(`../docs/agent-guide/${g.file}`)

  const blocks = []
  for (const rel of files) {
    const text = readFileSync(join(skillsDir, rel), 'utf8')
    const re = /```python\n([\s\S]*?)```/g
    let m
    while ((m = re.exec(text)) !== null) blocks.push({ file: rel, code: m[1] })
  }

  const py = process.env.DSH_BIO_PYTHON || [
    join(homedir(), '.dsh', 'dsh-bio-genie', 'python-env', 'Scripts', 'python.exe'),
    join(homedir(), '.dsh', 'dsh-bio-genie', 'python-env', 'bin', 'python'),
  ].find(existsSync)

  if (blocks.length === 0) {
    console.log('  SKIP 未发现 python 代码块')
  } else if (!py) {
    warn(`发现 ${blocks.length} 个 python 代码块，但找不到自举环境（DSH_BIO_PYTHON 可指定）→ 跳过语法/import 检查`)
  } else {
    // 第二层/第三层依赖允许缺失（首次调用时按需补装），只有第一层依赖缺失才算 FAIL
    // 本插件自带、通过 sys.path 注入可导入的模块（不是 pip 包，find_spec 查不到）
    const LOCAL_MODULES = new Set(['figurelib'])
    const lazy = new Set()
    for (const pkgs of Object.values(EXTRA_DEPS)) for (const p of pkgs) lazy.add(p.replace(/[<>=!~].*$/, ''))
    for (const mod of Object.values(ADDON_MODULES)) for (const p of mod.packages) lazy.add(p)

    // stdin 只能有一个消费者：脚本走 stdin（python -I -），payload 走临时文件 argv
    const payloadFile = join(tmpdir(), `dsh-skills-blocks-${process.pid}.json`)
    writeFileSync(payloadFile, JSON.stringify({ blocks, lazy: [...lazy], local: [...LOCAL_MODULES] }), 'utf8')
    const probe = `
import ast, json, sys, importlib.util
data = json.loads(open(sys.argv[1], encoding='utf-8').read())
bad_syntax, missing, lazy_missing, checked = [], [], [], 0
for b in data['blocks']:
    try:
        tree = ast.parse(b['code'])
    except SyntaxError as e:
        bad_syntax.append({'file': b['file'], 'err': f"line {e.lineno}: {e.msg}"})
        continue
    mods = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for a in node.names: mods.add(a.name.split('.')[0])
        elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
            mods.add(node.module.split('.')[0])
    for m in sorted(mods):
        if m in set(data['local']):
            continue                      # 插件自带模块（sys.path 注入），非 pip 包
        checked += 1
        if importlib.util.find_spec(m) is None:
            if m in set(data['lazy']):
                lazy_missing.append({'file': b['file'], 'mod': m})
            else:
                missing.append({'file': b['file'], 'mod': m})
print(json.dumps({'syntax': bad_syntax, 'missing': missing, 'lazy': lazy_missing, 'checked': checked}))
`
    let out
    try {
      out = execFileSync(py, ['-I', '-', payloadFile], { input: probe, encoding: 'utf8', timeout: 120000 })
    } catch (e) {
      warn(`自举环境执行失败（${py}）→ 跳过代码块检查: ${String(e.message).slice(0, 120)}`)
      out = null
    }
    if (!out || !out.trim()) {
      warn('自举环境未返回结果 → 跳过代码块检查（stdout 为空）')
    } else {
      const r = JSON.parse(out.trim().split('\n').pop())
      console.log(`  ${blocks.length} 个代码块 / ${r.checked} 个 import 已解析`)
      assert(r.syntax.length === 0, `全部代码块 ast.parse 通过${r.syntax.length ? ' → ' + r.syntax.map((s) => `${s.file}(${s.err})`).join('; ') : ''}`)
      assert(r.missing.length === 0, `第一层依赖全部可解析${r.missing.length ? ' → ' + r.missing.map((s) => `${s.file}:${s.mod}`).join('; ') : ''}`)
      if (r.lazy.length) console.log(`  INFO 第二/三层按需依赖未装（首次调用自动补装，非失败）: ${[...new Set(r.lazy.map((s) => s.mod))].join(', ')}`)
      else console.log('  INFO 第一层依赖齐备，无按需缺失')
    }
  }
}

// 棘轮报告：存量待补清单（非失败）+ 已补全可移除项
if (acceptancePending.length) {
  warn(`「验收标准」节：存量待补 ${acceptancePending.length} 个 skill（棘轮基线内，不阻塞；补全后从 scripts/skill-standards-baseline.json 删除）`)
}
if (acceptanceFilled.length) {
  console.log(`  INFO 已补全「验收标准」节、可从基线移除: ${acceptanceFilled.join(', ')}`)
}

const line = (s) => String.fromCharCode(10) + s
if (failures === 0) console.log(line(`ALL PASS${warnings ? `（${warnings} warning）` : ''}`))
// 注意：不用 process.exit()——Node 在管道下会截断未刷新的 stdout（实测丢过整段输出）。
else { console.error(line(`${failures} FAILURES`)); process.exitCode = 1 }
