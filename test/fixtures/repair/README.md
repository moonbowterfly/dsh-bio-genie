# test/fixtures/repair/ — 合成 fixtures（Repair Proposal v0）

**铁律（C4 fixture 约定）**：本目录只允许**合成**样本——禁止放入真实日志、真实
错误 message、用户代码、序列、科研路径、项目名或任何 token。

| 文件 | 用途 |
|---|---|
| `incident-valid.json` | 一个合法的 `g-repair-incident/v1` 样本（闭集校验应通过） |
| `reject-samples.json` | 拒绝样本（raw 字段 / 绝对路径 id / 未知状态；闭集校验应拒绝） |

这些样本由 `test/repair-contract.mjs` 读取并断言。修改本目录内容时同步跑该测试。
