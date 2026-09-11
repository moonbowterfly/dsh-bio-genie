/**
 * 文档-代码计数一致性检查（防「改一处漏三处」）。
 *
 * 背景：工具/skill 计数散落在 README、package.json、lib/client.js、preset、
 * ARCHITECTURE 等多处；2026-09-11 实测出现过「加了工具只改主表格，标题与
 * 三处引用仍写旧值」的情况。本检查从**代码实证**出发，断言各处文档声称一致。
 *
 * 真值来源（不硬编码）：
 *   语义化工具 = src/tools.js 中 bioTool(config, { 的出现次数
 *   全部工具   = src/tools.js 中唯一 name: 'bio_xxx' 的个数
 *   skill 数   = skills/*.md（递归）+ docs/agent-guide/*.md + 1（主 skill）
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()

function read(p) {
  return existsSync(join(ROOT, p)) ? readFileSync(join(ROOT, p), 'utf8') : ''
}

function countFiles(dir) {
  if (!existsSync(join(ROOT, dir))) return 0
  let n = 0
  for (const e of readdirSync(join(ROOT, dir))) {
    const full = join(ROOT, dir, e)
    if (statSync(full).isDirectory()) n += countFiles(join(dir, e))
    else if (e.endsWith('.md')) n += 1
  }
  return n
}

const toolsSrc = read('src/tools.js')
const semanticTools = (toolsSrc.match(/bioTool\(config, \{/g) || []).length
const allToolNames = new Set([...toolsSrc.matchAll(/name: '(bio_[a-z0-9_]+)'/g)].map((m) => m[1]))
const allTools = allToolNames.size
const skillFiles = countFiles('skills')
const guideFiles = countFiles('docs/agent-guide')
const skillTotal = skillFiles + guideFiles + 1 // +1 = 主 skill（GENIE_SKILL_CONTENT）

console.log('代码实证真值：')
console.log(`  语义化工具 = ${semanticTools}`)
console.log(`  全部工具   = ${allTools}`)
console.log(`  skill 总数 = ${skillTotal}（skills/ ${skillFiles} + agent-guide ${guideFiles} + 主 skill 1）`)
console.log()

let pass = 0
let fail = 0
let warned = 0
let skipped = 0

/** 断言：某文件里出现的 `N 个<单位>` 必须全部等于真值。 */
function assertCount(file, re, truth, label) {
  const txt = read(file)
  if (!txt) {
    console.log(`SKIP  ${label}（文件不存在: ${file}）`)
    skipped += 1
    return
  }
  const found = [...txt.matchAll(re)].map((m) => Number(m[1]))
  const uniq = [...new Set(found)]
  if (uniq.length === 0) {
    // 「没找到」不等于「一致」——显式报 WARN，避免检查静默失效
    console.log(`WARN  ${label}：${file} 未出现该计数表述（本项检查未覆盖，非通过）`)
    warned += 1
    return
  }
  const bad = uniq.filter((n) => n !== truth)
  if (bad.length === 0) {
    console.log(`PASS  ${label}：${file} 中出现 [${uniq.join(', ')}]，与真值 ${truth} 一致`)
    pass += 1
  } else {
    console.log(`FAIL  ${label}：${file} 中出现 [${uniq.join(', ')}]，其中 ${bad.join(', ')} ≠ 真值 ${truth}`)
    fail += 1
  }
}

assertCount('package.json', /(\d+)\s*个高频语义化工具/g, semanticTools, 'package.json 语义化工具数')
assertCount('README.md', /(\d+)\s*个工具/g, allTools, 'README 工具总数')
assertCount('README.md', /Skill 体系（(\d+) 个）/g, skillTotal, 'README skill 总数')
assertCount('lib/client.js', /(\d+)\s*个语义化工具/g, semanticTools, 'client.js 语义化工具数')
assertCount('src/index.js', /(\d+)\s*个语义化工具/g, semanticTools, 'index.js 语义化工具数')
assertCount('preset/bio-genie/preset.yml', /(\d+)\s*个工具/g, allTools, 'preset.yml 工具总数')
assertCount('preset/bio-genie/agent.cordis.yml', /(\d+)\s*个工具/g, allTools, 'preset 人格 工具总数')

// ── 工具清单完整性：人格/tools.md 提到的工具集合应覆盖代码定义的全部工具 ──
// 注意人格里会用 `bio_seq_io_read/write` 这类斜杠简写表示两个工具，必须先展开，
// 否则会产生大量误报（首版就误报了 5 个）。
function mentionedTools(text) {
  const out = new Set()
  for (const m of text.matchAll(/\b(bio_[a-z0-9_]+)\b/g)) out.add(m[1])
  for (const m of text.matchAll(/\b(bio_[a-z0-9_]+?)\/([a-z0-9_]+)\b/g)) {
    const parts = m[1].split('_')
    parts[parts.length - 1] = m[2]
    out.add(parts.join('_'))
  }
  return out
}

for (const file of ['preset/bio-genie/agent.cordis.yml', 'docs/agent-guide/tools.md']) {
  const body = read(file)
  if (!body) { console.log(`SKIP  工具清单完整性（${file} 不存在）`); continue }
  const mentioned = mentionedTools(body)
  const missing = [...allToolNames].filter((t) => !mentioned.has(t)).sort()
  if (missing.length === 0) {
    console.log(`PASS  工具清单完整性：${file} 覆盖全部 ${allToolNames.size} 个工具`)
    pass += 1
  } else {
    console.log(`FAIL  工具清单完整性：${file} 未提及 ${missing.length} 个工具 → ${missing.join(', ')}`)
    fail += 1
  }
}

console.log(`\n${pass} passed, ${fail} failed, ${warned} warning(s), ${skipped} skipped`)
process.exit(fail === 0 ? 0 : 1)
