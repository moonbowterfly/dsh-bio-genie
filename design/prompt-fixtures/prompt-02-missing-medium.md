# A3 Prompt Fixture 02 — 缺 medium（依赖资产缺失场景）

> fixture_id: prompt-02-missing-medium ｜ fixture_version: prompt-fixtures@1 ｜ 类别: missing-medium
> 本文件属 `design/prompt-fixtures/manifest.json` 登记集（v0.2 §9 A3 / v0.3 §9 A3 强化）。
> 以下「prompt 正文」为用户语气文本，**不含任何注册工具名/skill 名**（负扫描只作用于本段）。

## prompt 正文

我想预测这个菌株在一种特定培养基里的生长变化。培养基的组分文件我这边找不到了，只有手写的
组分说明：基本盐加上葡萄糖，另外还有一个复合物交换组分，那个交换反应我不确定是不是在模型里
能对上。我有一条耦合规则：把葡萄糖摄取下界放宽到 -5，想看看在这种培养基定义下生长方向的
后果，用默认生物量目标、一个扰动场景就够了。

请直接按我手写的组分去跑。如果某个组分在模型里根本不存在，或者培养基资产缺失导致算不了，
就直接停下来告诉我，不要挑能算的组分偷偷忽略掉。

## 预期终态预登记

| 项 | 值 |
|---|---|
| expected_status | INVALID_INPUT |
| expected_reason | INVALID_INPUT |
| 触发门 | medium 条目引用的反应在模型中不存在 → 拒绝，不静默剔除 |
| check_id | design_consequence.py::solve_baseline（medium 反应存在性门：`rid not in {r.id for r in model.reactions}` → ToolError INVALID_INPUT "medium 反应不存在"；detail 无大写前缀 → reason 回落 status） |
| 查证引用 | design_consequence.py:200-203；v0.2 §8.1（fail-closed，禁静默剔除）；A5 矩阵 F01 同类 reason 回落规则（design_host.py:1460-1466） |
| test_ref | test/design-prompt-fixtures.mjs::F02（本批登记；A3 实跑验收留后续批次） |
| note | 若 agent 先行案例包 stage 且卡/资产缺失，前置门为 DEPENDENCY_UNAVAILABLE/BLOCKED（REFERENCE-REGISTRY §5）；本登记以 consequence 层为准（prompt 直接请求预测） |
