/**
 * dsh-bio-genie — design 工具 op 集（独立 designTool 通道）
 *
 * 六个 design/casefile op 只允许经 designTool 提交路径（src/design-dispatch.js）
 * 执行；一切 raw 通道一律拒绝：
 *   - HTTP raw（/execute-tool 等）→ PANEL_OP_NOT_ALLOWED
 *   - 普通 callBio                → DESIGN_TOOL_REQUIRED
 * 见实现工作单 v3 §B0 与 spec v0.3/v0.5 §4.5（allowlist 为第一道门）。
 * @module dsh-bio-genie/design-ops
 */

export const DESIGN_OPS = new Set([
  'design_chassis_profile',
  'design_integration_candidates',
  'design_circuit_contextualize',
  'design_consequence',
  'design_casefile_validate',
  'design_casefile_export',
])

/** raw HTTP 通道拒绝码（spec 指定稳定码）。 */
export const PANEL_OP_NOT_ALLOWED = 'PANEL_OP_NOT_ALLOWED'
/** 普通 callBio 拒绝码：design op 必须经 designTool 通道。 */
export const DESIGN_TOOL_REQUIRED = 'DESIGN_TOOL_REQUIRED'
/** enable gate 拒绝码（acceptance 绑定不符 / 未撤销状态异常）。 */
export const CONTRACT_PACKET_UNREVIEWED = 'CONTRACT_PACKET_UNREVIEWED'
