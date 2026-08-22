---
language: python
---

# DNA/质粒设计工具

> PCR 引物设计、密码子优化、DNA 组装策略、质粒图谱生成。

## 工具速查

| 工具 | 用途 |
|------|------|
| `bio_primer_design` | PCR 引物设计（Tm/GC/评分） |
| `bio_seq_optimize` | 密码子优化（ecoli/human/yeast） |
| `bio_assembly_design` | Gibson/Golden Gate/限制酶组装 |
| `bio_plasmid_map` | 文本质粒注释图 |

## 典型工作流

### 1. PCR 扩增目标基因
```
bio_primer_design(sequence="ATGCGT...（模板序列）", product_size=1200)
→ 正/反向引物对（Tm≈60°C, GC≈50%）
```

### 2. 密码子优化后表达
```
bio_seq_optimize(sequence="ATGCGTAAAGAT...", organism="ecoli")
→ 优化序列（GC%、变更率）
```

### 3. 多片段组装
```
bio_assembly_design(fragments=[seq1, seq2, seq3], method="gibson")
→ Gibson 接头设计 + 协议
```

### 4. 质粒构建验证
```
bio_plasmid_map(name="pET28a-MCS", features=[
  {"name":"T7 promoter","start":0,"end":200,"type":"regulatory"},
  {"name":"His-tag CDS","start":200,"end":230,"type":"cds"},
  {"name":"origin","start":3000,"end":3500,"type":"origin"}
])
→ 文本质粒图谱
```
