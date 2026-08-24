# dsh-bio-genie 架构说明

本文记录 dsh-bio-genie 插件的设计决策、运行机制与扩展方式，面向维护者和贡献者。

## 1. 定位：一个 DSH bundle

DeepSeek Harness 是 Cordis 驱动的「一切皆插件」框架。第三方插件以 **bundle** 形式分发：
一个 npm 包，在 `package.json` 的 `dsh.bundle.patch` 字段声明一个 `cordis.patch.yml`，
该 patch 在 profile 加载时插入插件行。dsh-bio-genie 只插入一行：

```yaml
- insert:
    - id: dsh-bio-genie
      name: '@dsh-bio/dsh-bio-genie'
```

插件模块 `inject = ['tools', 'skills', 'systemPrompt']`，依赖 `@deepseek-ai/dsh-base`
提供的三个服务。所有注册均返回 effect disposer，随插件生命周期自动装配与卸载。

## 2. 工具分层哲学（本插件核心设计）

工具分层结合「语义化快捷工具」与「通用执行器」两条路线：

| 层 | 工具 | 适用场景 | 优点 | 代价 |
|----|------|---------|------|------|
| **语义化工具** | bio_seq_analyze / translate / restriction / io / entrez… | 高频稳定操作 | 参数校验、结构化输出、省 token | 覆盖有限，需逐个开发 |
| **执行器** | bio_python | 语义化工具覆盖不到的功能（比对、PDB、Phylo、motif、BLAST、自定义流程） | 覆盖 100% Biopython | 每次生成代码、token 消耗大、无参数校验 |
| **环境诊断** | bio_env | 环境故障排查 | 可重装 | — |

agent 的决策路径（写入 `dsh-bio-genie` 主 skill）：**先查语义化工具表，命中就用；
否则用 bio_python 写代码执行**。两个 skill 体系并存：14 个领域 skill（教模型写
Biopython 代码）+ 1 个主 skill（教模型选工具）。

## 3. 为什么不用 dsh 内置的 code-runtime

dsh 的 code-runtime 在 Node worker 线程执行 TypeScript/JavaScript，不执行 Python。
Biopython 是 Python 生态，因此插件自带 Python 执行通道：spawn venv python + `-I` 隔离。

## 4. 执行链路

```
model ──bio_python(code)──▶ tools.js
                              │ ensureEnvironment(config)
                              │   ├─ 命中已有 env → 复用
                              │   └─ 未命中 → 自举（下载 uv → python → venv → pip）
                              │ resolveWorkdir(exec, workdir)
                              │   ├─ 显式 workdir → 用之（绝对路径原样；相对路径基于默认基准）
                              │   ├─ 会话工作区 exec.agent.session.header.cwd → 用之
                              │   └─ 均不可用 → ~/deepseek-harness/bio-genie-workspace（自动创建）
                              ▼
                     spawn <python> -I bridge.py   （cwd=工作区，stdin=JSON envelope）
                              ▼
                     bridge.py: exec code，捕获 stdout/stderr/result
                              ▼
                     返回 { ok, stdout, stderr, result, exitCode, timedOut }

model ──bio_seq_analyze(seq)──▶ tools.js
                              │ ensureEnvironment(config)
                              │ resolveWorkdir(exec)  （同上，语义化工具也获得工作区 cwd）
                              ▼
                     spawn <python> -I bio_ops.py  （cwd=工作区，stdin={op, args}）
                              ▼
                     返回 { ok, result | error }
```

- `bridge.py`：执行器唯一入口。stdin 读 JSON envelope（code/cwd），`exec` 用户代码，
  捕获 stdout/stderr，回写一行 JSON。`result` 变量约定返回结构化值。
- `bio_ops.py`：语义化 op 分发器。stdin 读 `{op, args}`，按注册表分发，返回 `{ok, result}`。
- 两者均以 `-I`（isolated）模式运行并清空 PYTHONPATH/PYTHONHOME，**防止宿主环境
  变量污染导致加载错误版本的 Bio**（实测踩坑）。

## 5. 环境引导（零依赖自举）

环境目录解析：`config.pythonEnvDir` → `$DSH_HOME/dsh-bio-genie/python-env`（默认）。
刻意**不用** `<插件目录>/python-env`：npm 升级/重装插件会覆盖 node_modules 内的环境，
导致用户已引导的环境丢失；放在 DSH_HOME 私有目录则与插件本体分离、升级不丢。

引导策略（不假设系统有任何 Python/uv）：
1. **下载 uv** 到 `$DSH_HOME/dsh-bio-genie/bin/`（GitHub release，按平台/架构；
   `DSH_BIO_UV_BASE` 可换镜像加速国内网络；下载后校验 SHA256——官方 release 取
   `sha256sums.txt`、清华 wheel 取 PEP 503 `#sha256=` 碎片，自定义镜像需自备
   `sha256sums.txt`，校验失败拒绝执行）
2. `uv python install 3.12 --install-dir <priv>` → 私有 CPython
3. `uv venv` → 私有虚拟环境
4. `uv pip install biopython numpy`

回退：自举失败且系统有 python3/python 时，用 `python -m venv` + pip 兜底。

幂等 + 进程内锁（`bootstrapLock`）防并发；`state.json` 记录状态。插件加载时后台预热
（`warmUp`），工具调用时若未就绪则等待（最长 10 分钟超时）。

### 5.1 R 引擎（已移除，2026-08）

R 执行器（bio_r / bio_r_env）及其惰性引导机制已从插件中移除；差异表达与
GSEA 改由 Python 语义化工具 `bio_deseq2` / `bio_gsea` 提供。
历史决策与移除细节见 `docs/R_REMOVAL_REPORT.md`。

## 6. 工具 schema 约定

- 参数用 `ParameterSchemaSpec`；输出用 `ValueSchemaSpec`。
- **所有 object 节点必须显式声明 `additionalProperties: true/false`**
  （dsh 严格校验，漏写导致 `UNSUPPORTED_SCHEMA` 加载失败——实测踩坑）。
- `bio_python.result` 用 `type: 'json'`（无约束 lossless JSON）。
- 工具 `timeoutMs` = 调用超时 + 引导等待（600s），覆盖首次引导场景。

## 7. Skill 与提示词

- 领域 skill 在 `skills/*.md`，插件加载时读入并 `ctx.skills.register`（embedded runtime skill）。
- `dsh-bio-genie` 主 skill 内联在 `src/skills.js`（工具分层决策树）。
- 提示词正文 `prompts/persona.md`（可编辑），`src/prompt.js` 以 `order=200` 注入。

## 8. 扩展方式

- **加语义化工具**：`bio_ops.py` 加 op 函数 + 注册表登记；`src/tools.js` 加 bioTool 条目。
- **加领域 skill**：`skills/bio-xxx.md` + `src/skills.js` 的 SKILL_MANIFEST 加条目；
  **所有 skill（领域/协议/指南）开头 frontmatter 必须含 `language:` 字段**
  （`python`/`r`/`mixed`/`none`），test-skills.mjs 强制校验。
- **加依赖**：改 `python/requirements.txt`；`bio_env reinstall` 生效。
- **改提示词**：编辑 `prompts/persona.md` 后重启 dsh。
- **说明书同步义务**：工具/skill/依赖变更必须同步更新 `docs/agent-guide/` 对应指南。

## 9. 客户端半面（浏览器设置面板）

除宿主侧（Node）插件外，本插件还带一个**浏览器客户端半面**（`lib/client.js`），
在 dsh Web UI 的设置面板侧栏注册「BioGenie」一级菜单项，点击进入本插件的独立设置页。

- **契约**：package.json 声明 `dsh.client`（`platform: "web"` + inject 边）与
  `exports["./client"]`；`dsh-client-modules` 的 Node 半扫描到后把包加入
  `window.__DSH_BOOT__` 浏览器名册，并按 `/plugins/<id>/client.js` 提供 bundle。
  无需新增 cordis 组合行——现有 bundle row 自动生效。
- **bundle 形态**：classic script 调 `window.__ModuleLoader__.load({ id, factory })`
  （与 @linxin666 / @deepseek-ai 各客户端的 tsdown 产物同构）。**零构建手写**，
  仅依赖浏览器静态模块表中的 seed 词（`react` / `react/jsx-runtime` /
  `@deepseek-ai/dsh-client-ui-slots`），刻意不引入 tsdown 工具链。
- **注册方式**：`ctx.slots.inject('settings.section', …)` → `ctx.slots.register(...)`
  注册 `settings.section` 列表条目（`id: biogenie`、`order: 50`、`label: BioGenie`），
  即设置面板侧栏一级菜单 + 右侧内容页。`inject = ['slots']`（cordis 服务，由
  `@deepseek-ai/dsh-client-runtime` 提供）。
- **当前内容（v0.3.1+，2026-08-18 起）**：四 tab 内部 state 切换的设置面板
  - **总览 tab**：包元信息 + 配置默认值只读视图 + 文档导航（v0.3.0 原有）
  - **Skill 模块 tab**：调 GET /api/dsh-bio-genie/skills 拉真实清单，主 skill 1 +
    领域/研究/协议/指南共 47 个条目，按 category 分组显示
  - **Python 环境 tab**：调 GET /api/dsh-bio-genie/python-packages 拉 venv 内
    `pip list --format=json` 真实结果，name + version 按字母排序；venv 未引导时
    明确标注 + 引导触发方式
- **数据通道（v0.3.1 新增，loopback-only RPC）**：浏览器 fetch('/api/dsh-bio-genie/<endpoint>')
  同源调宿主侧 server.js 注册的路由；server.js 用 isLoopbackRequest 守卫
  （127.0.0.1/localhost/sec-fetch-site/origin 三层校验）拒绝跨站/非本地访问。
  返回统一信封 { ok, value } 或 { ok:false, code, message }，失败 code 区分
  env-not-ready/network/parse-failed/internal，方便面板渲染对应占位与重试。
- **扩展路径**：设置内容复杂化后可迁到 tsdown 构建（`src/client/*.tsx`），
  宿主侧逻辑完全不受影响。RPC 端点可继续扩展（写端点 mutate 已在 guard 中保留
  POST 支持，但当前未对外暴露）。

## 10. 平台兼容

- `pythonExecutable()` 按平台区分 `Scripts/python.exe`（win32）与 `bin/python`（POSIX）。
- `windowsHide: true` + AbortSignal 监听，跨平台一致。
- uv 下载 URL 按 `process.platform`/`process.arch` 选择。

## 11. 自愈执行（ACR）— 三层职责边界

**核心原则**（2026-08-18 文档化）：开发时主动消除错误根源（修复插件 bug、补 requirements），运行时只在「确定可解的失败」上自愈，其余交给 agent。**自愈与修复不是二选一，是分层协作**。

| 层 | 实现位置 | 触发条件 | 动作 | 上限 |
|---|------|----------|------|------|
| **L1 插件自愈** | 插件代码 | 当前**不实现任何自动重试**——所有失败统一透传到 stderr，让 agent 看见 | — | 0 次（占位；后续若加白名单错误类型的自动重试，必须以 `stderr` 追加 `[bio-genie self-healed: ...]` 让用户可见） |
| **L2 记忆复用** | 插件（`pendingFixes` Map）+ agent 决策 | `bio_python` 失败后，stderr 错误签名若在 `~/.dsh/dsh-bio-genie/memory/error_lessons.json` 命中 | agent 主动 `bio_memory action=lessons` 查 fix_hint；命中即套用再调 | agent 试错 ≤ 1 次 |
| **L3 agent 自愈** | agent（prompt 驱动） | 任何 L1/L2 未覆盖的失败（代码逻辑错、API 误用、路径错、限流、数据结构错） | 读 stderr → 改 code → 再调 | agent 最多自动修复 2 次（共 3 次尝试） |
| **终止** | — | 累计 3 次仍失败 | **停止自愈，如实向用户报告**：错误原文 + 已尝试的修复路径 + 残余不确定性。绝不编造结果 | — |

**L1 边界（必须严格遵守，不要扩大）**：插件自愈只对「确定的事」负责——环境缺包、venv 损坏、镜像切换这类可机械执行的恢复。**不要让插件自动改 code**——code 是模型写的，插件不应擅改，改坏了 agent 反而看不到原始失败信号。

**L3 触发与修法速查**（写入主 skill `dsh-bio-genie` 的 ACR 章节与 `bio-core.md`，本节是索引）：

- `ImportError/ModuleNotFoundError` → 先 `bio_env` 看环境；若环境就绪却仍缺包是插件 bug——停止自愈，报告插件 bug（不要自行 pip install，违反「零安装」原则）
- `HTTP 429` / 速率限制 → code 里加 `time.sleep(0.4)`；批量任务走 `bio-proto-entrez-batch`
- `FileNotFoundError` → 相对路径基于工作区；不确定就用绝对路径
- `KeyError/AttributeError` → 读 stderr 行号定位
- `UnicodeDecodeError` → 中文 Windows 文件用 `open(path, encoding='utf-8', errors='replace')`
- `TimeoutError` / `timedOut=true` → 传更大 `timeoutMs`；大数据写文件而非 print
- 模糊密码子 `TranslationError` → 翻译前 `seq.replace('X','N').replace('-','N').replace('.','N')`

**沉淀**：`pendingFixes` Map 配对失败→修复成功 → 写入 `error_lessons.json`，下次同类错误直接套用 fix_hint（无需重新发明）。

## 12. 已知限制

- `bio_python` 直接 spawn Python，未走 dsh 沙箱；信任级别等同用户本机 Python。
  这是「许愿式编程」（执行模型写的任意代码）的固有属性。
- 需要网络的 skill（NCBI/BLAST）依赖环境网络，受上游速率限制。
- `bio-graphics` 绘图需 reportlab（可选依赖，按需加入 requirements）。
- 首次引导需网络；已引导后可离线使用语义化工具。
