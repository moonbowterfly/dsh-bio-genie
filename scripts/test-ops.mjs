// bio_ops.py 全 op 回归测试：离线确定性用例 + 网络真实验证。
// 用法：node scripts/test-ops.mjs          （全量，含网络）
//       SKIP_NETWORK=1 node scripts/test-ops.mjs   （只跑离线用例）
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
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
