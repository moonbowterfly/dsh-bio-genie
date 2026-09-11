---
language: python
---

# 变异分析（Variant Analysis）

> 吸收自 bio-research variant-analysis + Google DeepMind science-skills ClinVar/gnomAD 最佳实践

## When to Use

处理 VCF 变异数据、变异注释、变异致病性解读、群体频率分析时加载本 skill。

## 环境

- **Python**：`vcfpy`（**内置第一层依赖**，无需安装；若 `import vcfpy` 失败，调 `bio_env` 的 `reinstall=true` 补装）；cyvcf2 需 htslib，插件不内置
- **数据库**：ClinVar、gnomAD、Ensembl VEP、dbSNP

## 变异分析决策树

```
变异数据
├─ VCF 文件处理
│   ├─ 格式转换/过滤 → vcfpy / bcftools
│   ├─ 变异注释 → Ensembl VEP / ANNOVAR
│   └─ 可视化 → pygenomeviz / matplotlib（基因组位置图）
├─ 变异解读
│   ├─ 致病性分类 → ClinVar（P/LP/VUS/LB/B）
│   ├─ 群体频率 → gnomAD（AF < 0.01 为罕见）
│   └─ 功能影响 → SIFT / PolyPhen-2 / CADD
└─ 变异-表型关联
    ├─ 已知致病变异 → ClinVar + OMIM
    └─ 新发变异 → 家系分析 + 功能验证建议
```

## 标准分析流程

### 1. VCF 读取与基础统计
```python
import vcfpy

reader = vcfpy.Reader.from_path('variants.vcf')
variants = list(reader)
print(f"总变异数: {len(variants)}")

# 按类型统计——**必须按 ALT 序列长度分类，不能按 len(v.ALT)**：
# len(v.ALT) 是"ALT 等位基因个数"，不是序列长度（A>AT 的插入会被误判成 SNV）。
# 多等位记录（A>G,T）按 ALT 逐条计数更准确。
from collections import Counter
types = Counter()
for v in variants:
    for alt in v.ALT:
        alt_seq = str(alt.value)
        if alt_seq == '.':
            types['NoAlt'] += 1
        elif len(alt_seq) == len(v.REF) == 1:
            types['SNV'] += 1
        elif len(alt_seq) > len(v.REF):
            types['Insertion'] += 1
        elif len(alt_seq) < len(v.REF):
            types['Deletion'] += 1
        else:
            types['MNV/Complex'] += 1
print(dict(types), '（多等位记录按 ALT 分别计数）')
```

### 2. 变异过滤
```python
# 过滤标准（根据研究目的调整）
filtered = []
for v in variants:
    # 质量过滤
    if v.QUAL is not None and v.QUAL < 30:
        continue
    # 次要等位基因频率（MAF）过滤——注意两点：
    #   ① 字段缺失时**不要**当作"不合格"丢掉；
    #   ② VCF 头声明 Number=1 时 vcfpy 返回**标量 float**，声明 Number=A 时返回列表
    maf = v.INFO.get('MAF')
    if maf is not None:
        maf_val = maf[0] if isinstance(maf, (list, tuple)) else maf
        if float(maf_val) > 0.05:
            continue
    # 功能区域（外显子/剪切位点）；ANN 缺失或格式异常时跳过该判据
    # ⚠️ ANN 字段里是 SO 术语（synonymous_variant / intron_variant…），
    #    不是 INTRON / SYNONYMOUS 这类缩写——写错术语集合会让整条判据静默失效
    NONCODING = {'synonymous_variant', 'intron_variant', 'intergenic_region',
                 'upstream_gene_variant', 'downstream_gene_variant'}
    ann = (v.INFO.get('ANN') or [None])[0]
    parts = str(ann).split('|') if ann else []
    if len(parts) > 1 and parts[1] in NONCODING:
        continue
    filtered.append(v)
print(f"过滤后: {len(filtered)}")
```

### 3. ClinVar 致病性注释
```python
# 通过 NCBI Entrez 获取 ClinVar 信息
from Bio import Entrez
Entrez.email = "your@email.com"

# 查询 ClinVar
handle = Entrez.esearch(db="clinvar", term=f"{variant_id}[Variant ID]")
record = Entrez.read(handle)
# 获取详细信息
handle = Entrez.efetch(db="clinvar", id=record["IdList"], rettype="vcv")
```

### 4. gnomAD 群体频率
```python
# gnomAD API 查询
import requests

def query_gnomad(gene, variant):
    url = f"https://gnomad.broadinstitute.org/api"
    query = """
    query {
        gene(gene_name: "%s") {
            variants {
                variant_id
                allele_frequency
                ac
                an
            }
        }
    }
    """ % gene
    # 注意：gnomAD API 有速率限制
```

### 5. 可视化
```python
# Circos 风格基因组全景图
# 用 Python pygenomeviz / matplotlib 实现（插件已移除 R 引擎）

# 基因组位置图
import matplotlib.pyplot as plt
fig, ax = plt.subplots(figsize=(12, 3))
for v in filtered:
    chrom = int(v.CHROM.replace('chr', ''))
    ax.scatter(chrom, v.POS, c='red', s=10)
ax.set_xlabel('Chromosome')
ax.set_ylabel('Position')
plt.savefig('figures/variant_manhattan.png', dpi=300)
```

## 变异致病性解读（ACMG 标准）

| 分类 | 缩写 | 标准 |
|------|------|------|
| 致病 | P | ≥2 强证据 或 1 强+多中等 |
| 可能致病 | LP | 1 强+1-2 中等 |
| 意义未明 | VUS | 证据不足或矛盾 |
| 可能良性 | LB | 1 强良性 或 多中等良性 |
| 良性 | B | ≥2 强良性证据 |

**证据类型**：
- 强致病：PVS1（功能丧失）、PS1-PS4（已知致病）
- 中等致病：PM1-PM6（功能/共分离/新发）
- 强良性：BA1（MAF>5%）
- 支持良性：BS1-BS4（频率/共分离）

## 报告规范

| 指标 | 必须报告 |
|------|----------|
| 变异位置 | ✅ chr:pos REF/ALT |
| 基因/转录本 | ✅ HGVS 命名 |
| ClinVar 分类 | ✅ P/LP/VUS/LB/B |
| gnomAD AF | ✅ 群体频率 |
| 功能影响预测 | ✅ SIFT/PolyPhen/CADD |
| 临床意义 | ✅ 与表型的关联证据 |

## 常见错误

| 错误 | 正确做法 |
|------|----------|
| 只报告 VUS 不给建议 | 说明「证据不足，建议家系分析+功能验证」 |
| 忽略群体频率 | 必须查 gnomAD，MAF>0.01 通常排除 |
| 混淆 SNP/Indel | 明确变异类型，Indel 需 HGVS indel 命名 |
| 不校正多重检验 | 多变异分析用 Bonferroni 或 BH-FDR |


## 验收标准

- [ ] VCF 用**声明了 INFO 头**（`Number`/`Type`）的真实文件验证过：MAF 标量与列表两种形态都不崩
- [ ] 变异类型统计按 ALT **序列长度**分类（A>AT 必须报 Insertion），多等位记录按 ALT 分别计数
- [ ] 过滤前后数量对得上，且**字段缺失不等于不合格**（缺 MAF/ANN 的记录不被静默丢弃）
- [ ] 每条判据都用合成 VCF 实跑复现过（不是"看着对"）
