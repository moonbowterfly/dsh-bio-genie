// memory.js 单元测试：签名提取 / 错误签名 / 去重与上限 / 检索。
// 用法：node scripts/test-memory.mjs
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  codeSignature, errorSignature, rememberSuccess, rememberLesson,
  readPatterns, readLessons, searchMemory, memoryExists,
} from '../src/memory.js'

let failures = 0
function assert(cond, msg) {
  if (cond) console.log(`  PASS ${msg}`)
  else { failures++; console.error(`  FAIL ${msg}`) }
}

const base = mkdtempSync(join(tmpdir(), 'dshbio-mem-test-'))
console.log(`[memory] 测试目录 ${base}`)

// --- 意图签名 ---
const sig1 = codeSignature('from Bio import SeqIO\nrecords = SeqIO.parse("a.fa", "fasta")')
assert(sig1.includes('Bio') && sig1.includes('SeqIO.*'), `Bio 导入+调用入签名: ${sig1}`)
// 多模块导入 + 点号调用；裸调用（Seq("ACGT")）不入签名——修复常改裸调用名，入签名会破坏配对
const sig2 = codeSignature('from Bio.SeqUtils import GC\nfrom Bio import SeqIO\nx = GC("ACGT")\nrecs = SeqIO.parse("a.fa", "fasta")')
assert(sig2.includes('Bio.SeqUtils') && sig2.includes('SeqIO.*') && !sig2.includes('GC('), `多导入+点号调用入签名，裸调用不入: ${sig2}`)
// 修复常改函数名:同一意图不应因函数名差异而签名不同
const a = codeSignature('from Bio.SeqUtils import GC\nGC("ACGT")')
const b = codeSignature('from Bio.SeqUtils import gc_fraction\ngc_fraction(Seq("ACGT"))')
assert(a === b, `GC()/gc_fraction() 改名不影响意图签名: "${a}" == "${b}"`)

// --- 错误签名 ---
const stderr = 'Traceback (most recent call last):\n  File "<dsh-bio>", line 1\nNameError: name \'pritn\' is not defined. Did you mean: \'print\'?'
assert(errorSignature(stderr) === 'NameError: name \'pritn\' is not defined. Did you mean: \'print\'?', '提取 traceback 最后的异常行')
assert(errorSignature('') === 'unknown', '空 stderr → unknown')

// --- 成功模式去重 + 上限 ---
for (let i = 0; i < 60; i++) {
  rememberSuccess({ signature: 'sig' + (i % 55), template: 'code v' + i, tool: 'bio_python' }, base)
}
let pats = readPatterns(base)
assert(pats.length === 50, `成功模式上限 50（现有 ${pats.length}）`)
const sig0 = pats.filter((p) => p.signature === 'sig0')
assert(sig0.length === 1, '同签名去重为 1 条')
assert(sig0[0].template === 'code v55', '同签名保留最新模板')

// --- 错误经验去重 + 上限 ---
for (let i = 0; i < 55; i++) {
  rememberLesson({ error_signature: 'NameError: e' + (i % 52), fix_hint: 'fix v' + i, example: '' }, base)
}
let lessons = readLessons(base)
assert(lessons.length === 50, `经验上限 50（现有 ${lessons.length}）`)
assert(lessons.filter((l) => l.error_signature === 'NameError: e0').length === 1, '同错误签名去重')
assert(lessons.filter((l) => l.error_signature === 'NameError: e0')[0].fix_hint === 'fix v52', '同签名保留最新修法')

// --- 检索 ---
rememberLesson({ error_signature: 'ModuleNotFoundError: No module named biopython', fix_hint: 'run bio_env reinstall=true', example: '' }, base)
const hit = searchMemory('reinstall', base)
assert(hit.lessons.length >= 1 && hit.lessons[0].error_signature.includes('ModuleNotFoundError'), '关键词检索命中经验')
const miss = searchMemory('NoSuchWord_xyz', base)
assert(miss.patterns.length === 0 && miss.lessons.length === 0, '无命中返回空')
assert(memoryExists(base) === true, 'memoryExists 为真')

if (failures === 0) console.log('\nALL PASS')
else { console.error(`\n${failures} FAILURES`); process.exit(1) }
