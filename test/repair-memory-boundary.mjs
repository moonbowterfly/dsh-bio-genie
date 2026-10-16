// repair-memory-boundary 单元测试：L2 边界（无 proof 拒绝 / legacy 不返回 / 有效 proof 可见 / 撤销与篡改失效）。
// 用法：node test/repair-memory-boundary.mjs
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { legacyLessonCount, promoteVerifiedLesson, readLessons, searchMemory } from '../src/memory.js'
import { readRecord, scanStore, writeRecord } from '../src/repair-store.js'
import { newUuid } from '../src/repair-contract.js'

let failures = 0
function assert(cond, msg) {
  if (cond) console.log(`  PASS ${msg}`)
  else { failures++; console.error(`  FAIL ${msg}`) }
}

const base = mkdtempSync(join(tmpdir(), 'dshbio-mb-'))
const PKG = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const env = { plugin: PKG.version, python: null }

const mkLesson = (over = {}) => ({
  lesson_id: newUuid(),
  error_signature: 'ModuleNotFoundError: No module named X',
  fix_hint: '改用当前 API 名称',
  env: { plugin: PKG.version, python: null },
  status: 'VERIFIED',
  created_at: new Date().toISOString(),
  ...over,
})
const mkProof = (lessonId, over = {}) => ({
  schema: 'g-repair-lesson-proof/v1',
  proof_id: newUuid(),
  lesson_id: lessonId,
  red_case_id: 'red-1',
  green_case_id: 'green-1',
  base_fingerprint: 'a'.repeat(64),
  verifier: { id: 'verifier-local-1', version: 'v1' },
  result_sha256: 'b'.repeat(64),
  revoked: false,
  created_at: new Date().toISOString(),
  ...over,
})

// ① 无 proof / 残缺 proof → 拒绝，零入库
console.log('[memory-boundary] 无 proof 拒绝')
{
  const l = mkLesson()
  const r1 = promoteVerifiedLesson(l, undefined, base)
  assert(!r1.ok && r1.code === 'PROOF_SCHEMA', `无 proof 拒绝（${r1.code}）`)
  const r2 = promoteVerifiedLesson(l, { schema: 'g-repair-lesson-proof/v1', revoked: false }, base)
  assert(!r2.ok && r2.code === 'PROOF_SCHEMA', '残缺 proof 拒绝')
  assert(readLessons(base, { env }).length === 0, '无任何记录入库')
}

// ② 有效 proof → 可见
console.log('[memory-boundary] 有效 proof 可见')
{
  const l = mkLesson()
  const r = promoteVerifiedLesson(l, mkProof(l.lesson_id), base)
  assert(r.ok, '有效 proof 入库')
  const list = readLessons(base, { env })
  assert(list.length === 1 && list[0].lesson_id === l.lesson_id, '可见且 id 正确')
  assert(list[0].fix_hint === '改用当前 API 名称', 'fix_hint 为模板文本')
}

// ③ 环境不符 → 不返回
console.log('[memory-boundary] 环境指纹')
{
  assert(readLessons(base, { env: { plugin: '0.0.0-other', python: null } }).length === 0, '版本不符不返回')
  assert(readLessons(base, { env: { plugin: PKG.version, python: '9.9' } }).length === 1, 'python 未标注（null）不受 python 覆盖影响')
}

// ④ 撤销 → 失效
console.log('[memory-boundary] 撤销')
{
  const l = mkLesson()
  promoteVerifiedLesson(l, mkProof(l.lesson_id), base)
  assert(readLessons(base, { env }).length === 2, '撤销前可见')
  const { record } = readRecord('lessons', l.lesson_id, { base })
  writeRecord('lessons', l.lesson_id, { type: 'lesson', lesson: record.lesson, proof: { ...record.proof, revoked: true } }, { base })
  assert(readLessons(base, { env }).every((x) => x.lesson_id !== l.lesson_id), '撤销后不返回')
}

// ⑤ 篡改 → 失效 + 台账报告
console.log('[memory-boundary] 篡改')
{
  const l = mkLesson()
  promoteVerifiedLesson(l, mkProof(l.lesson_id), base)
  const file = join(base, 'repair', 'lessons', `${l.lesson_id}.json`)
  const text = readFileSync(file, 'utf8')
  const tampered = text.replace('"fix_hint": "改用当前 API 名称"', '"fix_hint": "被篡改的修法"')
  assert(tampered !== text, '篡改文本确实生效')
  writeFileSync(file, tampered)
  assert(readLessons(base, { env }).every((x) => x.lesson_id !== l.lesson_id), '篡改记录不返回')
  const scan = scanStore({ base })
  assert(!scan.ok && scan.issues.some((i) => i.kind === 'lessons' && i.code === 'INTEGRITY_FAILED'), 'ledger scan 报告篡改')
}

// ⑥ legacy → 只计不返
console.log('[memory-boundary] legacy')
{
  mkdirSync(join(base, 'memory'), { recursive: true })
  writeFileSync(join(base, 'memory', 'error_lessons.json'), JSON.stringify([
    { error_signature: 'NameError: legacy', fix_hint: 'legacy 修法 xyz', ts: '2020-01-01' },
  ]))
  assert(legacyLessonCount(base) === 1, 'legacy 计数 = 1')
  assert(readLessons(base, { env }).every((x) => !String(x.fix_hint).includes('legacy 修法')), 'legacy 不被 readLessons 返回')
  assert(searchMemory('legacy 修法', base).lessons.length === 0, 'legacy 不被 searchMemory 返回')
}

if (failures === 0) console.log('\nALL PASS')
else { console.error(`\n${failures} FAILURES`); process.exit(1) }
