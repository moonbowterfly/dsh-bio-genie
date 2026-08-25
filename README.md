# 🧬 dsh-bio-genie

<div align="center">

**中文** | [English](README.en.md)

</div>

**面向 DeepSeek Harness (dsh) 的生物信息学「许愿式分析」插件**

> **dsh bio analysis** · **dsh biology analysis** · **deepseek harness bioinformatics** · Biopython · sequence analysis · genomics
>
> 说人话，出结果。用户用自然语言描述生物学分析需求，dsh 的 agent 自动完成分析。

**下载安装即用** —— 无需用户安装 Python 或 Biopython，插件首次运行自动引导完全隔离的 Python 环境。

---

## ✨ 特性

| 特性 | 说明 |
|------|------|
| 🪄 **许愿式分析（Wish Coding）** | 说人话就能分析：*"这条序列的 GC 含量和 EcoRI 酶切位点？"* |
| 🧩 **全功能覆盖** | `bio_python` 执行器可运行任意 Biopython 代码（比对、PDB、Phylo、motif、BLAST…），配合 21 个领域/研究 skill 配方 |
| ⚡ **高频语义化工具** | 44 个固定参数工具（GC 含量、翻译、限制酶、k-mer、文件 IO、BLAST、多序列比对、系统发育树、Entrez 检索、通路富集、PubMed 文献、参考基因组、出版级绘图、机器学习、DNA 设计、Primer3 引物/多约束 DNA 优化/克隆模拟/SBOL 标准化/生产包络线、基因回路编译/动力学仿真、差异表达/GSEA）+ 5 个执行器/元工具（bio_python / bio_env / bio_log / bio_memory / bio_goal）——省 token、输出稳定、参数有校验 |
| 📦 **零安装** | 自动下载隔离的 Python 环境（uv + venv + Biopython 绘图栈）到 `$DSH_HOME/dsh-bio-genie/`，不污染系统 |
| 🇨🇳 **网络自动适配** | 默认直连官方源，任一环节失败自动切换国内镜像（uv→清华 PyPI、CPython→npmmirror、PyPI 包→清华镜像），无需任何配置 |
| 🛡️ **环境隔离** | Python 子进程以 `-I`（isolated）模式运行，不受宿主 PYTHONPATH 污染 |
| 🔁 **自愈执行（ACR）** | bio_python 失败返回 `needs_repair` 信号 + stderr，模型自动修复重试（最多 3 次），失败即如实报告 |
| 📜 **透明性日志** | 每次代码执行/工具调用异步记 JSONL 日志（哈希/预览/耗时），`bio_log` 可回溯任何一次分析 |
| 🧬 **科学严谨性约束** | persona 强制「生物学结论必须可溯源到工具输出」，纯推断标注 [推断-未验证] |
| 🧠 **会话记忆** | 成功代码模式 + 错误→修复经验自动沉淀（本地 JSON），`bio_memory` 查询，越用越聪明 |
| ⚙️ **设置面板** | dsh 设置面板（⚙️ 齿轮）侧栏「BioGenie」菜单——标签页：总览（包元信息/配置默认值）、Skill 模块（49 个条目按主 skill/领域/研究/协议/指南分组）、Python 环境（venv 包列表）、工具调试 |
| 📚 **协议知识库** | 17 个高频任务协议（质控/比对/BLAST/克隆/建树/结构/富集/出版级绘图/坐标系统/统计检验/差异表达/GSEA…），每个含可执行代码模板 + 常见坑，随插件打包 |

---

## 📦 安装

本插件已发布为 npm 包 `@dsh-bio/dsh-bio-genie`，使用 dsh 官方标准的 `dsh plugin` 命令安装：

```sh
# 方式一：从 npm 安装（推荐，安装预构建代码）
dsh plugin --profile web add @dsh-bio/dsh-bio-genie

# 方式二：从 GitHub 安装（拉取源码；本插件为纯 ESM 无构建步骤，可直接加载）
dsh plugin --profile web add github:moonbowterfly/dsh-bio-genie

# 方式三：从本地目录安装（开发调试）
dsh plugin --profile web add ./dsh-bio-genie
```

安装后重启 dsh web 服务，插件即被加载。首次启动时插件会在后台自动引导 Python
环境（下载 uv → Python 3.12 → venv → biopython，约 1-2 分钟），之后秒级就绪。

验证插件层是否生效（无需启动）：

```sh
dsh --profile web --dump-config   # 输出中应包含 "# == dsh-bio-genie" 层
```

### 故障排除：profile 已有本地包导致 pnpm 校验失败

若你的 profile 里已装过**不在 npm registry 的本地包**（如皮肤插件），`dsh plugin add`
触发的 pnpm 全量校验可能报 `ERR_PNPM_FETCH_404`。此时可手动挂载（已验证可行）：

```bash
mkdir -p ~/.dsh/profiles/web/node_modules/@dsh-bio/dsh-bio-genie
cd /path/to/dsh-bio-genie
cp -r src index.js cordis.patch.yml package.json skills prompts python docs \
  README.md README.en.md LICENSE THIRD_PARTY_NOTICES.md \
  ~/.dsh/profiles/web/node_modules/@dsh-bio/dsh-bio-genie/
```

然后在 `~/.dsh/profiles/web/package.json` 中：
- `dependencies` 添加：`"@dsh-bio/dsh-bio-genie": "file:.../dsh-bio-genie"`
- `dsh.profile.bundles` 数组添加：`"@dsh-bio/dsh-bio-genie"`

最后重启 dsh web 服务。

---

## 🛠 工具总览

### 执行器与元工具

| 工具 | 功能 |
|------|------|
| `bio_python` | 运行任意 Biopython Python 程序（比对/PDB/Phylo/motif/复杂流程/自定义分析/出版级绘图），覆盖 100% 长尾需求 |
| `bio_env` | Python 环境诊断 / 重建 |
| `bio_log` | 执行日志回溯（bio_python 代码哈希/预览/耗时 + 工具调用记录） |
| `bio_memory` | 会话记忆查询（成功代码模式 / 错误修复经验，越用越聪明） |

### 语义化工具（高频稳定操作）

| 工具 | 功能 | 典型触发词 |
|------|------|-----------|
| `bio_seq_analyze` | 长度 / GC% / 反向互补 / **六框翻译**（正负链）/ 分子量 / 蛋白 AA 组成 | GC含量、序列特征、翻译 |
| `bio_seq_translate` | DNA→蛋白翻译（可指定密码子表） | 翻译、蛋白序列 |
| `bio_seq_gc_skew` | GC skew（复制起点识别） | 偏斜、复制起点 |
| `bio_seq_find_orf` | 最长开放阅读框 | ORF、编码区 |
| `bio_seq_kmer` | k-mer 频率统计 | k-mer |
| `bio_seq_io_read` | 读 FASTA/GenBank（UTF-8/GBK 自适应） | 读取fasta、解析文件 |
| `bio_seq_io_write` | 写序列文件 | 写fasta、保存序列 |
| `bio_seq_restriction` | 限制酶切位点（CommOnly 默认 / all 可选） | 限制酶、酶切位点 |
| `bio_blast_search` | 远程 BLAST（NCBI qblast：blastn/blastp/blastx → 命中 accession/e-value/score/一致性） | BLAST、同源性搜索 |
| `bio_msa` | 多序列比对（clustalw/muscle；返回 Clustal+FASTA 比对、共识序列、保守性统计；缺二进制返回安装提示） | 多序列比对、MSA |
| `bio_phylo_build` | 系统发育树构建（nj/upgma → Newick；可接 bio_msa 的 alignment_fasta 输出） | 进化树、建树、NJ |
| `bio_entrez_search` | NCBI 检索（esearch+esummary；db=gene 返回基因元数据摘要：全名/染色体位置/别名） | NCBI、检索基因、查基因信息 |
| `bio_entrez_fetch` | NCBI 取序列 | 下载序列 |
| `bio_enrichr` | 通路/GO 富集分析（基因符号列表 → p 值排序条目；GO/KEGG/Reactome/MSigDB 等库） | 富集分析、通路、GO、KEGG |
| `bio_pubmed_search` | PubMed 文献检索（PMID/标题/期刊/作者/DOI） | 查文献、PubMed |
| `bio_pubmed_abstract` | 按 PMID 取结构化摘要（标题/摘要全文/作者/日期/DOI） | 读摘要、PMID |
| `bio_ref_genome` | 参考基因组 assembly 信息（Ensembl：assembly 名/染色体/下载目录） | 参考基因组、基因组版本 |

### 序列类型自动判断

`bio_seq_analyze` 的 `seq_type` 默认 `auto`，自动识别三类序列：
- 含 U 无 T → **RNA**
- 含 IUPAC 模糊碱基（R/Y/S/W/K/M/B/D/H/V）、X（未知/修饰碱基）、比对 gap 字符（-/.）→ **DNA**（引物/探针/SNP/比对结果安全）
- 出现非核酸字母 → **蛋白质**

X 与 gap 在翻译时按未知碱基处理（Biopython 标准行为），含 X/gap 的序列不会因模糊密码子崩溃。

---

## 📚 Skill 体系（49 个）

### 主 skill：`dsh-bio-genie`
工具分层决策树：**先查语义化工具表 → 命中就用；否则用 bio_python 执行器写 Biopython 代码**。

### 17 个领域配方 + 4 个研究方法

| Skill | 覆盖的 Biopython 模块 |
|-------|---------------------|
| `bio-core` | 核心工作流（任何分析先加载） |
| `bio-io` | Bio.SeqIO（FASTA/FASTQ/GenBank/EMBL…） |
| `bio-seq` | Bio.Seq / Bio.SeqUtils（GC、Tm、分子量） |
| `bio-align` | Bio.Align.PairwiseAligner / Bio.AlignIO |
| `bio-blast` | Bio.Blast（NCBIWWW / NCBIXML） |
| `bio-searchio` | Bio.SearchIO（BLAST/HMMER/Exonerate 解析） |
| `bio-entrez` | Bio.Entrez（esearch/efetch/esummary/elink） |
| `bio-phylo` | Bio.Phylo（Newick/Nexus、系统发育） |
| `bio-structure` | Bio.PDB（结构解析、距离、叠合） |
| `bio-motif` | Bio.motifs（PWM、JASPAR/MEME） |
| `bio-restriction` | Bio.Restriction（酶切位点、片段） |
| `bio-utils` | Bio.Data.CodonTable（遗传密码表、密码子用法） |
| `bio-graphics` | Bio.Graphics.GenomeDiagram（图谱绘制） |
| `bio-popgen` | Bio.PopGen（群体遗传学） |
| `bio-figure` | 出版级科研绘图顾问（figurelib：选图决策、18 陷阱、期刊规格、CJK 中文） |
| `bio-ml` | scikit-learn 生物数据机器学习（分类/降维/聚类/特征重要性） |
| `bio-dna-design` | DNA 设计（引物、密码子优化、质粒图谱） |

研究方法 skill：`bio-survival-analysis`（生存分析）、`bio-variant-analysis`（变异分析）、`bio-literature-review`（文献综述）、`bio-paper-writing`（论文写作）。另有 17 个协议模板与 8 份 agent 使用指南，随插件打包。

---

## 🧞 精灵专家人设（`bio-genie` preset）

本插件同时提供一个 **dsh agent preset（智能体预设）**——`bio-genie`，让 AI 一进 dsh 就成为精通本插件的「**生物基因精灵**」专家人设。

### 它是什么

- **人设文件**（`preset/bio-genie/preset.yml` + `agent.cordis.yml`）——覆盖 base persona，告诉 AI「你手头有 51 个工具 + 49 个 skill」。
- **入门口诀**（`skills/dsh-bio-genie-expert.md`）——一个 meta-skill：「先看工作区 → 二选一（语义化工具 / `bio_python`） → 失败按 ACR 三层修 → 报告带可追溯链」。
- **一键安装**：`pnpm install` 跑 postinstall 钩子会自动把 preset 复制到 `~/.dsh/.agent-presets/bio-genie/`；无需手动操作。

### 它**不是**

- ❌ **不接管 49 个工具**——所有 `bio_*` 工具仍由本插件的 `cordis.patch.yml` 注入，preset **不重声明**任何工具，避免冲突。
- ❌ **不抢默认人设**——postinstall 装完后，「生物基因精灵」出现在 dsh 预设选择器里；用户**主动选择**才激活。`agent-presets.default` 不会被改成 `bio-genie`。
- ❌ **不破坏其他插件**——presets 与 plugins 是 dsh 的两个独立 seam，共存不冲突。

### 怎么用

1. **安装本插件**：`pnpm add @dsh-bio/dsh-bio-genie`（postinstall 会自动装 preset）。
2. **重启 dsh web**。
3. **设置面板** → 选「**生物基因精灵**」人设。
4. 之后 AI 启动会话即说：「我是生物基因精灵……你的工作区是 `{{cwd}}`……先看看你有什么数据再开工」。

### 手动安装 / 卸载

```bash
# 手动复制（postinstall 失败时）
node scripts/install-preset.js

# 强制覆盖（用户就地编辑过 preset 时也覆盖）
node scripts/install-preset.js --force

# 试运行（只看会做什么）
node scripts/install-preset.js --dry-run

# 卸载：直接删
#   Windows: rd /s /q %USERPROFILE%\.dsh\.agent-presets\bio-genie
#   macOS/Linux: rm -rf ~/.dsh/.agent-presets/bio-genie
```

### 故障排除

- **预设选择器看不见「生物基因精灵」** → 检查 `~/.dsh/.agent-presets/bio-genie/preset.yml` 是否存在；不存在则 `node scripts/install-preset.js` 手动装。
- **切到 preset 后工具没出现** → 工具由插件注入，与 preset 无关；检查插件是否真在 `dependencies`（`pnpm ls @dsh-bio/dsh-bio-genie`）。
- **想自定义 persona** → 直接编辑 `~/.dsh/.agent-presets/bio-genie/agent.cordis.yml`（不被自动覆盖除非 `--force`）。

---

## 🚀 使用示例

**场景 1：语义化工具路径（高频操作）**

> 用户：*"分析这个文件里的序列 GC 含量和 EcoRI 位点：D:/data/genes.fasta"*

```
agent 自动：
1. bio_seq_io_read        → 读取 FASTA
2. bio_seq_analyze        → 逐条 GC 含量
3. bio_seq_restriction    → 检查 EcoRI
4. 汇总报告 + 生物学解读
```

**场景 2：执行器路径（语义化工具覆盖不到的功能）**

> 用户：*"画一下这两个基因的蛋白结构比对"*

```
agent 自动：
1. 加载 bio-align / bio-structure skill
2. bio_python 写 Biopython 程序执行
3. 产出文件 + 报告
```

**场景 3：组合路径（实测）**

> 用户：*"读取 FASTA 分析每条序列的 GC、最长 ORF 和 EcoRI 位点"*

```
agent 自动（实测行为）：
1. 加载 dsh-bio-genie 主 skill（决策指引）
2. bio_seq_io_read 读取文件
3. bio_python 一次性完成 GC + ORF + 酶切组合分析
4. 输出汇总表（GC 48.28%、ORF 7aa、EcoRI nt 3-8）+ 生物学解读
```

---

## 🔧 环境引导（零依赖自举）

首次调用（或 dsh 启动后台预热）时插件自动执行：

```
1. 下载 uv            → $DSH_HOME/dsh-bio-genie/bin/uv
   （官方 GitHub 直连失败自动切换清华 PyPI 的 uv wheel，实测 18MB/约 2 秒）
2. uv python install  → $DSH_HOME/dsh-bio-genie/python/（私有 CPython 3.12）
   （官方源失败自动切换 npmmirror 的 python-build-standalone 镜像）
3. uv venv --seed     → $DSH_HOME/dsh-bio-genie/python-env/（预装 pip，方便按需补包）
4. uv pip install     → biopython + numpy + matplotlib + reportlab + pandas/scipy/seaborn/Pillow（出版级绘图栈；官方 PyPI 失败自动切换清华镜像）
```

- **网络自动适配**：每个环节默认直连官方源，失败自动切换国内镜像，全程无需用户配置；
  高级用户可用环境变量覆盖镜像地址（`DSH_BIO_UV_BASE` / `DSH_BIO_PYTHON_MIRROR` / `DSH_BIO_PYPI_INDEX`，
  也尊重 uv 官方变量 `UV_PYTHON_INSTALL_MIRROR` / `UV_DEFAULT_INDEX` / `UV_INDEX_URL`）；
  ⚠️ uv 二进制下载后一律做 SHA256 校验（官方/镜像通道均校验，校验失败拒绝执行）——
  自定义 `DSH_BIO_UV_BASE` 镜像需在镜像根目录提供 `sha256sums.txt`（与 uv 官方 release 同格式）
- **全部产物**在 `$DSH_HOME/dsh-bio-genie/`（默认 `~/.dsh/dsh-bio-genie/`），删除即完全卸载
- **不假设系统有任何 Python/uv**（自举）；引导失败自动回退系统 python（若有）
- **升级插件不丢环境**：环境在 DSH_HOME 私有目录，与插件本体（node_modules）分离
- **幂等**：已就绪则秒级复用；引导失败自动重试
- 首次引导需网络；引导完成后可离线使用语义化工具

---

## 🔄 兼容性

| 维度 | 要求 |
|------|------|
| **Node** | `^22.19 \|\| >=24`（与 dsh 一致） |
| **dsh** | peer 依赖 `@deepseek-ai/dsh-tools` 等为 `^0.1.0-rc.6`，与 dsh 源码仓库当前构建版本匹配。若宿主 dsh 为 npm `latest` 旧版本（`0.0.1-rc.1`），可能解析出两份 `dsh-tools` 导致类型不匹配——建议使用与源码仓库同步构建的 dsh |
| **平台** | Windows / macOS / Linux（x86_64 / arm64），按平台自动下载对应 uv/Python |

---

## 🧩 开发

纯 ESM JavaScript，**无构建步骤**，改完即用：

```bash
git clone https://github.com/dsh-bio/dsh-bio-genie
# 直接调用引导器（首次会下载环境，约 1-2 分钟）：
node --input-type=module -e "import('./src/runtime.js').then(m => m.ensureEnvironment({}))"
```

- 架构设计详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)
- **给 dsh agent 的使用说明书**：[docs/agent-guide/](docs/agent-guide/)——8 份指南（总览/工具参考/skill 导航/bio_python 编程/工作流/绘图专题/故障排查/严谨性），随插件注册为 `dsh-bio-genie-guide-*` 技能，agent 可随时加载
- 加语义化工具：`python/bio_ops.py` 加 op + `src/tools.js` 加 bioTool 条目
- 加领域 skill：`skills/bio-xxx.md` + `src/skills.js` 的 SKILL_MANIFEST
- **skill 语言标注约定**：所有 skill（领域/协议/指南）开头 frontmatter 必须含 `language:` 字段（`python`/`r`/`mixed`/`none`），test-skills.mjs 强制校验

---

## 📄 许可证

- **dsh-bio-genie 本体**：MIT License
- **Biopython**：Biopython License Agreement / BSD 3-Clause（宽松，详见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)）
- **numpy**：BSD License
- **scipilot-figure-skill**（figurelib 绘图脚本）：MIT（Copyright Haojae，详见 THIRD_PARTY_NOTICES.md）
- **K-Dense scientific-agent-skills**（figurelib 样式资产 + 知识型协议来源）：MIT（Copyright K-Dense Inc.，详见 THIRD_PARTY_NOTICES.md）
- **不含 BioSQL**（LGPL，刻意排除）

---

## 🙏 致谢

本项目的一切生物学计算能力都建立在 **Biopython** 之上 —— 感谢 [biopython/biopython](https://github.com/biopython/biopython) 项目及全体贡献者 25 年来的卓越工作：他们维护的序列分析、比对、结构生物学、系统发育等高质量实现，让"许愿式生物信息学"成为可能。Biopython 采用宽松的 [Biopython License Agreement](https://github.com/biopython/biopython/blob/master/LICENSE.rst)（兼容 BSD 3-Clause），允许自由复制、修改与分发，本插件因此得以安心地依赖并推广它。

出版级绘图能力（figurelib）借鉴了 [Haojae/scipilot-figure-skill](https://github.com/Haojae/scipilot-figure-skill)（MIT）的"可视化顾问"工作流与视觉自检设计，样式资产与部分知识型协议参考 [K-Dense-AI/scientific-agent-skills](https://github.com/K-Dense-AI/scientific-agent-skills)（MIT）——一并致谢。

同时感谢 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 提供的插件化 Agent 框架，以及 numpy 社区的基础贡献。
