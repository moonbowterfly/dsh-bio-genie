# 故障排查与插件边界

> 出错了先看这里；用户要"超能力"时，先看边界表再如实回答。

## 1. 环境类故障

| 现象 | 原因 | 处理 |
|---|---|---|
| 首次调用几分钟没返回 | 正在引导环境（下载 uv/CPython/装包） | 告知用户等待，**不要重复调用**（重复调用只是排队） |
| `bio_env` ready=false | 引导失败（网络/磁盘） | 看 error 字段；建议 `bio_env reinstall=true` 重试一次 |
| ImportError（某个包） | 升级后新依赖未补装（或环境损坏） | 插件会**自动补装**；若仍失败 `bio_env reinstall=true` |
| 引导日志提到 GitHub 下载失败 | 官方源不可达 | 插件自动切国内镜像（无需你处理）；用户显式设过 DSH_BIO_UV_BASE 时要提醒检查其镜像 |

## 2. bio_python 失败

`needs_repair: true` 时按 stderr 修复重试（最多 2 次修复），常见签名：

| stderr 签名 | 根因 | 修法 |
|---|---|---|
| `ModuleNotFoundError: No module named 'ete3' / 'scanpy' / ...` | 不在环境内 | 换 Biopython 等效实现（见边界表），不要 pip install |
| `TranslationError` | 模糊密码子（XXG/--A） | 翻译前 `seq.replace('X','N').replace('-','N').replace('.','N')` |
| `ValueError: Cannot read from ...` | SeqIO 格式不对 | 检查 format 参数/文件内容；先用 bio_seq_io_read 验证 |
| `UnicodeDecodeError` | 中文 Windows 文件 GBK 编码 | `open(path, encoding='utf-8', errors='replace')` 或先按字节读再降级 |
| `HTTPError: 429` | NCBI 限流 | `time.sleep(0.4)` 后重试；批量任务按 entrez-batch 协议分批 |
| `TimeoutError` / 网络超时 | 网络/代理问题 | 一次重试；仍失败如实报告网络问题 |
| `Process killed` / timedOut | 超时（默认 60s） | 传更大 `timeoutMs`；大数据改成写文件而非 print |

3 次尝试后仍失败：**停止并如实报告**（错误 + 已尝试的修复），绝不编造。

## 3. 网络类

- NCBI/Enrichr/PubMed 的限流与缓存已由插件内置（语义化工具）；bio_python 内直接调 API 时自己 sleep。
- Ensembl REST（ref_genome）：直连优先、代理回退已内置；报错时如实转达。
- 中国网络：引导器自动镜像切换；BLAST qblast 偶发超时→重试一次。
- OpenAlex/OLS4（协议内模板）：api.openalex.org 与 ebi.ac.uk 需网络，直连失败可在 bio_python 里加 ProxyHandler({}) 直连优先。

## 4. 插件边界（用户要超能力时——如实说明 + 给替代方案）

| 用户想要 | 插件现状 | 替代方案（你可以做的） |
|---|---|---|
| 单细胞分析（scanpy/Seurat） | ❌ 不内置（numba/torch 体积 1GB+） | 建议用在线平台；插件可做下游基因列表富集（bio_enrichr） |
| RNA-seq 上游（STAR/Salmon/FastQC） | ❌ 外部二进制不可装 | 用户给 counts 矩阵，插件可做统计检验+绘图+富集 |
| MAFFT/IQ-TREE 精确建树 | ❌ 外部工具 | Bio.Phylo 距离法 NJ（小数据集够用），如实说明近似 |
| 分子对接/蛋白结构预测（AlphaFold 等） | ❌ GPU 级 | 建议云平台；插件可做 Bio.PDB 结构分析 |
| 化学信息学（RDKit/SMILES） | ❌ 明确排除 | 建议其他工具链 |
| GSEA 排序富集 | ⚠️ 仅 ORA（bio_enrichr） | 可用 numpy 手写简化 GSEA，或如实说明需外部 gseapy |
| 交互式图（plotly） | ❌ 未内置 | matplotlib 静态图完全够期刊投稿 |
| 图像 AI 读图复核 | ⚠️ 依赖 dsh 模型多模态 | 无多模态时用程序自检（audit_layout）+ 清单核对 |

原则：**说"做不到"时，永远跟一个"但你可以……"**；绝不让用户手动装东西（违反对"零安装"的承诺时，改成推荐替代路径）。

## 5. 数据安全与文件位置

- 所有分析在本地进行（除显式网络查询）；产出文件写在工作区，报告绝对路径。
- 插件运行数据在 `~/.dsh/dsh-bio-genie/`（环境/日志/记忆）——不要当作用户数据目录。
- 日志可回溯：`bio_log action=search query=<错误信息>`。
