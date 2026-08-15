# dsh-bio-genie

**生物信息学「许愿式分析」插件 for DeepSeek Harness (dsh)**

用户用自然语言描述生物学分析需求，dsh 的 agent 自动完成分析。
**下载安装即用**——无需用户安装 Python 或 Biopython，插件首次运行自动引导隔离环境。

## ✨ 特性

- **许愿式分析（Wish Coding）**：说人话就能分析（"这条序列的 GC 含量和 EcoRI 酶切位点？"）
- **全功能覆盖**：`bio_python` 执行器可运行任意 Biopython 代码（比对、PDB、Phylo、motif、BLAST…）+ 14 个领域 skill 配方
- **高频语义化工具**：11 个固定参数工具（GC 含量、翻译、限制酶、k-mer、文件 IO、Entrez…）——省 token、输出稳定
- **零安装**：自动下载隔离的 Python 环境（uv + venv + Biopython）到 `$DSH_HOME/dsh-bio-genie/`，不污染系统
- **国内网络友好**：`DSH_BIO_UV_BASE` 镜像开关加速 uv 下载
- **环境隔离**：Python 子进程以 `-I` 隔离模式运行，不受宿主 PYTHONPATH 污染

## 📦 安装

```bash
# 在 deepseek-harness 仓库目录下，或直接手动挂载（见下）
dsh plugin --profile web add "link:<本插件路径>"
# 或发布到 npm 后：
dsh plugin --profile web add @dsh-bio/dsh-bio-genie
```

重启 dsh web 服务后生效。首次启动时插件会在后台自动引导 Python 环境
（下载 uv → Python 3.12 → venv → biopython），之后秒级就绪。

### 手动挂载（profile 有本地包时）

```bash
mkdir -p ~/.dsh/profiles/web/node_modules/@dsh-bio/dsh-bio-genie
cp -r lib scripts cordis.patch.yml package.json ~/.dsh/profiles/web/node_modules/@dsh-bio/dsh-bio-genie/
# 在 ~/.dsh/profiles/web/package.json 的 dependencies 加
#   "@dsh-bio/dsh-bio-genie": "file:.../dsh-bio-genie"
# 在 dsh.profile.bundles 数组加 "@dsh-bio/dsh-bio-genie"
```

## 🛠 工具总览

### 执行器（覆盖 100% Biopython）
| 工具 | 功能 |
|------|------|
| `bio_python` | 运行任意 Biopython Python 程序（比对/PDB/Phylo/motif/复杂流程） |
| `bio_env` | 环境诊断/重建 |

### 语义化工具（高频稳定操作）
| 工具 | 功能 | 触发词 |
|------|------|--------|
| `bio_seq_analyze` | 长度/GC%/反向互补/三框翻译/分子量 | GC含量、序列特征 |
| `bio_seq_translate` | DNA→蛋白翻译 | 翻译、蛋白序列 |
| `bio_seq_gc_skew` | GC skew | 偏斜、复制起点 |
| `bio_seq_find_orf` | 最长开放阅读框 | ORF、编码区 |
| `bio_seq_kmer` | k-mer 频率 | k-mer |
| `bio_seq_io_read` | 读 FASTA/GenBank | 读取fasta、解析文件 |
| `bio_seq_io_write` | 写序列文件 | 写fasta、保存序列 |
| `bio_seq_restriction` | 限制酶切位点 | 限制酶、酶切位点 |
| `bio_entrez_search` | NCBI 检索 | NCBI、检索基因 |
| `bio_entrez_fetch` | NCBI 取序列 | 下载序列 |

### Skill（14 领域 + 1 主）
`dsh-bio-genie`（主指引）· `bio-core` · `bio-io` · `bio-seq` · `bio-align` · `bio-blast` · `bio-searchio` · `bio-entrez` · `bio-phylo` · `bio-structure` · `bio-motif` · `bio-restriction` · `bio-utils` · `bio-graphics` · `bio-popgen`

## 🚀 使用示例

**用户**：*"分析这个文件里的序列 GC 含量和 EcoRI 位点：D:/data/genes.fasta"*

agent 自动：
1. `bio_seq_io_read` → 读取 FASTA
2. `bio_seq_analyze` → 逐条 GC 含量
3. `bio_seq_restriction` → 检查 EcoRI
4. 汇总报告 + 生物学解读

**用户**：*"画一下这两个基因的蛋白结构比对"*（无对应语义化工具）

agent 自动：
1. 加载 `bio-align` / `bio-structure` skill
2. `bio_python` 写 Biopython 程序执行
3. 产出文件 + 报告

## 🔧 环境引导

首次调用（或 dsh 启动后台预热）时插件：

1. 下载 uv（GitHub release；`DSH_BIO_UV_BASE` 可换镜像加速，如 `https://gh-proxy.com/https://github.com/astral-sh/uv/releases/download/0.7.5`）
2. `uv python install 3.12 --install-dir <priv>` → 私有 CPython
3. `uv venv` → 私有虚拟环境
4. `uv pip install biopython numpy`

产物在 `$DSH_HOME/dsh-bio-genie/`（默认 `~/.dsh/dsh-bio-genie/`）。删目录即卸载。
系统无任何 Python/uv 也能工作（自举）；引导失败自动回退系统 python（若有）。

## 🔄 兼容性

- **Node**：`^22.19 || >=24`（与 dsh 一致）
- **dsh**：插件 peer 依赖声明 `@deepseek-ai/dsh-tools` 等为 `^0.1.0-rc.6`，与 dsh 源码仓库当前构建版本匹配。若你的宿主 dsh 为 npm `latest` 旧版本（`0.0.1-rc.1`），可能同时解析出两份 `dsh-tools` 导致类型不匹配——**建议使用与源码仓库同步构建的 dsh**（`deepseek-harness` 仓库 `pnpm run build` 后运行）。
- **平台**：Windows / macOS / Linux（x86_64 / arm64），按平台自动下载对应 uv/Python

## 📄 许可证

- **dsh-bio-genie 本体**：MIT License
- **Biopython**：Biopython License Agreement / BSD 3-Clause（宽松，见 THIRD_PARTY_NOTICES.md）
- **numpy**：BSD License
- **不含 BioSQL**（LGPL，刻意排除）

## 🧩 开发

```bash
npm install --legacy-peer-deps   # 仅 schemastery 运行时依赖
node --input-type=module -e "import('./src/runtime.js').then(m => m.ensureEnvironment({}))"
```
纯 ESM 无构建，改完即用。详见 [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)。
