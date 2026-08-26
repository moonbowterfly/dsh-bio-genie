# 模型 agentic 能力差异对插件使用的影响（实测备忘）

> 面向维护者/使用者的实测文档。记录同一插件（dsh-bio-genie）在不同 LLM 下
> 的表现差异、定量证据与可复用的诊断方法。2026-08-27 实测，基于 C58 全基因组
> 分析任务（2.1 Mb 线性染色体）的两次真实会话。

## 1. 背景与动机

插件层（工具/技能/溯源护栏）对 agent 提供的是**能力上限**，但最终的执行质量
同时取决于**模型自身的 agentic 能力**。同一任务、同一插件、同一提示词，换一个
模型可能从「卡死」变成「流畅完成」。本文记录一次完整的对照实测，供模型选型、
任务编排与故障诊断参考。

## 2. 实测环境

| 项 | 值 |
|----|----|
| 任务 | Agrobacterium fabrum C58 线性染色体（NC_003063.2，2,075,577 bp）全面生信分析 |
| 插件 | @dsh-bio/dsh-bio-genie v0.6.21+（同一套工具/技能/护栏） |
| 会话 A（旧） | opencode-go / mimo-v2.5，contextWindow 1,000,000，maxTokens 128,000 |
| 会话 B（新） | opencode-go / deepseek-v4-flash，contextWindow 1,000,000，maxTokens 384,000 |
| 工作区 | D:\Program\dsh\c58-analysis (A) / c58-analysis-v2 (B) |

两会话为相同任务、相同 preset（bio-genie）、相同提示词约束（溯源铁律、报告落盘、
中文报告）。

## 3. 定量对比

### 3.1 会话级统计（session.list → projections.sessionStats）

| 指标 | mimo-v2.5 (A) | deepseek-v4-flash (B) |
|------|--------------|------------------------|
| 纯推理时间 llmMs | 1,138,443（≈19 min） | 555,271（≈9.3 min） |
| 完成步骤 steps | 9（卡死在最后一步） | 13（全部完成） |
| decodeTokens | 54,516 | 48,850 |
| 工具调用 | 11 次（含片段传参） | 22 次，0 失败 0 自愈 |
| 产物流 | 无报告（任务未完成） | 报告 + 2 图 + 15 数据文件 |

### 3.2 事件流证据（session.history）

会话 A 事件流含 **19,040 个 `assistant/chunk`，全部是同一个 `bio_seq_gc_skew`
工具的 tool-call-delta 参数增量**——模型反复流式输出同一工具参数却始终未发出
可执行的 `tool/call`。这 19 分钟推理时间几乎全是无效输出。

结论：mimo-v2.5 的「失败」不是工具调用报错，而是**流式工具参数生成不收敛**。

## 4. 三个关键差异维度

### 4.1 工具调用协议收敛性

- **mimo-v2.5**：流式生成工具参数时易陷入不收敛循环（大量 tool-call-delta 事件
  而不产生 tool/call）。表现为「会话一直 running、turns 不涨、工具数不涨」。
- **deepseek-v4-flash**：参数流干净收敛，每次调用都是 call → result 完整配对。

> 诊断信号：`session.history` 中 `assistant/chunk` 数量暴涨（千级）而
> `tool/call` 数量不变 = 参数生成不收敛，应视为模型卡死而非任务执行慢。

### 4.2 认知监控（结果合理性自校验）

v4-flash 对不合理结果会主动停下来排查，mimo-v2.5 基本不校验自身结果：

| 场景 | v4-flash 行为 |
|------|---------------|
| 限制酶扫出 0 位点 | 自判「高 GC 基因组上不合常理，EcoRI 在 2 Mb 应出现数百个」→ 定位 `Bio.Restriction` API 用法错误 → 改写字符串检索 |
| 六框扫描 KeyError | 定位 `strand` 列名与字典键 `fwd/rev` 不匹配 |
| f-string 转义冲突 | 改三重引号模板 |
| 脚本截断/未写完 | 主动补全重跑 |

### 4.3 工具边界语义理解

- **mimo-v2.5**：把 ~100 bp 片段塞进 `bio_seq_find_orf` / `bio_seq_restriction`
  的 `sequence` 参数（未意识到 2.1 Mb 无法整串传参，语义化工具传长序列会失真）。
- **v4-flash**：主动选择「2.1 Mb 无法整串传参，用执行器落盘」，全程 `bio_python`
  处理全长序列，图件 300 dpi 审计 PASS。

## 5. 配置层差异（settings.yaml）

| 参数 | mimo-v2.5 | deepseek-v4-flash |
|------|-----------|-------------------|
| contextWindow | 1,000,000 | 1,000,000（相同） |
| maxTokens | 128,000 | 384,000（3 倍） |

输出上限 3 倍差异对**长代码生成 + 长格式修复**影响明显：mimo-v2.5 生成完整修复
脚本时更易触及上限导致截断、重试循环。

## 6. 结论与建议

- 插件层在两次会话中均未触发自愈（0 self-heal），差异全部来自模型 agentic
  能力：① 工具调用协议收敛性；② 错误检测与根因定位回路；③ 输出预算。
- **模型选型**：重任务（基因组级分析、代谢建模、多步湿实验设计）优先
  deepseek-v4-flash 或同等 agentic 能力模型；轻任务可保留低成本模型。
- **若必须用低 agentic 模型**：提示词显式要求「每个工具调用后校验结果合理性；
  怀疑异常时先用 bio_python 小步调试」，用提示词补偿认知监控短板。
- **任务编排**：对易卡模型，把任务拆小（单轮少步骤），降低单 turn 推理负载。

## 7. 可复用的诊断方法

```python
# 卡死探测：assistant/chunk 暴涨而 tool/call 不涨 = 参数不收敛
from dsh_bio_client import DshClient, extract_events
dsh = DshClient('http://127.0.0.1:3080/api')
evs = extract_events(dsh.history(sid, limit=500))
from collections import Counter
cnt = Counter(typ for _, typ, _ in evs)
print(cnt)  # 重点看 assistant/chunk 与 tool/call 的比例
```

| 信号 | 判读 |
|------|------|
| chunk 数百~千级、tool/call 为 0 且长时间不变 | 流式参数不收敛 → 建议换模型/取消 |
| chunk 涨、tool/call 同步涨 | 正常推进 |
| tool/result 连续报错（traceback） | 插件代码缺陷 → 应修复插件而非换模型 |