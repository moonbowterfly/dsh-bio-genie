# Reference Bundle 登记表（C 资产 · 外置）

- 派发：G-LOOP-20261015-RR-001（2026-10-15 · C 资产：reference bundle 登记与许可核验）
- 基线：仓库 master = `bad53a7`（派发单声明；本任务内未执行任何 git 命令，未核实 HEAD）
- 资产目录（外置，不在 git 仓库）：`D:\Program\dsh-plug-develop\genie-synbio-design-20261012\reference\`
- 依据：`notes/PREFLIGHT-2026-10-12.md`（bsp 2026-10-12 实测）＋ `reference/SOURCES.txt`（来源台账）
- SHA 口径：2026-10-15 由本任务以 Windows certutil 独立实测；脚本 `scripts/validate_reference_registry.py` 以 hashlib 复算；**三方一致 = 实测值 == SHA256SUMS-*.txt == 本表登记值**（大小写归一化后逐字符相等）
- 配套核对：`scripts/validate_reference_registry.py`（解析本表 §1 主表并逐文件核对；任一 FAIL → 非零退出）

## 1. 资产登记表（在册 7 文件）

| 文件名 | 来源（URL/出处） | 获取日期 | 许可与分发条款（要点；依据与原文见 §4） | SHA256（实测 2026-10-15） | 与 SHA256SUMS 核对 | 用途 |
|---|---|---|---|---|---|---|
| iML1515.xml | BiGG Models 静态文件：`http://bigg.ucsd.edu/static/models/iML1515.xml` | 2026-10-12 | BiGG License：学术/研究/非营利用途可无偿使用、复制、修改、分发（须在所有副本保留版权声明与许可段落）；商业用途须联系 UCSD 技术转移；要求引用 King 2016（BiGG）与 Monk 2017（iML1515）。见 §4.2 | 9c772d44ca43350e40dc7ee86c7aa148796856be1eea45e5406c6df8f7dcde28 | PASS（= SHA256SUMS-iML1515.txt） | 宿主基因组 GEM（定量后果层）；好氧葡萄糖最小培养基 growth 0.876997 冻结锚点（PREFLIGHT） |
| MG1655_NC_000913.3.fna | NCBI RefSeq `NC_000913.3`（efetch nuccore，FASTA） | 2026-10-12 | NCBI 分子数据政策：NCBI 自身对使用/分发无限制；RefSeq 记录为 NCBI 所有（美国政府作品 → 公共领域）；NLM 建议后续使用给予致谢。见 §4.1 | 6b195feda4c66140f6762742eb8b30c2652f02b45878b174f5b00ef85ecc95d7 | PASS（= SHA256SUMS-MG1655.txt） | 宿主基因组序列（reference_profile 路线） |
| MG1655_NC_000913.3.gff | NCBI Assembly `GCF_000005845.2`（ASM584v2）genomic.gff（解压自 gz） | 2026-10-12 | 同上（NCBI 分子数据政策） | 68d25735ccde6d37af68613dca57a588ae69423f0ecee99b0f29d596eff7accb | PASS（= SHA256SUMS-MG1655.txt） | 注释层（坐标/特征/重叠检查） |
| GCF_000005845.2_genomic.gff.gz | NCBI FTP：`https://ftp.ncbi.nlm.nih.gov/genomes/all/GCF/000/005/845/GCF_000005845.2_ASM584v2/GCF_000005845.2_ASM584v2_genomic.gff.gz` | 2026-10-12 | 同上（NCBI 分子数据政策） | afdf03dc1d06e423d874ee29d9e0df14f5d32baf893f4da9f93aa721eb5f495e | PASS（= SHA256SUMS-MG1655.txt） | 原始下载归档（gff 的 gz 原件，保留以备重放） |
| SHA256SUMS-iML1515.txt | 本地生成（bsp 2026-10-12，随 iML1515.xml 归档） | 2026-10-12 | 本仓自产清单文件（无第三方许可问题） | a3bdf26f41b74f12389ae593dc72dd85dfb934d58d9f6a625280c5325a41808f | 无外部参考（清单文件自身） | 完整性清单（索引，非独立信任根，见 §5） |
| SHA256SUMS-MG1655.txt | 本地生成（bsp 2026-10-12，随 MG1655 资产归档） | 2026-10-12 | 同上 | f7847c33f0e51c6fb47b5ed589fa9a30a2d2fd02aa46b7021b7794465356241f | 无外部参考（清单文件自身） | 完整性清单（索引，非独立信任根） |
| SOURCES.txt | 本地生成（bsp 2026-10-12，来源台账） | 2026-10-12 | 本仓自产台账（无第三方许可问题） | fa31f3afd10b0c7d5f860a65d131e77b1bb737b2a72bd374d776aa12e1287d6a | 无外部参考（台账文件自身） | 来源台账/出处记录 |

> 说明：派发单在册 5 文件 = iML1515.xml、SHA256SUMS-iML1515.txt、MG1655_NC_000913.3.fna、MG1655_NC_000913.3.gff、SHA256SUMS-MG1655.txt。目录内另有 2 文件一并登记核对（满足「对 reference/ 下每个文件实测」）：`GCF_000005845.2_genomic.gff.gz`（gff 原始下载归档，被 SHA256SUMS-MG1655.txt 覆盖）、`SOURCES.txt`（来源台账）。

## 2. SHA 实测与核对明细（2026-10-15）

实测通道：① Windows certutil（独立实测）；② 脚本 hashlib 复算（`validate_reference_registry.py`）。两通道一致。

| 文件 | certutil 实测（首 16 位） | SHA256SUMS 记录（首 16 位） | 登记表记录（首 16 位） | 结论 |
|---|---|---|---|---|
| iML1515.xml | 9c772d44ca43350e | 9c772d44ca43350e | 9c772d44ca43350e | 三方一致 PASS |
| MG1655_NC_000913.3.fna | 6b195feda4c66140 | 6b195feda4c66140 | 6b195feda4c66140 | 三方一致 PASS |
| MG1655_NC_000913.3.gff | 68d25735ccde6d37 | 68d25735ccde6d37 | 68d25735ccde6d37 | 三方一致 PASS |
| GCF_000005845.2_genomic.gff.gz | afdf03dc1d06e423 | afdf03dc1d06e423 | afdf03dc1d06e423 | 三方一致 PASS |
| SHA256SUMS-iML1515.txt | a3bdf26f41b74f12 | 无外部参考 | a3bdf26f41b74f12 | 登记值 = 实测 PASS |
| SHA256SUMS-MG1655.txt | f7847c33f0e51c6f | 无外部参考 | f7847c33f0e51c6f | 登记值 = 实测 PASS |
| SOURCES.txt | fa31f3afd10b0c7d | 无外部参考 | fa31f3afd10b0c7d | 登记值 = 实测 PASS |

脚本首跑（2026-10-15）：`RESULT: PASS`（exit 0），7/7 文件核对通过。

## 3. 资产身份核对（2026-10-15）

| 文件 | 大小（B） | 身份核验点 | 结论 |
|---|---|---|---|
| iML1515.xml | 11,412,293 | SBML Level 3 Version 1（含 fbc v2 命名空间）；与 PREFLIGHT 记录同一文件（cobra 加载 2,712 reactions / 1,516 genes / 1,877 metabolites；growth 0.876997） | 一致 |
| MG1655_NC_000913.3.fna | 4,708,035 | 头行 `>NC_000913.3 Escherichia coli str. K-12 substr. MG1655, complete genome`；碱基数 4,641,652 | 一致 |
| MG1655_NC_000913.3.gff | 2,314,238 | GFF3；`#!genome-build ASM584v2`；`#!genome-build-accession NCBI_Assembly:GCF_000005845.2`；`##sequence-region NC_000913.3 1 4641652` | 一致（与 fna 碱基数吻合） |
| GCF_000005845.2_genomic.gff.gz | 387,627 | 对应 SHA256SUMS-MG1655.txt 第三条目（gff 原始压缩归档） | 一致 |

## 4. 许可与分发核验

### 4.1 MG1655 / NC_000913.3（NCBI RefSeq）— 依据层级：官方政策原文（已查证，2026-10-15 抓取）

- NCBI「Website and Data Usage Policies and Disclaimers」（http://www.ncbi.nlm.nih.gov/home/about/policies.shtml）：
  - Copyright Status of Webpages：「Information that is created by or for the US government on this site is within the public domain. Public domain information on the National Library of Medicine (NLM) Web pages may be freely distributed and copied. However, it is requested that in any subsequent use of this work, NLM be given appropriate acknowledgment.」
  - Molecular Data Usage：「NCBI itself places no restrictions on the use or distribution of the data contained therein. Nor do we accept data when the submitter has requested restrictions on reuse or redistribution. However, some submitters of the original data … may claim patent, copyright, or other intellectual property rights in all or a portion of the data… NCBI is not in a position to assess the validity of such claims…」
- RefSeq FAQ（NCBI Bookshelf NBK50679）：「RefSeq records are owned by NCBI and therefore can be updated as needed…」→ `NC_000913.3` 为 NCBI 拥有的 RefSeq 记录（美国政府作品 → 公共领域）。
- GenBank Overview（https://www.ncbi.nlm.nih.gov/genbank/）：「NCBI places no restrictions on the use or distribution of the GenBank data. However, some submitters may claim patent, copyright, or other intellectual property rights in all or a portion of the data they have submitted.」
- **结论：NC_000913.3（FASTA 序列 + GFF 注释）可自由使用、复制、修改与再分发（公共领域状态；NLM 建议致谢）。** NCBI 声明其不评估第三方（原始提交者）可能的主张；E. coli K-12 MG1655 基因组序列（Blattner et al., Science 1997）为长期公开序列，未检索到公开的专利/版权主张记录 —— 该项为公开记录层面的观察，非 NCBI 官方确认，标注见 §4.3。

### 4.2 iML1515（BiGG Models）— 依据层级：官方 License 页全文 + 期刊论文声明（已查证，2026-10-15 抓取）

- BiGG License（http://bigg.ucsd.edu/license）关键条款：
  - 「Permission to use, copy, modify and distribute any part of BiGG Models for educational, research and non-profit purposes, without fee, and without a written agreement is hereby granted, provided that the above copyright notice, this paragraph and the following three paragraphs appear in all copies.」
  - 商业用途：「Those desiring to incorporate BiGG Models into commercial products or use for commercial purposes should contact the Technology Transfer & Intellectual Property Services, University of California, San Diego, 9500 Gilman Drive, Mail Code 0910, La Jolla, CA 92093-0910, Ph: (858) 534-5815, FAX: (858) 534-7345, e-mail: invent@ucsd.edu.」
  - 免责：「The BiGG Models provided herein is on an 'as is' basis, and the University of California has no obligation to provide maintenance, support, updates, enhancements, or modifications.」
- BiGG Models 2020（NAR 48:D402-D406, 2020，doi:10.1093/nar/gkz1054）：「BiGG Models is freely available online for academic and non-profit use … under the BiGG License described at http://bigg.ucsd.edu/license. While the content of BiGG is restricted to academic and non-profit use to protect intellectual property claims, the source code is open source … under the MIT license …」
- 引用要求（BiGG 网站「How do I cite BiGG Models?」）：引用最新出版物 King ZA et al., 「BiGG Models: A platform for integrating, standardizing, and sharing genome-scale models」(2016) Nucleic Acids Research 44(D1):D515-D522, doi:10.1093/nar/gkv1049；模型原始论文：Monk JM et al., 「iML1515, a knowledgebase that computes Escherichia coli traits」(2017) Nat Biotechnol 35(10):904-908, doi:10.1038/nbt.3956（PMID 29020004）。
- **模型文件本身未内嵌任何许可/版权文本**（2026-10-15 对 iML1515.xml 全文检索：无 license/copyright/Monk/bigg 字样）→ 若随包分发模型文件，须另行随附 §4.2 许可原文，以满足「provided that … appear in all copies」条件。
- **结论 / 分发限制：**
  1. 学术/研究/非营利项目：允许使用、复制、修改、分发（条件：副本携带版权声明与许可段落）。
  2. 商业用途：禁止；须联系 UCSD 技术转移（invent@ucsd.edu）。
  3. **策略建议（首选）：不随包分发 iML1515.xml；运行时按需从 BiGG 获取**（`http://bigg.ucsd.edu/static/models/iML1515.xml`），下载后立即按本登记表 SHA 校验，校验失败按 §5 fail-closed 处理。理由：a) 避免把第三方许可义务带进发行包；b) 与 BiGG 当前版本保持一致；c) 学术分发虽许可，但「不随包」更保守、更易审计。
  4. 若离线环境必须随包：随附 BiGG License 全文 + 两篇引用（King 2016、Monk 2017），且仅在学术/非营利用途内分发。

### 4.3 不确定项（显式标注，不猜测填补）

- **[待核]** NC_000913.3 原始提交者是否存在未公开的专利/版权主张：NCBI 声明不评估第三方主张；公开记录未见主张，但该观察非 NCBI 官方确认。
- **[待核/需人工复核]** BiGG License 对「模型内容 vs 数据库整体」的覆盖边界：License 页未逐模型说明；iML1515.xml 是否单独受论文作者版权约束未明示。当前按 BiGG License 统一处理（保守解释，不改变学术/非营利结论）。
- **[待核/需人工复核]** 若本项目未来涉及商业产品/商业分发，须在发布前联系 UCSD 技术转移确认（invent@ucsd.edu）。

## 5. 离线 fail-closed 运行口径（供 B1 实现；仅记录，不实现）

- 依赖声明：B1 六工具（chassis_profile / integration_candidates / circuit_contextualize / design_consequence / casefile_validate / casefile_export）凡消费 reference bundle 资产的路径，把「资产就绪」作为前置门禁：先校验后使用。
- **缺文件**：登记在册文件不存在或不可读 → 状态 `DEPENDENCY_UNAVAILABLE`：拒绝执行该步骤，不产出部分结果，不写入科学快照/registry（对齐 A5「registry 只登记 status=OK」），退出非零。
- **哈希不符**：文件存在但 SHA256 ≠ 登记值（或 ≠ SHA256SUMS 值）→ 状态 `BLOCKED`（HASH_MISMATCH）：视为资产受损，禁止使用、禁止缓存、禁止静默重算；建议从来源重新获取后更新登记表并复跑 `scripts/validate_reference_registry.py`。
- **无法访问（运行时获取路径）**：网络不可达 / HTTP 非 200 / 下载后校验失败 → `DEPENDENCY_UNAVAILABLE`：不降级、不缓存未验证内容；重试次数由调用方策略限定（建议 ≤ 3）。
- **校验入口**：`scripts/validate_reference_registry.py`（exit 0 = PASS；非零 = FAIL 且带明细）。任一 FAIL 必须阻断依赖该资产的下游动作。
- 检查顺序建议：目录存在 → 文件存在 → 哈希一致 → 才允许使用；任一失败即短路，错误信息须含文件名与期望/实际哈希。
- 注意：SHA256SUMS 文件为完整性索引，非独立信任根（对齐 D6 备注）；登记表值以 §1 为准。

## 6. 复跑与验收

- 验收命令（派发单 §4）：

```
cd /d D:\Program\Github\dsh-bio-genie
"C:\Users\shuai\.dsh\dsh-bio-genie\python-env\Scripts\python.exe" "scripts\validate_reference_registry.py"
```

- 2026-10-15 首跑：`RESULT: PASS`（exit 0），7/7 文件核对通过（明细见 §2）。
- 负测（2026-10-15，一次性）：`--reference-dir` 指向不存在目录 → FAIL / `DEPENDENCY_UNAVAILABLE`（exit 1）；指向篡改副本（iML1515.xml 尾部加字节）→ FAIL / 哈希不符（exit 1）。均为预期 fail-closed 行为。

## 7. 边界披露

- 本任务仅新增：本文件 ＋ `scripts/validate_reference_registry.py`；未 commit、未执行任何 git 写操作。
- 未修改 `design/packet`、`design/acceptance*`、`design/capability-policy` 及并行轨文件（未做任何写操作）。
- git HEAD 未在本任务内核实（派发单声明 master = `bad53a7`）。
- `design/README.md` 未改动（未将本登记表链接入目录索引；如需可另行提交）。
