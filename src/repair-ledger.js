/**
 * dsh-bio-genie — Repair Proposal v0：只读台账摘要（src/repair-ledger.js）
 *
 * 职责：从私有 store 读取**有限、只读**的状态/完整性摘要
 * （bio_repair_status / bio_repair_ledger_verify 两个工具的后端）。
 *
 * 明确不做（C4）：
 *  - 不维护 public release ledger（v0 无公开台账，见 docs/repair-proposal-v0.md）；
 *  - 不把 private incident 计数输出为 health counter / 质量声称（计数≠质量）；
 *  - 不输出任何原始内容（记录本身只有脱敏字段）；不导出、不上传。
 *
 * @module dsh-bio-genie/repair-ledger
 */
import { listIds, readRecord, scanStore } from './repair-store.js'

/**
 * 摘要（incident 新在前）。scan = 离线完整性扫描；by_state = 状态分布；
 * recent = 最近条目（脱敏摘要，无原始内容）。
 * @param {{base?: string, maxRecent?: number}} [opts]
 */
export function ledgerSummary({ base, maxRecent = 10 } = {}) {
  const scan = scanStore({ base })
  const byState = {}
  const recent = []
  for (const id of listIds('incidents', { base })) {
    try {
      const { record } = readRecord('incidents', id, { base })
      byState[record.state] = (byState[record.state] ?? 0) + 1
      recent.push({
        incident_id: record.incident_id,
        state: record.state,
        symptom_class: record.symptom_class,
        tool_id: record.tool_id,
        created_at: record.created_at,
      })
    } catch { /* scan.issues 已报告 */ }
  }
  recent.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
  return {
    ok: scan.ok,
    checked: scan.checked,
    counts: scan.counts,
    by_state: byState,
    issues: scan.issues,
    recent: recent.slice(0, Math.max(0, maxRecent)),
  }
}
