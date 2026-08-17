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

### 5.1 R 环境引导（双引擎，2026-08-17 起）

与 Python 侧同构的零依赖自举模型（`src/r-runtime.js`，独立模块不动 Python 侧）：

1. **下载 R 4.6.0 安装器**（官方 CRAN → 失败自动切清华镜像；校验文件是
   `md5sum.R-4.6.0.txt`——按版本命名，非 `md5sum.txt`，两源实测踩坑修正）
2. **静默安装**到 `$DSH_HOME/dsh-bio-genie/r/`（Inno Setup `/VERYSILENT /NORESTART /DIR`）
3. **BiocManager 装核心包集**到 `r-lib/`（版本对固定 R 4.6.0 ↔ Bioc 3.23；
   `install.packages.compile.from.source="never"` 二进制优先；清华 CRAN + 清华
   Bioconductor 镜像回退）

与 Python 侧的差异：
- **惰性引导**：`warmUpR` 默认 false（R+核心包数百 MB，不为从未用 R 的用户强制下载）；
  首次 `bio_r` 调用触发（工具等待上限 40 分钟）。
- **包级修复**：缺包 → 幂等安装器补装（R 本体不重装）；`bio_r_env reinstall=true` 强制重装包集。
- **平台边界**：引导器仅 Windows（R 安装器无可移植静默安装路径）；macOS/Linux 需用户
  自行装 R 并配置 `rscriptPath`（诚实报错，不假装支持）。
- **许可模型**：R/CRAN/Bioc 软件全部运行时从官方仓库安装到用户私有目录，
  插件零源码分发（逐包许可证清单与 AGPL phyloseq 论证见 THIRD_PARTY_NOTICES.md）。

执行层 `r/r_bridge.R`：与 `python/bridge.py` 同构的 JSON 信封（stdin 读
`{code, cwd}` → stdout 一行 `{ok, stdout, stderr, result}`）；`result <- 值`
结构化返回；错误被捕获写 stderr（`Error`/`Execution halted` 标记），TS 侧据此
判定 `needs_repair`（与 Python 的 traceback 判定对称）。UTF-8 走原始字节通道
（Windows GBK 环境防乱码）。R 子进程环境隔离：`R_LIBS` 指向私有库、
`R_ENVIRON_USER/R_PROFILE_USER` 清空 + `--vanilla`。

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
- **加 R 核心包**：改 `r/requirements-r.txt`（安装器自动读取）；存量环境缺包自动补装。
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
- **当前内容为占位**：面板具体设置项尚未设计，渲染标题 + 说明文字。
- **扩展路径**：设置内容复杂化后可迁到 tsdown 构建（`src/client/*.tsx`），
  宿主侧逻辑完全不受影响。

## 10. 平台兼容

- `pythonExecutable()` 按平台区分 `Scripts/python.exe`（win32）与 `bin/python`（POSIX）。
- `windowsHide: true` + AbortSignal 监听，跨平台一致。
- uv 下载 URL 按 `process.platform`/`process.arch` 选择。

## 11. 已知限制

- `bio_python` 直接 spawn Python，未走 dsh 沙箱；信任级别等同用户本机 Python。
  这是「许愿式编程」（执行模型写的任意代码）的固有属性。
- 需要网络的 skill（NCBI/BLAST）依赖环境网络，受上游速率限制。
- `bio-graphics` 绘图需 reportlab（可选依赖，按需加入 requirements）。
- 首次引导需网络；已引导后可离线使用语义化工具。
