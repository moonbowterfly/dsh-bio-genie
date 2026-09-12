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
import { SKILL_MANIFEST, GUIDE_MANIFEST } from '../src/skills.js'

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

// ── 面板元信息版本：静态 client bundle 必须与 package 真值同步 ──
const packageVersion = JSON.parse(read('package.json')).version
const clientVersion = /version:\s*'([^']+)'/.exec(read('lib/client.js'))?.[1]
if (clientVersion === packageVersion) {
  console.log(`PASS  client.js 面板版本：${clientVersion} 与 package.json 一致`)
  pass += 1
} else {
  console.log(`FAIL  client.js 面板版本：${clientVersion ?? '未找到'} ≠ package.json ${packageVersion}`)
  fail += 1
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

// ── skill 计数覆盖（2026-09-11 扩展）──
// 背景：skill 计数的漂移面比工具数更广（README 双语 3 处 + 指南导航 + 架构文档 +
// package.json + index.js 头注释 + 手写 bundle），且「加一个 skill 只改一处」正是
// 本轮实测踩过的坑。这里把每个声明点都钉在代码真值上。
console.log('--- skill 计数 ---')
const catCount = (c) => SKILL_MANIFEST.filter((s) => s.category === c).length
const domainN = catCount('domain')
const researchN = catCount('research')
const protocolN = catCount('protocol')
const guidesN = GUIDE_MANIFEST.length

assertCount('README.md', /Skill 体系（(\d+) 个）/g, skillTotal, 'README skill 总数')
assertCount('README.md', /Skill 模块（(\d+) 个条目/g, skillTotal, 'README 面板条目数')
assertCount('README.md', /(\d+) 个 skill」/g, skillTotal, 'README 人设声明 skill 数')
assertCount('README.en.md', /Skill System \((\d+) total\)/g, skillTotal, 'README.en skill 总数')
assertCount('README.en.md', /Skill Modules \((\d+) entries/g, skillTotal, 'README.en 面板条目数')
assertCount('README.en.md', /you have \d+ tools \+ (\d+) skills/g, skillTotal, 'README.en 人设声明 skill 数')
assertCount('docs/agent-guide/README.md', /(\d+) 个 skill 导航/g, skillTotal, 'guide-README skill 数')
assertCount('docs/agent-guide/skills.md', /Skill 体系导航（(\d+) 个注册条目）/g, skillTotal, 'skills.md 标题条目数')
assertCount('docs/ARCHITECTURE.md', /共 (\d+) 个条目/g, skillTotal, 'ARCHITECTURE 条目数')
assertCount('src/index.js', /共 (\d+) 个注册条目/g, skillTotal, 'index.js 头注释条目数')
assertCount('lib/client.js', /(\d+) 个 skill、零依赖/g, skillTotal, 'client.js 面板文案 skill 数')
assertCount('package.json', /\+ (\d+) 个 skill（1 主 skill/g, skillTotal, 'package.json description skill 数')

// 组件计数（领域+研究）——外部评审 2026-09-12 指出：只断言总数会漏掉「21 应为 22」这类残留
const domainResearch = domainN + researchN
assertCount('README.md', /配合 (\d+) 个领域\/研究 skill 配方/g, domainResearch, 'README 领域/研究 skill 数')
assertCount('README.en.md', /backed by (\d+) domain\/research skill recipes/g, domainResearch, 'README.en 领域/研究 skill 数')
assertCount('lib/client.js', /note: '(\d+) 领域\/研究/g, domainResearch, 'client.js 面板领域/研究 skill 数')
assertCount('docs/ARCHITECTURE.md', /(\d+) 个领域\/研究 skill/g, domainResearch, 'ARCHITECTURE 领域/研究 skill 数')

const breakdown = 1 + domainN + researchN + protocolN + guidesN
if (breakdown === skillTotal) {
  console.log(`PASS  skill 分类分解：主 1 + 领域 ${domainN} + 研究 ${researchN} + 协议 ${protocolN} + 指南 ${guidesN} = ${skillTotal}`)
  pass += 1
} else {
  console.log(`FAIL  skill 分类分解：1+${domainN}+${researchN}+${protocolN}+${guidesN}=${breakdown} ≠ 文件真值 ${skillTotal}`)
  fail += 1
}
{
  const m = read('docs/agent-guide/skills.md').match(/主 1 \+ 领域 (\d+) \+ 研究 (\d+) \+ 协议 (\d+) \+ 指南 (\d+)/)
  const ok = m && +m[1] === domainN && +m[2] === researchN && +m[3] === protocolN && +m[4] === guidesN
  if (ok) { console.log(`PASS  skills.md 分类分解与 manifest 一致（${m[1]}/${m[2]}/${m[3]}/${m[4]}）`); pass += 1 }
  else { console.log(`FAIL  skills.md 分类分解${m ? ` 写的是 ${m[1]}/${m[2]}/${m[3]}/${m[4]}` : ' 未找到'}，manifest 真值 ${domainN}/${researchN}/${protocolN}/${guidesN}`); fail += 1 }
}

console.log(`\n${pass} passed, ${fail} failed, ${warned} warning(s), ${skipped} skipped`)
process.exit(fail === 0 ? 0 : 1)
