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
  // pyparsing>=3.1 是防冲突护栏：pydna 的传递依赖会把 pyparsing 降到 2.4.7，
  // 破坏 matplotlib（_fontconfig_pattern 需要 pyparsing3 的 one_of）。
  clone_simulate: ['pydna', 'pyparsing>=3.1'],
  // Phase 2 预留：
  // cobra_model: ['cobra', 'glpk'],
}

/** pip 包名 → import 模块名（不一致或带版本约束时在此覆盖）。 */
export const EXTRA_IMPORT_NAMES = {
  pydna: 'pydna',
  'pyparsing>=3.1': 'pyparsing',
}

/** 第三层：需用户手动启用的扩展模块（Phase 2/3 预留）。 */
export const ADDON_MODULES = {
  'circuit-modeling': {
    name: '基因回路建模',
    packages: ['biocrnpyler', 'bioscrape'],
    tools: ['bio_circuit_compile', 'bio_circuit_simulate'],
    description: 'BioCRNpyler + Bioscrape',
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
