# integration_ruleset@1 v0 — 取值依据（SOURCES）

- 资产：`design/integration-ruleset/integration-ruleset-v0.json`
- req_id：G-LOOP-20261015-IR-001（冲刺轨 2 · 豆包）
- 日期：2026-10-15
- 冻结 schema：`design/packet/schemas/integration_ruleset.json`（artifact_type 常量 `integration_ruleset@1`）
- corpus 样例：`design/packet/schema-corpus/schema_cases.json`（irs-01 minimal valid〔`default-integration` / version `"1"` / feature_overlap + window=200〕/ irs-02 缺 version invalid / irs-03 bad kind invalid）
- 规格依据：
  - `genie-synbio-design-reply-2026-10-12.md`：整合位点从「安全位点」降级为「给定 annotation、窗口和证据下未触发排除规则的候选」；「基于 feature overlap、邻近风险、重复序列、已知落点证据的整合候选筛选」
  - `genie-synbio-design-spec-v0.1-2026-10-12.md` §6.2：feature overlap（CDS/rRNA/tRNA…）、环状 contig、方向、侧翼窗口、已知 landing-pad evidence；只输出 `excluded` / `screened_candidate` / `literature_characterized` / `blocked`，禁止「安全」结论；fixture 含正反链 CDS、tRNA/rRNA、重复区、intergenic 区、跨 origin 位点
  - `genie-synbio-design-spec-v0.2-2026-10-12.md` §5/§6.2：ruleset 强制；`screened_candidate` 仅当 mandatory rules 全部已知且通过；**unknown annotation/repeat/essentiality 不得默认为通过（→ blocked/unknown-risk）**
  - `genie-synbio-design-spec-review-1-2026-10-12.md` [P1] / `review-2` F29：固定 ruleset + 可审计 feature evidence；unknown 不默认通过已修
  - `genie-synbio-design-impl-work-order-v3-2026-10-14.md` §A0.5 / §B1 [P1-3]：`design_integration_candidates` 硬依赖本资产，缺 → `BLOCKED` / `NOT_RUN`
  - `genie-synbio-design-FREEZE-v1.0-arch-FINAL-2026-10-13.md`、`P0A-WORK-ORDER.md` C 节（iML1515 sha `9c772d44…` 属 reference bundle 资产清单）
- 领域惯例引用：大肠杆菌同源重组（recA 依赖 HR）最小同源臂长度、oriC/DnaA box 调控区尺度、Chi 位点（GCTGGTGG）重组热点——均为分子生物学教科书级事实（见 §2/§4/§5 具体条）。

> 原则：位点评估规则集的语义边界 = 「给定 annotation、窗口和证据下未触发排除规则的候选」；mandatory 规则必须全知且通过才能给 `screened_candidate`，未知一律不默认通过（规格链 F29 冻结语义）。数值不必照抄 corpus 样例，但每个取值必须有依据；弱依据标注「待裁定」。

---

## 1. `feature_overlap`（mandatory=true）— 与基因组功能元件重叠检查

| 项 | 内容 |
|---|---|
| rule_id / kind | `feature_overlap` / `feature_overlap` |
| params | `window`=200（bp）；`feature_classes`=["CDS","rRNA","tRNA","ncRNA","regulatory"]；`unknown_policy`="block" |

**生物学动机**：整合位点不得破坏已注释功能元件（编码序列、核糖体/tRNA 基因、非编码 RNA、调控元件）。spec v0.1 §6.2 的 method 原文即「feature overlap（CDS/rRNA/tRNA…）」；reply 2026-10-12 把位点定义为「未触发排除规则的候选」，feature overlap 是最核心的排除面。规则语义：候选区间按 `window` 扩展后的基因座与任一 `feature_classes` 元件相交即排除。

**参数来源**：
- `window`=200：与冻结 corpus irs-01 样例的字面量完全一致（该样例即 feature_overlap + `window: 200`）。领域惯例：landing-pad 类筛选的侧翼缓冲一般在 100–500 bp（覆盖注释边界不确定性与启动子/终止子干扰面）；200 bp 处于中位且与冻结语料零差异，是 v0 最强可辩护取值。**取值依据强（冻结语料一致）**；是否放宽/收紧由 bsp 裁定。
- `feature_classes`：覆盖 GFF3/GenBank 常见功能注释类别；spec v0.1 fixture 明确列出的 CDS、tRNA、rRNA 全部包含，「regulatory」承接 GFF3 `regulatory` 特征类型。**保守设定**（类别集合可按宿主注释体系扩充）。
- `unknown_policy`="block"：review-1 [P1]/review-2 F29 冻结语义——注释未知/不完整不得默认为通过；规则结果 unknown → 候选不能进入 `screened_candidate`（可保留 `preliminary_candidate` 或 `blocked`+`unknown_or_incomplete_annotation`，由工具层按 spec v0.3 classification 规则落地）。

**保守性论证**：mandatory=true 使该规则参与 mandatory coverage 阻断；window 200 比 100 更宽（多排除、少误放行）；unknown 一律 block。三者都取「不确定不发言」的保守侧。

---

## 2. `repeat`（mandatory=true）— 重复/同源序列导致的整合不稳定

| 项 | 内容 |
|---|---|
| rule_id / kind | `repeat` / `repeat` |
| params | `min_repeat_length_bp`=20；`window_bp`=200；`annotated_repeat_classes`=["repeat_region","insertion_sequence","transposon","mobile_element"]；`unknown_policy`="block" |

**生物学动机**：插入位点含（或邻近）重复/同源序列时，整合子与基因组同源区发生 recA 依赖同源重组，可导致整合子切除、串联重复、缺失或重排。reply 2026-10-12 明确把「重复序列」列为候选筛选取证维度之一；spec v0.1 fixture 含「重复区」。规则语义：`window_bp` 扩展基因座内存在 ≥`min_repeat_length_bp` 的 ab-initio 重复单元，或命中 `annotated_repeat_classes` 注释类别，即排除。

**参数来源**：
- `min_repeat_length_bp`=20：大肠杆菌 recA 依赖 HR 的高效同源臂通常需 ~20–50 bp（重组工程/基因打靶领域通行量级）；保守取下限 20 bp——阈值越低检出越多风险，宁多排除不误放行。**【待裁定】**（若实证表明 20 bp 以下 microhomology 也贡献显著失稳，可进一步下调；若噪声过多可上调至 25–50）。
- `window_bp`=200：与 §1 `window` 同一侧翼窗口语义（单一窗口尺度，避免同一定义两种数）。**保守设定**。
- `annotated_repeat_classes`：重复区、插入序列、转座子、移动元件是细菌基因组重复失稳的主体类别；前噬菌体等大型移动区不在此列，改由 §6 advisory 规则承接（存在性 ≠ 必然失稳，不设硬排除）。**保守设定**。
- `unknown_policy`="block"：spec v0.2 显式「unknown repeat 不得默认为通过」。

**保守性论证**：mandatory=true；阈值取下限；注释类别宽覆盖；unknown block。

---

## 3. `essentiality`（mandatory=true）— 必需基因重叠/邻近

| 项 | 内容 |
|---|---|
| rule_id / kind | `essentiality` / `essentiality` |
| params | `essentiality_sources`=["DEG","Keio","iML1515_in_silico"]；`union_semantics`="any_source_essential"；`proximity_window_bp`=200；`unknown_policy`="block" |

**生物学动机**：破坏必需基因（或其调控面）直接致死/致生长缺陷，是位点筛选的硬约束。brief 2026-10-12 将整合候选定位为「安全位点与必需性交叉」；spec v0.1 明确「避开必需基因」结论纪律。规则语义：候选基因座与任一来源判定为必需的基因重叠、或落在其 `proximity_window_bp` 内，即排除。

**参数来源**：
- `essentiality_sources`：DEG（Database of Essential Genes，领域标准必需基因库）、Keio（大肠杆菌 K-12 单基因敲除实验集合）、`iML1515_in_silico`（本仓 reference bundle 的 iML1515 模型在固定条件下的生长必需性预测，P0A C 节资产）。三源取并集（`any_source_essential`）：任一来源判定必需即排除——对多源分歧采取最保守侧。**【待裁定】**（源集合是否扩/缩、`iML1515_in_silico` 是否要求固定条件绑定，由 bsp/主控裁定）。
- `proximity_window_bp`=200：与全局侧翼窗口一致，覆盖必需基因上游启动子/UTR 的干扰面（大肠杆菌典型启动子区在 TSS 上游 ~60 bp 内，UTR 多 <200 bp）。**【待裁定】**（收紧至 100 亦合理）。
- `unknown_policy`="block"：spec v0.2 显式「unknown essentiality 不得默认为通过」。

**保守性论证**：union 语义 + mandatory=true + 邻近缓冲 + unknown block，四重保守。

---

## 4. `neighborhood`（mandatory=true）— 基因组邻域/表达上下文

| 项 | 内容 |
|---|---|
| rule_id / kind | `neighborhood` / `neighborhood` |
| params | `origin_exclusion_window_bp`=2000；`high_expression_exclude_percentile`=90；`expression_evidence_required`=true；`unknown_policy`="block" |

**生物学动机**：邻域上下文影响整合稳定性与表达行为——复制起点邻域（复制叉/剂量效应）、高表达基因邻域（通读转录、启动子串扰、剂量扰动）。reply 2026-10-12 把「邻近风险」列为筛选维度；spec v0.1 fixture 特意含「跨 origin 位点」负例。规则语义：距复制起点 <`origin_exclusion_window_bp` 即排除；有表达证据时，距 top `high_expression_exclude_percentile` 高表达基因 < 侧翼窗口即排除；无表达证据 → 子检查 unknown。

**参数来源**：
- `origin_exclusion_window_bp`=2000：大肠杆菌 oriC 本体 ~245 bp 且 DnaA box 调控区及邻近复制叉起始区域尺度在 kb 级；保守取 ±2 kb。**【待裁定】**（0.5–2 kb 均常见，取 2 kb 为最保守端）。
- `high_expression_exclude_percentile`=90：top 十分位高表达基因视为邻域干扰源。**【待裁定】**（85–95 均可辩护）。
- `expression_evidence_required`=true：表达证据（如 RNA-seq）缺失时该子检查不得假装通过——与规格链「unknown 不默认通过」一致；后果是 structural_only 模式（无表达证据）下位点最多停留在 `preliminary_candidate`，与 spec v0.1 表「注释不可信 → 位点类 NOT_RUN」同向。**【待裁定】**（是否将该子检查降为 advisory 由 bsp 裁定；v0 取保守侧）。
- `unknown_policy`="block"：同上冻结语义。

**保守性论证**：origin 窗口取最保守端；高表达排除开启；证据缺失即 unknown-block。

---

## 5. `motif`（mandatory=true）— 调控基序样序列，避免干扰

| 项 | 内容 |
|---|---|
| rule_id / kind | `motif` / `motif` |
| params | `annotated_regulatory_classes`=["promoter","terminator","ribosome_binding_site","operator","attenuator"]；`sequence_motif_table`=[{"id":"chi_site","sequence":"GCTGGTGG","strand_sensitive":false}]；`window_bp`=200；`unknown_policy`="block" |

**生物学动机**：插入落入调控元件会破坏其功能；插入片段自身携带短功能基序（重组热点、调控信号）会在整合后干扰局部调控或促进重组。规则语义：`window_bp` 扩展基因座命中注释调控类别，或序列命中 `sequence_motif_table` 任一基序，即排除。

**参数来源**：
- `annotated_regulatory_classes`：启动子/终止子/RBS/操纵子/衰减子为原核注释的常见调控类别；与 §1 的泛化 `regulatory` 类别构成双粒度覆盖（注释粗分在 feature_overlap，细分与序列级在此）。**保守设定**。
- `sequence_motif_table`（v0 仅 chi_site）：Chi 位点 `GCTGGTGG` 是大肠杆菌 RecBCD 依赖重组的经典重组热点（教科书级事实），位点内/邻近存在会提高同源重组介导的重排风险；序列短、无注释依赖，可直接强制扫描。其余候选（σ70 启动子保守盒、rho 非依赖终止子发夹等）为简并/结构基序，v0 不引入字面量表，退化为注释类别覆盖。**【待裁定】**（表扩充与否由 bsp 裁定）。
- `window_bp`=200：与全局侧翼窗口一致。
- `unknown_policy`="block"：序列级扫描无 unknown 概念；注释类别部分沿用冻结语义。

**保守性论证**：mandatory=true；序列级扫描不依赖注释（structural_only 模式也可执行）；Chi 位点按 strand-insensitive 双向计数（更保守）。

---

## 6. `contextual_stability`（kind=`other`，mandatory=false）— 移动/岛元件邻域 advisory 标记

| 项 | 内容 |
|---|---|
| rule_id / kind | `contextual_stability` / `other` |
| params | `flag_features`=["prophage","genomic_island","integron","CRISPR_array"]；`flag_window_bp`=2000；`action`="flag_for_review" |

**引入动机**：前噬菌体、基因组岛、整合子、CRISPR 阵列邻域的失稳风险是**上下文依赖**的（存在性 ≠ 必然失稳，菌株/诱导条件/邻近序列都影响），v0 不设硬排除；但完全忽略会漏掉人工复核信号。故引入 advisory 规则：命中即 `flag_for_review`，**不参与 mandatory coverage 阻断、不覆盖任何 mandatory 规则结论**。这是对规格链「只输出 excluded / screened_candidate / literature_characterized / blocked」的忠实补充——advisory 标记可进入候选的 evidence/reasons 而不改变 classification。

**参数来源**：
- `flag_features`：前噬菌体/基因组岛/整合子/CRISPR 阵列为原核基因组移动与岛结构的主体类别。**保守设定**。
- `flag_window_bp`=2000：上下文观察窗取 kb 级。**【待裁定】**。
- `action`="flag_for_review"：v0 唯一动作；mandatory=false 与动作语义一致。

**保守性论证**：宁可多 flag 不放过——即使不排除，也强制进入人工复核面；同时不因证据不足而错杀（不设排除）。

---

## 边界披露（建议 bsp/主控最终裁定）

| 项 | 本 v0 取值 | 备选 | 理由与影响 |
|---|---|---|---|
| `ruleset_id` / `version` | `default-integration` / `"0"` | version `"1"`（corpus irs-01 字面量） | corpus 的 `"1"` 属于其最小 valid 测试样例，非本资产内容版本；本资产以内容版本 `"0"` 起步。若主控希望与冻结语料逐字对齐可改 `"1"`（不破坏 schema，但会与 corpus 文档同 id 不同内容并存） |
| `feature_overlap.window` | 200 | 100 / 500 | 与 corpus irs-01 字面量一致；若宿主注释边界不确定性更小可收紧 |
| `repeat.min_repeat_length_bp` | 20 | 25–50 | 大肠杆菌 HR 最小同源臂 ~20–50 bp，取下限保守；若噪声过多可上调 |
| `repeat.window_bp` / `essentiality.proximity_window_bp` / `motif.window_bp` | 200（全局统一） | 100 | 单一窗口语义；若需区分注释缓冲与必需基因邻近缓冲可拆分 |
| `essentiality.essentiality_sources` | DEG ∪ Keio ∪ iML1515_in_silico（union） | 仅离线可核验子集 | union 最保守；若要求全部源离线可核验，需裁剪或绑定 condition |
| `neighborhood.origin_exclusion_window_bp` | 2000 | 500–1000 | 复制起点干扰面尺度不定，取最保守端 |
| `neighborhood.high_expression_exclude_percentile` | 90 | 85 / 95 | 表达证据口径（RNA-seq 归一化方法）未冻结，阈值依赖该口径 |
| `neighborhood.expression_evidence_required` | true（无证据 → unknown-block） | false（降级 advisory） | v0 取规格链「unknown 不默认通过」最严解读；若 bsp 认为 structural_only 场景应保留候选输出，可改 advisory |
| `motif.sequence_motif_table` | 仅 chi_site（GCTGGTGG） | 扩充（σ70 盒、rho 非依赖终止子等） | 其余候选为简并/结构基序，字面量表需先冻结定义；v0 由注释类别兜底 |
| `contextual_stability.flag_window_bp` | 2000 | 500–5000 | advisory 观察窗，无强依据 |

以上备选均为 schema 合法值，替换不破坏校验；kind/mandatory 结构与 `unknown_policy="block"` 语义（规格链 F29 冻结）不建议变更。
