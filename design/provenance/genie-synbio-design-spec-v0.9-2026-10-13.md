# dsh-bio-genie「基因组感知的基因线路设计 + 设计后果推理」V1 设计规格

**v0.9 · 冻结候选（修复复核 8 的两处矛盾） ｜ 2026-10-13 ｜ 主笔: Hermes bsp**
**req_id: H-20261012-002 / seq: SPEC-FREEZE-6（最终确认轮）**
**基线**: v0.8 + Codex 复核 8（`genie-synbio-design-spec-review-8-2026-10-13.md`）
**性质**: 修复 M1–M5（$ref 资源模型统一 / decimal-string 真值规则修正 / pattern 白名单澄清 / P0a 增补 / 工作单同步）；其余沿版本链 v0.1→v0.8。

---

## H1. `$ref` 资源模型（统一；替换 G1.1/G1.2 相应文字）

- **文件身份**：manifest 内**每个文件**（`schemas/*` 与 `meta/*`）具有唯一规范 `$id`：`bundle://<exact-manifest-path>`（逐字节匹配 manifest 路径；大小写敏感；不做 percent-encoding）。
- **`$ref` 允许形式（仅两种）**：
  (a) **绝对形式**：`bundle://<exact-manifest-path>`（可加 `#<JSON Pointer>`）——**可引用 schemas/* 与 meta/* 的任意文件（含 `common.defs.json`）**；
  (b) **同文件片段形式**：`#<JSON Pointer>`（相对本文档 `$id` 解析）。
- **禁止**：相对引用、远程协议（http/https/file 等）、bundle 外逃逸、动态 loader/retrieve callbacks。
- **错误码**：`REF_FORM_INVALID`（形式不符）/ `REGISTRY_UNRESOLVED`（不在 manifest 或 hash 不符）/ `REF_ESCAPE`（越界）。
- **registry**：双端从**同一 manifest/hash 集合**预注册不可变本地 registry（禁止任何网络或文件系统回调）。

## H2. decimal-string 真值规则（定死；含真值表）

- **canonical 词法（修正）**：`^(0|-?(0\.[0-9]*[1-9]|[1-9][0-9]*(\.[0-9]*[1-9])?))$`
  （修正点：单独 `-0` 不合法；`0` 合法；小数尾不得为零；无指数、无 `+`。）
- **真值表**（corpus oracle 逐字节采用）：

| 输入 | 判定 | 输入 | 判定 |
|---|---|---|---|
| `"0"` | 收 | `"-0"` | 拒 |
| `"12"` | 收 | `"0.0"` | 拒 |
| `"-12"` | 收 | `"1.0"` | 拒 |
| `"0.5"` | 收 | `"1.00"` | 拒 |
| `"-0.5"` | 收 | `"1e3"` | 拒 |
| `"12.34"` | 收 | `"00.1"` | 拒 |
| `"10.01"` | 收 | `"+1"` | 拒 |
| `"0.001"` | 收 | `"1."` / `"01.2"` | 拒 |

- 非 canonical 输入 = 拒绝（`DECIMAL_STRING_NONCANONICAL`，不归一）。
- **配对约束**：标注 `x-decimal-string: true` 的 string 节点必须同时携带 canonical decimal `pattern`（逐字节等于 `common.defs.json` patterns 集合成员）；lint 强制配对。

## H3. `pattern` 白名单（澄清 G1.4，消除"引用机制"歧义）

- V1 的 `pattern` 关键字**只接受**逐字节等于 `common.defs.json` 的 `patterns` 集合成员的值（集合成员判定）；**不存在** pattern 的 `$ref` 机制；集合外的任何自由字面量 → lint 拒绝。
- `common.defs.json` 的 patterns 集合必须包含（至少）：canonical decimal（H2 配对用）、sha256 hex、JSON Pointer、bundle 路径、ISO 时间戳；完整集合随 packet 冻结。

## H4. P0a 清单增补（复核 8 项）
1. `packet_acceptance` 进一步 schema 化：producer / 存储位置 / review-policy identity / 撤销与过期语义（hash-bound 方向保留为架构层要求）。
2. checksum/index 文件自身的 hash 纳入最终 packet manifest（checksum 文件是完整性索引，非独立信任根）。

## H5. 工作单同步（已完成）
- `P0A-WORK-ORDER.md` 已更新：A7 补 `allErrors: true`；规范来源层级表述统一（"派生物，非规范来源"定位保持）。

## §20. 评审发现处置表（v0.8 → v0.9）

| # | 发现（复核 8） | 处置 | 落点 |
|---|---|---|---|
| M1 | `$ref` 资源模型自相矛盾（meta/* 无法被引用等） | 统一模型：全体文件 `$id`；两种允许形式；错误码与 registry 规则定死 | §H1 |
| M2 | decimal-string 真值规则自相矛盾（`-0` 等） | 修正 regex + 逐字真值表 + 配对约束 | §H2 |
| M3 | pattern"引用"机制歧义 | 澄清为白名单集合成员判定（无 ref 机制） | §H3 |
| M4 | P0a 增补（acceptance schema 化 / checksum 索引 hash 入 manifest） | 已并入 | §H4 |
| M5 | 工作单遗留（allErrors / 来源层级） | 已更新 | §H5 |

—— v0.9（冻结候选）完。请最终确认：**M1–M5 闭合判定 + v0.9 是否可冻结为 v1.0-架构基线**（可 / 否：[仅列阻断项]）。
