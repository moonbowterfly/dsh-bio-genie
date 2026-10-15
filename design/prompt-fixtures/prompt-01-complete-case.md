# A3 Prompt Fixture 01 — 完整 reference case（可解链全链路）

> fixture_id: prompt-01-complete-case ｜ fixture_version: prompt-fixtures@1 ｜ 类别: complete-reference-case
> 本文件属 `design/prompt-fixtures/manifest.json` 登记集（v0.2 §9 A3 / v0.3 §9 A3 强化）。
> 以下「prompt 正文」为用户语气文本，**不含任何注册工具名/skill 名**（负扫描只作用于本段，
> 扫描集见 manifest）。

## prompt 正文

我在做一个大肠杆菌宿主的底盘设计，材料如下：基因组序列文件、一份特征表（坐标是 0-based
half-open 的，里面那个 4200 bp 的小环是环状分子）。请你按下面几步帮我把这个设计走完：

1. 先把这份基因组和特征整理成一份宿主底盘画像，给出基因组参考信息和宿主概况，确认环状拓扑
   没有被当成线状处理；
2. 在这个宿主里找一批适合做基因组整合的候选位点，给出排名和依据；
3. 我有一段表达元件（启动子，只有 kind 标记和序列），想把它放到这个宿主里做表达情景化，
   看看元件按证据怎么排名、能不能给出耦合草案——注意没有证据的元件不要给绝对结论；
4. 我有一条耦合规则：把葡萄糖摄取的下界放宽到 -5。请用默认的生物量目标，预测这条规则对
   生长方向的后果，并声明两个扰动场景来检验方向是否稳健；
5. 最后把以上所有材料整理成一个完整案例包：做一次整体校验，确认所有工件一致、无红线冲突，
   然后导出报告和一份可归档的打包文件。

如果哪一步缺材料或条件不满足，请明确告诉我缺什么，不要跳过、不要猜。

## 预期终态预登记

| 项 | 值 |
|---|---|
| expected_status | OK |
| expected_reason | OK |
| 链路预期 | 五段逐段 OK：底盘画像→整合候选→表达情景化→后果预测→案例包校验导出 |
| check_id | design_host.py::op_design_chassis_profile / op_design_integration_candidates / op_design_circuit_contextualize（正路径 OK）；design_consequence.py:248-257（rule 命中 + baseline optimal → OK）；design_casefile.py::op_design_casefile_validate（CHECKS 8 项全 PASS） |
| 查证引用 | v0.2 §9 A3（可解链完整请求）；design_consequence.py:198-218（solve_baseline optimal 门）；design_consequence.py:255-257（apply_rules）；design_casefile.py:680-685（export 前重跑 check） |
| test_ref | test/design-prompt-fixtures.mjs::F01（本批登记；A3 实跑验收留后续批次） |
| note | 本 fixture 只登记预期，不做真实 dsh 运行；实跑批需 iML1515 + card（reference bundle 冻结锚点） |
