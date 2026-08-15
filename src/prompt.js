/**
 * dsh-bio-genie — 系统提示词段
 *
 * 正文在 prompts/persona.md（可编辑），加载时读取；缺文件时用内联兜底。
 * 注册在 order=200（位于 persona 与工具指导带之后）。
 *
 * @module dsh-bio-genie/prompt
 */
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const PERSONA_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'prompts', 'persona.md')

const FALLBACK = `本机已安装 dsh-bio-genie 插件（生物信息学「许愿式分析」）。用户可以用自然语言描述生物学分析需求，你应优先使用 bio_* 语义化工具（bio_seq_analyze/bio_seq_translate/bio_seq_restriction/bio_seq_io_read/bio_seq_io_write/bio_entrez_* 等）完成高频操作；语义化工具覆盖不到的功能（比对、PDB、Phylo、motif、BLAST、复杂流程）用 bio_python 执行器运行 Biopython 代码。首次调用任一工具时插件会自动下载并安装隔离的 Python 环境（含 Biopython）到插件私有目录，可能需要几分钟，请告知用户耐心等待。文件操作用绝对路径。`

function loadPersona() {
  try {
    return readFileSync(PERSONA_PATH, 'utf8')
  } catch {
    return FALLBACK
  }
}

export const BIO_PROMPT_SECTION = {
  name: 'dsh-bio-genie',
  order: 200,
  text: loadPersona(),
}
