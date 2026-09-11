// 执行级 smoke 门：把 skill 里"可独立运行"的代码块真跑一遍。
//
// 为什么需要它（外部代码评审 2026-09-12 的 P1）：
//   test-skills.mjs 只做 ast.parse + import 可用性检查——它无法发现
//   数组形状不匹配、缺 plt 导入、v.INFO 标量被当列表索引、len(v.ALT) 语义错用这类
//   运行时错误。本轮 5 个 P1 里有 5 个都是"语法通过但一跑就炸"。
//
// 口径：每个 case 指定「哪个文件 + 含哪段特征的代码块」，附 prelude（准备数据/环境）
//       与 check（断言 + 打印 CASE_OK）。只有 CASE_OK 出现才算通过。
// 用法：node scripts/test-recipe-runtime.mjs
//       DSH_BIO_PYTHON=<python> 可指定解释器；DSH_SKILLS_STRICT=1 时缺解释器判 FAIL。
import { readFileSync, existsSync, writeFileSync, mkdtempSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const STRICT = /^(1|true|yes)$/i.test(process.env.DSH_SKILLS_STRICT || '')
const NL = String.fromCharCode(10)

// 代码块切分：按围栏切而不是正则 —— 跨进程/多引号层会吃掉反斜杠转义（本轮实测踩过）
const splitBlocks = (text) => text.split('```python').slice(1).map((s) => s.split('```')[0])

let failures = 0
const assert = (cond, msg) => {
  if (cond) console.log(`  PASS ${msg}`)
  else { failures++; console.error(`  FAIL ${msg}`) }
}

// ── 夹具：标准声明式 VCF（MAF 声明为 Number=1/Type=Float，与真实数据一致）──
const VCF_FIXTURE = [
  '##fileformat=VCFv4.2',
  '##INFO=<ID=MAF,Number=1,Type=Float,Description="Minor allele frequency">',
  '##INFO=<ID=ANN,Number=.,Type=String,Description="Functional annotation">',
  '#CHROM\tPOS\tID\tREF\tALT\tQUAL\tFILTER\tINFO',
  '1\t100\t.\tA\tG\t50\tPASS\tMAF=0.01;ANN=G|missense_variant|MODERATE',   // SNV，保留
  '1\t200\t.\tA\tAT\t60\tPASS\tMAF=0.001;ANN=G|frameshift_variant|HIGH',   // 插入，保留
  '1\t300\t.\tA\tG,T\t70\tPASS\tMAF=0.02;ANN=G|missense_variant|MODERATE', // 多等位 SNV，保留
  '1\t400\t.\tA\tG\t80\tPASS\tMAF=0.5;ANN=G|missense_variant|MODERATE',    // MAF 过高，丢弃
  '1\t500\t.\tA\tG\t10\tPASS\tMAF=0.01;ANN=G|missense_variant|MODERATE',   // QUAL 过低，丢弃
  '1\t600\t.\tA\tG\t60\tPASS\tANN=G|synonymous_variant|LOW',               // 缺 MAF（不该被丢）+ 同义，丢弃
  '',
].join(NL)

const fixtureDir = mkdtempSync(join(tmpdir(), 'dsh-recipe-'))
writeFileSync(join(fixtureDir, 'variants.vcf'), VCF_FIXTURE, 'utf8')

const PY_PRELUDE = [
  'import sys, os',
  "sys.path.insert(0, r'" + join(repoRoot, 'python').replace(/\\/g, '/') + "')",
  'import matplotlib',
  "matplotlib.use('Agg')",
  'import matplotlib.pyplot as plt',
  'import numpy as np, pandas as pd',
  `os.chdir(r'${fixtureDir.replace(/\\/g, '/')}')`,
].join(NL)

// ── 用例 ───────────────────────────────────────────────────────────────
const CASES = [
  {
    name: 'statistics · statsmodels 功效配方（ANOVA 总 N / 每组 n）',
    file: 'skills/protocols/statistics.md',
    contains: 'FTestAnovaPower',
    check: [
      "assert abs(n_anova_total - 178.397) < 0.1, n_anova_total",
      "assert n_anova_per_group == 45, n_anova_per_group",
      "assert abs(float(ind.solve_power(effect_size=0.5, alpha=0.05, power=0.8, ratio=1.0)) - 63.77) < 0.1",
      "assert abs(float(TTestPower().solve_power(effect_size=0.5, alpha=0.05, power=0.8, alternative='two-sided')) - 33.37) < 0.1",
      "assert float(np.ceil(26 / (1 - 0.20))) == 33",
      "print('CASE_OK')",
    ].join(NL),
  },
  {
    name: 'statistics · Tukey HSD 事后检验',
    file: 'skills/protocols/statistics.md',
    contains: 'pairwise_tukeyhsd',
    prelude: "df = pd.DataFrame({'group': ['a']*10 + ['b']*10 + ['c']*10, 'value': list(np.random.default_rng(4).normal(3, .5, 30))})",
    check: "print('CASE_OK')",
  },
  {
    name: 'statistics · multipletests（BH-FDR）',
    file: 'skills/protocols/statistics.md',
    contains: 'multipletests',
    prelude: 'pvals = [0.001,0.008,0.039,0.041,0.042,0.06,0.074,0.205,0.212,0.216]',
    check: "assert list(rej[:2]) == [True, True] and abs(float(q[0]) - 0.01) < 1e-6" + NL + "print('CASE_OK')",
  },
  {
    name: 'pub-figure · 剂量-反应误差棒（x/y/yerr 同长）',
    file: 'skills/protocols/pub-figure.md',
    contains: "groupby('dose')",
    prelude: "df = pd.DataFrame({'dose': [1,1,1,10,10,10,100,100,100], 'response': [3.0,3.1,2.9,4.0,4.2,3.8,6.0,5.8,6.2]})" + NL + 'fig, ax = plt.subplots()',
    check: "assert len(g) == 3" + NL + "print('CASE_OK')",
  },
  {
    name: 'pub-figure · 显著性桥（含负值数据不破轴）',
    file: 'skills/protocols/pub-figure.md',
    contains: 'p_to_stars',
    prelude: "df = pd.DataFrame({'value': [-3.0,-2.5,-2.8,-1.0,-1.2,-0.9,1.0,1.4,1.1]})" + NL + 'pairs = [(0,1,0.03),(1,2,0.0005)]' + NL + 'fig, ax = plt.subplots()' + NL + "ax.plot([-3,-1,1]); ax.set_ylim(-4, 2)",
    check: "ymin2, ymax2 = ax.get_ylim()" + NL + "assert ymin2 == -4 and ymax2 > 2, (ymin2, ymax2)" + NL + "print('CASE_OK')",
  },
  {
    name: 'pub-figure · 不等宽多面板（GridSpec + 共享轴）',
    file: 'skills/protocols/pub-figure.md',
    contains: 'add_gridspec',
    check: "assert len(fig.axes) >= 3" + NL + "print('CASE_OK')",
  },
  {
    name: 'bio-variant · VCF 读取 + 类型统计 + 过滤（标准 INFO 头）',
    file: 'skills/bio-variant-analysis.md',
    contains: 'vcfpy.Reader',
    append: "filtered = []",
    check: [
      // 类型统计覆盖**全部**记录（不过滤）：pos100 + pos300 多等位(2) + pos400 + pos500 + pos600 = 6 个 SNV
      "assert types['SNV'] == 6, types",
      "assert types['Insertion'] == 1, types",  // pos200 A>AT —— 按 len(v.ALT) 会误判成 SNV
      "assert sorted(f'{v.CHROM}:{v.POS}' for v in filtered) == ['1:100', '1:200', '1:300'], [f'{v.CHROM}:{v.POS}' for v in filtered]",
      "print('CASE_OK')",
    ].join(NL),
  },
  {
    name: 'bio-survival · 环境导入块（lifelines 路径 + plt）',
    file: 'skills/bio-survival-analysis.md',
    contains: 'from lifelines',
    check: "import lifelines" + NL + "from lifelines.statistics import logrank_test as _lr" + NL + "assert callable(_lr) and plt is not None" + NL + "print('CASE_OK')",
  },
  {
    name: 'bio-evidence-appraisal · I²/τ²/κ 配方',
    file: 'skills/bio-evidence-appraisal.md',
    contains: 'def i_squared',
    check: [
      "assert i_squared(40, 10) == 77.5",
      "assert abs(tau_squared_dl([10,10,10], [0,1,2]) - 0.9) < 1e-9",
      "assert abs(cohen_kappa(90,10,10,90) - 0.8) < 1e-9",
      "print('CASE_OK')",
    ].join(NL),
  },
]

// ── 运行 ───────────────────────────────────────────────────────────────
const py = process.env.DSH_BIO_PYTHON || [
  join(homedir(), '.dsh', 'dsh-bio-genie', 'python-env', 'Scripts', 'python.exe'),
  join(homedir(), '.dsh', 'dsh-bio-genie', 'python-env', 'bin', 'python'),
].find(existsSync)

console.log(`[recipes] ${CASES.length} 个可执行配方用例${STRICT ? '（严格模式）' : ''}`)

if (!py) {
  const msg = '找不到自举环境 → 无法执行配方（DSH_BIO_PYTHON 可指定）'
  if (STRICT) assert(false, msg); else console.warn(`  WARN ${msg}`)
} else {
  for (const c of CASES) {
    const text = readFileSync(join(repoRoot, c.file), 'utf8')
    const block = splitBlocks(text).find((b) => b.includes(c.contains))
    if (!block) { assert(false, `${c.name} → 未在 ${c.file} 找到含「${c.contains}」的代码块`); continue }
    // 有些配方跨两个块（如「读取+统计」与「过滤」），用 append 指定第二个块的定位特征
    let extra = ''
    if (c.append) {
      const b2 = splitBlocks(text).find((b) => b.includes(c.append))
      if (!b2) { assert(false, `${c.name} → 未找到含「${c.append}」的追加代码块`); continue }
      extra = b2
    }
    const code = [PY_PRELUDE, c.prelude || '', block, extra, c.check].filter(Boolean).join(NL + NL)
    let out = ''
    try {
      out = execFileSync(py, ['-I', '-'], {
        input: code, encoding: 'utf8', timeout: 180000,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      })
    } catch (err) {
      out = String(err.stdout || '') + String(err.stderr || '')
    }
    const ok = out.includes('CASE_OK')
    assert(ok, `${c.name}${ok ? '' : ' → ' + out.trim().split(NL).slice(-2).join(' | ').slice(0, 200)}`)
  }
}

if (failures === 0) console.log(`\nALL PASS${STRICT ? '（strict）' : ''}`)
else { console.error(`\n${failures} FAILURES`); process.exitCode = 1 }
