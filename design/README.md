# design/ — 基因组感知线路设计 contract packet（随插件分发）

本目录是 v1.0-实现基线的**嵌入副本**，随 npm 包分发（零手动安装原则）。

## 布局

- `packet/` — **完整 rev4 contract packet，逐字节原样**（79 条目 + `SHA256SUMS-packet.txt`；与 `D:\Program\sharespace\synbio-design-packet-rev4-2026-10-14\` 逐字节一致，verify_mirror 78/78）。
- `provenance/` — acceptance 绑定的 packet 外工件：`casefile-c14n-1.profile.md` + spec v0.9–v0.12（哈希对 acceptance.bindings 逐项核验）。
- `acceptance.json` — `packet_acceptance@1` 记录副本（自哈希 `e861329d…`；绑定 packet index `927dc813…` + manifest `fef3b113…`）。

## 不变量（改动即破坏）

- **任何字节变化 = acceptance 撤销触发**（index/绑定不符 → enable gate fail-closed `CONTRACT_PACKET_UNREVIEWED`）。
- 需要修改 packet 时：新版本（rev5）+ 新 manifest/index + 新 acceptance（窄范围复审）；**实现期不得就地改动这些文件**。
- `design/packet/**`、`design/provenance/**`、`design/acceptance.json` 已在 `.gitattributes` 钉 `-text`（禁 eol 转换，字节保真）。

## enable gate

- `src/design-gate.js` 的 `verifyDesignPacket()`：acceptance 状态（approved + 未撤销）→ packet index 全量集合（逐文件重算 + 多余文件扫描 + index 自哈希）→ manifest 哈希 → **全部绑定**（pattern-library / unicode-domain / common.defs / corpora / locks / profile / spec chain）→ 返回核验摘要。
- **无缓存**（每次全量核验，百毫秒级）：缓存对抗（原子替换 / mtime 保持 / 后继 acceptance）天然免疫。
- 失败 → `CONTRACT_PACKET_UNREVIEWED`（fail-closed）。调用方：`src/design-dispatch.js`（designTool 通道）在**任何 spawn 之前**调用；`src/design-ops.js` 定义六 op 集与稳定拒绝码。

## 关联

- 规格：`provenance/genie-synbio-design-spec-v0.12-2026-10-13.md`（§K1–K8）+ profile。
- 工作单：`D:\Program\sharespace\genie-synbio-design-impl-work-order-v3-2026-10-14.md`（§A0 集成架构 / §B0 containment / §P0 证明批次）。
