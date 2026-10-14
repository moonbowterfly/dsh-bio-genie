# 双端 Conformance 报告（c14n + schema corpus + 环境版本）

- req_id：G-LOOP-20261015-E2-001
- 日期：2026-10-15（生成时刻 UTC：2026-10-14T22:24:59.866Z）
- 生成命令：`node scripts/conformance-report.mjs --out design/conformance/conformance-result.json`
- 结论：**PASS**（退出码 0；双端全等 = PASS，任一不一致 = FAIL fail-closed）

## 1. 运行环境版本表（本次运行实测）

| 侧 | 组件 | 版本 |
| --- | --- | --- |
| node | node | v26.7.0 |
| node | ICU | 78.3 |
| node | Unicode 数据版本（`process.versions.unicode`） | 17.0 |
| node | V8 | 14.6.202.34-node.28 |
| node | ajv（`node_modules/ajv`） | 8.20.0 |
| python | python | 3.12.10 |
| python | 平台 | Windows-11-10.0.26300-SP0 |
| python | Unicode 数据版本（`unicodedata.unidata_version`） | 15.0.0 |
| python | jsonschema | 4.26.0 |
| python | referencing | 0.37.0 |
| 平台 | node `win32`/x64 · python `Windows-11-10.0.26300-SP0` | |

> 与既有证据记录 `design/packet/evidence/conformance-environment.txt`（2026-10-13）对比：
> 差异：**python** 记录 3.12.11 → 本次实测 3.12.10。

## 2. schema corpus（99 例）双端一致性

- 语料：`design/packet/schema-corpus/schema_cases.json`（99 例；期望分布：valid 28 / invalid 71）
- TS 侧：`node src/design-validate.js --batch`（ts-prod，ajv 8.20.0）
- PY 侧：`python python/design_validate.py --batch`（py-prod，jsonschema 4.26.0）
- 判定（valid/invalid）双端全等：是（不一致 0 例）
- core_valid 双端全等：是（不一致 0 例）
- sem 双端全等：是（不一致 0 例）
- c14n 层双端全等：是（不一致 0 例）
- vs 语料期望全等：是（不一致 0 例）
- vs packet 冻结结果（node/python 双侧）全等：是（不一致 0 例）
- 不一致清单：**空**

## 3. c14n corpus（58 例）双端一致性

- 语料：`design/packet/corpus/c14n_cases.json`（58 例；期望分布：accept 43 / reject 15）
- JS 侧：`node design/packet/impl/c14n.mjs --batch`（node）
- PY 侧：`python design/packet/impl/c14n.py --batch`（python）
- 判定（accept/reject）双端全等：是（不一致 0 例）
- canonical 字节双端全等（accept 43 例）：是（不一致 0 例）
- vs 语料期望（status）全等：是（不一致 0 例）
- vs 冻结 canonical 全等：是（不一致 0 例）
- reject code 双端差异（warn，不阻断）：0 例
- 不一致清单：**空**

## 4. 失败 / 警告明细
- 失败：无
- 警告（1）：
  - [env] evidence delta python: prior=3.12.11 now=3.12.10

## 5. 方法 / 边界披露

- 复跑命令：`node scripts/conformance-report.mjs --out design/conformance/conformance-result.json`（重跑即重新生成本报告与 JSON）
- fail-closed 判定：双端任一不一致（判定 / sem / canonical 字节 / vs 语料期望 / vs packet 冻结结果）或任一运行失败、结果缺失 → 结论 FAIL、退出码 1；c14n reject code 双端差异与既有证据记录的环境版本差异仅警告不阻断。
- Unicode 数据版本不对称：node ICU 78.3（Unicode 17.0）vs python unicodedata 15.0.0；本报告的全等结论仅对该环境组合成立，任一版本变化需重跑。
- 范围：本次运行只新增本报告与 `scripts/conformance-report.mjs`；未修改 `design/packet`、`design/acceptance*`、`design/capability-policy` 字节，未改动既有测试与实现，未执行 git 操作。
