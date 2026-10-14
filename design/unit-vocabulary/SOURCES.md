# unit_vocabulary@1 · v0 — 转换规则来源说明（SOURCES）

- **资产**：`design/unit-vocabulary/unit-vocabulary-v0.json`
- **版本/req**：v0（G-LOOP-20261015-UV-001，2026-10-15；冲刺轨 2）
- **schema（冻结）**：`design/packet/schemas/unit_vocabulary.json`（packet rev4；`artifact_type` / `units` / `conversions` / `forbidden_mixes`）
- **规格依据**：
  - `D:/Program/sharespace/genie-synbio-design-spec-v0.4-2026-10-12.md` §C6（unit_vocabulary@1 定义：量纲向量、可换算关系、禁止混算矩阵）
  - `D:/Program/sharespace/genie-synbio-design-spec-v0.5-2026-10-12.md` §3（M10 四类 oracle：非法 unit / 量纲不符 / 非法转换 / 错误基准量）
  - 工作单 C 节：`D:/Program/dsh-plug-develop/genie-synbio-design-20261012/notes/P0A-WORK-ORDER.md`（C 资产：unit_vocabulary@1 词表 + 转换规则来源）

## 0. 全局约定

1. **unit_id 稳定命名**：一律 ASCII（`u` 表示微前缀 µ，`degC` 表示 °C，`mol_e` 表示 mol e⁻，`umol_per_min` 表示 µmol/min）——UCUM 以 `u` 代 µ 的惯例，避免 Unicode 等价字符（U+00B5 与 U+03BC）在标识符层引起歧义；**symbol 字段使用 SI 正式符号**（µg / µL / µM / °C / s⁻¹）。
2. **量纲向量**：`dimension` 为 {base, exponent} 集合，仅列非零指数；**无量纲 = 空数组**（`[]`）。浓度（M 族）= amount·length⁻³；U / µmol/min = amount·time⁻¹；kcat = time⁻¹；mg/mL = mass·length⁻³；体积（L 族）= length³；bp/kb/Mb/nm = length¹。
3. **factor 词法**：精确十进制字符串（`x-decimal-string` / pattern-library `canonicalDecimal`，无科学计数、无尾零、非零）。**只收录有限小数可精确表达的换算**——因此 `s→min`（1/60）、`s→h`（1/3600）、`min→h`、`h→d` 等非有限小数方向不收录（逆方向均为精确整数，已收录）。
4. **°C↔K 无乘算因子**：温度换算为偏移（差值）语义（T[K] = T[°C] + 273.15），非乘性，故不提供 conversion，列入 forbidden_mixes（见 §7）。

## 1. 质量（mass）换算来源

| conversion | factor | 来源 | 依据 |
|---|---|---|---|
| mg→g / g→mg | 0.001 / 1000 | SI | BIPM SI Brochure 9th ed. (2019), Table 3（十进制前缀 m = 10⁻³） |
| ug→mg / mg→ug | 0.001 / 1000 | SI | SI Brochure Table 3（µ = 10⁻⁶；1 µg = 10⁻³ mg） |
| ug→g | 0.000001 | SI | SI Brochure Table 3（µ = 10⁻⁶） |
| kg→g / g→kg | 1000 / 0.001 | SI | SI Brochure（kg 为 SI 质量基本单位，1 kg = 10³ g） |
| mg→kg | 0.000001 | SI | SI Brochure Table 3 链式（1 mg = 10⁻³ g = 10⁻⁶ kg） |
| ug→kg | 0.000000001 | SI | SI Brochure Table 3 链式（1 µg = 10⁻⁹ kg） |
| Da→g | 0.0000000000000000000000016605390666 | CODATA 2018 | 原子质量常数 mᵤ = 1.660 539 066 60(50)×10⁻²⁷ kg（CODATA 2018，NIST）；1 Da = 1.6605390666×10⁻²⁴ g |
| kDa→Da | 1000 | SI + 领域惯例 | SI Brochure Table 3（k = 10³）；kDa 为分子生物学质量规格标准用法 |
| kDa→g | 0.0000000000000000000000016605390666 | CODATA 2018 链式 | 1 kDa = 10³ Da = 1.6605390666×10⁻²¹ g（与 Da→g × kDa→Da 链一致） |

## 2. 物质量（amount）换算来源

| conversion | factor | 来源 | 依据 |
|---|---|---|---|
| mmol→mol / mol→mmol | 0.001 / 1000 | SI | SI Brochure Table 3（m = 10⁻³） |
| umol→mmol / mmol→umol | 0.001 / 1000 | SI | SI Brochure Table 3（µ = 10⁻⁶） |
| nmol→umol / umol→nmol | 0.001 / 1000 | SI | SI Brochure Table 3（n = 10⁻⁹） |
| umol→mol | 0.000001 | SI | SI Brochure Table 3 链式 |
| nmol→mol | 0.000000001 | SI | SI Brochure Table 3 链式 |

## 3. 体积（volume）换算来源

| conversion | factor | 来源 | 依据 |
|---|---|---|---|
| mL→L | 0.001 | SI / UCUM | SI Brochure Table 3；UCUM（Loinc v1.9）：mL = 10⁻³ L |
| uL→mL | 0.001 | SI / UCUM | SI Brochure Table 3；UCUM：uL = 10⁻³ mL |
| uL→L | 0.000001 | SI | SI Brochure Table 3 链式 |
| L→mL / mL→uL | 1000 / 1000 | SI | SI Brochure Table 3 逆换算 |
| L→uL | 1000000 | SI | SI Brochure Table 3 链式 |

## 4. 时间（time）换算来源

| conversion | factor | 来源 | 依据 |
|---|---|---|---|
| min→s | 60 | SI | SI Brochure Table 6（1 min = 60 s，非 SI 但被 SI 接受的单位） |
| h→s | 3600 | SI | SI Brochure Table 6（1 h = 3600 s） |
| d→s | 86400 | SI | SI Brochure Table 6（1 d = 86400 s） |
| h→min | 60 | SI | SI Brochure Table 6（1 h = 60 min） |
| d→min | 1440 | SI | SI Brochure Table 6（1 d = 24 h = 1440 min） |
| d→h | 24 | SI | SI Brochure Table 6（1 d = 24 h） |

## 5. 浓度 / 生信 / 酶学 / 无量纲换算来源

| conversion | factor | 来源 | 依据 |
|---|---|---|---|
| mM→M / M→mM | 0.001 / 1000 | SI | SI Brochure Table 3（M = mol/L 为化学领域标准定义浓度单位） |
| uM→mM / mM→uM | 0.001 / 1000 | SI | SI Brochure Table 3 |
| nM→uM / uM→nM | 0.001 / 1000 | SI | SI Brochure Table 3 |
| uM→M | 0.000001 | SI | SI Brochure Table 3 链式 |
| nM→M | 0.000000001 | SI | SI Brochure Table 3 链式 |
| bp→kb / kb→bp | 0.001 / 1000 | 领域惯例 + UCUM | 分子生物学序列长度十进制前缀（kb = 10³ bp）；UCUM 前缀语义；**非物理米制**（与 nm 换算见 forbidden_mixes） |
| kb→Mb / Mb→kb | 0.001 / 1000 | 领域惯例 + UCUM | 同上（Mb = 10³ kb） |
| bp→Mb / Mb→bp | 0.000001 / 1000000 | 领域惯例 + UCUM | 同上（Mb = 10⁶ bp） |
| U→umol_per_min | 1 | IUPAC/IUBMB | 酶活单位定义：1 U = 1 µmol 底物转化/min（IUPAC Nomenclature Committee；Bier 1955 引入） |
| percent→dimensionless | 0.01 | ISO 80000-1 | ISO 80000-1:2009 §6.5.5：% = 0.01（无量纲数） |
| ppm→dimensionless | 0.000001 | 领域惯例 | ppm = 10⁻⁶（**质量/质量默认**；basis 歧义见 §7 与边界披露） |

## 6. 单位语义注释（SOURCES 侧说明；units 条目受 schema 约束不带 note 字段）

| unit_id | 语义 | 依据 |
|---|---|---|
| gDW | 干重（细胞干生物量），mass 维度 | 微生物培养领域惯例（比生长速率 µ、产量 Y 等以 gDW 为基准） |
| gWW | 湿重（未烘干生物量），mass 维度 | 发酵领域惯例；与 gDW 换算需含水率基准（见 forbidden_mixes） |
| mol_e | 电荷基底：1 mol e⁻ ≡ 1 mol 基本电荷 | 电化学惯例（Faraday 常数 F = 96485.33212... C/mol，CODATA 2018） |
| OD600 | 600 nm 光密度；**非物理量**，无量纲浊度代理读数 | 微生物学惯例（分光光度法；经验刻度，与菌浓/干重仅经验相关） |
| cell / CFU | 细胞计数 / 菌落形成单位（活菌计数代理），均无量纲 | 微生物学惯例 |
| U / kcat | U = µmol/min 粗活力（amount·time⁻¹）；kcat = s⁻¹（time⁻¹，每活性位点归一） | IUPAC 酶动力学惯例（kcat 需 [E] 与位点化学计量，见 forbidden_mixes） |
| dimensionless / percent / ppm | 无量纲；% 与 ppm 仅同 basis 可比 | ISO 80000-1:2009（ppm 非 SI，建议避免使用） |

## 7. forbidden_mixes 语义来源

| 对 | reason 依据 |
|---|---|
| g ↔ mol | 质量/物质量换算需分子量（n = m/M）——SI 量纲法则 + 化学定义 |
| mol_e ↔ mol | 电荷/物质量需 Faraday 常数——电化学定义（CODATA 2018） |
| OD600 ↔ cell / CFU / gDW | 浊度代理 vs 直接计数的经验相关（菌种/仪器/生长阶段依赖）——微生物学惯例 |
| bp ↔ nm | 序列长度 vs 物理长度需每碱基长度假设（dsDNA B 型 ~0.34 nm/bp，近似惯例）——**近似，非精确常数** |
| bp ↔ Da | 需碱基平均分子量假设（dsDNA ~660 Da/bp，近似惯例）——**近似，非精确常数** |
| degC ↔ K | 仅差值（偏移）语义可比：T[K] = T[°C] + 273.15——SI Brochure 温度定义 |
| gDW ↔ gWW / g ↔ gDW | 干湿基准换算需含水率——发酵领域惯例 |
| percent ↔ ppm | basis 歧义（质量/质量 vs mol/mol 等）；1 % = 10⁴ ppm 仅同 basis 成立——ISO 80000-1 |
| U ↔ kcat | 粗活力 vs 位点归一催化常数需 [E] 与化学计量——IUPAC 酶动力学 |
| L ↔ g | 体积/质量需密度基准——物理定义 |
| mM ↔ mg_per_mL | 摩尔浓度 vs m/v 浓度需溶质分子量——化学定义 |
| CFU ↔ cell | 活菌计数代理 vs 总细胞数（平板效率影响）——微生物学惯例 |

## 8. 边界披露 / 待核

1. **Da→g / kDa→g（来源强，精度边界）**：CODATA 2018 原子质量常数 1.660 539 066 60(50)×10⁻²⁷ kg。词表因子取 11 位有效数字（canonical 词法强制去尾零，1.66053906660 ≡ 1.6605390666，数值无损失），相对不确定度 ~3×10⁻¹³，可覆盖代谢/蛋白质量级换算。若需更高精度请回查 CODATA 最新推荐值（v0 标注：常数取值以 CODATA 2018 为准）。
2. **bp→nm、bp→Da（近似假设，**非换算**）**：仅作为 forbidden_mixes 的 reason 依据（~0.34 nm/bp、~660 Da/bp 为 dsDNA 平均惯例近似），**未提供 conversion**；不同构象（ssDNA/RNA/A 型）数值不同。
3. **OD600 经验相关**：比浊系数随菌种、仪器、生长阶段显著变化，v0 只声明"非换算"，不给出任何经验系数（系数留给宿主模型绑定层）。
4. **ppm basis**：ISO 80000-1:2009 建议避免使用 ppm；本表按质量/质量默认，basis 未注明禁止混用（percent↔ppm 列 forbidden）。
5. **gDW/gWW 含水率**：因培养条件而异，v0 不固化任何默认含水率。
6. **非有限小数方向**（s→min、s→h、min→h、h→d 等）因十进制词法约束**不收录**；消费方可由逆换算组合得出（链式一致性由自校验脚本核对）。
7. **kcal 等能源单位、辐射/压力单位不在 v0 范围**：代谢建模涉及的压力/能量单位留待 v1 扩展（本资产为"最小充分集"）。

—— 全部 49 条 conversion 均有上述可核来源；无「硬缺失待核」条目。近似/惯例性质条目（2–5）已逐条标注。
