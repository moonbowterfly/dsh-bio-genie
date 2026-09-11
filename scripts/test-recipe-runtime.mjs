// 执行级 smoke 门：把 skill 里"可独立运行"的代码块真跑一遍。
//
// 为什么需要它（外部代码评审 2026-09-12 的 P1）：
//   test-skills.mjs 只做 ast.parse + import 可用性检查——发现不了数组形状不匹配、
//   缺 plt 导入、v.INFO 标量被当列表索引、len(v.ALT) 语义错用这类运行时错误。
//   本轮 5 个 P1 全部属于"语法通过但一跑就炸"。
//
// 关键设计约束（外部评审第二轮实测踩出来的）：
//   **prelude 必须按 case 最小化**。给所有 case 统一预置 matplotlib.pyplot 会遮蔽
//   "被抽取代码块自己漏了导入"这类缺陷——survival case 曾因此假绿。
//
// 用法：node scripts/test-recipe-runtime.mjs
//   DSH_BIO_PYTHON=<python>      指定解释器
//   缺解释器默认判 FAIL；确实没有自举环境时可显式放行：DSH_SKILLS_ALLOW_SKIP=1
import { readFileSync, existsSync, writeFileSync, mkdtempSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { homedir, tmpdir } from 'node:os'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')
const NL = String.fromCharCode(10)
const TAB = String.fromCharCode(9)
const STRICT = !/^(1|true|yes)$/i.test(process.env.DSH_SKILLS_ALLOW_SKIP || '')

let failures = 0
const assert = (cond, msg) => {
  if (cond) console.log(`  PASS ${msg}`)
  else { failures++; console.error(`  FAIL ${msg}`) }
}

// 代码块切分：按围栏切而不是正则 —— 跨进程/多引号层会吃掉反斜杠转义（本轮实测踩过）
// 读取时顺手归一化 EOL（autocrlf 检出会带 CRLF，别让它影响断言）
const CR = String.fromCharCode(13)
const readNorm = (p) => readFileSync(p, 'utf8').split(CR + NL).join(NL)
const splitBlocks = (text) => text.split('```python').slice(1).map((s) => s.split('```')[0])

// ── 夹具：两种真实 MAF 声明形态 ─────────────────────────────────────────
const vcf = (infoLines, rows) => [
  '##fileformat=VCFv4.2', ...infoLines,
  ['#CHROM', 'POS', 'ID', 'REF', 'ALT', 'QUAL', 'FILTER', 'INFO'].join(TAB),
  ...rows, '',
].join(NL)

// 夹具 1：Number=1（标量 MAF）——最常见形态
const fixtureDir = mkdtempSync(join(tmpdir(), 'dsh-recipe-'))
writeFileSync(join(fixtureDir, 'variants.vcf'), vcf(
  ['##INFO=<ID=MAF,Number=1,Type=Float,Description="Minor allele frequency">',
   '##INFO=<ID=ANN,Number=.,Type=String,Description="Functional annotation">'],
  [
    ['1', '100', '.', 'A', 'G', '50', 'PASS', 'MAF=0.01;ANN=G|missense_variant|MODERATE'].join(TAB),   // SNV 保留
    ['1', '200', '.', 'A', 'AT', '60', 'PASS', 'MAF=0.001;ANN=G|frameshift_variant|HIGH'].join(TAB),  // 插入保留
    ['1', '300', '.', 'A', 'G,T', '70', 'PASS', 'MAF=0.02;ANN=G|missense_variant|MODERATE'].join(TAB), // 多等位保留
    ['1', '400', '.', 'A', 'G', '80', 'PASS', 'MAF=0.5;ANN=G|missense_variant|MODERATE'].join(TAB),   // MAF 过高丢弃
    ['1', '500', '.', 'A', 'G', '10', 'PASS', 'MAF=0.01;ANN=G|missense_variant|MODERATE'].join(TAB),  // QUAL 过低丢弃
    ['1', '600', '.', 'A', 'G', '60', 'PASS', 'ANN=G|synonymous_variant|LOW'].join(TAB),              // 缺 MAF + 同义 → 丢弃
  ]), 'utf8')

// 夹具 2：Number=A（列表 MAF）——只破坏列表分支时必须有门报红
const fixtureDirA = mkdtempSync(join(tmpdir(), 'dsh-recipe-A-'))
writeFileSync(join(fixtureDirA, 'variants.vcf'), vcf(
  ['##INFO=<ID=MAF,Number=A,Type=Float,Description="Minor allele frequency per ALT">'],
  [
    ['1', '100', '.', 'A', 'G,T', '50', 'PASS', 'MAF=0.01,0.9'].join(TAB),  // 首元素 0.01 → 保留
    ['1', '200', '.', 'A', 'C,G', '60', 'PASS', 'MAF=0.9,0.2'].join(TAB),   // 首元素 0.9 → 丢弃
  ]), 'utf8')

// ── prelude：按 case 最小化组装 ────────────────────────────────────────
const BASE_PRELUDE = [
  'import sys, os',
  "sys.path.insert(0, r'" + join(repoRoot, 'python').replace(/\\/g, '/') + "')",
  'import numpy as np, pandas as pd',
]
const PLT_PRELUDE = ['import matplotlib', "matplotlib.use('Agg')", 'import matplotlib.pyplot as plt']

/** 组装某 case 的前导：基础 + （默认）绘图 + case 自定义 + 切换夹具目录。 */
function preludeFor(c) {
  const dir = (c.cwd || fixtureDir).replace(/\\/g, '/')
  return [...BASE_PRELUDE, ...(c.plt === false ? [] : PLT_PRELUDE),
          c.prelude || '', `os.chdir(r'${dir}')`].filter(Boolean).join(NL)
}

// ── 用例 ───────────────────────────────────────────────────────────────
const CASES = [
  {
    name: 'statistics · statsmodels 功效配方（ANOVA 总 N / 每组 n）',
    file: 'skills/protocols/statistics.md',
    contains: 'FTestAnovaPower',
    plt: false,
    check: [
      'assert abs(n_anova_total - 178.397) < 0.1, n_anova_total',
      'assert n_anova_per_group == 45, n_anova_per_group',
      'assert abs(float(ind.solve_power(effect_size=0.5, alpha=0.05, power=0.8, ratio=1.0)) - 63.77) < 0.1',
      "assert abs(float(TTestPower().solve_power(effect_size=0.5, alpha=0.05, power=0.8, alternative='two-sided')) - 33.37) < 0.1",
      'assert float(np.ceil(26 / (1 - 0.20))) == 33',
      "print('CASE_OK')",
    ].join(NL),
  },
  {
    name: 'statistics · Tukey HSD 事后检验',
    file: 'skills/protocols/statistics.md',
    contains: 'pairwise_tukeyhsd',
    plt: false,
    prelude: "df = pd.DataFrame({'group': ['a']*10 + ['b']*10 + ['c']*10, 'value': list(np.random.default_rng(4).normal(3, .5, 30))})",
    check: "print('CASE_OK')",
  },
  {
    name: 'statistics · multipletests（BH-FDR）',
    file: 'skills/protocols/statistics.md',
    contains: 'multipletests',
    plt: false,
    prelude: 'pvals = [0.001,0.008,0.039,0.041,0.042,0.06,0.074,0.205,0.212,0.216]',
    check: 'assert list(rej[:2]) == [True, True] and abs(float(q[0]) - 0.01) < 1e-6' + NL + "print('CASE_OK')",
  },
  {
    name: 'pub-figure · 剂量-反应误差棒（x/y/yerr 同长）',
    file: 'skills/protocols/pub-figure.md',
    contains: "groupby('dose')",
    prelude: "df = pd.DataFrame({'dose': [1,1,1,10,10,10,100,100,100], 'response': [3.0,3.1,2.9,4.0,4.2,3.8,6.0,5.8,6.2]})" + NL + 'fig, ax = plt.subplots()',
    check: 'assert len(g) == 3' + NL + "print('CASE_OK')",
  },
  {
    name: 'pub-figure · 显著性桥（含负值数据不破轴）',
    file: 'skills/protocols/pub-figure.md',
    contains: 'p_to_stars',
    prelude: "df = pd.DataFrame({'value': [-3.0,-2.5,-2.8,-1.0,-1.2,-0.9,1.0,1.4,1.1]})" + NL
      + 'pairs = [(0,1,0.03),(1,2,0.0005)]' + NL + 'fig, ax = plt.subplots()' + NL
      + 'ax.plot([-3,-1,1]); ax.set_ylim(-4, 2)',
    check: 'ymin2, ymax2 = ax.get_ylim()' + NL + 'assert ymin2 == -4 and ymax2 > 2, (ymin2, ymax2)' + NL + "print('CASE_OK')",
  },
  {
    name: 'pub-figure · 不等宽多面板（GridSpec + 共享轴）',
    file: 'skills/protocols/pub-figure.md',
    contains: 'add_gridspec',
    check: 'assert len(fig.axes) >= 3' + NL + "print('CASE_OK')",
  },
  {
    name: 'bio-variant · VCF 读取 + 类型统计 + 过滤（Number=1 标量 MAF）',
    file: 'skills/bio-variant-analysis.md',
    contains: 'vcfpy.Reader',
    append: 'filtered = []',
    plt: false,
    check: [
      // 类型统计覆盖**全部**记录（不过滤）：pos100 + pos300 多等位(2) + pos400 + pos500 + pos600 = 6 个 SNV
      "assert types['SNV'] == 6, types",
      "assert types['Insertion'] == 1, types",  // pos200 A>AT —— 按 len(v.ALT) 会误判成 SNV
      "assert sorted(f'{v.CHROM}:{v.POS}' for v in filtered) == ['1:100', '1:200', '1:300'], [f'{v.CHROM}:{v.POS}' for v in filtered]",
      "print('CASE_OK')",
    ].join(NL),
  },
  {
    name: 'bio-variant · 列表形态 MAF（Number=A,Type=Float）',
    file: 'skills/bio-variant-analysis.md',
    contains: 'vcfpy.Reader',
    append: 'filtered = []',
    cwd: fixtureDirA,
    plt: false,
    bind: "v_maf = variants[0].INFO.get('MAF')",
    check: [
      'assert v_maf is not None and isinstance(v_maf, (list, tuple)), type(v_maf)',
      "assert sorted(f'{v.CHROM}:{v.POS}' for v in filtered) == ['1:100'], [f'{v.CHROM}:{v.POS}' for v in filtered]",
      "print('CASE_OK')",
    ].join(NL),
  },
  {
    name: 'bio-survival · 环境导入块（自证 lifelines 路径 + plt，不预置）',
    file: 'skills/bio-survival-analysis.md',
    contains: 'from lifelines',
    plt: false,   // 关键：不预置 matplotlib —— 该 skill 必须自己导入
    // check 里不自己 import：直接引用名字，缺导入即 NameError → 报红
    check: 'assert callable(logrank_test)' + NL
      + 'assert callable(KaplanMeierFitter) and callable(CoxPHFitter)' + NL
      + 'assert plt is not None' + NL + "print('CASE_OK')",
  },
  {
    name: 'bio-evidence-appraisal · I²/τ²/κ 配方',
    file: 'skills/bio-evidence-appraisal.md',
    contains: 'def i_squared',
    plt: false,
    check: [
      'assert i_squared(40, 10) == 77.5',
      'assert abs(tau_squared_dl([10,10,10], [0,1,2]) - 0.9) < 1e-9',
      'assert abs(cohen_kappa(90,10,10,90) - 0.8) < 1e-9',
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
  const msg = '找不到自举环境 → 无法执行配方（DSH_BIO_PYTHON 可指定；确需跳过程序请设 DSH_SKILLS_ALLOW_SKIP=1）'
  if (STRICT) assert(false, msg); else console.warn(`  WARN ${msg}`)
} else {
  for (const c of CASES) {
    const text = readNorm(join(repoRoot, c.file))
    const block = splitBlocks(text).find((b) => b.includes(c.contains))
    if (!block) { assert(false, `${c.name} → 未在 ${c.file} 找到含「${c.contains}」的代码块`); continue }
    let extra = ''
    if (c.append) {
      const b2 = splitBlocks(text).find((b) => b.includes(c.append))
      if (!b2) { assert(false, `${c.name} → 未找到含「${c.append}」的追加代码块`); continue }
      extra = b2
    }
    const code = [preludeFor(c), block, extra, c.bind || '', c.check].filter(Boolean).join(NL + NL)
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
