---
name: bio-proto-literature-review
domain: literature
inputs: [研究主题关键词]
outputs: [文献列表 + 结构化摘要 + 综述要点]
requires_network: true
---

# 文献调研工作流协议（语义工具版）

**适用场景**：新课题背景调研、方法学文献查证、为分析结论找文献支撑。

## 步骤

1. 用 `bio_pubmed_search` 检索主题（支持 PubMed 语法：`TP53[Title]`、`AND/OR`）
2. 挑相关 PMID，用 `bio_pubmed_abstract` 批量取结构化摘要
3. 汇总：研究问题 → 方法 → 主要发现 → 与当前任务的关联

## 工具调用序列

```
bio_pubmed_search term="CRISPR prime editing" retmax=10
bio_pubmed_abstract ids=["42595700","42589580",...]
```

## 检索式技巧

- 精确主题：`"prime editing"[Title/Abstract] AND review[Publication Type]`
- 限定年份：`AND 2023:2026[dp]`
- 排除噪声：`NOT "case report"[Publication Type]`

## 常见坑

- retmax 默认 10，综述调研可加到 30-50（限流已由插件内置）
- 摘要为空 = 无摘要（letter/editorial），跳过或标注
- 批量取摘要一次 ≤ 30 个 PMID，多了分批
- 结论引用文献时必须带 PMID/DOI——科学严谨性约束要求可溯源

## 解读要点

- 按年份 + 期刊影响力加权判断结论可信度（顶刊 + 近期 > 其他）
- 综述（review）适合快速了解领域；原创研究（article）适合引用具体方法参数
- 输出建议用表格：PMID | 年份 | 期刊 | 核心发现一句话
