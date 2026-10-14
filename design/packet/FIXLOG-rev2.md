# packet rev2 修复计划（staging — 待审阅报告完整后应用）

> 触发：packet-review-1 独立审阅已锁定的发现（审阅进行中，此为已证实部分；完整清单待报告落盘）。
> 原则：① rev1 保持冻结（审阅引用了其哈希）——修复一律进入 **rev2**（新 packet index，bundle 内容不变）；② 每条修复必须有**负向验证**（坏化副本上必须报红）。

## 已证实的发现 → 修复映射

### F1（阻断链·复现性）锁文件 README 的 Node 复现命令因 ESM 依赖解析失败
- 现象：`node <packet>/build/check_compile.mjs` 从 npm-ci 工作区运行时，`import "ajv"` 按**脚本所在目录**解析（非 cwd）→ ERR_MODULE_NOT_FOUND。
- 修复：node 侧脚本一律改用 **`createRequire(workspace)`** 解析依赖（`AJV_WORKSPACE` env 或参数指定 npm-ci 工作区）；脚本可在任意位置运行、无需复制。涉及：`check_compile.mjs`、`run_schema_corpus.mjs`（去掉 copy-to-scratch 机制）、`meta_smoke.mjs`。
- 负向验证：从全新 npm-ci 工作区按 README 命令逐一跑通；把 ajv 拿掉 → 必须给明确诊断而非静默。

### F2（阻断链·变异可检性）编译器/检查器硬编码绝对路径 → 坏化副本上仍全绿
- 现象：`check_compile.{py,mjs}`、`meta_smoke.{py,mjs}` 硬编码 `D:/Program/.../packet`；复制包做坏化实验时仍读原树。
- 修复：所有脚本 packet 根 = **自身位置相对推导**（`__file__`/`import.meta.url`），env `PACKET_ROOT` 可选覆盖；无一机器绝对路径（build 自检：`grep -r "D:/Program" build evidence schema-corpus corpus` 必须为空）。
- 负向验证（复现审阅方法）：复制包 → 坏化 → 跑**副本内的**检查器 → 必须报红。

### F3（阻断项）文档化 lint（L1–L12）不是可执行实体
- 修复：新增 `build/packet_lint.py` = **单一权威可执行 lint**：L1–L12 全部 + manifest 交叉核验 + 索引（HASHES / SHA256SUMS）核验；稳定错误码；`make_schemas.py` 改为调用它（去重）；x-canonical.meta.json 的 lint_checks 与代码逐一对应。
- 负向验证：`build/lint_mutation_check.py` 劫化台架——对临时副本逐一注入 S1–S12 违规，**每一例都必须被 packet_lint 以预期错误码杀死**；无注入时全绿。

### F4（次要）pattern_samples.py 内联复制字面量（双源漂移 + 破坏「同源判定」）
- 修复：改为从 `meta/common.defs.json`（自身位置相对）读取字面量。

### F5（次要）run_schema_corpus.py 的 DEFAULT_NODE_CWD 硬编码 scratch
- 修复：改为必填 `AJV_WORKSPACE`（或 `--node-workspace`）；未设时 fail-closed 给明确指引。

## 不动的部分（bundle 内容）

23 schema + 2 meta 一字不动 → `bundle.manifest.json` 哈希预计保持 `e0fb1fd0…`（若验证阶段发现必须的 schema 修补，再另行记录）。packet index / acceptance 模板相应更新到 rev2 值。

## 应用流程（审阅报告到手后）

1. 收完整报告 → 逐条独立复核（补齐可能的额外发现）。
2. 建立 `packet-rev2/`（从 rev1 复制）→ 应用 staging 修复 → 全链重跑（生成 → 编译 → 双语料 → 样例 → lint → 劫化台架）→ 全新环境复验。
3. 重算索引与绑定（HASHES / SHA256SUMS-packet / BINDINGS）→ 更新 acceptance 模板。
4. 投递复验轮（窄范围）→ 通过后物化 packet_acceptance → 升级 v1.0-实现基线。

---

## rev2 候选验证结果（2026-10-13，应用修复后即测）

| 检查 | 结果 |
|---|---|
| build/packet_lint.py（无注入） | PACKET_LINT: PASS |
| build/lint_mutation_check.py | **13/13 劫化全杀 + baseline green**（ALL KILLED） |
| 双端编译（py / mjs via AJV_WORKSPACE） | ALL OK（23 / 23） |
| schema 语料（双端） | cases=96 fails=0 ALL_PASS |
| c14n 语料 | cases: 53 fails: 0 \| ALL_PASS |
| pattern 样例（双端） | 25/25 ALL_PASS |
| meta smoke（双端） | ALL PASS |

环境：ostir-preflight venv（python）+ scratch/ajv-probe（node，AJV_WORKSPACE）。
备注：待审阅方完整报告；如有新增发现将并入 rev2 后再次提交复验。

---

## 审阅终判（2026-10-13）与裁决

报告：`D:\Program\sharespace\genie-synbio-design-packet-review-1-2026-10-13.md`
（sha256 `0c40692f07287fa3a8a56e01f8ca08a3ffaa6e152faafa318be26031af11f8d2`）
**判定：否——仅列阻断项：P0-1..P0-5。**

逐条独立复核后**全部接受**（无需申诉）：
- P0-1 第三 Ajv keyword：审阅正确——"loader-only"不构成豁免。采纳审阅选项 2：library 迁址为独立非 Schema resource（v0.12 §K1）。
- P0-2 registry 未由 manifest 驱动：正确。修 = 双端 bundle_loader + 全 runner 接入 + 4 杀手例（§K2）。
- P0-3 J1/I2 未执行 + Node 裸 .test()：正确。修 = 显式 wrapper + domain/max_len 执行 + lint 可执行化 + 固定负测（§K3）。
- P0-4 Unicode 15/17 NFC 实际分叉（U+1ACF 反例）：正确。修 = 冻结 UCD 15.0 表 + NFC 前闸门（§K4）。
- P0-5 复跑根/只读/镜像：正确。修 = canonical root + 只读默认 + 自证头 + verify_mirror（§K5）。

规格修订已立项：`D:\Program\sharespace\genie-synbio-design-spec-v0.12-2026-10-13.md`（随 rev2 复验轮提交）。

### rev2 实施状态（v0.12 轮）
- [x] K1 机制：pattern-library.json 拆分（make_meta 双输出）
- [x] K2 机制：bundle_loader.py/.mjs（本目录）
- [ ] K2 接线：全部 runner 经 loader（进行中）
- [ ] K3：wrapper/domain/max_len/lint-L13/负测（进行中）
- [ ] K4：unicode 表 + 闸门 + corpus（待）
- [ ] K5：只读默认 + 自证头 + verify_mirror（进行中）

---

## rev2 (v0.12) 完成态（2026-10-13）

五项阻断修复全部**机制落地并自验**：
- K1 pattern-library 迁址：common.defs 为纯 Schema；注册恰两 keyword（L13 校验）；lint PASS 不再依赖第三注册。
- K2 bundle_loader.{py,mjs}：全 runner 经 manifest 驱动；4 杀手例（缺 meta/篡改/注入/库目标 ref）全部被杀死。
- K3 显式 wrapper + domain/max_len 执行；pattern 样例扩至 37 例（含 wrapper 契约对抗例）；R1/R2/R2b 变异全杀。
- K4 unicode-domain-table（715 ranges）+ §1a 闸门；c14n 语料扩至 58 例（含 U+1ACF 反例/非字符/私用区/星体面）；R3/R4 闸门剥离变异全杀。
- K5 canonical root + 只读默认 + 自证头（全部 runner）+ verify_mirror.py。

终态验证（本目录）：
- packet_lint: PASS；劫化台架: **22/22 ALL KILLED + baselines green**（16 lint + 5 runner + 1 说明）
- 双端编译 23/23 + 23/23；c14n 语料 58/58（冻结）；schema 语料 96/96；pattern 样例 37/37 双端；meta smoke 双端 PASS；manifest 27 条目（`1f4c0dfc…`）
- profile rev2026-10-13b（`cfe0b23c…`）；BINDINGS 全量重算（含 v0.12 spec `3b0bf115…`）
- 待做：镜像入链（sharespace）+ SHA256SUMS + verify_mirror → 复验轮提交。

---

## rev3（v0.13）修复轮记录（2026-10-13；对 packet-review-rev2 四项残余）

- P0-1 残余（契约矛盾 + 链断裂）：schema_helpers ← pattern-library.json；链闭环入台架（make_meta→make_schemas→make_manifest→make_index→lint→双端编译，字节稳定复现）；probe_ajv v3 + validator-probe-results 重生成；L10/length_accounting/validator-init 文本归一；packet_lint L13 扫描保障。
- P0-2 残余（loader 旁路）：run_corpus 先经 bundle_loader（REGISTRY_UNRESOLVED / exit 2，任何语义计算前），ranges 以已验证字节注入双端（py set_domain_ranges / node --domain-json）；R5 空白篡改负测被杀死。
- P0-3 残余（码/单位/序）：domain 先行 + Unicode 标量计数；schema 语料 sem-code 逐项比对；新增 gvr-07/08/09 反例；样例 40 例逐例精确码；R6/R7 序回归被 sem-code mismatch 杀死；length_accounting 等价条件写入契约（K3 解除条件替代分支）。
- P0-5 残余（只读/自足）：全部 py runner dont_write_bytecode + 子进程环境自固定；自证头齐备（root/manifest/index）；check_readonly_replay 树级 bit-identical PASS；台架在无用户环境变量的 Windows 会话自足（ALL KILLED）。
- 终态：lint PASS；台架 25+链+基线 ALL KILLED；编译 23/23×2；c14n 58/58；schema 99/99；样例 40/40；manifest fef3b1135036cfb8…；两侧均携带索引（各自可独立验证）。

---

## rev4（P0-2/P0-5 残余修复）记录（2026-10-14；对 packet-review-rev3 两项阻断）

- P0-2：c14n 双端 CLI 移除路径回退 → 自跑等价 verified loader；失败 REGISTRY_UNRESOLVED/exit 2；R5b/R5c 负测（直接 CLI + whitespace tamper）双双被杀死（rc=2 marker=REGISTRY_UNRESOLVED）。
- P0-5：18 个 py 入口固定 UTF-8 stdout/stderr（4 个纯 ASCII 生成器同样补 pin）；check_readonly_replay 剥离四变量构造净环境；run_schema_corpus.mjs self-cert header 落 stderr（stdout 纯 JSON）；净环境回放 PASS（9/9 runner rc=0，tree bit-identical）。
- 非阻断：schema_helpers/make_manifest 文案同步；probe_ajv.mjs 统一 AJV_WORKSPACE 入口。
- 终态：lint PASS；台架 27 杀全灭 + 链闭环 + 5 基线；编译 23/23×2；c14n 58/58；schema 99/99；样例 40/40；净环境回放 PASS。
