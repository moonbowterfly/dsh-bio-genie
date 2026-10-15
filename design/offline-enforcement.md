# A6 Offline Enforcement — 断网验收执行口径

req_ref: genie-synbio-design-spec-v0.2-2026-10-12.md#9 (A6) / v0.3-2026-10-12.md#9 (强化)
实现：req G-LOOP-20261015-D5-001 ｜ 测试：`test/design-offline.mjs`

## 1. 目标

在**真实断网**（非 mock）环境下跑通 reference bundle 驱动的 E2E 链路，并保证：
任何未声明的网络 fetch 在子进程级被阻断（fail-closed，`DEPENDENCY_UNAVAILABLE/BLOCKED` 语义
由 REFERENCE-REGISTRY §5 声明，见 §4）。

## 2. 网络拦截方式（可复跑、可审计）

**机制：子进程级 socket guard（sitecustomize 预载哨兵）**，由 `test/design-offline.mjs`
在测试现场动态生成哨兵目录（`<tmp>/<offline-guard>/sitecustomize.py`），对每个 worker
子进程注入：

```python
# sitecustomize.py（测试现场生成，非仓库文件）
import socket as _socket
import builtins

def _block_connect(*_a, **_k):
    raise OSError("OFFLINE_GUARD: socket connection blocked by A6 offline guard")

_socket.socket.connect = _block_connect      # 实例连接路径
_socket.create_connection = _block_connect   # urllib/urllib3/http.client 统一入口
builtins._OFFLINE_GUARD_ACTIVE = True        # 正探针标记
```

注入方式：worker spawn 时设置 `PYTHONPATH=<哨兵目录>`（**不使用 `-I` 隔离模式**，
否则 `-E` 会忽略 PYTHONPATH 导致哨兵不载入——这是 A6 与其余测试的 spawn 参数差异点，
已在测试注释中披露）。Python 启动时 site 模块自动 import sitecustomize，在任何业务
import（cobra 等）发生前完成拦截。阻断特征：`OSError("OFFLINE_GUARD: ...")`。

审计性：
- 正探针：`builtins._OFFLINE_GUARD_ACTIVE is True` → 哨兵确实载入；
- 负探针：`socket.create_connection(('1.2.3.4', 80))` → 必须抛 `OFFLINE_GUARD` 特征错误
  （断言拦截真实生效，不是"假装断网"）。

不采用的方式及理由：
- **禁用代理（清 `HTTP(S)_PROXY`）**：只阻断代理通道，直连仍可出网，不是断网；
  作为补充仍由测试 env 显式清空（防代理兜底出网）。
- **mock 网络库**：不拦截真实 socket，无法证明"断网下工具行为"。

## 3. 现状核证：design 实现零 fetch

2026-10-15 全仓核证（`findstr /s /i "urllib requests urlopen socket"` 于
`python/design_consequence.py design_host.py design_casefile.py design_ops.py`
`src/design-validate.js design-envelope.js design-dispatch.js` 等 design 通道文件）：
**零命中**。design 通道（host 三工具 + consequence + casefile validate/export）全部为
本地文件读写（stdin JSON → 本地对象/snapshot/registry），无任何网络依赖。
`test/design-offline.mjs` §3 将此核证固化为断言（防未来引入未声明 fetch 而静默联网）。

## 4. 未声明 fetch 的 fail-closed 口径

任何未来引入的 fetch 在 guard 下必然于 socket 层死亡（`OFFLINE_GUARD` OSError）——
worker 侧不会"假成功"。资源侧 fail-closed 口径照 `design/reference-bundle/REFERENCE-REGISTRY.md` §5：

- reference bundle 资产缺失 → `DEPENDENCY_UNAVAILABLE`；
- 资产哈希与登记表不符 → `BLOCKED/HASH_MISMATCH`；
- 拒绝执行不产出部分结果、不写科学快照/registry、退出非零。

A5 矩阵中 F08（OSTIR unavailable）与 F05–F07（solver 状态门）即该口径的可执行/登记证据。

## 5. 允许的本地缓存白名单

断网环境下唯一允许读取的本地资源（全部离线，逐条列出）：

| 白名单项 | 路径 | 校验 |
|---|---|---|
| 冻结契约树 | `design/packet/**` | design gate（`verifyDesignPacket`）sha256 锚 |
| reference bundle 外置资产 | `D:\Program\dsh-plug-develop\genie-synbio-design-20261012\reference\`（7 文件，不在 git） | `scripts/validate_reference_registry.py`（7/7 PASS）+ 工具侧入口哈希核验 |
| 本地依赖 | `python-env\Scripts` / site-packages（cobra 等） | 无网络安装路径；venv 本地已装 |
| 测试现场资产 | `<tmp>/<test>/`（builder fixtures 副本、哨兵目录） | 测试自建自清理 |

**无任何网络缓存**：design 通道不写、不读任何联网缓存目录（grep 核证无 cache 路径）。

## 6. E2E 链路（`test/design-offline.mjs`）

在 guard env 下全量执行：casefile stage（builder）→ validate → export（+ consequence/iML1515
含冻结锚点 baseline growth=0.876997，iML1515 不可用则显式 skip 并披露）。全程 exit 0 / OK，
无任何 fetch 尝试。
