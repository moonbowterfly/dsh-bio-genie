# test/fixtures/design — 小型设计 fixtures 登记表

> 入仓任务：G-LOOP-20261015-FX-001（冲刺轨 2 · 豆包）｜ 2026-10-15
> 仓库基准：master `1fb863e`。本目录**只新增文件**，未 commit（bsp 核验后统一提交）。
> 字节纪律：全部 6 文件以二进制模式（`copy /B`）复制，实测 SHA256 与源目录一致（见 §4 校验）。

## 0. 背景与对应关系

**[P1-8]（IMPL1 评审）**：「当前 Genie checkout 尚无 `design/`、`test/fixtures/design/` 或已追踪的
MG1655 / iML1515 reference bundle」——本目录解决其中**小型 fixtures 入仓**部分；外置大资产
（MG1655 / iML1515）的登记与许可核验由 RR 任务完成
（`design/reference-bundle/REFERENCE-REGISTRY.md`，commit `1fb863e`）。

**工作单对应**：`notes/P0A-WORK-ORDER.md`（P0a 工作单）§C「资产（reference bundle v0）」条目
**「环形坐标夹具 + 15 候选期望向量（自校验 OK）」**。本目录为该条目的物化交付：
环形基因组夹具（`fixture_circular.fna` + 特征表 + 候选表）+ 15 候选期望向量
（`fixture_expected_vectors.json`）+ 生成器/自校验脚本 + 哈希清单 + 本登记表。

## 1. 登记表（6 文件）

| 文件 | 大小(字节) | 用途 | 来源 | SHA256（实测） | 与期望向量的关系 | 复现方法 |
|---|---|---|---|---|---|---|
| `fixture_circular.fna` | 4337 | 环形基因组夹具 FASTA：单记录 `synth_circ_4200`（4200 nt，circular，ruleset=R0-draft），含跨原点（oriCDS）与直接重复（rep1/rep2）布局 | 生成器生成（固定种子 seed=20261012） | 0d6c7fa7d450ef056bc6a677c5cc2970f58d453b7ecb51811fea3135c8c8dfc8 | 期望向量 JSON 顶层 `fasta_sha256` 字段绑定本文件（实测一致） | `python make_circular_fixture.py` |
| `fixture_features.tsv` | 500 | 特征表：8 个 feature（CDS/rRNA/tRNA/repeat），0-based half-open 分段；跨原点特征 oriCDS 以两段表示（3950-4200;0-100） | 生成器生成 | 0f440c5bdf6ee97ae8f04745edf73b8c27707d064ac744d4bc817295375efff4 | 期望向量中每个候选的 `features_hit` 由本表特征计算 overlap_nt 得出 | `python make_circular_fixture.py` |
| `fixture_candidates.tsv` | 610 | 候选位点表：15 个候选插入窗口（C01–C15，payload 40/50/70 nt），覆盖基因内/基因间/跨原点/重复区等语义场景 | 生成器生成 | ff15cef7b85bbb03e38dc26c775aa2e5c0fb9f664d2132837127655055997f9d | 与期望向量 `candidates[]` 按 `candidate_id` 一一对应（segments 同源） | `python make_circular_fixture.py` |
| `fixture_expected_vectors.json` | 12115 | 15 候选期望向量：`classification`（12 excluded / 3 screened_candidate）、`rule_id`（R0-1/2a/2b/3/4）、`features_hit`（feature_id/type/strand/overlap_nt）、`flank_left_60`/`flank_right_60`（seq+sha256）、顶层 `fasta_sha256` 绑定 | 生成器生成 | 49bd8415749ae79eeca3bb523f957122cd7f7e8392451b64587d285161884b6f | 本体：P1a 语义 oracle 冻结对照值（见 §3） | `python make_circular_fixture.py` |
| `make_circular_fixture.py` | 9710 | 夹具生成器/自校验脚本（确定性：固定种子；`--verify` 重推导比对）；同时为复现工具 | 外置 fixtures 源目录冻结（2026-10-12，任务输入） | b254fd2b35c20a2dac58bb7b3dcf71c228c7a063e48b7ee5956c4a4cc5b1391c | 生成全部期望向量（复跑可复现，见 §2） | 不适用（生成器自身为冻结入仓） |
| `SHA256SUMS-fixture.txt` | 359 | 4 个数据文件的 SHA256 清单（生成器写入；不含生成器自身与清单自身） | 生成器生成 | a1c957ab04702484aa1474233fed28a2254cbaa01dfbb8725aac8c58d2f1928d | 覆盖 fna/features/candidates/expected_vectors 四文件哈希 | `python make_circular_fixture.py` |

## 2. 复现方法（make_circular_fixture.py 用法）

- `python make_circular_fixture.py` — 在**脚本所在目录**生成 5 个文件：
  `fixture_circular.fna`、`fixture_features.tsv`、`fixture_candidates.tsv`、
  `fixture_expected_vectors.json`、`SHA256SUMS-fixture.txt`（清单仅列 4 个数据文件）。
- `python make_circular_fixture.py --verify` — 从冻结文件重推导期望向量并比对，输出 `VERIFY: OK`（exit 0）。
- 确定性：固定种子 `SEED=20261012`、长度 `L=4200` → 复跑产物字节一致。
- ⚠️ 本目录内直接复跑会**覆盖已入仓文件**；复跑须在临时副本目录进行。
- **本次复跑记录（2026-10-15）**：在临时目录复跑 → WROTE 5 文件全部 SHA256 与源一致（5/5 MATCH），
  `--verify` 输出 `VERIFY: OK`（exit 0）→ **可复现**。

## 3. 「P1a 前证据」定位

- **可供 P1a 复核的期望值**（`fixture_expected_vectors.json`，15 候选）：
  - `classification` + `rule_id`：12 excluded（R0-1/2a/2b/3）+ 3 screened_candidate（R0-4）；
  - `features_hit`：每个候选命中的 feature_id/type/strand/overlap_nt 明细；
  - `flank_left_60` / `flank_right_60`：候选两侧 60 nt 序列 + 各自 sha256（与序列自洽，已核验）。
- **冻结绑定链**：向量 JSON 顶层 `fasta_sha256` ↔ `fixture_circular.fna`（实测一致）；
  对应 mutation-matrix M2/M3（semantic-oracle-ring-fixture / semantic-oracle-expected-vector）：
  期望向量单独冻结并 hash 绑定，语义 oracle 对照漂移须报红。
- 本目录为工作单 C 节待办**「小型证据表（P1a 前）」**提供前置数据源。

## 4. 校验

核对脚本：`scripts/validate_design_fixtures.py`（独立可复跑，fail-closed）：

```
cd /d D:\Program\Github\dsh-bio-genie
"C:\Users\shuai\.dsh\dsh-bio-genie\python-env\Scripts\python.exe" "scripts\validate_design_fixtures.py"
```

预期：`RESULT: PASS`（exit 0）+ 源目录对照 6/6 字节一致（源目录不可达时该项降级为 SKIP 告警，不影响仓库内校验结论）。
