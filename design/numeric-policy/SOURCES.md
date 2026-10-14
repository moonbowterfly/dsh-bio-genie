# numeric_policy@1 v0 — 取值依据（SOURCES）

- 资产：`design/numeric-policy/numeric-policy-v0.json`
- req_id：G-LOOP-20261015-NP-001（冲刺轨 2 · 豆包）
- 日期：2026-10-15
- 冻结 schema：`design/packet/schemas/numeric_policy.json`
- corpus 样例：`design/packet/schema-corpus/schema_cases.json`（npo-01 valid / npo-02 `-0` invalid / npo-03 bad-enum invalid）
- 规格：`D:/Program/sharespace/genie-synbio-design-spec-v0.4-2026-10-12.md` §C4（FBA/FVA 后果强制携带 `numeric_policy_ref`）、§C6（`numeric_policy@1` 被每条 quantitative coupling rule 与 `consequence_run@1` 引用）
- 生态核对源：`D:\Program\Github\dsh-bio-gem`（gem 插件，cobra 分析栈）

> 原则：数值不必照抄 corpus 样例，但每个取值必须有依据；生态可查的默认值以对齐生态为优先依据；方向/跨零语义取保守侧。

---

## 1. `fva_fraction_of_optimum` = `0.9999`

| 项 | 内容 |
|---|---|
| 类型/域 | number，0–1（schema minimum 0 / maximum 1） |
| 取值 | **0.9999** |

**依据（生态对齐，第一优先）**：`dsh-bio-gem/python/fluxscan.py` 第 27 行定义通量区间制（FVA 区间 + pFBA 点值）的生态默认

```python
DEFAULT_FRACTION = 0.9999
```

该值是 gem 插件 `gem_fluxscan`（README 已锁定语义："FVA 区间+pFBA 点值；条件对比区间分离判定，overlap=伪影禁止引用"）在所有条件对比与 C58 实测中使用的 `fraction_of_optimum` 默认值。spec §C6 中 `numeric_policy@1` 服务于 quantitative coupling rule 与 `consequence_run@1`，二者消费的正是同一类 FVA 定量路径，因此对齐该默认值是强依据。

**与样例的关系**：corpus npo-01 用 `0.99`——它是冻结 corpus 的最小 valid 样例（测试值），不是生态事实；本资产以生态实测默认 `0.9999` 为准（任务允许"数值不必照抄"）。

**保守性论证**：`fraction_of_optimum` 越大，FVA 可行域越贴近最优解、区间越窄。0.9999 > 0.99，方向/分离判定基于更紧的区间，误报"分离/方向"的概率更低（次优解空间的伪影更少进入区间端点），符合"保守"取向；同时与 gem 生态既有计算口径完全一致，避免资产与插件默认不一致导致的数值漂移。

---

## 2. `solver` = `{"id": "glpk", "version": "5.0"}`

| 项 | 内容 |
|---|---|
| 类型/域 | object：`id`、`version` 均非空字符串（minLength 1 / maxLength 64） |
| 取值 | id=`glpk`，version=`5.0` |

**依据（生态核对）**：
- gem 插件实际求解依赖为 **GLPK**：`docs/ARCHITECTURE.md` 第 127 行记录"分析 Python 3.13.13 / cobra 0.32.1 / GLPK"；`python/ledger.py` 第 89–90 行按 solver 名判 `swiglpk`；`python/essential_scan.py` / `fluxscan.py` 全部经 cobra/optlang 调 GLPK（`optlang.glpk_interface`，`test/test_gm3_identity.py` 第 32 行记录其接口版本号 `5.0.13`）。
- **版本取 `5.0` 的理由**：冻结 corpus 中所有数值类资产统一使用 `{"id": "glpk", "version": "5.0"}`（npo-01/02/03、mmr-01），即 packet 冻结语料已认可该字面量；`5.0.13` 是 optlang 接口层报告号而非 GLPK 发行版本号，且未在冻结 corpus 中出现。为与冻结语料完全一致、避免引入未冻结版本字符串，取 `5.0`。gem 实测的 `5.0.13` 记录于此作为背景（见 §边界披露）。

**保守性论证**：GLPK 是 gem 生态唯一实际求解器，且为自由软件、无许可风险；版本字面量与冻结 corpus 一致，未来升级/更换求解器时只需 bump 此资产。

---

## 3. `tolerance` = `1e-07`

| 项 | 内容 |
|---|---|
| 类型/域 | number，exclusiveMinimum 0 |
| 取值 | **1e-07** |

**依据（生态对齐 + 语义自洽）**：
- gem/cobra 生态的求解器可行性容差默认即 **1e-7**：`python/energy_gate.py` 第 151–152 行 `_solver_feasibility_tolerance(m, default=1e-7)`（"尽力读 solver feasibility tolerance，读不到用保守 default"）；`test/test_gm3_identity.py` 第 32–33 行求解器 identity 用 `tolerances: {feasibility: 1e-7, optimality: 1e-7}`。
- 语义定位：`tolerance` 为通用数值/求解容差（FBA/FVA 后果判定中的"两个数是否相等/可行"尺度），对齐 GLPK feasibility 默认 1e-7 最自洽。
- corpus 样例用 `1e-06`（npo-01），其来源是 fluxscan 的区间分离判定容差 `DEFAULT_TOL = 1e-6`（fluxscan.py 第 28 行，注释"tol=1e-6 仍完全覆盖求解器噪声"）——那是**输出规整后区间端点**的比较容差；本资产 `tolerance` 定位为**求解器级**容差，取 1e-7。

**保守性论证**：1e-7 < 1e-6，判定尺度更严格（更小的差异即视为不等），任何"相等/可行"结论的误报面更小；且不弱于生态求解器默认，不会因容差过严引入不存在的分歧。

---

## 4. `direction_epsilon` = `"0.001"`

| 项 | 内容 |
|---|---|
| 类型/域 | decimal-string（canonicalDecimal 词法，`^(0|-?(0\.[0-9]*[1-9]|[1-9][0-9]*(\.[0-9]*[1-9])?))$`，maxLength 320）；"0.001" 通过词法（无负号、小数尾位非零、无指数） |
| 取值 | **"0.001"** |

**依据（语义自洽 + 与冻结样例一致）**：
- 语义：`direction_epsilon` 是**方向信号阈值**（|v| < ε 视为近零、无方向）。方向阈值必须显著大于求解器/数值容差，否则数值噪声会翻转方向判定。
- 自洽核对：0.001 = 1e-3 ≫ tolerance 1e-7（相差 4 个数量级），亦大于 fluxscan 区间判定容差 1e-6（相差 3 个数量级），方向判定不会被 LP 噪声污染。
- 与冻结 corpus npo-01 完全一致（样例即 `"0.001"`），该字面量已被 packet 冻结语料验证过词法。

**保守性论证**：阈值越大，被判定为"有方向"的门槛越高——只有 |v| ≥ 0.001 才产生方向信号，弱信号一律按近零处理（不产生方向），符合"不确定不发言"的保守原则。不取更小值（如 1e-5），以免接近求解器噪声区。

---

## 5. `near_zero_rule`（措辞）

```text
if abs(value) < direction_epsilon then flag the value as near_zero; a near_zero value carries no direction signal and must not be used as positive/negative direction, zero-crossing, or coupling evidence
```

**依据**：任务要求措辞明确——"近零如何标记、不作为方向信号"。本措辞包含三个要素：
1. **触发条件**：`abs(value) < direction_epsilon`（与 `direction_epsilon` 字段直接绑定，不引入第三个阈值）；
2. **标记方式**：`flag the value as near_zero`；
3. **信号禁用**：near_zero 不得作为正/负方向、零穿越、耦合证据（对应 FVA/后果推理中"弱信号不渲染为结论"）。

与样例（"abs(value) < epsilon flags near-zero"）同构且更明确；全部 ASCII（规避冻结 Unicode 域约束），长度 ~200 ≤ 1024。

---

## 6. `interval_zero_crossing_rule` = `"crossing_flags_indeterminate"`

| 项 | 内容 |
|---|---|
| 类型/域 | enum：`crossing_flags_indeterminate` \| `crossing_allowed_with_note` |
| 取值 | **`crossing_flags_indeterminate`**（保守选项） |

**依据（保守优先 + 生态语义一致）**：
- 任务明确"保守选项优先"，`crossing_flags_indeterminate` 是保守项：区间含零/跨零（如 FVA 区间 [−a, +b]）时，正负方向不确定，标记为 indeterminate，禁止渲染确定方向结论。
- 与 gem 生态已锁定语义完全一致：`fluxscan.py` 第 3 行"overlap = 点值差异是求解器伪影，禁止引用"、第 36–42 行 `judge_interval` 在区间不分离时输出 `overlap=true / hard_conclusion=false / direction=null`——即不确定时**不产出方向**。`crossing_flags_indeterminate` 是同一原则在区间跨零场景的资产化表达。
- corpus npo-01 冻结样例同值；npo-03 确认 `"always_ok"` 非法。
- 选另一项（`crossing_allowed_with_note`）需强依据（允许跨零仍给方向、仅附注），v0 阶段无此依据，故不选。

---

## 边界披露（建议 bsp/主控最终裁定）

| 字段 | 本 v0 取值 | 备选 | 理由与影响 |
|---|---|---|---|
| `solver.version` | `"5.0"` | `"5.0.13"`（gem 实测 optlang 接口号） | 本 v0 取冻结 corpus 字面量 `5.0`；若主控希望记录 gem 实测接口版本号 `5.0.13` 可直接替换（schema 仅要求非空字符串） |
| `fva_fraction_of_optimum` | `0.9999` | `0.99`（corpus 样例值） | 生态默认 0.9999 优先；若主控意图让资产与冻结样例逐字对齐，可改 0.99 |
| `tolerance` | `1e-07` | `1e-06`（corpus 样例值 / fluxscan 区间判定容差） | 语义定位为求解器级容差取 1e-7；若主控希望与 fluxscan `DEFAULT_TOL=1e-6` 对齐可改 |

以上备选均为 schema 合法值，替换不破坏校验；其余字段（direction_epsilon、near_zero_rule、interval_zero_crossing_rule）依据充分，不建议变更。
