# 模型 agentic 能力差异对插件使用的影响（实测备忘）

> 面向维护者/使用者的实测文档。记录同一插件（dsh-bio-genie）在不同 LLM 下的表现差异、定量证据与可复用的诊断方法。2026-08-27 实测，基于某xxx细菌基因组（2.1 Mb 染色体）分析任务的两次真实会话。

## 1. 背景与动机

插件层（工具/技能/溯源护栏）对 agent 提供的是**能力上限**，但最终的执行质量
同时取决于**模型自身的 agentic 能力**。同一任务、同一插件、同一提示词，换一个
模型可能从「卡死」变成「流畅完成」。本文记录一次完整的对照实测，供模型选型、
任务编排与故障诊断参考。

## 2. 实测环境

| 项 | 值 |
|----|----|
| 任务 | 某xxx细菌 染色体（NC_xxx，xxx bp）全面生信分析 |
| 插件 | @dsh-bio/dsh-bio-genie v0.6.21+（同一套工具/技能/护栏） |
| 会话 A（旧） | opencode-go / mimo-v2.5，contextWindow 1,000,000，maxTokens 128,000 |
| 会话 B（新） | opencode-go / deepseek-v4-flash，contextWindow 1,000,000，maxTokens 384,000 |
| 工作区 | D:\Program\dsh\xxx-analysis (A) / xxx-analysis-v2 (B) |

两会话为相同任务、相同 preset（bio-genie）、相同提示词约束（溯源铁律、报告落盘、
中文报告）。模型推理强度均为default。

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

会话 A 事件流含 **19,040 个 `assistant/chunk`，其中 4,482 个是同一个
`bio_seq_gc_skew` 工具的 tool-call-delta 参数增量**——模型持续流式输出
该工具参数（内容逐字符增长，4,032 个唯一片段）却始终未发出可执行的
`tool/call`，且全程 0 个 tool-call-end 闭合信号。这 19 分钟推理时间几乎
全是无效输出。

结论：mimo-v2.5 的「失败」不是工具调用报错，而是**流式工具参数生成后不
闭合**（卡在 tool-call-delta 阶段，详见 §5 供应商层归因检验）。

## 4. 差异维度

### 4.1 工具调用协议收敛性（模型生成质量的核心表现）

- **mimo-v2.5**：流式生成工具参数时易陷入「持续生成不闭合」（大量 tool-call-delta
  事件、内容持续增长、无 tool-call-end，不产生 tool/call）。表现为「会话一直
  running、turns 不涨、工具数不涨」。
- **deepseek-v4-flash**：参数流干净收敛，每次调用都是 call → result 完整配对。

> 诊断信号：`session.history` 中 `assistant/chunk` 数量暴涨（千级）而
> `tool/call` 数量不变 = 参数生成不闭合，应视为模型卡死而非任务执行慢。

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

## 5. 配置层差异与归因检验（settings.yaml）

| 参数 | mimo-v2.5 | deepseek-v4-flash |
|------|-----------|-------------------|
| contextWindow | 1,000,000 | 1,000,000（相同） |
| maxTokens | 128,000 | 384,000（3 倍） |

**归因检验：maxTokens 是否主导本次差异？——否。**

| 反证 | 说明 |
|------|------|
| decodeTokens 远低于上限 | 会话 A 实际输出 54,516 tokens，仅占 128K 上限 42.6%，卡死时预算未用尽 |
| 卡死形态 ≠ 截断形态 | maxTokens 瓶颈典型表现为参数 JSON 截断不闭合；实际观察到的是同一工具参数千级持续增量，两者机制不同 |
| 两会话 decodeTokens 相近 | A=54.5K / B=48.9K，生成量相当但一个卡死一个完成——差异在生成质量而非生成额度 |
| 认知监控/工具边界理解 | 与输出预算无关的纯能力维度（见 4.2/4.3） |

**归因检验：是否为供应商（网关/上游）问题？——证据不支持为主因，但未完全排除。**

| 证据 | 指向 |
|------|------|
| 卡死段 4,482 个 tool-call-delta 有 4,032 个唯一 hash（重复最多的 hash 仅 5 次），内容逐字符增长（`'{"sequence": "'`→`'T'`→`'TGATATTG...'`） | **排除「网关重复推送同一帧」**——模型在真实生成新内容 |
| 整个卡死段 0 个 tool-call-end 事件 | 参数流不闭合；模型/供应商/引擎三方皆可能，单入口数据无法区分（v4-flash 同引擎同网关正常闭合 → 引擎嫌疑弱，但网关对不同模型可用不同上游/转换路径） |
| step 9 reasoning 自述 "whole genome is huge" 却仍将序列整串写入 `sequence` 参数 | **模型决策层硬伤**，与供应商无关；对照 v4-flash 选择「2.1Mb 不能整串传参→bio_python 落盘」 |

> 彻底闭合「流不闭合」归因需隔离实验：将 mimo-v2.5 挂另一 provider 入口
> 跑同任务同工具调用。正常闭合 → 供应商转换问题；仍不闭合 → 模型特性。

结论：maxTokens 是真实配置差异，但本次实测中**未触及、未构成瓶颈**；
主导因素为模型 agentic 生成质量（tool-call JSON 生成与终止能力、认知监控、
工具边界理解）；供应商问题未被完全排除但有明确反证，需隔离实验定论。

## 6. 结论与建议

- 插件层在两次会话中均未触发自愈（0 self-heal），差异主要来自模型 agentic
  生成质量（工具调用收敛性、认知监控、工具边界理解）；输出预算为次要因素，
  本次未成瓶颈。
- **模型选型**：重任务（基因组级分析、代谢建模、多步湿实验设计）优先
  deepseek-v4-flash 或同等 agentic 能力模型；轻任务可保留低成本模型。
- **若必须用低 agentic 模型**：提示词显式要求「每个工具调用后校验结果合理性；
  怀疑异常时先用 bio_python 小步调试」，用提示词补偿认知监控短板。
- **任务编排**：对易卡模型，把任务拆小（单轮少步骤），降低单 turn 推理负载。

## 7. 可复用的诊断方法（由AI生成，未经人为检验）

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