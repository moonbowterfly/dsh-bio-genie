# casefile-c14n@1 — 规范化 profile（冻结候选文本 · rev2026-10-13）

**profile_id: `casefile-c14n` ｜ version: `1` ｜ status: frozen-candidate（rev2026-10-13b：并入复核 6 三处语义修订 + v0.12 §K4 冻结域闸门）**
本文件为**不可变工件候选**；其 sha256 见同目录 `SHA256SUMS-contracts.txt`（每次修订更新；v1 正式冻结后任何修改 = `casefile-c14n@2`）。

## 0. 范围
- 定义 **schema-defined JSON 工件与 manifest** 的 canonical 字节形式，供跨语言（TS/Node 与 Python）独立重算得到逐字节一致结果。
- **不适用于原始 blob**（FASTA、GFF、SBML、zip 等）：它们保持**原始磁盘 bytes 身份**，不经过本 profile。
- 凡本 profile 覆盖的序列化/归一/排序行为，双端实现必须逐字节一致（由共享 corpus 判定）。

## 1. 处理管线（唯一顺序，冻结）
```
lossless parse（见 §3：不得用 JS 默认 JSON.parse 表示大数）
→ 拒绝：raw 重复对象键 / lone surrogate
→ 拒绝：scalar 超出冻结 Unicode 规范化域（§1a，v0.12 K4）
→ 全深度 NFC 归一（所有字符串与对象键）
→ 拒绝：NFC 后对象键碰撞（如 {"é":1, "e"+U+0301:2} → 拒绝）
→ schema 校验（在归一化后的树上）
→ canonical 序列化（§2/§3/§4）
```
- 基底：RFC 8785（JCS）——对象键按 **UTF-16 码元序**排序、无多余空白、UTF-8 输出。
- **lone surrogate**（未配对代理项）→ **拒绝**。
- **raw 重复对象键** → **拒绝**（不允许 last-wins）。
- **NFC 后键碰撞** → **拒绝**（不 last-wins、不产出含重复键的 JSON）。

### 1a. 冻结规范化域（v0.12 K4）
- 域定义 = UCD 15.0 assigned（category != Cn，含私用区 Co）+ 非字符（版本间稳定）；字节表 = `meta/unicode-domain-table.json`（hash-bound，双端共用同一表）。
- 闸门位置：NFC **之前**；任何 scalar 不在域内 → **拒绝**（稳定码 `UNICODE_OUT_OF_FROZEN_DOMAIN`，fail-closed，不归一、不重试）。
- 用途：消除两端 Unicode 数据版本差（Node ICU vs Python unicodedata）在 NFC 上的分叉；域外字符（如 U+1ACF）由闸门确定性拒绝而非依赖版本行为。

## 2. 数组与排序
- 每个数组必须由 schema 注解 `x-canonical: "set" | "seq"` 声明语义；**未注解数组 → 拒绝**。
- `set`：按元素 **canonical JSON 文本的 unsigned UTF-8 字节序**（byte-wise lexicographic）排序；**重复元素 → 拒绝**（以 canonical 等价比较）。
- `seq`：保持原序。
- **对象成员键**：按 RFC 8785 的 **UTF-16 code-unit** 规则排序（与 set 元素排序规则不同，禁止混用）。
- 注：UTF-8 字节序与 UTF-16 码元序对 BMP 外字符结果相反（对抗例：`"U+FFFF"` 与 `"U+10000"` 两个字符串）——本 profile 以 §2/§1 的分工消除歧义，该对抗例必须进 corpus。

## 3. 数值模型（修订：取消无界 number）
- **整数（number 形式）**：限 **JavaScript safe-integer 范围**（|n| ≤ 2^53 − 1）；超范围整数**不得以 JSON number 形式出现**。
- **大整数/高精度小数**：必须采用 schema 约束的 **decimal-string 子类型**（字符串 + `x-decimal-string: true` 注解 + 固定 `pattern`）；canonical 形式 = 其规范化十进制字符串（无前导零、无 `+`、可选负号、小数点仅当小数位存在）。
- 浮点：ECMAScript **最短往返表示**；`1e0`、`1.0` 规范化为 `1`；**`-0 → 0`**；**NaN / ±Infinity → 拒绝**。
- 禁止以科学计数法词法伪装整数；超范围 number 形式（如 10^40 作为 number）→ **拒绝**（要求改用 decimal-string）。

## 4. 未知字段与拒绝
- schema 未声明的对象字段 → **拒绝**（除非该对象 schema 显式 `additionalProperties: true`，且仍须满足本 profile）。
- 本 profile 的全部拒绝行为一律 **fail-closed**（error code 由实现定义，语义 = 拒绝）。

## 5. 对象身份
- artifact identity = **磁盘字节**（由 producer 按其侧同 profile 写成，写盘即定型）。
- manifest 级 canonical 由 TS 生成；双端任何重算必须与 **共享 corpus** 逐字节一致。

## 6. 一致性 corpus（P0a-a 交付；hash-first 启用门）
- `synbio-c14n-corpus@1`：≥50 例，**必含**：
  - 数值：`1e0`/`1.0`/`-0`、safe-integer 边界（2^53−1、-(2^53−1)）、**超范围 number 形式（拒）与其 decimal-string 形式（收）对照**、最短往返边界样例；
  - Unicode：NFC/NFD 对、lone surrogate（拒）、**NFC 后键碰撞（拒：键 "é" 与 "e"+U+0301 并存）**、**U+FFFF 与 U+10000 字符串的排序对抗例**、BMP 外字符 UTF-16 键排序、冻结域闸门（U+1ACF 拒；非字符 U+FDD0 / 私用区 U+E000 / 星体面 U+20000 收）；
  - 结构：重复对象键（拒）、重复 set 元素（拒）、未注解数组（拒）、嵌套/混合数组注解、空对象/空数组、深层嵌套。
- **启用门**：corpus canonical hash 未记录 → `CORPUS_UNPINNED`，双端一致性门与依赖它的任何校验**拒绝启用**（不得以"跳过"形式降级）。

## 7. 实现纪律
- 不得将运行时 `JSON.parse()` / `JSON.stringify()` 的默认行为等同于本 profile 的完整实现（数值/Unicode/排序边界必须显式处理；大数须 lossless 解析为字符串或等价的 decimal 表示）。
- 双端实现各自完成；一致性仅由 corpus 判定（非由单侧自证）。

## 8. 修订记录
- v1（2026-10-12 初稿，冻结候选）。
- **v1 rev 2026-10-13**：并入复核 6 三处修订——§2 set 排序改为 UTF-8 字节序（与键排序明确分工）；§1 增加 NFC 后键碰撞拒绝与完整管线顺序；§3 取消无界 number（大整数改 decimal-string 子类型）；§0 明确不适用于原始 blob。旧 hash 作废，新 hash 见 `SHA256SUMS-contracts.txt`。
- **v1 rev 2026-10-13b**：并入 v0.12 §K4——新增 §1a 冻结 Unicode 规范化域闸门（NFC 前；`UNICODE_OUT_OF_FROZEN_DOMAIN`）；corpus 增补闸门用例。旧 hash 作废，新 hash 见 `SHA256SUMS-contracts.txt`。
