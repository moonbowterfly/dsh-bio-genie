---
name: bio-proto-source-audit
domain: database
inputs: [标识符/序列清单或待审计文本]
outputs: [逐条六态核验结果/审计报告]
requires_network: true
language: python
---

# 来源审计协议（source audit）

> 把「先查后写」纪律工具化：凡写进交付物的**标识符**（登录号/基因 ID/文献 ID）与
> **序列**，先与权威来源核验；结果按六态落账；修正或标注留痕。工具：`bio_source_audit`。

## When to Use

- **交付前**：报告 / 图表 / 附表里每一个登录号（NCBI/UniProt/PDB/Ensembl）与引用 ID（PMID）过一遍审计；
- **写任何标识符之前**（先查后写）——尤其是凭记忆或二手转述得到的编号；
- **序列溯源**：确认分析/设计中用到的序列确实来自声称的记录（逐字命中或反向互补命中）；
- 拿到一份来路不明的笔记/报告：先 `scan` 抽候选清单，再对需要的条目显式核验。

## 工具三模式

| mode | 用途 | 输入 | 联网 |
|---|---|---|---|
| `identifiers` | 存在性 + 比对项（organism_contains / title_contains / length / year / gene_contains） | `items_json` 或 `items_file`（JSON 数组） | 是 |
| `sequences` | 序列逐字/反向互补核验（返回 1-based 位置） | `items_json` 或 `items_file` | 是 |
| `scan` | 抽取候选清单（NC_/NP_/ENS\*/`PMID:`/`PDB:`/≥15nt ACGT） | `text` 或 `file` | 否 |

标识符条目 `[{"db": "ncbi_nucleotide", "id": "NC_003063.2", "expect": {"organism_contains": "Agrobacterium", "length": 2075577}}, {"db": "uniprot", "id": "P04637", "expect": {"organism_contains": "Homo sapiens", "gene_contains": "TP53"}}, {"db": "pmid", "id": "36418310", "expect": {"year": 2022}}]`；
序列条目 `[{"db": "ncbi_nucleotide", "id": "NC_003063.2", "sequence": "TGATATTG..."}]`。

## 六态怎么读（严禁混用）

| 状态 | 含义 | 处置 |
|---|---|---|
| `verified` | 存在性 + 全部请求项通过 | 可作「已核验」引用（范围＝所查项） |
| `mismatch` | 记录存在但比对失败 | 必改：改错、或确认 ID 是否指错对象 |
| `partial` | 存在性通过、部分项无法核验 | 不能写「已全部核验」；补信息或降级表述 |
| `not_found` | 源明确无记录 | 必改（该 ID 不得进入交付物） |
| `unreachable` | 未能查询（网络/超时/限流） | **不是结论**：重试，或显式标注「未完成核验」 |
| `error` | 条目格式错误/来源不支持该模式 | 修条目或换正确来源 |

## 标准工具调用序列

1. **收集**：列 items（`scan` 可先抽候选、人工确认后转正式核验）；
2. **核验**：`bio_source_audit`（单次 ≤25 条，超了分批；多源逐条核验自带节流）；
3. **处置**：`mismatch`/`not_found` 逐条改；`unreachable` 重试或显式标注未核验；
4. **留痕**：`out_md` 输出审计报告（含每项期望值/实测值与检索时间），与交付物一并存档。

```python
# 在 bio_python 中构造核验清单（示例：把一批 ID 转成 items）
import json
found = [("ncbi_nucleotide", "NC_003063.2"), ("uniprot", "P04637"), ("pmid", "36418310")]
items = [{"db": db, "id": rid} for db, rid in found]
print(json.dumps(items, ensure_ascii=False))
# 将该输出作为 items_json 调用 bio_source_audit（mode=identifiers）；
# 需要比对的条目补 expect（organism_contains / title_contains / length / year / gene_contains）。
```

## 与其他严谨性基建的分工

- **数字**的出处 → provenance 台账 / rigor-guard（自动，回合内）；
- **结论强度**（能说多强、怎么措辞） → `bio-evidence-appraisal`；
- **标识符/序列与源的一致性** → 本协议（显式调用，逐条留痕）。

## 常见坑

- **「存在 ≠ 是你说的那个」**：ID 存在但 organism/title 与所述不符 = mismatch——请带 `expect` 比对项，别只查存在性；
- **版本号差异不是错**：请求 `NC_003063` 返回 `NC_003063.2` 属正常（取最新版本）；交付物里引用**实际检索到的**版本号；
- **反向链不一定是错**：查询与记录反向互补一致时报告 `strand="-"` 与位置；设计序列时注意方向语境；
- **查不了 ≠ 没有**：`unreachable` 不得读成 `not_found`，更不得读成「没问题」；
- **别扫完就当核验**：`scan` 只给候选（含误报），核验必须显式跑 `identifiers`/`sequences`。

## 验收标准

- [ ] 交付物里每个登录号/PMID 都经过 `bio_source_audit` 核验（或显式标注「未核验」）
- [ ] `expect` 至少含 1 个可比对项（organism/title/length/gene/year）——只查存在性不算核验
- [ ] `mismatch` / `not_found` 条目已全部修正或删除
- [ ] `unreachable` 条目已重试；仍不可达的显式标注「未完成核验」，未读成「无记录 / 没问题」
- [ ] 序列命中已核（含 strand 与 1-based 位置）；引用的版本号与检索结果一致
- [ ] 审计报告（`out_md`）已与交付物一并存档
