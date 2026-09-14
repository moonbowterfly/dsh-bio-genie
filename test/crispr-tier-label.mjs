// test/crispr-tier-label.mjs — bio_crispr_guide 的「语义标签」回归（GPT 裁决 #4）。
//
// 背景：bio_crispr_guide 输出 0-100 启发式综合分，与 graft 的「禁综合分」哲学冲突。
// 裁决是**保留行为、只改标签**（对既有用户零破坏）：返回值必须带
//   scope: 'lightweight_heuristic' / scope_note / advanced_designer_available
// 且原有字段（candidates/efficiency_score）一个都不能少。
//
// 为什么走工具层而不是 op 直测：标签是 tools.js 的 decorate 钩子注入的，
// op 直测（直接跑 python/bio_ops.py）**看不见**它。
//
// 用法：node test/crispr-tier-label.mjs
import './register-dsh-tools.mjs'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failed = 0
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok   ${name}`)
  else { failed += 1; console.error(`  FAIL ${name} ${detail}`) }
}

const toolsMod = await import('../src/tools.js')

const registered = []
const ctx = {
  tools: { register: (def) => { registered.push(def); return () => {} } },
  effect: () => () => {},
}
toolsMod.registerTools(ctx, { defaultTimeoutMs: 60_000, warmUp: false, enableLog: false, enableMemory: false })

const tool = registered.find((t) => t.name === 'bio_crispr_guide')
check('bio_crispr_guide is registered', Boolean(tool))

if (tool) {
  const seq = 'ATGTTGAGGCGAGCGCAAGGTTATACGCTCCGATCTTAATGTGGAGTAAATAAGTGGGCGCAGCGTTGGTTGTCCATGAGAAATTATCCTGACAG'
  const workdir = mkdtempSync(join(tmpdir(), 'genie-crispr-label-'))
  let value = null
  let err = null
  try {
    value = await tool.execute({ sequence: seq, top_n: 3 }, {
      signal: new AbortController().signal,
      cwd: workdir,
    })
  } catch (e) {
    err = e
  }
  rmSync(workdir, { recursive: true, force: true })

  check('execute returns a value', value !== null, err ? `threw: ${err.message}` : '')
  if (value) {
    check('carries scope=lightweight_heuristic', value.scope === 'lightweight_heuristic', String(value.scope))
    check('carries a scope_note that forbids report-grade citation',
      typeof value.scope_note === 'string' && value.scope_note.includes('不得作为报告'),
      String(value.scope_note).slice(0, 60))
    check('carries advanced_designer_available as a boolean',
      typeof value.advanced_designer_available === 'boolean', String(value.advanced_designer_available))
    check('advanced_designer_available matches the real dsh-bio-graft install',
      value.advanced_designer_available === true,
      'expected true on this machine (graft 0.1.1 installed in the profile)')
    check('legacy fields survive (behaviour preserved)',
      Array.isArray(value.recommendations) && typeof value.total_candidates === 'number' &&
      value.filter_criteria !== undefined,
      JSON.stringify(Object.keys(value)).slice(0, 240))
    check('_provenance is stamped', typeof value._provenance?.tool === 'string')
  }
}

if (failed > 0) {
  console.error(`\ncrispr-tier-label: ${failed} failed`)
  process.exitCode = 1
} else {
  console.log('\ncrispr-tier-label: all passed')
}
