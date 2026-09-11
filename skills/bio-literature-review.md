---
language: none
---

# 文献检索与综述（Literature Review）

> 检索式与筛选流程吸收自 OpenAI life-science-research + PubMed 最佳实践；
> 系统综述流程层（PRISMA 2020 / 偏倚评估工具选择）吸收自
> [aipoch/medical-research-skills](https://github.com/aipoch/medical-research-skills)（MIT，commit `f5ef65b9`），
> 书目锚点经 PubMed 实测核验。

## When to Use

文献检索、文献综述、研究背景调研、系统综述/Meta 分析、参考文献收集时加载。
结论强度与证据分级 → 配合 `bio-evidence-appraisal`；写作用 `bio-paper-writing`。

## 一、检索工具选择

| 工具 | 用途 | 调用方式 |
|------|------|----------|
| `bio_pubmed_search` | PubMed 文献检索（返回 PMID + 元数据） | 语义化工具 |
| `bio_pubmed_abstract` | 获取结构化摘要（含 DOI） | 语义化工具 |
| `bio_entrez_search` | NCBI 多数据库检索 | 语义化工具 |
| web_search | 补充检索（预印本/灰色文献） | 通用工具 |

## 二、PubMed 检索式构建

```
# 关键词检索                   cancer AND TP53
# 限定字段                     TP53[Gene Name] AND cancer[Title/Abstract]
# 限定物种                     human[Organism] OR mice[Organism]
# 限定时间                     2020:2026[dp]
# 限定文献类型                 review[pt] OR clinical trial[pt]
# 组合                         (TP53 OR BRCA1) AND cancer AND human[Organism] AND 2020:2026[dp]
```

**常用检索式模板**：`{gene}[Gene Name] AND review[pt]` · `{disease} AND {gene} AND human[Organism]` ·
`{technique} AND {application} AND protocol[pt]` · `{topic} AND 2024:2026[dp]`

**⚠️ 检索式陷阱（实测）**：`A|B` 是 OR，会把宽泛词条并进来（实测 count 从 1 涨到 32 万）；
含冒号/连字符的标题短语加引号后可能 0 命中 —— 用「去标点的短片段 + [Title] + [Journal]/[dp] 收窄」验证具体文献。

## 三、系统综述：PRISMA 2020 完整流程

> **适用边界**：PRISMA 是**系统综述**的报告规范，不是所有综述都要走。
> 叙述性综述只需透明说明检索方法；范围综述用 PRISMA-ScR；方案阶段用 PRISMA-P；活体系统综述用 PRISMA-LSR。
> **只在真正做了系统检索+筛选+合成时才声明 PRISMA 合规**（声明了却缺流图/排除理由 = 报告造假）。

| 步骤 | 动作 | 硬要求 |
|---|---|---|
| 1 提问与方案 | PICO/PICOS 框架：人群 Population / 干预 Intervention / 对照 Comparator / 结局 Outcome（+ 研究设计 Study） | **检索前**定死纳入排除标准；方案预注册（PROSPERO 或 OSF） |
| 2 多库检索 | 至少 2 个库 + 引文追溯（前向/后向 snowballing） | 记录**每个库的完整检索式 + 检索日期 + 命中数**；跨库去重后计数 |
| 3 两阶段筛选 | ① 题摘筛选 ② 全文评估 | **每条排除都要记理由**（流图必需）；双人复核时报 Cohen's κ（配方见 `bio-evidence-appraisal` §7） |
| 4 数据提取 | 预定义字段表（见 §六） | 提取表先定后填；作者间分歧走第三方仲裁 |
| 5 偏倚评估 | 按设计选工具（见 §五） | 逐域判定 + 判定依据引原文 |
| 6 定量合成 | **仅当研究足够同质**时做 Meta 分析（见 §七） | 异质性说明不可解释即不做合并，改叙述性综合 |
| 7 报告 | PRISMA 流图 + 清单（27 项）+ 纳入研究特征表 + 偏倚汇总 + 森林图 + SoF 表（GRADE） | 所有**预先计划的分析无论显著与否都要报告** |
| 8 开放与更新 | 提取数据与代码公开；新证据出现时更新 | 报告局限（研究层 + 综述层） |

**PRISMA 2020 流图四阶段计数**（缺一即不合规）：

```
识别 Identification：各库命中 n=? → 去重后 n=?
筛选 Screening    ：题摘筛选排除 n=?（理由分类计数）→ 全文评估 n=?
合格 Eligibility  ：全文排除 n=?（逐条理由：人群不符/无对照/数据不可用…）
纳入 Included     ：最终纳入 n=?（其中进入定量合成 n=?）
```

> PRISMA 2020 声明：Page MJ et al. BMJ 2021;372:n71（PMID 33782057，27 项清单）；
> 方案清单 PRISMA-P（PMID 25555855）；活体系统综述扩展 PRISMA-LSR（PMID 39562017）。

## 四、偏倚风险评估：按研究设计选工具（选错工具 = 评估无效）

| 研究设计 | 工具 |
|---|---|
| 随机对照试验 | **RoB 2**（PMID 31462531） |
| 非随机干预研究 | **ROBINS-I**（PMID 27733354） |
| 队列 / 病例对照（观察性） | **Newcastle-Ottawa Scale**（PMID 20652370 为方法学评价） |
| 诊断准确性 | **QUADAS-2**（PMID 22007046）；2026 年已发布修订版 **QUADAS-3**（PMID 41698208） |
| 系统综述（纳入综述本身时） | **AMSTAR 2**（PMID 28935701） |
| 动物实验 | **SYRCLE 偏倚工具**（PMID 24667063）+ 报告遵循 **ARRIVE 2.0**（PMID 34095516） |

评估要点：逐域给判定（选择/实施/检测/失访/报告…)并附原文引证；**不得只写"质量良好"**。

## 五、定量合成要点

- **效应量口径**：连续变量 → SMD（Hedges g）；二分类 → OR / RR；时间-事件 → HR。转换前确认单位与方向一致。
- **模型**：默认随机效应（研究间真实差异更常见）；固定效应仅在研究同质且可互换时用。
- **异质性**：I²（25/50/75 低/中/高）+ Cochran Q + τ²（配方见 `bio-evidence-appraisal` §7）。**I² 高不能只看数字**——要指出异质性来源。
- **敏感性分析**：leave-one-out（逐个剔除）；**剪补法 trim-and-fill** 需谨慎解读（仅提示可能的发表偏倚）。
- **发表偏倚**：漏斗图 + Egger 检验，**研究数 <10 时不可靠**，不据此下结论。
- **不可合并时**：改做"结构化叙述综合"（按机制/人群/设计分层描述），并明确说明为什么不合并。

## 六、文献信息提取模板

```markdown
| PMID | 第一作者 | 年份 | 期刊 | 主题 | 关键发现 | 方法 | 偏倚判定 |
|------|----------|------|------|------|----------|------|----------|
| 12345678 | Zhang et al. | 2024 | Nature | TP53在肝癌中的作用 | 发现新机制 | CRISPR筛选 | 中（失访未报） |
```

## 七、综述写作结构

```
叙述性综述：1 引言（背景/范围/目的）→ 2 主体（按主题/时间/方法组织，逐节小结 + 争议与空白）
           → 3 讨论与展望 → 4 结论
系统综述：  1 标题与摘要 → 2 引言 → 3 方法（纳入排除标准/检索策略/数据提取/质量评估）
           → 4 结果（PRISMA 流图/纳入研究特征/质量评估/合成结果）→ 5 讨论 → 6 结论
```

## 八、引用格式速查

```
Vancouver：[1] Zhang Y, Li X, Wang L. TP53 mutations in hepatocellular carcinoma.
           J Hepatol. 2024;80(3):456-467. doi:10.1016/j.jhep.2023.12.003
Nature：   1. Zhang, Y., Li, X. & Wang, L. TP53 mutations in hepatocellular carcinoma.
           J. Hepatol. 80, 456–467 (2024).
APA：      Zhang, Y., Li, X., & Wang, L. (2024). TP53 mutations in hepatocellular carcinoma.
           Journal of Hepatology, 80(3), 456-467. https://doi.org/10.1016/j.jhep.2023.12.003
```

## 九、硬规则

1. **看到结果后修改纳入标准 = 报告偏倚**。要改必须写明改动理由与时间点。
2. 只报告显著/正面结果 = 选择性报告；预先计划的分析全都要报。
3. PMID / DOI 一律来自检索（`bio_pubmed_search`），**禁止凭记忆写引用**；核验不了的标 `[未核验]`。
4. 不把叙述性综述包装成"系统综述/PRISMA 合规"。
5. 检索式、日期、命中数、排除理由必须可复现（缺任一项，第三方无法复核）。

## 验收标准

- [ ] 声称 PRISMA 合规时：流图四阶段计数齐全 + 每条排除附理由 + 27 项清单核对
- [ ] 偏倚评估工具与设计匹配（对照 §四表），逐域给判定而非笼统评价
- [ ] 检索式/日期/命中数逐库记录，去重后计数
- [ ] 合成前检查同质性；不可合并时给出结构化叙述综合
- [ ] 每条引用带可核验 PMID/DOI；未核验者已标注
- [ ] 预先计划的分析全部报告（含阴性结果）

<!-- absorbed (systematic review layer) from aipoch/medical-research-skills@f5ef65b9bea79b6dd9553f52f95b0d08f7d64d26 (MIT), 2026-09-11.
     改造：剔除其 ScienceClaw/PROSPERO 平台耦合步骤；补入工具选择表与已核验 PMID；
     增加「PRISMA 适用边界」与「不可合并时怎么办」两条实操判据。 -->
