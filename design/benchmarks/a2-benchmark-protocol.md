# A2 casefile 库基准协议 v1

> req_id：`G-LOOP-20261015-D3-001` ｜ 冻结日期：2026-10-15 ｜ 脚本：`scripts/bench-a2-casefile.mjs` v1.0.1
> 基线：`design/benchmarks/a2-benchmark-baseline.json`（首跑实测冻结）
> 被测实现：`src/design-casefile.js`（A2：每-case 锁 / 单事务六步 / 孤儿 GC / case 上下文）
> 仓库 HEAD：`dc1960d9c97ae328d8643821946251e4ef8ccfce`（master）

## 1. 目的与范围

为 A2 casefile 库建立**可复现的性能基准**：固定输入、固定重复数、无随机，每次运行输出各场景的
wall time 统计（mean / p50 / p95）。基线随本协议冻结，将来回归时对照退化。

范围内：`commitTransaction`（单/多工件）、`loadSnapshot`、`gcOrphans`（dryRun + 实删）、
`acquireCaseLock`/`releaseCaseLock`（无竞争）。
范围外：`resolveCaseContext` / `resolveCaseOperations` / `loadArtifact` / `canonicalizeViaPacket`
单点、跨机锁竞争、并发争抢（本基准全部为单进程无竞争路径）。

## 2. 场景定义（v1 冻结）

| 场景 | 操作 | 输入（固定夹具） | 重复数 | 预热 |
|---|---|---|---|---|
| S1 单工件事务提交 | `commitTransaction`（完整六步），每次全新 case | 1 工件：`host_profile` `hpf-01`（语料 `design/packet/schema-corpus/schema_cases.json`） | 50 | 1 次 |
| S2 多工件事务提交 | `commitTransaction`（完整六步），每次全新 case | 10 工件：`gvr-01` `hpf-01` `ccd-01` `evi-01` `mmr-01` `cpl-01` `cir-01` `kcr-01` `itc-01` `exs-01`（10 个合法类型，顺序固定） | 20 | 1 次 |
| S3 快照读取 | `loadSnapshot(sha)` 读取同一既有快照 | setup 阶段真实提交生成的快照（543 B，sha `724568a0…b2fbd`） | 200 | 1 次 |
| S4 GC 扫描 | `gcOrphans(dryRun)` 与 `gcOrphans()`（实删）成对度量 | 每次构造：100 对象（60 被 2 个快照引用 + 40 孤儿）+ 3 个 `*.tmp-*` 残片 + 1 个 staging 残留目录 | 10 | 1 次 |
| S5 锁获取/释放 | `acquireCaseLock` + `releaseCaseLock`（无竞争，每次全新 case） | 空 case 目录 | 100 | 1 次 |

补充说明：
- S5 为协议允许的「最多加 1 个」额外场景。动机：每次 `commitTransaction`/`gcOrphans` 都经
  `withCaseLock` 持锁，锁是全部写路径的固定开销；单独度量可把锁成本从 c14n/校验成本中隔离，
  且开销极小（~3.5 ms），几乎不增加总时长。
- S1/S2 每次重复使用**全新 case 目录**（`ensureCaseDir` + commit），保证每次都是完整六步
  （stage → 校验 → 发布 → 快照 → HEAD → receipt），不存在跨重复的「重复工件 → no_change」短路。
- S1/S2 的 policy 固定为 `{policy_id:'design-capability-policy', policy_version:'0', policy_hash:'b'×64}`；
  `case_content_id` 在 setup 阶段从固定输入派生（`rootInputArtifactIds` 为 `a×64`/`b×64`，
  `policyVersion:'0'`，`canonicalParams` 固定），确定性，与 `test/design-casefile.mjs` 的
  golden（`bdfb54d1…c41bd`）一致。
- 所有夹具在脚本启动时经 `validateDesignArtifact` 断言合法（不合法则退出非 0，杜绝坏基线）。
- 预热 1 次不计入统计；S1/S2/S4 的 case 构建（`mkdtemp`+`ensureCaseDir`）在计时窗口外。

## 3. 指标口径

- **指标**：单次重复的 wall time（`performance.now()`，单调时钟），单位 **ms**。
- **统计**：`mean`（算术平均）、`p50`、`p95`——分位数采用 **nearest-rank**：
  `pX = samples[ceil(n·X/100) − 1]`（升序排序后），n=样本数。
- **样本**：完整逐次样本保留在基线 JSON 的 `samples` 数组内（可审计）。
- 输出单位：ms，保留两位小数。
- 全跑总时长（`total_wall_ms`）含各场景 setup/预热，作为环境参考值一并记录。

## 4. 运行方式

```
node scripts/bench-a2-casefile.mjs                 # 人类可读摘要表 + 机器可读 JSON
node scripts/bench-a2-casefile.mjs --json          # 仅 JSON 到 stdout（机器可读）
node scripts/bench-a2-casefile.mjs --out <file>    # JSON 另存文件（可与上者组合）
node scripts/bench-a2-casefile.mjs --repeat <n>    # 覆盖全部场景默认重复数
```

- **退出码 0** = 跑完且所有操作成功（**无性能硬门**——退化判定属人/复核流程，见 §6）。
- **退出码非 0** = 用法错误、夹具断言失败、或任一重复的操作返回 `ok:false`（功能性问题）。
- 工作区：全部在系统临时目录（`os.tmpdir()`）`a2-bench-*` 下创建，结束时递归自清理；
  脚本不写仓库任何文件，无 git 写操作（仅读 `git rev-parse HEAD` / `git status --porcelain`
  记录环境）。

## 5. 环境记录要求

每次运行输出的 JSON 必须包含（基线 JSON 已含首跑值）：

| 字段 | 说明 |
|---|---|
| `environment.node` | `process.version`，如 `v26.7.0` |
| `environment.platform` / `release` / `arch` | 如 `win32` / `10.0.26300` / `x64` |
| `environment.cpu_model` / `cpu_count` | `os.cpus()[0].model` + 核数 |
| `environment.tmpdir` | 临时目录路径 |
| `environment.date_utc` | 运行时刻（UTC ISO8601） |
| `environment.commit` / `dirty` | 被测仓库 HEAD（`git rev-parse HEAD`）与工作树是否脏 |
| `environment.script_version` | 基准脚本版本（当前 `1.0.1`） |

跨平台/跨机对比前必须核对环境块；环境不同（node 大版本、CPU、操作系统）不直接可比。

## 6. 通过 / 退化标准

判定**只针对冻结基线**（`a2-benchmark-baseline.json`，同一脚本版本 + 同一协议版本）。

**复核触发器（非硬门）**——命中以下任一即触发人工复核（查环境变化 / 代码变化 / 测量噪声，
结论记入复核记录），**不自动判失败**：

1. 任一场景 **p50 > 2× 基线 p50**；
2. 任一场景 **mean > 2× 基线 mean**；
3. 任一场景 **p95 > 3× 基线 p95**（p95 对尾部噪声敏感，阈值放宽）。

**硬错误（直接上报）**——与性能无关：

- 任一操作返回 `ok:false` 或断言失败（脚本退出非 0）；
- 环境块与基线差异巨大（如 node 主版本变更、CPU 变更）导致可比性丧失时，按 §7 重冻结而非比较。

**方向性提示**：性能显著**改善**（如 p50 < 0.5× 基线）同样值得记录原因，但无需复核流程。

## 7. 「冻结」语义

- 基线值随本协议冻结于 `design/benchmarks/a2-benchmark-baseline.json`；协议文档引用之。
- 基线 = **首跑实测数据**（2026-10-15，final-run1；run2 一致性证据见 §8），非估计值。
- 重冻结（更新 baseline.json）须满足以下之一并**说明理由**，且记入 §10 变更日志：
  1. A2 实现语义/结构变更（`src/design-casefile.js` 修改）；
  2. 被测依赖变更（packet / c14n / schema-corpus / node 主版本）；
  3. 硬件或平台变更（CPU/OS/机器）；
  4. 协议版本升级（场景定义变化）。
- 同一冻结版本内多次运行取**首次**为基准；复核确认「环境噪声」导致的偶发超标不触发重冻结。

## 8. 首冻一致性证据（2026-10-15，最终脚本 v1.0.1 连跑两次）

两次均为完整默认重复数，`node scripts/bench-a2-casefile.mjs --json`，exit 0：

| 场景 | run1 mean / p50 / p95 | run2 mean / p50 / p95 | mean 偏差 | p50 偏差 |
|---|---|---|---|---|
| S1 单工件事务提交 | 1631.55 / 1609.65 / 1772.49 | 1614.56 / 1601.88 / 1783.08 | −1.0% | −0.5% |
| S2 多工件事务提交(10) | 7460.68 / 7211.43 / 8622.18 | 6953.66 / 6882.67 / 7413.83 | −6.8% | −4.6% |
| S3 快照读取 | 0.43 / 0.37 / 0.64 | 0.48 / 0.50 / 0.65 | +11.6% | +35%（绝对差 0.13 ms） |
| S4 GC dryRun | 7.26 / 7.24 / 8.55 | 7.62 / 7.59 / 8.75 | +5.0% | +4.8% |
| S4 GC 实删 | 36.59 / 37.47 / 40.69 | 35.57 / 36.38 / 40.58 | −2.8% | −2.9% |
| S5 锁 获取/释放 | 3.63 / 3.63 / 4.05 | 3.44 / 3.45 / 3.75 | −5.2% | −5.0% |
| 全跑 wall | 249.5 s | 238.1 s | −4.6% | — |

结论：两跑统计一致。S1/S2/S4/S5 的 mean 与 p50 偏差均在 ±7% 内；S3 为亚毫秒量级
（绝对差 < 0.15 ms），相对偏差大但无实际意义；S2 p95 差 16%（run1 8622 vs run2 7414）
属 n=20 小样本分位数粗糙（见 §9）。**基线取 run1**。

## 9. 边界披露（2026-10-15 首冻实测）

1. **60 s 预算超限**：派发单「规模控制：全跑 ≤60 s」在本机实测不可达——默认重复数
   全跑 wall = **249.5 s（final-run1）/ 238.1 s（final-run2）**，约 4 分钟。根因：单次提交含
   3 次 c14n **子进程** spawn（每次 ~165 ms，实测 5 次直接 spawn = 823 ms）+ 多次
   packet 加载（`verifyDesignPacket`/Ajv schema 编译每次 ~200–300 ms），S1 单次提交
   ≈ 1.61 s、S2 ≈ 7.2 s。**待裁定项**：保持 50/20 重复数（本协议现状）还是按
   ≤60 s 预算下调（如 S1=20、S2=6，代价是分位数样本变粗）——请 bsp 裁定。
2. **成本构成**：S1/S2 的时间 ~90% 为 c14n 子进程 + packet 校验，而非磁盘/锁；
   未来若并行化 c14n（如 worker 池），S1/S2 应大幅下降——属于预期内改善，不是退化。
3. **S3 分层现象**：200 次样本出现两段平台（~0.33 ms 与 ~0.6 ms），疑似后台进程/
   页面缓存/GC 干扰；p95=0.64 ms 已覆盖。亚毫秒量级受环境噪声影响大，S3 判读以
   mean 和量级（<1 ms）为准。
4. **小样本分位数粗糙**：S2 n=20、S4 n=10，nearest-rank 下 p95 只对应第 19/10 个
   样本，尾部分位不稳定（final-run1→run2 S2 p95 差 16%）。判读优先用 mean 与 p50。
5. **单机进程级锁**：S5 仅无竞争路径；跨机分布式锁不在本基准范围（与 A2 证据 §4 一致）。
6. **环境**：Windows 10.0.26300 / AMD Ryzen 5 5600H (12 线程) / node v26.7.0；
   工作树 `dirty=true`（并行轨道文件存在，未提交）；真实提交 `dc1960d`。
7. 快照/对象规模固定为小型（543 B 快照、~16 B 对象）；大对象（如 256 MiB 上限附近）
   的吞吐不在本基准范围——规模上限语义由 A2 证据（`maxObjectBytes` 256 MiB /
   `maxManifestBytes` 16 MiB / `maxArtifactsPerSnapshot` 10000）覆盖，非性能口径。

## 10. 变更日志

| 日期 | 版本 | 变更 | 理由 |
|---|---|---|---|
| 2026-10-15 | v1.0.0 | 首版：协议 + 脚本 v1.0.0 + 初跑基线 | req G-LOOP-20261015-D3-001；开发验证用 |
| 2026-10-15 | v1.0.1 | 脚本修复：①所有场景工作区并入共享根 `a2-bench-*`（修自清理泄漏）；②修复 `runCommitScenario` 未 `await` 导致的 S1/S2 结果丢失；基线按 v1.0.1 首跑（final-run1）重新冻结 | 自清理缺陷 + 结果完整性缺陷；测量语义未变（同一操作路径、同一临时盘），两版统计一致（S1 p50 1574 vs 1610，Δ2.3%） |
