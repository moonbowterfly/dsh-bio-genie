# Biopython 许可声明

本插件通过隔离的 Python 虚拟环境使用 **Biopython**（以及 numpy），
并可能随插件分发其 wheel 包。

Biopython 采用双许可：

1. **Biopython License Agreement**（默认，宽松许可）
2. **BSD 3-Clause License**（部分文件可选）

两者均允许：复制、修改、分发、商业使用，无需付费。

条件：
- 保留版权声明（本文件即满足）
- 不得使用 Biopython 贡献者姓名进行广告背书

完整许可文本：
- https://github.com/biopython/biopython/blob/master/LICENSE.rst
- 或本地克隆：`D:\Program\Github\biopython\LICENSE.rst`

---

**注意**：本插件刻意**不包含 BioSQL 模块**。BioSQL 采用 LGPL v3.0
许可（弱 copyleft），为保持插件整体宽松许可，已将其排除。

---

# scipilot-figure-skill 许可声明

本插件的 `python/figurelib/`（setup_style.py / profile_data.py /
export_figure.py / check_figure.py / layout_tools.py / visual_qa.py）
吸收自 [Haojae/scipilot-figure-skill](https://github.com/Haojae/scipilot-figure-skill)
（基线 commit `43098ddb9e6a6d142218540c114f9ed38922fc42`，2026-06-15）。

**MIT License** — Copyright (c) 2026 Haojae

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.

---

# K-Dense scientific-agent-skills 许可声明

本插件的 `python/figurelib/assets/`（nature/publication/presentation.mplstyle、
publisher_profiles.json、color_palettes.py）吸收自
[K-Dense-AI/scientific-agent-skills](https://github.com/K-Dense-AI/scientific-agent-skills)
的 scientific-visualization skill（基线 commit
`991bd993aca4e90891d1f9908ba82ef45d77b6f0`，2026-08-07）。
知识型内容（坐标系统、统计检验、富集解读、文献检索策略）经重写吸收
进 skills/ 协议文档，出处已标注在对应协议正文。

**MIT License** — Copyright (c) 2025 K-Dense Inc.

（许可全文与上文 scipilot 条目一致，MIT 标准文本）

---

# R 语言与 R/Bioconductor 生态许可声明（2026-08-17 起）

## 分发模型（与 Python 侧同构，零源码复制）

本插件**不随 npm 包分发任何 R、CRAN、Bioconductor 软件本体或源码**。
插件仓库只包含：

1. `r/requirements-r.txt` —— 包名清单（事实性信息，非版权客体）；
2. `r/r_bridge.R` / `r/install_packages.R` —— 本插件原创脚本（MIT）；
3. `skills/bio-r-*.md` 等 —— 原创中文教学文档（方法学借鉴官方 vignette，非文字复制；
   Bioconductor 官方 vignette 页明确欢迎教学用途，见 https://bioconductor.org/help/package-vignettes/）。

所有软件均在**运行时由引导器从官方仓库下载、安装到用户私有目录**
（`~/.dsh/dsh-bio-genie/r/` 与 `r-lib/`），与用户自行执行
`BiocManager::install()` 在许可意义上完全等同。

## R 本体

R 采用 **GPL-2 | GPL-3** 双许可（https://www.r-project.org/COPYING）。
本插件以独立子进程（Rscript）调用 R——插件与 R 之间无链接、无衍生，
R 安装器由用户侧下载安装，插件不分发 R 二进制，故 GPL 义务不传导至插件本体（MIT）。
插件配置 `rscriptPath` 亦可指向用户自行安装的 R。

## 核心包集许可证清单（2026-08-17 从各包官方页面/DESCRIPTION 逐一核实）

| 包 | 来源 | 许可证 |
|---|---|---|
| R 4.6.0 | r-project.org | GPL-2 \| GPL-3 |
| BiocManager | CRAN | Artistic-2.0 |
| jsonlite / dplyr / tibble / readr / ggplot2 | CRAN | MIT |
| BiocGenerics / S4Vectors / IRanges / GenomicRanges / Biostrings / SummarizedExperiment | Bioconductor | Artistic-2.0 |
| clusterProfiler / ggtree | Bioconductor | Artistic-2.0 |
| fgsea / ComplexHeatmap | Bioconductor | MIT (+ file LICENSE) |
| DESeq2 | Bioconductor | LGPL (>= 3) |
| edgeR / limma | Bioconductor | GPL (>= 2) |
| phyloseq | Bioconductor | AGPL-3 |

## 各许可类别在本模型下的合规说明

- **Artistic-2.0 / MIT**：宽松许可，运行时安装与 API 调用无任何限制。
- **LGPL (>=3)（DESeq2）**：弱 copyleft——仅约束对库本身的修改再分发。
  本插件不复制、不修改、不分发 DESeq2，只在其官方发行版上通过公开 API 调用，
  与"动态链接 LGPL 库"同等甚至更宽松（独立进程），无义务传导。
- **GPL (>=2)（edgeR/limma/R 本体）**：独立进程调用 + 用户侧下载安装 +
  零分发 = 聚合（mere aggregation）关系，插件 MIT 保持成立。
- **AGPL-3（phyloseq）**：AGPL 的"网络服务条款"仅约束**再分发 AGPL 代码或其衍生**
  的行为。本插件：①不分发 phyloseq 任何代码（用户运行时从官方仓库安装）；
  ②插件的 R 脚本与 skill 只是通过公开 API 调用它，不构成衍生作品。
  因此无 AGPL 义务。与 Python 侧排除 BioSQL（LGPL）的区别：BioSQL 当年若吸收
  需要**复制源码进插件**，而 phyloseq 完全不复制——风险更低。若后续社区出现
  不同解读争议，可随时从核心包集移除 phyloseq（微生物组能力由用户自行安装替代）。

**结论**：R 生态集成在分发模型、许可类别、进程边界三个层面均合法合规；
唯一较激进项（AGPL-3 的 phyloseq）经上述论证属于"运行时安装 + API 调用"，
不构成再分发，风险可控且可随时降级。


