---
name: bio-proto-enrichment-workflow
domain: functional-analysis
inputs: [基因符号列表]
outputs: [富集通路/GO term + p 值 + 解读]
requires_network: true
---

# 富集分析工作流协议（语义工具版）

**适用场景**：差异表达基因列表、CRISPR 筛选 hits、共表达模块——"这组基因在功能上指向什么"。

## 步骤

1. 整理基因符号列表（5-500 个，去掉重复）
2. 用 `bio_enrichr` 跑多个库：GO_BP → 功能过程；KEGG → 通路；Reactome → 信号级联
3. 按 adjusted_p_value 升序取 top，交叉解读

## 工具调用序列

```
bio_enrichr genes=["TP53","BRCA1","EGFR",...] library="GO_Biological_Process_2023" top=10
bio_enrichr genes=[...] library="KEGG_2021_Human" top=10
bio_enrichr genes=[...] library="Reactome_2022" top=10   # 可选交叉验证
```

## 常见坑

- 基因符号要统一物种与命名（人源大写；小鼠首字母大写；其他物种先转 human ortholog）
- 同一物种内 GO 库与 KEGG 库的 p 值不可直接比较（背景集不同），分别报告
- `adjusted_p_value` 才是多重校正后的结论依据，别拿 raw p 值讲故事
- 基因数 < 5 富集意义弱；> 2000 背景校正失真

## 解读要点（科学严谨性约束）

- 报告格式：通路名 + adjusted p 值 + 重叠基因数/总命中数 + combined score
- 富集到「癌症相关通路」≠ 这组基因致癌——只能说与已知通路的成员重叠
- 结合基因已知功能交叉验证：如富集到 DNA repair 且列表里有 BRCA1/TP53，结论才自洽
- 结论标注证据来源（Enrichr + library 名 + 日期），如需文献支撑接 literature-review 协议
