/**
 * dsh-bio-genie — 第二层/第三层依赖注册表（合成生物学扩展）
 *
 * 分层模型（设计文档 05-实施细节-架构集成.md）：
 *  - 第一层（builtin）：python/requirements.txt，环境引导时一次性安装，始终可用。
 *  - 第二层（auto）：EXTRA_DEPS —— op 首次调用时由 runtime.ensureExtraDeps()
 *    检测缺失并用 uv pip install 自动补装，不增加首装体积。
 *  - 第三层（addon）：ADDON_MODULES —— 体积大或受众窄的能力包，需用户在
 *    设置面板显式安装（Phase 2/3 预留，当前仅登记元数据）。
 *
 * @module dsh-bio-genie/extra-deps
 */

/** 第二层：op 名 → 运行时按需自动补装的 pip 包列表。 */
export const EXTRA_DEPS = {
  // 合成生物学 Phase 1 下沉项（2026-08-26 v0.6.16）：原第一层内置。因第一层全量解析
  // 单包无解即整体失败——dnachisel>=3.3.0 unsatisfiable 曾卡死整个冷启动引导；
  // 且 primer3-py 在 Windows+Py3.12 只有 <=2.3.0 的 wheel。下沉后按需补装、故障局部化。
  primer3_design: ['primer3-py>=2.3.0'],
  dna_optimize: ['dnachisel>=3.2,<4'],
  plasmid_map: ['dna-features-viewer>=3.1'],
  // SBOL 标准化（2026-08-26 二次下沉）：tyto 依赖 pyparsing(<3)，留在第一层会把
  // 整个环境钉死在 pyparsing 2.4.7，与下方 clone_simulate 护栏结构性互斥。
  sbol_write: ['sbol3>=1.0', 'tyto>=1.4'],
  sbol_read: ['sbol3>=1.0', 'tyto>=1.4'],
  // pyparsing>=3.1 是防冲突护栏：pydna 的传递依赖会把 pyparsing 降到 2.4.7，
  // 破坏 matplotlib（_fontconfig_pattern 需要 pyparsing3 的 one_of）。
  clone_simulate: ['pydna', 'pyparsing>=3.1'],
  // Phase 3 基因回路建模：biocrnpyler 必须 --no-deps（fa2-modified 需 C++ 编译，
  // 无 Windows wheel；fa2 只用于力导向布局，缺失不影响编译/仿真）
  circuit_compile: ['biocrnpyler', 'python-libsbml', 'bokeh', 'networkx', 'bioscrape'],
  circuit_simulate: ['bioscrape'],
  // 出版级标注避碰（2026-09-12，受 R ggrepel 启发的 matplotlib 自动文字避碰）：
  // differential_plot 等关键基因标注防重叠。MIT，纯 Python 无二进制依赖。
  // 挂在 fig_lint op 上（agent 画完图 lint 时预装，供 bio_python 桥的标注配方 import）。
  fig_lint: ['adjustText>=1.1'],
  // RNA 二级结构预测（2026-09-16，能力补缺）：ViennaRNA 有 Windows wheel
  // （cp310-cp313 win_amd64，实测 2.7.2 在 CPython 3.12 装成功）。
  // ⚠️ 许可：ViennaRNA 为自定义学术许可（非 OSI 标准），本项目只作**按需依赖**
  // 由用户环境安装，不 vendor、不随包分发源码。
  rna_fold: ['ViennaRNA>=2.7'],
  // 单细胞 RNA-seq 质控（2026-09-16，能力补缺）：scanpy/anndata 为 py3-none-any
  // 纯 Python wheel，但要求 Python ≥3.12（引导器即 CPython 3.12，实测可装）。
  // 体积较大（含 numba/igraph 等传递依赖），故放第二层按需安装而非第一层。
  sc_qc: ['scanpy>=1.10', 'anndata', 'h5py'],
  // Phase 2 预留：
  // cobra_model: ['cobra', 'glpk'],
}

/** 需要 --no-deps 安装的包（其传递依赖在本平台不可装且非必需）。 */
export const EXTRA_NO_DEPS = new Set(['biocrnpyler'])

/** 第三层：需用户手动启用的扩展模块（Phase 2/3 预留）。 */
export const ADDON_MODULES = {
  'circuit-modeling': {
    name: '基因回路建模',
    packages: ['biocrnpyler', 'python-libsbml', 'bokeh', 'networkx', 'bioscrape'],
    tools: ['bio_circuit_compile', 'bio_circuit_simulate'],
    description: 'BioCRNpyler + Bioscrape（biocrnpyler 自动 --no-deps 安装）',
    size: '~20MB',
  },
  'sbol-standard': {
    name: 'SBOL 标准化设计',
    packages: ['sbol3', 'tyto'],
    tools: ['bio_sbol'],
    description: 'pySBOL3 + tyto',
    size: '~5MB',
  },
  'single-cell': {
    name: '单细胞分析',
    packages: ['scanpy', 'anndata', 'leidenalg', 'igraph'],
    tools: ['bio_perturbseq'],
    description: 'Scanpy + AnnData',
    size: '~2GB',
  },
  'crispr-ngs': {
    name: 'CRISPR NGS 分析',
    packages: ['pysam'],
    tools: ['bio_crispr_analysis'],
    description: 'pysam',
    size: '~10MB',
  },
}
