---
name: bio-wetlab-design
description: 把干实验结论转化为可执行的湿实验方案（克隆/PCR/敲除验证/工程菌构建）
language: none
category: guide
---

# 湿实验方案设计（干 → 湿 转化）

> 定位：你不做湿实验，但你输出的方案要能直接交给实验台。所有湿实验设计必须先过 in silico 验证。

## 铁律：先模拟，后方案

| 湿实验目标 | 必先执行的 in silico 验证 |
|---|---|
| 克隆构建 | `bio_clone_simulate`（Gibson/酶切/Golden Gate 全程模拟）+ `bio_plasmid_map` 出图 |
| PCR/引物 | `bio_primer3_design`（Tm/二聚体/发夹热力学评分），禁止手估 Tm |
| 密码子优化表达 | `bio_dna_optimize`（多约束）+ 优化后回验 `bio_seq_restriction` 无新酶切位点 |
| 基因敲除 | `bio_gene_knockout` 预测 essentiality + `bio_production_envelope` 评估生长代价 |
| 代谢工程改造 | `bio_fba`/`bio_fva` 预测通量变化，锁定靶点后 `bio_pathway_design` 确认通路 |
| 基因回路构建 | `bio_circuit_compile` + `bio_circuit_simulate` 仿真动力学，确认稳定态/切换行为 |

## 方案生成契约（两层，2026-08-26 确立）

`bio_wetlab_design` 返回值自带 `generation_contract` 字段，把「事实」与「发挥」的边界写明：

- **Layer 1 事实锚点**（代码计算 + 领域常数查表）：酶反应条件、同源臂长度区间、上游工具推导数值——**原样引用并标注来源工具，不可擅改**。
- **Layer 2 agent 适应层**：对照 `assumptions` 逐条核验用户现实场景（试剂库存/设备型号/片段浓度/样本特性），在 `adapt_points` 上具体化；改动处标注 `[推断]` 并给理由。
- **硬约束 `hard_constraints`**：任何一层都不可突破（如 Gibson 组装温度恒定 50°C、退火温度必须来自 primer3 实算）。

输出方案时按此结构组织：「事实锚点（溯源）→ 你的适应性调整（[推断] 标注）→ 最终可执行 protocol」。禁止把 Layer 1 模板当最终答案原样转述。

## 方案输出模板

```
《湿实验方案：<名称>》
■ 目标：……
■ in silico 验证摘要：<工具> → <关键数值结论>（溯源）
■ 材料清单：载体/插入片段/酶/引物（序列附后）/菌株
■ 步骤：
  1. ……（含具体条件：退火温度来自 primer3 输出、酶切体系、连接比例）
■ 质控节点：哪一步失败如何排查（ colony PCR / 测序验证位点）
■ 预期风险与备选：……
```

## 分领域要点

### 克隆
- 策略选择：Gibson（多片段/无缝）> Golden Gate（标准化部件）> 酶切连接（简单两端）
- 模拟通过后才输出引物；Gibson 重叠臂 20-40bp，Tm 由 primer3 算
- 输出质粒图（bio_plasmid_map）作为构建蓝图

### 蛋白表达
- 宿主选择是决策点（问用户：E. coli BL21 / 酵母 / 其他）
- 密码子优化必须保留/排除的元件让用户确认（His 标签、信号肽、酶切位点保护）

### 代谢工程
- 敲除靶点排序按 essentiality + 生产包络权衡， Top 3 给用户选
- 提醒：in silico 预测 ≠ 体内表型，方案中写明验证实验（生长曲线 + 产物测定）

### 基因回路
- 仿真展示剂量响应/稳态后再谈构建
- SBOL 文件（bio_sbol_write）作为标准化交付物，可直接进合成流水线

## 边界（诚实声明）

- 你不出具体的移液枪体积排程表（那是实验记录软件的事）
- 你不替代生物安全评估：涉及病原/毒素基因时提醒用户走机构 biosafety 流程
