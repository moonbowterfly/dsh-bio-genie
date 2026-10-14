# dsh-bio-genie「基因组感知的基因线路设计 + 设计后果推理」V1 设计规格

**v0.10 · 冻结候选（修复复核 9 的唯一阻断） ｜ 2026-10-13 ｜ 主笔: Hermes bsp**
**req_id: H-20261012-002 / seq: SPEC-FREEZE-7（最终确认轮）**
**基线**: v0.9 + Codex 复核 9（`genie-synbio-design-spec-review-9-2026-10-13.md`）
**性质**: 修复 I1–I3（decimal-string 共享全串执行器 / whitelist pattern 冻结形态 / packet 绑定）；其余沿版本链 v0.1→v0.9。

---

## I1. decimal-string 真值执行器（跨端共享算法；定死）

- `x-decimal-string: true` 绑定**校验规则**（不仅 annotation）：**三处校验点（Python 写盘前 / TS 登记前 / validate 时）都必须运行同一 lexical rule**；该规则**消费整个字符串**；**禁用任何 native `pattern`（search 语义）作为最终真值**。
- **共享算法（伪代码；双端逐字符扫描实现；禁以正则引擎作真值）**：

```
DECIMAL_STRING(s):
  1. 若 s 为空 → 拒
  2. i=0；若 s[0]=='-'：i=1（其后必须紧跟数字）
  3. 整数部分：
       若 s[i]=='0'：i+=1；**且不得跟数字**（即 "00…" 形式 → 拒）
       否则：s[i] 必须 ∈ [1-9]，i+=1；随后继续消费 [0-9]*
  4. 若 i==len(s)：若出现过 '-' 且整数部分为单个 '0' → 拒（"-0"）；否则 → 收
  5. 若 s[i]=='.'：i+=1；必须消费 [0-9]+（至少一位）；**最后一位必须 ∈ [1-9]**（尾零 → 拒）
  6. 若 i==len(s) → 收；否则 → 拒（任何剩余字符，含空白/控制字符/U+2028/U+2029/非 ASCII/代理项等，一律拒）
```

- **失败码与优先级（定死）**：类型检查（string）→ 运行 DECIMAL_STRING → 非 canonical ⇒ **`DECIMAL_STRING_NONCANONICAL`**（稳定码；不归一、不重试）。该规则**先于**任何冗余 `pattern` 检查；`pattern`（白名单字面量）仅作 metadata / lint 冗余证据，**不作 decimal-string 最终真值**。
- **corpus 增补（必含，逐字节判定）**：`"0"+LF`、`"0"+CR`、`"0"+CRLF`、`"0"+U+2028`、`"0"+U+2029`、`"-0.0"` → 全部**拒**；并保留 H2 全部真值样例。
- 注：unicode 归一与本规则无交互（合法 decimal 串为纯 ASCII；任何非 ASCII 在步骤 6 拒）。

## I2. whitelist pattern library 冻结形态

- 形态：`common.defs.json#/patterns` = 映射 `name → {pattern: <字面量字符串>, match_mode: "full", domain: "ascii", max_len: <n>}`。
- **比较域**：pattern 字面量按 **UTF-8 字节**做成员判定（不允许解码歧义）。
- **V1 仅允许 `match_mode: "full"`**（全串语义）；由**共享 wrapper 纪律**实现：两端不得使用裸 search 语义（Python 端不得依赖 `re.search` 默认行为，须 full-match 包装或共享判定器）；任何 `"search"` 模式在 V1 内**禁止**。
- 库内每条 pattern：长度上限 + ReDoS 审计 + 双端 corpus 判定样例（P0a-a 交付；完整集合随 packet 冻结）。
- 最少包含：canonical decimal（I1 的冗余证据）、sha256 hex、JSON Pointer、bundle path、ISO 时间戳。

## I3. packet 绑定增补

- 最终 packet **显式绑定**：**active profile**（`casefile-c14n@1` rev + hash `ea48988a…`）、**H2/I1 grammar**（版本化文本 + hash）、**common-defs pattern hash**——standalone consumer 不得自行选择另一条"fixed pattern"。

## I4. 工作单同步说明
- 工作单为**派生物（非规范来源）**；其 A6/A7 与 corpus 样例的全量重写将随 **freeze ceremony** 一并落地（含 I1/I2 全部要点）。暂态文本差异不构成规范冲突。

## §21. 评审发现处置表（v0.9 → v0.10）

| # | 发现（复核 9） | 处置 | 落点 |
|---|---|---|---|
| N1 | decimal-string 缺跨端全串真值执行器（native pattern 语义分叉，实测 `"0\n"` 分叉） | 共享逐字符算法 + 全串消费 + 稳定码 + 优先级 + corpus 增补 | §I1 |
| N2 | whitelist pattern 库形态未冻结（指针/形态/域/match_mode） | 形态定死 + 仅 full 模式 + 字节域 + 审计 | §I2 |
| N3 | packet 应绑定 active profile/grammar/pattern hash | 显式绑定条款 | §I3 |
| N4 | 工作单再同步 | freeze ceremony 全量重写（说明见 §I4） | §I4 |

—— v0.10（冻结候选）完。请最终确认：**N1–N4 闭合判定 + v0.10 是否可冻结为 v1.0-架构基线**（可 / 否：[仅列阻断项]）。
