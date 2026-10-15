# A3 Prompt Fixture 04 — 无注释 structural-only（仅结构信息请求）

> fixture_id: prompt-04-structural-only ｜ fixture_version: prompt-fixtures@1 ｜ 类别: structural-only
> 本文件属 `design/prompt-fixtures/manifest.json` 登记集（v0.2 §9 A3 / v0.3 §9 A3 强化）。
> 以下「prompt 正文」为用户语气文本，**不含任何注册工具名/skill 名**（负扫描只作用于本段）。

## prompt 正文

我手上只有一个质粒骨架的序列文件，还有几个表达元件的序列和 kind 标记（启动子、RBS 之类），
没有任何注释文件、没有特征表，也没有模型。

我想先知道这个结构现在能往下走多少步：能不能做底盘相关的分析？能不能做表达情景化？
缺的东西你列个清单告诉我就行——没有注释、没有模型的情况下，不要硬出结论，也不要拿
默认值冒充我的材料。

## 预期终态预登记

| 项 | 值 |
|---|---|
| expected_status | BLOCKED |
| expected_reason | BLOCKED |
| 触发门 | 结构信息不足以驱动设计链：无模型引用（model_ref 缺失）→ 拒绝，列缺失项不猜映射 |
| check_id | design_consequence.py::load_model_ref（无 sbml_path / 文件不存在 → `ToolError("BLOCKED", "model_ref sbml 缺失")`；无前缀 → reason 回落 BLOCKED） |
| 查证引用 | design_consequence.py:93-94；前置路径 design_casefile.js::resolveCaseOperations（空 case → missing_annotation，consequence 缺 coupling/注释时 deny）；v0.2 §7.8（缺依赖 → 明确报告，不静默降级） |
| test_ref | test/design-prompt-fixtures.mjs::F04（本批登记；A3 实跑验收留后续批次） |
| note | 若 agent 先行案例包 stage：无注释 → missing_annotation 状态（fail-closed，同属拒绝）；若用户补 model/card 后走 consequence → 以 strain 门/哈希门为准（同 prompt-03 登记） |
