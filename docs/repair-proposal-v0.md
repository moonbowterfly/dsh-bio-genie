# Genie Repair Proposal v0 — 设计与边界

> 本插件（dsh-bio-genie）v0 的受控修复事件管道。**v0 不叫「自修复」**——它把
> 「发现后如实报告但没有下游闭环」补成 **脱敏收集 → 可追踪提案 → 可重放验证 →
> 可审计发布** 的闭环，其中「生效」永远由维护者完成。
> 设计依据：`D:\Program\dsh-plug-develop\g-series-selfrepair-20261016\`（裁决报告
> v1.1 + 优化设计 v2.1 + 双通道讨论原文）；机器契约：`design/repair/`。

## 1. 状态机（incident）

```
OBSERVED → TRIAGED → REPRODUCIBLE | NOT_REPRODUCIBLE | OUT_OF_SCOPE
         → PROPOSAL_CREATED → INDEPENDENTLY_VERIFIED → MAINTAINER_APPROVED
         → MERGED → RELEASED → POST_RELEASE_VERIFIED
任一非终态可转 REJECTED | SUPERSEDED | STALE；终态无出边。
```

合法迁移表在 `src/repair-contract.js`（TRANSITIONS），任何跳步/回退由 store 拒绝
（`INVALID_TRANSITION`）。**v0 只到 OBSERVED 自动化**：capture 只登记 `OBSERVED`，
其余状态推进是维护者动作。

## 2. 能力面（常规 profile vs lab）

| 能力 | 常规 desktop profile（agent 可见） | repair lab（维护者手足） |
|---|---|---|
| `bio_repair_capture` | ✅ 登记脱敏观察（仅接受短命 token） | — |
| `bio_repair_status` | ✅ 只读摘要 | — |
| `bio_repair_ledger_verify` | ✅ 离线完整性校验 | — |
| proposal 生成 / 独立验证 | ❌ **不注册**（无 `propose/verify/apply` 工具） | `scripts/repair-lab-verify.mjs`（验证入口）+ `scripts/repair-gen-package.mjs`（生成器输入包：canary 预扫/载荷记录/拒发；均不进 npm 包） |
| 插件文件编辑 / shell / Git / npm / 发布 | ❌ 永不提供 | 仅维护者常规流程（本管道不代劳） |

## 3. 隐私边界（硬约束）

- **闭集 schema**：incident/proposal/receipt/lesson-proof 均拒绝未知字段——
  raw stderr/stdout、code/code_preview、workdir、路径、序列、token、用户项目名
  一律进不来（fixture 与测试含拒绝性用例）。
- **token 只含分类**：`repair_observation_token` 是随机 UUID + 粗粒度分类 + 指纹
  绑定；stderr/代码不进 token，也永不进入本管道的任何持久化路径。
- **私有 store**：`~/.dsh/dsh-bio-genie/repair/`（`bioRoot()/repair/`），**绝不**
  进科研 workdir / `result/design/` / session 记录；不导出、不上传。
- **无公开台账**：v0 不生成 `REPAIRS.md`、不写 public ledger、不把 private 计数
  当 health counter 输出（计数≠质量）。公开 release 级记录是 v1 议题（需签名
  enroll/rotation/revocation 制度，防止「假防篡改」）。

## 4. incident ≠ 插件 bug；lesson ≠ 一次成功

- `needs_repair=true` 只是 **症状信号**（stderr 匹配 traceback），**不是**插件归因。
  incident 的 `attribution` 固定 `UNVERIFIED`，「是否插件问题」由后续分诊/独立
  验证裁决。
- **L2 经验收紧**：失败→一次成功的配对**不再自动写入**经验（旧行为已移除）。
  经验升级只经 `promoteVerifiedLesson(lesson, lesson_proof@1)`——proof 必须来自
  独立验证（base-red / candidate-green / 冻结 checker），撤销/篡改/环境不符即不
  返回。旧 `error_lessons.json` 保留为 `LEGACY_UNVERIFIED`（只计不返）。

## 5. Lab 验证入口（receipt 语义）

`scripts/repair-lab-verify.mjs`：`--trusted <受信目录> --base <树> --candidate <树>
--proposal <uuid> --out <receipt.json>`。判定三件：**base 必红 + 候选必绿 + 策略
必过**；受信目录逐文件 MANIFEST 核对（未列文件一律拒绝）。退出码 0/1/2/3 =
READY / VERIFY_FAILED / TRUSTED_INTEGRITY / POLICY_REJECT；receipt 走
`g-repair-receipt/v1` 闭集校验后落盘。**候选运行时不得把候选树内的本文件当信任根**
（部署时复制到 lab 受信区，哈希记入 receipt）。

## 6. 维护者 approval checklist（v0）

1. receipt.result = READY_FOR_MAINTAINER_REVIEW 且 `verify` 的受信哈希与本机受信副本一致；
2. 变更面逐条对照 policy allowlist（精确路径）+ deny 兜底；
3. patch 之外复核：MRE/oracle/verifier/test-selection 未被候选触碰（v0：全在受信区）；
4. 领域语义复核（数值/默认值/科学约束不得静默变化；涉及输出语义的修复标 rerun/revalidation）；
5. 批准绑定 **commit + 制品哈希**；发布走既有维护者审阅链（打包、解包验收、运行态验证）。

## 7. 明确不做（v0）

不改安装态 `node_modules`；不热加载/不自动重启；不自动 commit/push/PR/issue/npm
publish；不读 execution log / session / memory 原文自动取证；不给 agent
propose/verify/apply；不改 package.json/lockfile/postinstall/CI/依赖/权限/网络配置；
不跨插件；不自动 rebase 旧提案；不做公开台账；不承诺「永不外泄」（在数据盘强隔离
完成前，表述一律用「输入卫生 + 发布链纪律」）。

## 8. 测试与运行

```bash
node test/repair-contract.mjs        # 闭集 schema / 状态机 / canonical / 策略 / 镜像防漂移
node test/repair-policy.mjs          # 策略镜像 + 拒绝性用例
node test/repair-capture.mjs         # token 一次性/TTL/指纹/去重/限流
node test/repair-store.mjs           # 原子写/sidecar/锁/CAS/上限/扫描
node test/repair-memory-boundary.mjs # L2 边界（proof/legacy/撤销/篡改）
node test/repair-tools.mjs           # 注册面（三工具、无 propose/verify/apply）+ 运行时
node test/repair-verify-lab.mjs      # lab 入口对抗场景
node test/repair-gen-canary.mjs      # 生成器输入包：canary/凭据/路径/二进制拒发、绑定、确定性、无网络面
node test/repair-package-boundary.mjs# npm pack 内容边界
```

配置：`repairMode: 'normal' | 'off'`（插件 config；默认 normal）。用户可在 profile
的 `cordis.patch.yml` 覆盖 `dsh-bio-genie` 行配置关闭。
