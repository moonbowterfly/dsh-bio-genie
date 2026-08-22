---
language: none
---

# 文献检索与综述（Literature Review）

> 吸收自 OpenAI life-science-research literature-search + PubMed 最佳实践

## When to Use

文献检索、文献综述、研究背景调研、参考文献收集时加载本 skill。

## 检索工具选择

| 工具 | 用途 | 调用方式 |
|------|------|----------|
| `bio_pubmed_search` | PubMed 文献检索 | 语义化工具 |
| `bio_pubmed_abstract` | 获取结构化摘要 | 语义化工具 |
| `bio_entrez_search` | NCBI 多数据库检索 | 语义化工具 |
| web_search | 补充检索（预印本/灰色文献） | 通用工具 |

## PubMed 检索式构建

### 基本语法
```
# 关键词检索
cancer AND TP53

# 限定字段
TP53[Gene Name] AND cancer[Title/Abstract]

# 限定物种
human[Organism] OR mice[Organism]

# 限定时间
2020:2026[dp]

# 限定文献类型
review[pt] OR clinical trial[pt]

# 组合检索
(TP53 OR BRCA1) AND cancer AND human[Organism] AND 2020:2026[dp]
```

### 常用检索式模板
```
# 基因功能综述
{gene}[Gene Name] AND review[pt]

# 疾病相关研究
{disease} AND {gene} AND human[Organism]

# 方法学文献
{technique} AND {application} AND protocol[pt]

# 最新研究
{topic} AND 2024:2026[dp]
```

## 文献筛选流程

```
初始检索（n=?）
    ↓
去重（n=?）
    ↓
标题/摘要筛选
├─ 纳入标准：
│   - 相关主题
│   - 原创研究或高质量综述
│   - 英文文献
│   - 近5年（除非经典）
└─ 排除标准：
    - 不相关主题
    - 会议摘要（除非重要）
    - 非同行评审
    ↓
全文筛选（n=?）
    ↓
质量评估
├─ 研究设计
├─ 样本量
├─ 统计方法
└─ 偏倚风险
    ↓
最终纳入（n=?）
```

## 文献信息提取模板

```markdown
| PMID | 第一作者 | 年份 | 期刊 | 主题 | 关键发现 | 方法 |
|------|----------|------|------|------|----------|------|
| 12345678 | Zhang et al. | 2024 | Nature | TP53在肝癌中的作用 | 发现新机制 | CRISPR筛选 |
```

## 综述写作结构

### 叙述性综述
```
1. 引言
   - 研究背景和意义
   - 综述范围和目的

2. 主体
   - 按主题/时间/方法组织
   - 每节总结关键发现
   - 指出争议和空白

3. 讨论与展望
   - 当前共识
   - 未解决问题
   - 未来方向

4. 结论
```

### 系统性综述（PRISMA）
```
1. 标题和摘要
2. 引言
3. 方法
   - 纳入/排除标准
   - 检索策略
   - 数据提取
   - 质量评估
4. 结果
   - PRISMA 流程图
   - 纳入研究特征
   - 质量评估结果
   - Meta分析（如适用）
5. 讨论
6. 结论
```

## 文献管理工具

| 工具 | 功能 | 推荐场景 |
|------|------|----------|
| Zotero | 文献收集/管理/引用 | 个人/团队 |
| Mendeley | PDF管理/社交 | 个人 |
| EndNote | 高级引用管理 | 机构用户 |

## 引用格式速查

### Vancouver（生物医学常用）
```
[1] Zhang Y, Li X, Wang L. TP53 mutations in hepatocellular carcinoma. 
    J Hepatol. 2024;80(3):456-467. doi:10.1016/j.jhep.2023.12.003
```

### Nature
```
1. Zhang, Y., Li, X. & Wang, L. TP53 mutations in hepatocellular carcinoma. 
   J. Hepatol. 80, 456–467 (2024).
```

### APA
```
Zhang, Y., Li, X., & Wang, L. (2024). TP53 mutations in hepatocellular 
   carcinoma. Journal of Hepatology, 80(3), 456-467. 
   https://doi.org/10.1016/j.jhep.2023.12.003
```

## 报告规范

| 指标 | 必须报告 |
|------|----------|
| 检索数据库 | ✅ PubMed, Embase, etc. |
| 检索时间范围 | ✅ 2015-2026 |
| 检索词 | ✅ 完整检索式 |
| 纳入/排除标准 | ✅ 明确定义 |
| 筛选流程 | ✅ PRISMA 流程图 |
| 纳入研究数 | ✅ 最终纳入 n=?? |
