---
language: none
---

# 科研论文写作（Scientific Paper Writing）

> 吸收自 OpenAI life-science-research paper-writing + IMRaD 结构 + Nature 写作指南

## When to Write

撰写论文、摘要、综述、实验报告时加载本 skill。

## IMRaD 结构模板

```
1. Title（标题）
   - 简洁、信息丰富、含关键发现
   - 避免缩写、公式、标点过多

2. Abstract（摘要）—— 150-300 词
   - Background: 1-2 句背景
   - Methods: 核心方法
   - Results: 关键发现（含统计量）
   - Conclusions: 生物学意义

3. Introduction（引言）
   - 研究背景和问题
   - 已知和未知
   - 研究目的和假设

4. Methods（方法）
   - 实验设计
   - 样本量和来源
   - 统计方法（含软件版本）
   - 伦理声明

5. Results（结果）
   - 按逻辑顺序呈现
   - 图表配合文字
   - 报告统计量（p值、效应量、CI）

6. Discussion（讨论）
   - 主要发现的生物学意义
   - 与已有文献的对比
   - 局限性和未来方向

7. References（参考文献）
   - 格式统一（Vancouver/APA/Nature）
   - PMID/DOI 可追溯
```

## 摘要写作模板

```markdown
## Background
[研究问题] is [importance]. However, [knowledge gap].

## Methods
We [study design] with [sample size] [samples]. [Key methods].

## Results
[Key finding 1] (p = [value], HR = [value], 95% CI [range]). 
[Key finding 2]. [Additional findings].

## Conclusions
[Main conclusion]. These findings suggest [biological implication].
```

## 统计报告规范

| 分析类型 | 必须报告 | 示例 |
|----------|----------|------|
| 差异表达 | log2FC, padj, 基因数 | "842 genes were DE (|log2FC|>1, padj<0.05)" |
| 生存分析 | HR (95% CI), p, C-index | "HR = 1.85 (1.12-3.05), p = 0.016" |
| 富集分析 | 基因数, padj, ES | "GO:0006915 (apoptosis), 23 genes, padj = 0.003" |
| 相关性 | r (或 ρ), p, n | "r = 0.45, p < 0.001, n = 150" |
| 变异分析 | 频率, 分类, 来源 | "gnomAD AF = 0.0003, ClinVar: LP" |

## 学术英语要点

### 常用句式
- **Background**: "XX has been implicated in...", "Despite extensive studies, ..."
- **Methods**: "We performed...", "Samples were analyzed using..."
- **Results**: "We observed...", "Compared to controls, ... showed..."
- **Discussion**: "Our findings suggest...", "This is consistent with..."

### 避免的表达
| ❌ 避免 | ✅ 改为 |
|---------|---------|
| "very significant" | "statistically significant (p < 0.001)" |
| "proven" | "demonstrated" / "supported" |
| "might" (过多使用) | "may" / "could" |
| "etc." | 明确列出或 "and others" |

### 数据可视化规范
- **图**：300 DPI, TIFF/PDF, 色盲友好配色
- **表**：三线表, 统计量对齐, 脚注清晰
- **图注**：独立于图, 含样本量和统计检验

## 参考文献管理

### PMID/DOI 获取
```python
# 通过 PubMed 获取 PMID
from Bio import Entrez
Entrez.email = "your@email.com"
handle = Entrez.esearch(db="pubmed", term="TP53 cancer review")
record = Entrez.read(handle)
pmids = record["IdList"]
```

### 格式化引用
```
Vancouver: Author. Title. Journal. Year;Volume(Issue):Pages. doi:xxx
Nature: Author et al. Title. J. Volume, Pages (Year).
APA: Author, A. A. (Year). Title. Journal, Volume(Issue), Pages.
```

## 伦理和可重复性

### 必须包含
- **伦理声明**：IRB 批准号、知情同意
- **数据可用性**：GEO/SRA 登录号
- **代码可用性**：GitHub 仓库链接
- **利益冲突声明**

### 可重复性清单
- [ ] 随机种子已设置
- [ ] 软件版本已记录
- [ ] 参数已明确
- [ ] 原始数据已存储
- [ ] 分析代码已共享
