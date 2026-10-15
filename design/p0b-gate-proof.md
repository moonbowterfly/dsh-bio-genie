# P0b 门禁证明总表（fixtures 级）

- 批次：E3「P0b 门禁证明（fixtures 级）」（req G-LOOP-20261015-E3-001）｜ 2026-10-15
- **本表为派生导航**：六证明点的冻结位置、门与复跑命令汇总；**规范源 = 规格链 v0.1–v0.12 + contract packet rev4 + acceptance**，一切判定以规范源为准，本表不替代规范。
- 状态词：**已证**（P0b 门禁级全绿证据）/ **部分**（E2E 级已绿，门禁级候期或缺口）/ **候 P1a-E2E**（矩阵 owner 标注，属下一阶段）/ **候 P1b**（reference 级）。

## 六证明点

| 证明点 | 冻结 fixtures | 门 / 测试文件 | 复跑命令 | 状态 |
|---|---|---|---|---|
| **schema**（packet 契约冻结） | `design/packet/**`（含 `schemas/`）rev4；M1/M9/M16 注入目标 | `test/design-gate.mjs`、`test/design-containment.mjs`、runner M1/M9/M16 | `node test/design-gate.mjs`；`node test/design-containment.mjs`；`python scripts/design_mutation_runner.py --matrix design/mutation-matrix.json --id M1` | **已证**（M1/M9/M16 均 killed；packet hash 篡改 → `CONTRACT_PACKET_UNREVIEWED` fail-closed） |
| **R1–R3**（红线链） | —（fixture 级由变异门 M12 系列覆盖，P1a-E2E） | M12-R1a/R1b/R2/R3 → `pending:B1-consequence-gate / B1-contextualize-gate / B1-coupling-gate` | 候期命令（矩阵 target_gate 未定） | **候 P1a-E2E**（owner: P0a-B1；P0b 层面已有 `design-consequence-tools.mjs` 34 断言覆盖 consequence 门禁负例，属单元级证据，非门禁击杀证据） |
| **tier**（能力分档冻结） | `design/capability-policy/policy-v0.json`（hash freeze）；M11a 注入目标 | `test/design-capability.mjs`、runner M11a | `node test/design-capability.mjs`；`python scripts/design_mutation_runner.py --matrix design/mutation-matrix.json --id M11a` | **已证**（M11a killed：`POLICY_HASH_MISMATCH`） |
| **GPR**（grow-predict-rollback） | —（M4 `pending:B1-gpr-proof`） | — | 候期 | **候 P1a-E2E**（owner: P0a-B1-gpr-proof） |
| **medium**（资产/培养基注册门） | —（M5 `pending:P1a-registry-gate`） | — | 候期 | **候 P1a-E2E**（owner: P1a-registry-gate） |
| **archive round-trip**（同 M14） | reference bundle（外置）`D:\Program\dsh-plug-develop\genie-synbio-design-20261012\reference\`（7 文件；可解包重验，commit `1fb863e`） | `test/design-archive-roundtrip.mjs`（D5 交付：hash inventory / zip-slip / 绝对路径独立复跑 / report↔manifest 一致） | `node test/design-archive-roundtrip.mjs` | **部分**：E2E 级已证（测试全绿、reference bundle 可独立复核）；门禁击杀级（M14）**候 P1b-reference**（owner: P1b-archive-gate） |

## M0–M16 状态表（design/mutation-matrix.json 实况，30 条）

| 组 | 条目 | 状态 |
|---|---|---|
| **P0b-fixture（5/5 killed，exit 0）** | M0 deterministic-replay（E3 新增，`DETERMINISM_VIOLATION`）；M1 hash-tamper-packet-file；M9 manifest-missing-entry；M11a tier-capability-tamper；M16 strict-bypass | **已证**：`python scripts/design_mutation_runner.py --matrix design/mutation-matrix.json --all-runnable` → 5 executed / 5 killed / 0 survived / 0 skipped；证据存档 `D:/Program/hermes/output/g-series-loop/e3-verify/p0b-runner.json` |
| **P1a-E2E（24 条 planned）** | M2、M3、M4、M5、M6a、M6b、M7a、M7b、M8、M10、M11-t1…M11-t7、M12-R1a、M12-R1b、M12-R2、M12-R3、M12-PT、M13、M15 | 候 P1a-E2E（matrix `not_yet_runnable: true`；`pending:B1-*` / `pending:P1a-*` 登记） |
| **P1b-reference（1 条 planned）** | M14 archive-gate | 候 P1b（reference bundle 已在 D5 验证，门禁击杀登记 `pending:P1b-archive-gate`） |

## E3 新增证据（M0 replay probe）

- 系统级拒绝接线：`src/design-casefile.js` `canonicalizeViaPacket` 单点（JSON.parse 后、c14n 子进程前）扫描 runtime metadata → 命中即 `{ok:false, code:'DETERMINISM_VIOLATION'}`；denylist 定稿 `_provenance / generated_at / captured_at / run_uuid`（`fetched_at` 因 `design/packet/schemas/genome_ref.json:102` 为合法工件字段而移除——全仓 grep 查证）。
- 冻结 fixture：`test/fixtures/design/replay-probe-input.json`（valid[3] 纯净样本 + invalid[3] tainted 样本；锚点唯一；注入片段自洽）。
- 门：`test/design-replay-probe.mjs`（17 断言：fixture 完整性 / valid 纯度 / 双跑确定性跨独立子进程+临时目录 / invalid 拒绝；通过态不打印 `DETERMINISM_VIOLATION`）。
- 全杀：M0 击杀 observed=`DETERMINISM_VIOLATION`、gate_exit_code=1、restore_verified=true；`--id M0` 单跑与 `--all-runnable` 全跑均 exit 0。

## 复跑命令（完整）

```
cd D:/Program/Github/dsh-bio-genie
node test/design-replay-probe.mjs
node test/design-mutation-runner.mjs
python scripts/design_mutation_runner.py --matrix design/mutation-matrix.json --all-runnable
python scripts/design_mutation_runner.py --matrix design/mutation-matrix.json --id M0
node test/design-casefile.mjs
node test/design-casefile-tools.mjs
node test/design-validation.mjs
node test/design-containment.mjs
node test/design-consequence-tools.mjs
npm run bench
```
（python 解释器：`C:\Users\shuai\.dsh\dsh-bio-genie\python-env\Scripts\python.exe`）
