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
  // Phase 2 预留：
  // cobra_model: ['cobra', 'glpk'],
}

/** 需要 --no-deps 安装的包（其传递依赖在本平台不可装且非必需）。 */
export const EXTRA_NO_DEPS = new Set(['biocrnpyler'])

/** pip 包名 → import 模块名（不一致或带版本约束时在此覆盖）。 */
export const EXTRA_IMPORT_NAMES = {
  'primer3-py>=2.3.0': 'primer3',
  'dnachisel>=3.2,<4': 'dnachisel',
  'dna-features-viewer>=3.1': 'dna_features_viewer',
  'sbol3>=1.0': 'sbol3',
  'tyto>=1.4': 'tyto',
  pydna: 'pydna',
  'pyparsing>=3.1': 'pyparsing',
  biocrnpyler: 'biocrnpyler',
  'python-libsbml': 'libsbml',
  bokeh: 'bokeh',
  networkx: 'networkx',
  bioscrape: 'bioscrape',
}

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
