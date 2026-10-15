# A3 Prompt Fixture 03 — GEM-strain mismatch（菌株与模型不匹配场景）

> fixture_id: prompt-03-gem-strain-mismatch ｜ fixture_version: prompt-fixtures@1 ｜ 类别: gem-strain-mismatch
> 本文件属 `design/prompt-fixtures/manifest.json` 登记集（v0.2 §9 A3 / v0.3 §9 A3 强化）。
> 以下「prompt 正文」为用户语气文本，**不含任何注册工具名/skill 名**（负扫描只作用于本段）。

## prompt 正文

我要给大肠杆菌的一个特定菌株做生长后果预测。我手里有一份模型卡，里面声明了这个模型的
哈希值；但我下载到的模型文件好像是另一个菌株版本的，我不能确定它对不对得上。

请你先核对一下：模型卡里声明的哈希和实际模型文件算出来的哈希是否一致。如果对不上，说明
卡和模型不是同一个东西，就不要再往下做任何预测了，直接停住并告诉我哪里不一致。如果一致，
再继续用默认生物量目标做生长预测，耦合规则是葡萄糖摄取下界放宽到 -5，一个扰动场景。

## 预期终态预登记

| 项 | 值 |
|---|---|
| expected_status | BLOCKED |
| expected_reason | BLOCKED |
| 触发门 | strain 匹配门：card 声明 model hash ≠ 实际 SBML 哈希 → 拒绝（fail-closed，不往下算） |
| check_id | design_consequence.py::load_model_ref（strain 匹配：card 内 model_sha256/sbml_sha256/model_hash 与磁盘 SBML 实测比对 → `ToolError("BLOCKED", "strain 不匹配：card 声明 … vs 实际 …")`；无前缀 → reason 回落 BLOCKED） |
| 查证引用 | design_consequence.py:104-124（:110-112 比对、:123-124 抛 BLOCKED）；v0.2 §8.1（不匹配资产不得驱动定量结论） |
| test_ref | test/design-prompt-fixtures.mjs::F03（本批登记；A3 实跑验收留后续批次） |
| note | 同场景另一入口：chassis 侧 genome fna 哈希不符 → BLOCKED/HASH_FAILED（design_host.py::_verify_input_files:163-165）；本登记以 consequence 层 strain 门为准（prompt 直接请求预测） |
