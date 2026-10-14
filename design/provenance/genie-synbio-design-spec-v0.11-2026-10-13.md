# dsh-bio-genie「基因组感知的基因线路设计 + 设计后果推理」V1 设计规格

**v0.11 · 冻结候选（修复复核 10 的唯一阻断） ｜ 2026-10-13 ｜ 主笔: Hermes bsp**
**req_id: H-20261012-002 / seq: SPEC-FREEZE-8（最终确认轮）**
**基线**: v0.10 + Codex 复核 10（`genie-synbio-design-spec-review-10-2026-10-13.md`，3,428 字符；该轮已完成并独立复验 I1 执行器）
**性质**: 修复 O1–O3；其余沿版本链 v0.1→v0.10。

---

## J1. pattern 成员映射（唯一阻断项修复；**逐字采用复核 10 建议条款**）

> 本条替代 v0.9 §H3 的 pattern-member 表述：schema 中 `pattern` 的已解码字符串，其 UTF-8 字节必须逐字节等于且仅等于 `common.defs.json#/patterns/<name>/pattern` 的 UTF-8 字节。两个条目的 `pattern` 字节相同即为 `PATTERN_LIBRARY_AMBIGUOUS` 并由 lint 拒绝；唯一命中的条目之 `match_mode`、`domain`、`max_len` 为必须执行的约束。

（效果：schema `pattern` ↔ library 成员判定唯一化；重复 literal 拒绝；命中条目的元数据约束强制生效。）

## J2. `x-decimal-string` 定位澄清（P0a 级消歧，一并写入）

> `x-decimal-string` 在原生 JSON Schema validator 中仍是 annotation；但在 casefile 三个语义校验门中，I1 的 DECIMAL_STRING 是强制验证规则并优先于 pattern。

## J3. I1 步骤 2 显式化（可机械翻译；附 corpus 增补）
- I1 步骤 2 显式分支：`if i == len(s) or s[i] not in [0-9]: reject`（消除 `"-"` 在不同语言中越界/undefined 比较的实现差异）。
- corpus 增补（最小集）：`"-"` → 拒、`"--"` → 拒、`"-."` → 拒。

## §22. 评审发现处置表（复核 10 → v0.11）

| # | 发现（复核 10） | 处置 | 落点 |
|---|---|---|---|
| O1 | I2/H3 成员映射未定死（对象化 library vs 字符串成员规则） | **逐字插入**替代条款 | §J1 |
| O2 | annotation/强制规则定位待消歧（P0a 级） | 逐字插入澄清句 | §J2 |
| O3 | I1 步骤 2 显式分支（P0a 级） | 本版显式化 + corpus 增补 | §J3 |

（复核 10 总评明确：「补齐该映射后即可冻结为 `v1.0-架构基线`」；本版请求据此确认冻结。）

—— v0.11（冻结候选）完。请最终确认：**O1–O3 闭合判定 + v0.11 是否可冻结为 v1.0-架构基线**（可 / 否：[仅列阻断项]）。
