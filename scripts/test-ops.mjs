// bio_ops.py 全 op 回归测试：离线确定性用例 + 网络真实验证。
// 用法：node scripts/test-ops.mjs          （全量，含网络）
//       SKIP_NETWORK=1 node scripts/test-ops.mjs   （只跑离线用例）
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

let failures = 0
function assert(cond, msg) {
  if (cond) console.log(`  PASS ${msg}`)
  else { failures++; console.error(`  FAIL ${msg}`) }
}

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 解析 python：优先插件 venv（~/.dsh/dsh-bio-genie/python-env），兜底系统 python。 */
function findPython() {
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const venv = join(home, 'dsh-bio-genie', 'python-env')
  const exe = process.platform === 'win32' ? join(venv, 'Scripts', 'python.exe') : join(venv, 'bin', 'python')
  return existsSync(exe) ? exe : 'python'
}

function callOp(op, args = {}) {
  const r = spawnSync(findPython(), ['-I', 'python/bio_ops.py'], {
    cwd: repoRoot,
    input: JSON.stringify({ op, args }),
    encoding: 'utf8',
    timeout: 180_000,
  })
  try {
    const line = (r.stdout ?? '').trim().split('\n').pop()
    return JSON.parse(line)
  } catch {
    return { ok: false, error: `stdout 非 JSON: ${String(r.stdout).slice(0, 200)}` }
  }
}

const SKIP_NET = process.env.SKIP_NETWORK === '1'

// ============ 离线确定性用例 ============
console.log('[ops] 离线用例')

// 序列类型自动判断 + IUPAC 模糊碱基（防 Bug2 回归）
const dna = callOp('seq_analyze', { sequence: 'ACGTRYKMBDHVN' })
assert(dna.ok && dna.result.seq_type === 'dna', `IUPAC 模糊碱基判为 DNA（seq_type=${dna.result?.seq_type}）`)
assert(dna.result.gc_percent !== undefined && dna.result.gc_percent >= 0, 'IUPAC 序列 GC 计算不崩溃')

const rna = callOp('seq_analyze', { sequence: 'ACGUACGU' })
assert(rna.ok && rna.result.seq_type === 'rna', '含 U 无 T 判为 RNA')

const prot = callOp('seq_analyze', { sequence: 'MKTAYIL' })
assert(prot.ok && prot.result.seq_type === 'protein' && typeof prot.result.molecular_weight === 'number', '非核酸字母判为蛋白 + 分子量')

const dna8 = callOp('seq_analyze', { sequence: 'ACGTTGCA' })
assert(dna8.ok && dna8.result.length === 8 && dna8.result.gc_percent === 50, 'DNA 长度/GC=50%')
assert(dna8.result.reverse_complement === 'TGCAACGT', '反向互补正确')

// X 未知碱基:2026-08-17 实战测试发现——含 X 的 DNA 曾被误判为 protein 且六框翻译
// 因 XXG 模糊密码子抛 TranslationError(边用边修:auto 判 DNA + X→N 再翻译 + protein 分子量降级)
const dnaX = callOp('seq_analyze', { sequence: 'ATGCXX' })
assert(dnaX.ok, `含 X 序列不崩溃(此前 TranslationError)`)
assert(dnaX.result.seq_type === 'dna', `含 X 的 DNA 判为 dna(实际=${dnaX.result?.seq_type})`)
assert(dnaX.result.gc_percent === 50, '含 X 序列 GC 计算正常(X 不计入)')
assert(dnaX.result.reverse_complement === 'XXGCAT', '含 X 序列反向互补正确')
assert(dnaX.result.translations?.['+1'] === 'MX', 'X 密码子按 N 翻译为 X 氨基酸')

const protX = callOp('seq_analyze', { sequence: 'MKTX', seq_type: 'protein' })
assert(protX.ok && protX.result.molecular_weight === null, '蛋白含 X 时分子量降级为 null 不崩溃')

const rnaX = callOp('seq_analyze', { sequence: 'AUGXXA' })
assert(rnaX.ok, `含 X 的 RNA 不崩溃(WB 第二轮 S2: RNA 分支缺 X→N)`)
assert(rnaX.result.seq_type === 'rna', `含 X 的 RNA 判为 rna(实际=${rnaX.result?.seq_type})`)
assert(rnaX.result.translations?.['+1'] === 'MX', 'RNA 含 X 翻译按 N 处理为 X 氨基酸')

const degenerate = callOp('seq_analyze', { sequence: 'ATGCNNSATGC' })
assert(degenerate.ok && degenerate.result.seq_type === 'dna', '简并引物(N/S)判为 DNA')

const aa20 = callOp('seq_analyze', { sequence: 'ACDEFGHIKLMNPQRSTVWY' })
assert(aa20.ok && aa20.result.seq_type === 'protein' && aa20.result.molecular_weight > 2000, '20 种标准氨基酸判为蛋白')

// gap 字符(比对序列):2026-08-17 WB 审查 N3 延伸处理——含 gap 的 DNA 比对序列
// 曾被误判 protein 且翻译遇 --A 崩;按设计修复:gap 入 IUPAC 字母表 + 翻译前 gap→N
const gapDna = callOp('seq_analyze', { sequence: 'ATGCGT--ACGT--' })
assert(gapDna.ok, '含 gap 的 DNA 不崩溃')
assert(gapDna.result.seq_type === 'dna', `含 gap 的 DNA 判为 dna(实际=${gapDna.result?.seq_type})`)
assert(gapDna.result.gc_percent === 50, '含 gap 的 DNA GC 计算正常')
assert(gapDna.result.translations?.['+1'] === 'MRXR', 'gap 密码子按 N 翻译为 X 氨基酸')

const gapRna = callOp('seq_analyze', { sequence: 'AUG--CUU' })
assert(gapRna.ok && gapRna.result.seq_type === 'rna', '含 gap 的 RNA 判为 rna 且不崩溃')

const gapProt = callOp('seq_analyze', { sequence: 'MKT-L' })
assert(gapProt.ok && gapProt.result.seq_type === 'protein', '蛋白含 gap 仍判 protein(不误判为 DNA)')

const tl = callOp('seq_translate', { sequence: 'ATGAAATAA' })
assert(tl.ok && tl.result.protein === 'MK*', '翻译（含终止）')
const tls = callOp('seq_translate', { sequence: 'ATGAAATAA', to_stop: true })
assert(tls.ok && tls.result.protein === 'MK', '翻译 to_stop=true')

const skew = callOp('seq_gc_skew', { sequence: 'ACGTTGCA', window: 4 })
assert(skew.ok && skew.result.gc_skew.length === 2, 'GC skew 窗口计算')

const orf = callOp('seq_find_orf', { sequence: 'AAATGAAACCCGGGTAATAG', min_len: 9 })
assert(orf.ok && orf.result.orf && orf.result.orf.length === 15, 'ORF 查找（ATG..TAA 共 15nt，min_len=9）')
const orfDefault = callOp('seq_find_orf', { sequence: 'AAATGAAACCCGGGTAATAG' })
assert(orfDefault.ok && orfDefault.result.orf === null, 'ORF 默认 min_len=30 过滤短 ORF')

const kmer = callOp('seq_kmer', { sequence: 'ACGTACGT', k: 2, top: 4 })
assert(kmer.ok && kmer.result.unique_kmers === 4 && kmer.result.top.AC === 2, 'k-mer 统计（AC×2，4 种 2-mer）')

// 注意：Bio.Restriction 的 search 返回 1-based 切割坐标（切点后第一个碱基的位置）
const restr = callOp('seq_restriction', { sequence: 'GAATTCGGATCC', enzymes: ['EcoRI', 'BamHI'] })
assert(restr.ok && restr.result.sites.EcoRI && restr.result.sites.EcoRI.cut_positions[0] === 2, 'EcoRI 位点 cut=2（1-based，G^AATTC）')
assert(restr.ok && restr.result.sites.BamHI && restr.result.sites.BamHI.cut_positions[0] === 8, 'BamHI 位点 cut=8（1-based，G^GATCC）')

// IO 往返
const tmp = mkdtempSync(join(tmpdir(), 'dshbio-ops-'))
const fa = join(tmp, 'roundtrip.fa')
const wr = callOp('seq_io_write', { path: fa, records: [{ id: 'r1', sequence: 'ACGTACGT', description: 'test' }] })
assert(wr.ok && wr.result.written === 1, 'io_write 写 1 条')
const rd = callOp('seq_io_read', { path: fa, limit: 10 })
assert(rd.ok && rd.result.count === 1 && rd.result.records[0].id === 'r1' && rd.result.records[0].length === 8, 'io_read 读回且字段正确')
rmSync(tmp, { recursive: true, force: true })

const env = callOp('env_status')
assert(env.ok && env.result.biopython, `env_status（biopython ${env.result.biopython}）`)

// ---- 出版级绘图（figurelib，2026-08-17 吸收 scipilot/K-Dense）----
// fig_qa：环境自检（Windows 自带 Microsoft YaHei → cjk_ready 应为 true）
const figQa = callOp('fig_qa', { lang: 'zh', journal: 'nature' })
assert(figQa.ok && figQa.result.matplotlib, 'fig_qa 返回 matplotlib 版本')
assert(Array.isArray(figQa.result.cjk_fonts), 'fig_qa 返回 CJK 字体列表')
assert(figQa.result.preset_test.ok === true, `fig_qa 期刊预设应用成功（${figQa.result.preset_test.error ?? '?'}）`)
assert(figQa.result.cjk_ready === true, `fig_qa 检测到 CJK 字体（${JSON.stringify(figQa.result.cjk_fonts)}）`)

// fig_profile：剖析 CSV + 分组 + 图型建议
const tmpFig = mkdtempSync(join(tmpdir(), 'dshbio-fig-'))
const figCsv = join(tmpFig, 'data.csv')
writeFileSync(figCsv, 'group,value\nA,1.2\nA,1.8\nA,1.5\nB,3.1\nB,3.6\nB,3.3\n')
const prof = callOp('fig_profile', { path: figCsv, group_cols: ['group'] })
assert(prof.ok && prof.result.n_rows === 6 && prof.result.columns.value.type === 'continuous', `fig_profile 剖析 6 行 CSV（value=${prof.result.columns?.value?.type}）`)
assert(prof.ok && prof.result.group_summary && prof.result.group_summary.n_groups === 2, 'fig_profile 分组结构 2 组')
assert(prof.ok && prof.result.group_summary.small_groups_flag === true, 'fig_profile 小样本警告（每组 n=3<10）')
assert(prof.ok && Array.isArray(prof.result.suggestions) && prof.result.suggestions.length > 0, 'fig_profile 给出图型建议')

const badProf = callOp('fig_profile', { path: join(tmpFig, 'nope.csv') })
assert(badProf.ok === false, 'fig_profile 文件不存在报错')

// fig_export：用 venv python 画真实 PNG/JPEG 审计（300dpi PASS / 72dpi FAIL / JPEG FAIL）
function makeFigure(outPath, dpi, fmt) {
  const code = `import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
fig, ax = plt.subplots(figsize=(3.5, 2.625))
ax.plot([0,1,2],[1,3,2])
fig.savefig(${JSON.stringify(outPath)}, dpi=${dpi}, format='${fmt}')
print('ok')`
  return spawnSync(findPython(), ['-I', '-c', code], { encoding: 'utf8', timeout: 120_000 })
}
const okPng = join(tmpFig, 'fig300.png')
assert(makeFigure(okPng, 300, 'png').status === 0, '画 300dpi PNG 成功')
const expOk = callOp('fig_export', { paths: [okPng], min_dpi: 300 })
assert(expOk.ok && expOk.result.results[0].verdict === 'PASS', `fig_export 300dpi PNG 审计 PASS（${JSON.stringify(expOk.result?.results?.[0]?.issues ?? expOk.error)}）`)

const lowPng = join(tmpFig, 'fig72.png')
assert(makeFigure(lowPng, 72, 'png').status === 0, '画 72dpi PNG 成功')
const expLow = callOp('fig_export', { paths: [lowPng], min_dpi: 300 })
assert(expLow.ok && expLow.result.results[0].verdict === 'FAIL' && /DPI/.test(JSON.stringify(expLow.result.results[0].issues)), 'fig_export 72dpi PNG 审计 FAIL（DPI 不足）')

const jpg = join(tmpFig, 'fig.jpg')
assert(makeFigure(jpg, 300, 'jpg').status === 0, '画 JPEG 成功')
const expJpg = callOp('fig_export', { paths: [jpg] })
assert(expJpg.ok && expJpg.result.results[0].verdict === 'FAIL' && /JPEG/.test(JSON.stringify(expJpg.result.results[0].issues)), 'fig_export JPEG 审计 FAIL（数据图禁用 JPEG）')

const expPreview = callOp('fig_export', { paths: [okPng], preview: true })
assert(expPreview.ok && expPreview.result.results[0].preview_png === okPng, 'fig_export PNG 预览返回原路径')

const expMissing = callOp('fig_export', { paths: [join(tmpFig, 'no.png')] })
assert(expMissing.ok && expMissing.result.results[0].verdict === 'FAIL', 'fig_export 文件不存在 → FAIL')

rmSync(tmpFig, { recursive: true, force: true })

// ---- 错误路径 ----
const badOp = callOp('no_such_op')
assert(badOp.ok === false && /unknown op/.test(badOp.error), '未知 op 返回友好错误')
const badEnrichr = callOp('enrichr', { genes: [] })
assert(badEnrichr.ok === false && /non-empty/.test(badEnrichr.error), 'enrichr 空列表报错')
const badPubmed = callOp('pubmed_abstract', { ids: [] })
assert(badPubmed.ok === false && /non-empty/.test(badPubmed.error), 'pubmed_abstract 空列表报错')
const badEnrichrLib = callOp('enrichr', { genes: ['TP53'], library: 'No_Such_Library_XYZ' })
assert(badEnrichrLib.ok && badEnrichrLib.result.results.length === 0, 'enrichr 无效库名优雅返回空结果')

// ============ 网络真实验证 ============
if (SKIP_NET) {
  console.log('[ops] SKIP_NETWORK=1，跳过网络用例')
} else {
  console.log('[ops] 网络用例（真实请求，代理环境）')

  /** 网络调用带一次重试（瞬时抖动容错）。 */
  const callNet = (op, args, retries = 1) => {
    let r = callOp(op, args)
    for (let i = 0; i < retries && !r.ok; i++) {
      console.log(`  [retry] ${op} 失败（${r.error}），2s 后重试`)
      const until = Date.now() + 2000
      while (Date.now() < until) { /* 空转等待，避免引入依赖 */ }
      r = callOp(op, args)
    }
    return r
  }

  const gene = callNet('entrez_search', { db: 'gene', term: 'TP53[Gene Name] AND human[Organism]', retmax: 3, email: 'shuaihao264@gmail.com' })
  assert(gene.ok && gene.result.summaries.length >= 1 && gene.result.summaries[0].name === 'TP53', 'gene 检索返回 TP53 元数据')
  assert(gene.ok && gene.result.summaries[0].id === '7157' && gene.result.summaries[0].map_location === '17p13.1', 'gene 元数据含 UID 与染色体位置')

  const nuc = callNet('entrez_search', { db: 'nucleotide', term: 'NM_007294', retmax: 1, email: 'shuaihao264@gmail.com' })
  assert(nuc.ok && nuc.result.summaries[0].accession === 'NM_007294', 'nucleotide 检索回归（accession 正确）')

  const enrich = callNet('enrichr', { genes: ['TP53', 'BRCA1', 'EGFR', 'MDM2'], library: 'KEGG_2021_Human', top: 3 })
  assert(enrich.ok && enrich.result.results.length === 3, 'enrichr KEGG 返回 3 条')
  assert(enrich.ok && enrich.result.results[0].adjusted_p_value < 1e-5 && Array.isArray(enrich.result.results[0].overlap_genes), 'enrichr 结果含校正 p 值与重叠基因')

  const pub = callNet('pubmed_search', { term: 'CRISPR gene editing', retmax: 3, email: 'shuaihao264@gmail.com' })
  assert(pub.ok && pub.result.results.length === 3 && pub.result.results[0].pmid, 'pubmed_search 返回 PMID')

  const abs = callNet('pubmed_abstract', { ids: ['42603971'], email: 'shuaihao264@gmail.com' })
  assert(abs.ok && abs.result.results[0].doi === '10.1016/j.omta.2026.201816', 'pubmed_abstract DOI 提取正确')
  assert(abs.ok && abs.result.results[0].abstract.length > 500, 'pubmed_abstract 摘要全文')

  const ref = callNet('ref_genome', { species: 'human' })
  assert(ref.ok && ref.result.assembly_name === 'GRCh38.p14', `ref_genome GRCh38.p14（失败信息: ${ref.error ?? '?'}）`)
  assert(ref.ok && ref.result.scaffold_count > 0 && ref.result.chromosomes.length >= 25, 'ref_genome 染色体列表完整')
}

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILURES`)
process.exit(failures === 0 ? 0 : 1)
