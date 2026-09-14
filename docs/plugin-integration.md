# 同系列插件接入契约（plugin-integration v2）

> dsh-bio-genie 定位 = 高度自主、基础通用的生物信息学插件；专精能力由同系列插件（**托管领域扩展**）提供。
> v2 在 v1（域插件路由 + 资产消费）基础上，引入**托管领域扩展**的正式语义、**只读集成协议 v1** 与五态判定模型。
> 首个实现样板：**dsh-bio-gem**（代谢建模域）。后续同系列插件接入沿用本契约。
>
> 变更摘要（v1 → v2）：§0 语义重定义（托管领域扩展 ≠ 运行时子插件）；新增 §2 集成 HTTP 协议、
> §3 五态模型、§4 唯一所有者表、§5 安全边界、§6 兼容与降级；§7 修订 Agent 路由机制；
> §12 批次与依赖顺序；§13 风险与纪律。v1 的资产契约（§8）与路由表（§9）原样保留。

## 0. 定位：托管领域扩展（Hosted Domain Extension）

「子插件 / 域插件」是**产品与集成语义**，不是 dsh 运行时拓扑。dsh 引擎没有插件依赖机制，
因此本契约不做、也不承诺以下任何一条：

| 层面 | 应有含义 | 不应有含义 |
|---|---|---|
| 产品 | 接入方在 genie 设置面板中有一个能力域子页 | 接入方是 genie 的 npm 依赖 |
| 导航 | genie 承载并展示接入方子页 | 接入方向 dsh 注册嵌套 settings.section |
| 契约 | 接入方声明身份、版本、能力、状态接口 | genie 直接 import/require 接入方代码 |
| 生命周期 | 各自独立安装、独立发布、独立卸载 | genie 负责接入方的安装顺序/升级/修复 |
| Agent 路由 | genie 知道 `<domain>_*` 是可选能力域 | 运行时动态篡改已构造的 system prompt |

**不做清单**（在第二个领域扩展出现并获得实证之前，不引入）：通用动态面板渲染框架、
通用跨插件 UI 嵌套机制、通用「能力 → prompt 片段」自动拼装器、通用任意动作清单执行器。

## 1. 接入总则

- genie **不做**接入方工具的反向封装：agent 直接调用对方的 `gem_*` 工具（同一 dsh 实例注册表天然共存）。
- 命名空间约定：`bio_*` = genie 本体工具；`<domain>_*`（如 `gem_*`）= 接入方工具。同实例共存无冲突。
- **安装探测**：genie 侧用非导入式模块解析（`require.resolve('@dsh-bio/dsh-bio-gem/package.json')`，
  失败回退同级目录）判断「包是否安装」，并读取其 `version`。探测成功 ≠ 可用（可用性见 §3 五态）。
- **能力声明载体**：不引入独立 capabilities 文件——能力与协议版本由 §2 的 `health` 端点**运行时**承载
  （唯一事实源），静态规范由本契约承载。避免第二事实源与漂移。

## 2. 集成 HTTP 协议 v1（接入方实现，genie 消费）

### 2.1 端点（固定路径，版本化；不允许任意 URL）

```text
GET  /api/dsh-bio-gem/integration/health          # 协商端点：长期稳定、快、无副作用
GET  /api/dsh-bio-gem/integration/v1/status       # 状态快照：完整、可缓存
POST /api/dsh-bio-gem/integration/v1/jobs         # 写操作（批次 2 预留，本批不实现）
GET  /api/dsh-bio-gem/integration/v1/jobs/:id     # 任务状态（批次 2 预留，本批不实现）
```

### 2.2 信封（与 genie 面板 RPC 同规格）

成功 `{ ok: true, value: {...} }`；失败 `{ ok: false, code: "<machine-readable>", message: "<human>" }`。
所有端点必须挂 **loopback-only 守卫**（照抄 genie `isLoopbackRequest` 的三层校验：
127.0.0.1/localhost、sec-fetch-site、origin），非 loopback 一律 403。

### 2.3 `health`（协商端点）

```json
{ "ok": true, "value": {
  "pluginId": "dsh-bio-gem",
  "pluginVersion": "0.1.11",
  "protocolMajor": 1,
  "protocolMinors": [0],
  "features": ["status", "model-store", "ledger", "exports", "carveme-runtime", "gapseq-probe"]
} }
```

要求：不启动昂贵探测（不 spawn Python）、不写盘；仅回报身份与协议能力。

### 2.4 `v1/status`（状态快照）

```json
{ "ok": true, "value": {
  "state": "ready | degraded",
  "generatedAt": "<ISO8601>",
  "pluginVersion": "0.1.11",
  "features": ["status", "model-store", "ledger", "exports", "carveme-runtime", "gapseq-probe"],
  "checks": [
    { "id": "python.cobra",   "status": "ok | warn | missing | error", "detail": "cobra 0.32.1 @ <path>" },
    { "id": "runtime.carveme", "status": "warn", "detail": "carve.exe 缺失 → gem_build(carveme) 不可用" },
    { "id": "runtime.gapseq",  "status": "missing", "detail": "WSL 探测未就绪（仅只读探测，不安装）" }
  ],
  "data": {
    "models": { "count": 3, "items": [{ "name": "C58.xml", "sizeBytes": 734000, "modifiedAt": "<ISO>" }] },
    "ledger": { "count": 2, "totalEntries": 670, "dir": "<abs>", "ledgers": [{ "model": "C58", "entries": 402, "modifiedAt": "<ISO>" }] },
    "exports": { "count": 1, "items": [{ "name": "targets_20260901.json", "sizeBytes": 12000, "modifiedAt": "<ISO>" }] }
  },
  "env": {
    "python": { "selected": { "path": "<abs>", "source": "GEM_PYTHON|gem.pythonOverride|genie-hosted|CONDA_PREFIX|PATH", "cobraVersion": "..." }, "candidates": [{ "path": "...", "source": "...", "exists": true }], "note": "..." },
    "engines": { "carveme": { "available": false, "hint": "..." }, "gapseq": { "available": null, "hint": "..." } }
  },
  "remediations": [
    { "code": "genie.install-wsl-gapseq", "owner": "genie", "detail": "在 genie 面板安装 WSL/gapseq" }
  ]
} }
```

- `checks` 是环境事实项的机器可读清单（`id` 稳定，`status` 四值枚举）；`state=degraded` 当且仅当存在非 `ok` 的 check。
- **慢探测必须非阻塞（stale-while-revalidate）**：任何可能耗时 >3s 的探测（如 WSL 命令、冷启动子进程）不得阻塞 `status` 响应——
  缓存未过期直接返回；过期时立即返回旧值并后台刷新；从未探测过则用占位值（如 `available: null` + `probing` 提示），
  并把该 check 记为 `warn`（语义 = 「尚未确定」），后台完成后自动转 `ok`/`missing`。
  **失败结果只做短缓存（≤60s）并自动重试**（冷启动类失败是暂时性状态）。真实教训：慢探测阻塞响应会导致消费端超时截断，
  使 `status` 永远不可达（实测）。
- `data` 只放摘要 + 有限条目（列表截断 ≤50，其余给计数）。
- `remediations` 只允许**受控 code + owner**（`owner ∈ {genie, gem}`）；**严禁**返回任意 URL、
  任意 shell 命令、任意 pip 参数或前端 callback；消费者只做 code → 已知页面/操作的映射。

### 2.5 写操作协议（批次 2 冻结形状，本批不实现）

写操作统一走 typed job（不允许零散 `install` / `delete` / `run` 路由）：

- `POST .../v1/jobs` body：`{ "action": "<受控枚举>", "args": { ... } }` → `{ ok:true, value:{ jobId } }`
- `GET .../v1/jobs/:id` → `{ jobId, owner, desiredState, phase, startedAt, updatedAt, resourceLock,
  attemptedSteps, safeLogTail, errorClass, nextSafeAction }`
- 相位机：`queued → preflight → running → verifying → succeeded | failed | interrupted | cancelled`
- 硬性纪律：先预检；隔离构建（staging → 健康检查 → 原子切换 active）；失败不损坏旧可用环境；
  单资源锁（同一运行时/目录不并发写）；**页面打开不自动修复**（写操作必须来自用户明确动作）；
  重启后从实际文件重新观察事实，未完成 job 标 `interrupted`；失败给单一安全出口
  （重试 / 修复 / 返回自动选择），不甩十条手工命令。

## 3. 五态模型（genie 侧适配器判定）

**404 ≠ 未安装**——适配器必须按下表组合「本地模块探测」与「健康探测」：

| 本地探测 | health 结果 | 状态 | 子页行为 |
|---|---|---|---|
| 未发现 | 不发请求 | `not-installed` | 可选扩展说明（不是错误）；不渲染空壳 |
| 发现（版本 < 引入协议的最低版本） | 404/失败 | `legacy`（installed-unavailable 子态） | **旧版兼容视图**：文件系统摘要只读 + 升级引导，明确标注「不能执行管理操作」 |
| 发现 | 404 / 超时 / 非 200 / 坏 JSON | `installed-unavailable` | 「已安装，但当前不可用」+ 重新探测；不误报未安装 |
| health 可达 | `protocolMajor` 不匹配 | `incompatible` | 显示双方协议版本与升级目标 |
| 协议兼容 | 存在非 ok check（`state=degraded`） | `degraded` | 展示准确缺项 + 修复责任方（owner） |
| 协议兼容 | 全部就绪 | `ready` | 真实状态 + feature 列表 |

适配器纪律：仅在子页打开 / 用户手动刷新 / 有任务运行时探测；短超时（3–5s）+ `AbortController`；
保留最后一次成功快照但标注「上次状态，已过期」；一次 fetch 异常**不得拖垮整个 BioGenie 面板**。

## 4. 唯一所有者表（资源级）

| 资源 / 动作 | 唯一所有者 | 子页上的调用去向 |
|---|---|---|
| genie 自举 Python、共享 cobra 基础 | genie | genie API |
| WSL / gapseq 等共享或系统级前置能力 | genie | genie API |
| 接入方模型、账本、导出记录 | 接入方（gem） | gem API |
| 接入方私有运行时（如 CarveMe venv） | 接入方（gem） | gem API |
| 接入方领域偏好（如解释器偏好） | 接入方（gem） | gem config API |
| 面板一级入口与子页 UI | genie | —（接入方不注册 UI） |
| 探测/使用共享前置（WSL/gapseq） | 接入方只读探测 | 缺失 → 返回 `owner:"genie"` 的 remediation |

## 5. 安全边界

- 本批（只读）：所有端点无副作用；`status` 不泄露 token、环境秘密、完整日志（日志仅 `safeLogTail` 脱敏尾部）。
- 批次 2（写）：仅接受 POST JSON；要求 Origin/Host/CSRF（或等效会话）校验——**loopback 不等于可暴露破坏性命令**；
  输入映射为有限 action schema，对模型目录/导出目录/删除目标做 allowlist 与路径归一化；
  不接受任意命令、任意路径、任意 pip 参数、任意下载 URL；job 日志脱敏并受分页/长度限制。
- 跨插件原则：**不执行对方给的 URL/命令**；remediation 只做受控 code → 已知操作映射。
- **内层 HTTP 纪律**：插件对**同一实例端点**发起的服务端请求（如宿主代理消费接入方 API）必须使用
  `node:http`（或等效直连实现），**不要用全局 `fetch`**——dsh 进程内可能装载全局代理 dispatcher
  （`@deepseek-ai/dsh-http-proxy` 会 `undici.setGlobalDispatcher`），实测同一端点在服务端内层 `fetch`
  下出现过长挂起（浏览器路径 102s vs `node:http` 62ms）。

## 6. 兼容与降级规则

- 兼容判据 = `protocolMajor` 一致 + 依赖 feature 标识（**不猜版本字符串行为**）。
- `protocolMajor` 升级 = 破坏性变更（旧 genie 判 `incompatible`，提示升级）；新 feature = 追加 feature 标识。
- 旧版接入方（无 integration API）：`legacy` 兼容视图（§3 第 2 行），其数据源可用文件系统摘要兜底，
  但必须明示「只读兼容视图」且不提供管理操作。
- 引入协议的最低gem版本在 genie 侧登记为常量（供 `legacy` 判定与升级引导文案）。

## 7. Agent 路由（persona 层）

- **权威机制 = 工具存在性条件句**（已写入 genie persona）：工具集含 `<domain>_*` → 该域请求交给它们；
  不含 → 明确说明该可选领域扩展未启用。具体能力/参数/限制由接入方工具 description 负责。
- 路由决策表（§9）中的触发词 = **辅助意图识别线索**（静态文本），不声称是动态运行机制；
  不引入「动态 persona 注入」（等第二个领域扩展出现再评估）。

## 8. 资产契约五条（消费规则层，v1 原文保留）

1. **命名空间共存**：`bio_*` 与 `gem_*` 同实例注册共存，无冲突、无封装。agent 按路由表选域。
2. **模型权威源 = 接入方模型卡**（sidecar JSON，lineage 版本化）。汇报模型规模/验证结果/必需基因时，
   provenance 指向模型卡字段或当次工具输出，**禁止凭印象重述**。
3. **预测权威源 = 接入方预测账本**（JSONL，逐条 `prediction_id`/`evidence_tier`/`status`）。
   引用必需/表型/分泌/合成致死预测时必须带 prediction_id 与 status；**未入账的预测不得谎称已有**。
4. **下游接口 = 接入方规范导出**（gem_targets 11 字段：target_id/type/genes/met_ids/condition/rationale/
   evidence_tier/status/growth_or_maxprod/source/exported_at）。靶点清单一律走 gem_targets，不自行编格式。
5. **质量铁律沿用 genie 本体**：数字必须来自工具输出（_provenance）；区间制对比（overlap=伪影禁止引用）；
   退化场景如实报告（wt≤EPS）；生长值单位 mmol/gDW/h。

## 9. 路由决策表（辅助意图识别，v1 原文保留）

| 用户意图 | 路由 | 触发词 |
|---|---|---|
| 基因组→建模 / 六关验证 / 缺口诊断补洞 / biomass 精修 / 表型回填 | gem_annotate / gem_build / gem_validate / gem_gapfind / gem_gapfill / gem_l3_fix / gem_biomass / gem_phenotype | 建模 / GEM / 代谢模型 / 模型验证 / 补洞 |
| 模型不生长（growth=0）先定位阻塞前体 | gem_precursor_scan（再 gem_gapfind） | 模型为什么不长 / 生长为零 / 哪个前体卡住 |
| 必需基因全扫 / 通量区间（硬结论 vs 伪影）/ 鲁棒性 / 双敲 SL / 分泌谱 / 富集 / 靶点导出 | gem_essentiality / gem_fluxscan / gem_sensitivity / gem_double_knockout / gem_secretion / gem_enrichment / gem_targets | 必需基因 / 通量区间 / 伪影 / 稳定性 / 合成致死 / 分泌谱 / 富集 / 靶点 |
| 已发表模型对比 / benchmark | gem_benchmark | benchmark / 模型对比 |
| 预测账本查询更新 / 模型报告 | gem_ledger / gem_report | 账本 / prediction_id / 模型报告 |
| 轻量代谢快查（临时试算、无模型资产溯源需求） | bio_fba / bio_gene_knockout / bio_production_envelope | textbook / 教科书模型 / 快速试算 |

判定原则：**深水区科学结论**（要写进报告/论文的数字）走接入方工具——它们消费模型卡/账本等持久资产、
自带证据分级；genie 轻量层只承接临时试算。

## 10. 汇报模板（代谢模型任务）

接入域任务汇报按固定结构，保证可溯源：

```
《代谢模型分析报告》
1. 模型卡摘要：模型文件（绝对路径）、引擎/lineage 版本、规模、验证关卡结果（引 gem_report/gem_validate 输出或模型卡字段）
2. 预测引用：每条预测带 prediction_id + evidence_tier + status（与 gem_ledger 一致）
3. 分析结论：通量对比只引区间分离判定；单点 diff 须标注伪影
4. 靶点/导出：gem_targets 产物路径 + 与账本计数闭合声明
```

## 11. 资产路径（dsh-bio-gem v0.1.0 基线）

- 模型卡：模型文件同目录 `<name>.card.json`（schema v3：lineage / verified_phenotypes / essential_genes / robustness）
- 预测账本：`~/.dsh/dsh-bio-gem/ledger/<模型名>.jsonl`（**一个模型一个账本**；四类型：essentiality / phenotype / secretion / synthetic_lethal；旧全局 predictions.jsonl 已弃用）
- 靶点导出：`~/.dsh/dsh-bio-gem/exports/targets_<ts>.csv|json`
- 接入方主指引：gem 插件 `skills/gem-expert.md`（决策树 + C58 回归锚）

## 12. 实施批次与依赖顺序

- **批次 1（本批，只读切片）**：接入方 `health` + `v1/status` 端点；genie 子页五态适配器 + 旧版兼容视图。
  验收矩阵：`not-installed` / `legacy` / `installed-unavailable` / `incompatible` / `degraded` / `ready` 六种可独立触发。
- **批次 2（写操作）**：job 框架（§2.5）；四类动作按此顺序：解释器偏好（gem 私有配置）→
  模型/导出清理（带影响提示）→ CarveMe 运行时安装（gem 私有）→ WSL/gapseq 安装（genie 共享）。
- 依赖顺序：协议与状态模型 → 接入方 health/status → genie 容错适配器 → （批次 2）config schema →
  genie 共享安装 job → 接入方私有 job → 第二个领域扩展出现后提炼通用机制。

## 13. 风险与纪律（实施与评审的检查项）

1. **语义膨胀**：不得让「子插件」暗示安装顺序/生命周期联动（dsh 无此能力）。
2. **双重事实源**：同一事实只能有一个权威源——genie 不得直读接入方数据目录后再由接入方 API 报告另一版本；
   旧版兼容视图是唯一例外且必须标注。
3. **版本漂移**：路由名/字段/feature 变更走协议协商 + feature 标识，禁止靠版本字符串猜行为。
4. **共享资源归属**：WSL/gapseq、genie Python、CarveMe 私有 venv 必须有唯一写入者（§4）。
5. **写 API 安全**：loopback ≠ 授权；CSRF/Origin/输入收敛/日志脱敏不可省。
6. **动态路由幻觉**：能力 manifest 不会自动更新已运行 agent 的常驻 prompt；依赖稳定条件句 + 工具 description。
7. **过早泛化**：单域阶段不建通用平台层（§0 不做清单）。

## 14. 后续接入方的最小接入清单（更新）

1. 接入方提供 `<domain>-expert` skill + 命名空间 `<domain>_*` 工具（同实例注册）
2. 接入方实现 §2 集成协议（health + v1/status；写操作按批次 2）
3. genie preset skill / persona 增加能力域路由段（条件句 + 辅助路由表），只增不改
4. 本契约追加「资产权威源」条款（模型/预测/导出三类）
5. 双方跑一次真实 agent 会话的 before/after 对照 + 五态矩阵，证明路由生效与契约传导

> **执行状态（2026-09-14）**：gem 与 graft 均已按本清单接入，见 §15。第 3 条的实现形态已从
> 「preset skill」收敛为 **persona 条件句 + 工具 description**（web profile 下 skill 平面可达性
> 已验证，但路由的常驻载体仍是 persona——这是 agent 每回合都看得到的那一层）。
> 第 5 条的 before/after 对照在 graft 上已完成（见 §15.5）。

## 15. 第二个接入方：dsh-bio-graft（基因编辑域，2026-09-14 落地）

### 15.1 身份与形态

| 项 | 值 |
|---|---|
| 包名 / 仓库 | `@dsh-bio/dsh-bio-graft` · https://github.com/moonbowterfly/dsh-bio-graft |
| 工具命名空间 | `graft_*`（7 个：profiles / design / score / offtarget / backend_status / plan_save / plan_load） |
| skill | `graft-expert`（provider=`dsh-bio-graft`） |
| 集成协议 | v1（`protocolMajor=1`），首个支持版本 **0.1.1** → 低于它判 `legacy` |
| 必检项（requiredCheckIds） | `python.interpreter` / `runtime.casoffinder` / `plans.dir` |
| features | `status` / `editor-registry` / `editplans` / `offtarget-backend` / `plan-write` |
| 宿主分页 | `/api/dsh-bio-genie/editing`（routeKey=`editing`，label=「基因编辑设计」） |
| 能力声明 | 仓库根 `capabilities.json`（`dsh-bio/capabilities@1`） |

### 15.2 宿主侧实现（提炼为声明式注册表）

`src/domain-adapter.js` 引入 `DOMAINS` 注册表（gem / graft 各一条声明）+ 通用机制：
`detectDomain`（模块解析 → 同级目录回退）、`classifyDomainState`（六态）、
`fetchDomainIntegration`（node:http 直连）、`handleDomainRequest`（条件分页分发）。

- **gem 行为零漂移**：`scripts/test-gem-adapter.mjs` 与 `scripts/test-gem-http.mjs` **零修改**通过；
  `server.js` 保留 `classifyGemState` / `fetchGemIntegration` / `GEM_INTEGRATION_*` 兼容别名。
- 新增 `scripts/test-graft-adapter.mjs`（11 断言）：六态矩阵 + 缺必检项不得判 ready +
  status/checks 矛盾判 installed-unavailable + gem 语义无漂移守卫。
- 这是契约 §0「两个领域扩展出现后提炼通用机制」的兑现；提炼范围仍严格限定在机械重复部分
  （不引入通用 UI 框架、不引入 capabilities 自动拼装）。

### 15.3 唯一所有者表（本域新增行）

| 资源 / 动作 | 唯一所有者 | 说明 |
|---|---|---|
| CRISPR/编辑**设计**（候选枚举、切割位点几何、脱靶解释、EditPlan、碱基编辑） | **graft** | 深水区结论（进报告/方案的数字）必须走 `graft_*` |
| 编辑后序列比对（wild-type vs edited） | genie（`bio_crispr_verify`） | 通用序列操作，不属编辑设计语义 |
| 参考基因组获取/assembly 信息 | genie（`bio_ref_genome` / `bio_entrez_*`） | graft 只做基因组体检与扫描，不实现下载 |
| 验证引物设计 | genie（`bio_primer3_design` 等） | graft 只产出验证**要求**（后续批次）与交接 |
| 轻量模板内 CRISPR 快查 | genie（`bio_crispr_guide`，**Tier 0 兜底层**） | 其 0-100 分为启发式，不得作为设计结论引用 |

### 15.4 资产权威源（本域）

**EditPlan = 编辑设计结论的唯一权威源**：`~/.dsh/dsh-bio-graft/plans/<name>.editplan.json`
+ append-only `plans/<name>/runs/`（run 号单调只增、写入原子、同名默认拒绝覆盖）。

- 引用候选/推荐必须带 plan 路径 + run 号；「为什么昨天 B 今天 D」只能由 `runs/` 时间线回答。
- schema 0.2 起含 `ranking_policy` / `off_target_summary` / `coordinate_systems`（口径随数字走）。
- 坐标口径：`start_0/end_0` 为 0-based 半开含 PAM；`cut_site_0` 位于 `cut_site_0-1` 与 `cut_site_0`
  之间；`cut_site_verified=false` 的编辑器几何禁止当既定事实。
- 质量铁律沿用：脱靶**永不说安全**（只能「在当前搜索参数下未检出」）；不打综合分
  （只给评分向量 + 声明式 objective）。

### 15.5 验证矩阵（已执行）

| 级别 | 动作 | 结果 |
|---|---|---|
| ① 端点直调 | `curl /api/dsh-bio-genie/editing?probe=install` 与完整请求 | `installed:true` / `state=ready` / checks 三项 ok / 5 计划 / 6 编辑器 / 7 工具 / remediations 空 |
| ② bundle 内容 | boot manifest → 拉 `@dsh-bio/dsh-bio-genie/client.js` | 新分页文案与组件全部命中（60KB bundle） |
| ③ 真实浏览器 | webbridge：设置 → BioGenie → 分页列表 | 出现「代谢建模」与「基因编辑设计」两个域分页；分页正文渲染完整（含证据分级列）；**抓到并按修复了**说明符口径 bug（`env.interpreter.selected` 是路径字符串） |
| ④ 路由 before/after | 真实会话（同一工作区、同一任务） | 修复前：agent 手抄数据到 Python 排序、2 次工具失败；修复后：`skill(graft-expert)` → `graft_profiles` → `graft_design` → `graft_score` → `graft_plan_save`，**全程 0 次 `bio_crispr_guide`**、无因工具故障的绕道 |
| ⑤ gem 回归 | `npm run bench` | exit 0（含 gem 两个既有测试零修改通过 + graft 适配器 + bio_crispr_guide 语义标签门） |

### 15.6 本域特有纪律（接入方与宿主都适用）

1. **脱靶 API 不得有 `safe: true`**（批次 C 将落地 `assessment.safety_conclusion='not_supported'`
   + `search_completeness` 枚举：mismatch=searched / bulge=not_searched）。
2. **几何 ≠ 效率**：`verified` 只表示「PAM/几何已对一手文献核对」，不代表活性可预测。
3. **负证据语义**：`0` / `null` / `not_searched` / `not_applicable` 必须可区分。
