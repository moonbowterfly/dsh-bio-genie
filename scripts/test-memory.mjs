// memory.js 单元测试：签名提取 / 成功模式 / L2 收紧后语义（lessons 只读已验证）。
// 用法：node scripts/test-memory.mjs
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as mem from '../src/memory.js'

let failures = 0
function assert(cond, msg) {
  if (cond) console.log(`  PASS ${msg}`)
  else { failures++; console.error(`  FAIL ${msg}`) }
}

const base = mkdtempSync(join(tmpdir(), 'dshbio-mem-test-'))
console.log(`[memory] 测试目录 ${base}`)

const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const env = { plugin: PKG.version, python: null }

// --- L2 收紧：写入口变化 ---
console.log('[memory] L2 收紧')
assert(typeof mem.rememberLesson === 'undefined', 'rememberLesson 已移除（未验证经验不得直写）')
assert(typeof mem.promoteVerifiedLesson === 'function', 'promoteVerifiedLesson 存在（唯一写入口）')

// --- 意图签名 ---
const sig1 = mem.codeSignature('from Bio import SeqIO\nrecords = SeqIO.parse("a.fa", "fasta")')
assert(sig1.includes('Bio') && sig1.includes('SeqIO.*'), `Bio 导入+调用入签名: ${sig1}`)
const sig2 = mem.codeSignature('from Bio.SeqUtils import GC\nfrom Bio import SeqIO\nx = GC("ACGT")\nrecs = SeqIO.parse("a.fa", "fasta")')
assert(sig2.includes('Bio.SeqUtils') && sig2.includes('SeqIO.*') && !sig2.includes('GC('), `多导入+点号调用入签名，裸调用不入: ${sig2}`)
const a = mem.codeSignature('from Bio.SeqUtils import GC\nGC("ACGT")')
const b = mem.codeSignature('from Bio.SeqUtils import gc_fraction\ngc_fraction(Seq("ACGT"))')
assert(a === b, `GC()/gc_fraction() 改名不影响意图签名: "${a}" == "${b}"`)

// --- 错误签名 ---
const stderr = 'Traceback (most recent call last):\n  File "<dsh-bio>", line 1\nNameError: name \'pritn\' is not defined. Did you mean: \'print\'?'
assert(mem.errorSignature(stderr) === 'NameError: name \'pritn\' is not defined. Did you mean: \'print\'?', '提取 traceback 最后的异常行')
assert(mem.errorSignature('') === 'unknown', '空 stderr → unknown')

// --- 成功模式去重 + 上限 ---
for (let i = 0; i < 60; i++) {
  mem.rememberSuccess({ signature: 'sig' + (i % 55), template: 'code v' + i, tool: 'bio_python' }, base)
}
const pats = mem.readPatterns(base)
assert(pats.length === 50, `成功模式上限 50（现有 ${pats.length}）`)
const sig0 = pats.filter((p) => p.signature === 'sig0')
assert(sig0.length === 1, '同签名去重为 1 条')
assert(sig0[0].template === 'code v55', '同签名保留最新模板')

// --- 已验证经验（promote → read） ---
const mkLesson = () => ({
  lesson_id: crypto.randomUUID(),
  error_signature: 'ModuleNotFoundError: No module named X',
  fix_hint: '改用当前 API 名称',
  env: { plugin: PKG.version, python: null },
  status: 'VERIFIED',
  created_at: new Date().toISOString(),
})
const mkProof = (lessonId) => ({
  schema: 'g-repair-lesson-proof/v1',
  proof_id: crypto.randomUUID(),
  lesson_id: lessonId,
  red_case_id: 'red-1',
  green_case_id: 'green-1',
  base_fingerprint: 'a'.repeat(64),
  verifier: { id: 'verifier-local-1', version: 'v1' },
  result_sha256: 'b'.repeat(64),
  revoked: false,
  created_at: new Date().toISOString(),
})
const lesson1 = mkLesson()
const r = mem.promoteVerifiedLesson(lesson1, mkProof(lesson1.lesson_id), base)
assert(r.ok, `promoteVerifiedLesson 成功（${JSON.stringify(r)}）`)
const list1 = mem.readLessons(base, { env })
assert(list1.length === 1 && list1[0].lesson_id === lesson1.lesson_id, 'readLessons 返回已验证经验')
assert(list1[0].fix_hint === '改用当前 API 名称', 'fix_hint 回读')
const listMismatch = mem.readLessons(base, { env: { plugin: '0.0.0-other', python: null } })
assert(listMismatch.length === 0, '环境（版本）不符不返回')
const rNoProof = mem.promoteVerifiedLesson(mkLesson(), { bogus: true }, base)
assert(!rNoProof.ok && rNoProof.code === 'PROOF_SCHEMA', `无 proof 拒绝（${rNoProof.code}）`)
const l2 = mkLesson()
const p2 = mkProof(crypto.randomUUID())
const rMis = mem.promoteVerifiedLesson(l2, p2, base)
assert(!rMis.ok && rMis.code === 'PROOF_LESSON_MISMATCH', `lesson_id 不一致拒绝（${rMis.code}）`)
const l3 = mkLesson()
const p3 = mkProof(l3.lesson_id); p3.revoked = true
const rRev = mem.promoteVerifiedLesson(l3, p3, base)
assert(!rRev.ok && rRev.code === 'PROOF_REVOKED', `撤销 proof 拒绝（${rRev.code}）`)

// --- legacy 只计不返 ---
mkdirSync(join(base, 'memory'), { recursive: true })
writeFileSync(join(base, 'memory', 'error_lessons.json'), JSON.stringify([
  { error_signature: 'NameError: legacy', fix_hint: 'legacy 修法 xyz', ts: '2020-01-01' },
]))
assert(mem.legacyLessonCount(base) === 1, 'legacy 计数 = 1')
assert(mem.readLessons(base, { env }).every((l) => !String(l.fix_hint).includes('legacy 修法')), 'legacy 不被 readLessons 返回')
assert(mem.searchMemory('legacy 修法', base).lessons.length === 0, 'legacy 不被 searchMemory 返回')

// --- 检索 ---
const hit = mem.searchMemory('改用当前 API', base)
assert(hit.lessons.length >= 1 && hit.lessons[0].error_signature.includes('ModuleNotFoundError'), '关键词检索命中已验证经验')
const miss = mem.searchMemory('NoSuchWord_xyz', base)
assert(miss.patterns.length === 0 && miss.lessons.length === 0, '无命中返回空')
assert(mem.memoryExists(base) === true, 'memoryExists 为真')

if (failures === 0) console.log('\nALL PASS')
else { console.error(`\n${failures} FAILURES`); process.exit(1) }
