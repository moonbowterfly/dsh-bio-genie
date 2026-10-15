---
name: bio-proto-design-casefile
domain: design-casefile
inputs: [基因组/特征/GEM/耦合规则/元件（design 链各段上游工件）]
outputs: [casefile 快照与校验报告、终态化报告、导出归档 bundle.zip]
requires_network: false
language: mixed
---

# design casefile 工作流协议（六工具链 → 红线校验 → 报告终态化 → 导出归档）

**适用场景**：把一段合成生物学设计（宿主底盘 → 整合候选 → 表达情景化 → 耦合后果 → 案例包）
沉淀为不可变案例包，并导出可独立复核的报告与归档。全程本地、离线可用
（reference bundle 资产前置门禁：缺失 → DEPENDENCY_UNAVAILABLE，哈希不符 → BLOCKED）。

## 步骤

1. **逐段提交进 casefile**：每个设计段先以宿主画像为起点（基因组 + 特征表 → 底盘画像），
   再找整合候选、做表达情景化（无证据元件只给排名，不给绝对表达）、做耦合后果预测
   （coupling_profile 必须已注册、哈希绑定；rule 全 miss → NOT_RUN 禁猜映射）。
2. **红线校验**：validate 前先自查三条红线（R1 CRN≠GEM / R2 分数≠bound / R3 proxy≠capacity）
   与 DAG 无环；任一 required check FAIL → 非零退出并禁止导出。
3. **报告终态化（B4 事务）**：在上一快照 S_n 上提交终态化报告（report.md）得到 S_(n+1)，
   再 validate、再 export；报告须以 `# 设计 casefile 最终报告` 开头、UTF-8、LF 行尾。
4. **导出归档**：export 产出 `report.md + bundle.zip`（含 snapshot.json / objects/ / hashes.sha256，
   确定性 STORE + 固定时间戳），落 `exports/<snap12>/`，**不入科学快照**；解压后哈希清单
   可独立复核（zip-slip/路径逃逸在验收门内拒绝）。

## 可执行模板（工具调用序列）

```text
工具调用序列（design 链六段，逐段校验再提交）：
① bio_chassis_profile      genome_files + coord_convention + contig_topology
② bio_integration_candidates host_profile_ref（或 host_profile）→ 候选排名
③ bio_circuit_contextualize  circuit + host_profile_ref → expression_scenario（禁绝对表达）
④ design_consequence        model_ref(sbml+card) + coupling_profile + scenarios → growth 方向
⑤ design_casefile_validate  casefile_dir → checks[8]（SNAPSHOT_BINDING/MANIFEST_COMPLETE/
   MANIFEST_DISK_HASH/SCHEMA/R1/R2/R3/DAG_ACYCLIC）
⑥ design_casefile_export    casefile_dir + format=both → report.md + bundle.zip
纯导出要求目标快照恰含 1 个终态化报告，否则 INVALID_INPUT/REPORT_FINALIZE_REQUIRED。
```

## 常见坑

- **report 禁含 8 类运行时熵**（case_instance_id / workdir / 临时路径 / run UUID / 实时日期 /
  stderr / bundle.zip 或 exports 路径 / snapshot_sha）——命中即拒绝提交。
- **导出不是科学快照**：exports/ 只是交付物；科学记录以 snapshot（S_n → S_(n+1)）为准。
- **consequence 只吃已复核 GEM**：model_ref 指向 CRN（kinetic_crn_ref）→ 红线 R1 FAIL。
- **别在 validate 后改 objects/**：磁盘 hash 不符 → INVALID_INPUT/OBJECT_HASH_MISMATCH；
  export 内部会重跑全部 check，篡改窗口闭合（TOCTOU 无产物）。

## 状态词表

OK / BLOCKED / NOT_RUN / INVALID_INPUT / DEPENDENCY_UNAVAILABLE / EXECUTION_ERROR
（来源：`design/failure-matrix.json#expected_status_vocab`；reason_code 取 detail 大写前缀，
无前缀回落 status）。规格：v0.5 §D2（报告终态化事务）、v0.2 §3.4（casefile 布局）。

## 验收标准

- [ ] casefile 目录含 `objects/` + `snapshots/` + `HEAD.json` + `run_receipt.jsonl`，HEAD 绑定不可变 snapshot
- [ ] 六段工具链逐段 OK 后再进下一段；任一段 NOT_RUN/BLOCKED 时不得用旧值或默认值续算
- [ ] validate 的 checks[] 8 项全 PASS 后才允许 export；红线 R1/R2/R3 任一 FAIL → 非零退出
- [ ] 终态化报告通过 8 类运行时熵门禁（无 case_instance_id/workdir/临时路径/UUID/实时日期/stderr/bundle 路径/snapshot_sha）
- [ ] 纯导出在目标快照恰含 1 个终态化报告时成功，否则 INVALID_INPUT/REPORT_FINALIZE_REQUIRED
- [ ] bundle.zip 解压到全新目录可独立复核：hashes.sha256 覆盖全部条目、无路径逃逸、无原目录路径依赖
- [ ] 全链路离线可跑（socket guard 下验证）；任何未声明 fetch → fail-closed
