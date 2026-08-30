# 同系列插件接入契约（plugin-integration v1）

> dsh-bio-genie 定位 = 高度自主、基础通用的生物信息学插件；专精能力由同系列插件（bundle）提供，
> genie 负责**路由引导**与**资产契约消费**。v1 以首个接入方 **dsh-bio-gem**（代谢模型能力域）为样板，
> 后续同系列插件接入沿用本契约。

## 0. 接入总则

- genie **不做**接入方工具的反向封装：agent 直接调用对方的 `gem_*` 工具（同一 dsh 实例注册表天然共存，
  阶段 D 已实测 agent 会话可见 73 工具）。
- genie 侧改动限于：preset skill 路由段（引导层）+ 本契约（消费规则层）。接入方仓库不受影响。
- 命名空间约定：`bio_*` = genie 本体工具；`<domain>_*`（如 `gem_*`）= 接入方工具。同实例共存无冲突。

## 1. 路由决策表（写入 preset skill 的引导层）

| 用户意图 | 路由 | 触发词 |
|---|---|---|
| 基因组→建模 / 六关验证 / 缺口诊断补洞 / biomass 精修 / 表型回填 | gem_annotate / gem_build / gem_validate / gem_gapfind / gem_gapfill / gem_l3_fix / gem_biomass / gem_phenotype | 建模 / GEM / 代谢模型 / 模型验证 / 补洞 |
| 必需基因全扫 / 通量区间（硬结论 vs 伪影）/ 鲁棒性 / 双敲 SL / 分泌谱 / 富集 / 靶点导出 | gem_essentiality / gem_fluxscan / gem_sensitivity / gem_double_knockout / gem_secretion / gem_enrichment / gem_targets | 必需基因 / 通量区间 / 伪影 / 稳定性 / 合成致死 / 分泌谱 / 富集 / 靶点 |
| 已发表模型对比 / benchmark | gem_benchmark | benchmark / 模型对比 |
| 预测账本查询更新 / 模型报告 | gem_ledger / gem_report | 账本 / prediction_id / 模型报告 |
| 轻量代谢快查（临时试算、无模型资产溯源需求） | bio_fba / bio_gene_knockout / bio_production_envelope | textbook / 教科书模型 / 快速试算 |

判定原则：**深水区科学结论**（要写进报告/论文的数字）走接入方工具——它们消费模型卡/账本等持久资产、
自带证据分级；genie 轻量层只承接临时试算。

## 2. 资产契约五条（消费规则层）

1. **命名空间共存**：`bio_*` 与 `gem_*` 同实例注册共存，无冲突、无封装。agent 按路由表选域。
2. **模型权威源 = 接入方模型卡**（sidecar JSON，lineage 版本化）。汇报模型规模/验证结果/必需基因时，
   provenance 指向模型卡字段或当次工具输出，**禁止凭印象重述**。
3. **预测权威源 = 接入方预测账本**（JSONL，逐条 `prediction_id`/`evidence_tier`/`status`）。
   引用必需/表型/分泌/合成致死预测时必须带 prediction_id 与 status；**未入账的预测不得谎称已有**。
4. **下游接口 = 接入方规范导出**（gem_targets 11 字段：target_id/type/genes/met_ids/condition/rationale/
   evidence_tier/status/growth_or_maxprod/source/exported_at）。靶点清单一律走 gem_targets，不自行编格式。
5. **质量铁律沿用 genie 本体**：数字必须来自工具输出（_provenance）；区间制对比（overlap=伪影禁止引用）；
   退化场景如实报告（wt≤EPS）；生长值单位 mmol/gDW/h。

## 3. 汇报模板（代谢模型任务）

接入域任务汇报按固定结构，保证可溯源：

```
《代谢模型分析报告》
1. 模型卡摘要：模型文件（绝对路径）、引擎/lineage 版本、规模、验证关卡结果（引 gem_report/gem_validate 输出或模型卡字段）
2. 预测引用：每条预测带 prediction_id + evidence_tier + status（与 gem_ledger 一致）
3. 分析结论：通量对比只引区间分离判定；单点 diff 须标注伪影
4. 靶点/导出：gem_targets 产物路径 + 与账本计数闭合声明
```

## 4. 资产路径（dsh-bio-gem v0.1.0 基线）

- 模型卡：模型文件同目录 `<name>.card.json`（schema v3：lineage / verified_phenotypes / essential_genes / robustness）
- 预测账本：`~/.dsh/dsh-bio-gem/ledger/predictions.jsonl`（四类型：essentiality / phenotype / secretion / synthetic_lethal）
- 靶点导出：`~/.dsh/dsh-bio-gem/exports/targets_<ts>.csv|json`
- 接入方主指引：gem 插件 `skills/gem-expert.md`（决策树 + C58 回归锚）

## 5. 后续接入方的最小接入清单

1. 接入方提供 `<domain>-expert` skill + 命名空间 `<domain>_*` 工具（同实例注册）
2. genie preset skill 增加能力域路由段（决策表 + 触发词），只增不改
3. 本契约追加"资产权威源"条款（模型/预测/导出三类）
4. 双方跑一次真实 agent 会话的 before/after 对照，证明路由生效与契约传导
