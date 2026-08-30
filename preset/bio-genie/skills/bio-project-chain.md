---
name: bio-project-chain
description: 干湿实验全链条项目管理：从 idea 到 in silico 设计、模拟验证、湿实验方案、数据分析回灌
language: none
category: guide
---

# 全链条项目管理（bio-project-chain）

> 用户给的是一个科研目标，不是单个任务。你负责把目标拆成链条、推进每一环、让数据在环间流动。

## 链条全景

```
① 问题定义 → ② 信息侦察 → ③ in silico 设计 → ④ 模拟验证
→ ⑤ 湿实验方案 → ⑥（用户做实验）→ ⑦ 数据分析回灌 → ⑧ 结论与迭代
```

你只执行 ①②③④⑤⑦⑧；⑥ 是用户的实验台工作。每一环的输出是下一环的输入。

## 各环操作要点

### ① 问题定义
- 把用户的自然语言目标落成可计算的问题（变量、约束、成功标准）
- 有歧义就用 ask_user_question 澄清，这是第一个决策点

### ② 信息侦察
- bio_entrez_search / bio_pubmed_search / bio_ref_genome 收集背景
- 数据质量门控（见 dsh-bio-genie-guide-rigor 第 0 节）：长度/完整性/物种匹配

### ③ in silico 设计
- 按 bio-wetlab-design 的「铁律表」选工具
- 设计产物标准化：序列文件（out/）、质粒图（figures/）、SBOL（bio_sbol_write）

### ④ 模拟验证
- bio_clone_simulate / bio_fba / bio_circuit_simulate
- 代谢模型（GEM）深度验证/分析走 dsh-bio-gem 能力域（gem_validate/gem_fluxscan/gem_essentiality，见 dsh-bio-genie-expert §7）；预测引用带 prediction_id（资产契约 v1）
- 验证失败 → 回到 ③ 迭代，记录迭代次数；3 轮不过 → 决策点，和用户讨论换路线

### ⑤ 湿实验方案
- 按 bio-wetlab-design 模板输出
- 高成本/高危步骤标出，等用户确认

### ⑦ 数据分析回灌（用户带回实验数据）
- NGS 数据：bio_deseq2 / bio_gsea；表型数据：bio_stats_test / bio_ml_pipeline
- **回灌闭环**：实验结果与 ④ 的预测对比——一致则增强结论；不一致是最重要的发现，
  明确指出「预测-实测偏差」并提出机制假设（标 [推断-未验证]）

### ⑧ 结论与迭代
- 《结果报告》+ 下一轮迭代建议
- 论文导向时用 bio-paper-writing / bio-graphics skill

## 状态追踪

- 长项目用 bio_goal 创建总目标，每完成一环汇报进度
- 关键中间结论查 bio_memory（成功模式/教训），避免重复踩坑
- 跨会话时：所有状态必须落盘为文件（out/project_state.md），不依赖对话记忆

## 示例触发

| 用户说 | 你进入的环节 |
|---|---|
| "我想让这个菌产更多 X" | ①→②→③（FBA 找靶点）→④→⑤ |
| "帮我构建一个 toggle switch" | ③（circuit_compile）→④（simulate）→⑤ |
| "这是我的 RNA-seq 数据" | ⑦ 直接进分析 |
| "实验做出来了，和预测不一样" | ⑦ 的偏差分析（最高优先级） |
