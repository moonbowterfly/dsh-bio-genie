---
language: python
---

# 系统发育（Bio.Phylo）

解析、操作、绘制进化树。

## 解析与导出

```python
from Bio import Phylo

tree = Phylo.read("tree.nwk", "newick")   # 或 "nexus" / "phyloxml" / "nexml"
print(tree)                                # ASCII 打印
print("terminals:", len(tree.get_terminals()))
print("total branch length:", tree.total_branch_length())

Phylo.write(tree, "out.nwk", "newick")
```

## 遍历

```python
from Bio import Phylo

tree = Phylo.read("tree.nwk", "newick")
for clade in tree.find_clades(order="level"):   # 逐层
    print("  " * (tree.depths()[clade] or 0), clade.name)

for leaf in tree.get_terminals():                # 叶节点
    print(leaf.name)

# 找共同祖先 / 最近共同祖先（需外部库时才用；简单场景用 mrca 需 TreeConstruction）
# 手动找两叶的距离：
print(tree.distance("sp1", "sp2"))
```

## 重根 / 剪枝

```python
from Bio import Phylo

tree = Phylo.read("tree.nwk", "newick")
tree.root_with_outgroup({"name": "outgroup"})   # 以外群重根
tree.root_at_midpoint()                          # 中点重根
print(tree)

# 剪枝：保留部分叶
tree.prune(["sp1", "sp2", "sp3"])
Phylo.write(tree, "pruned.nwk", "newick")
```

## 绘制

```python
from Bio import Phylo
import matplotlib
matplotlib.use("Agg")            # 无显示器环境
import matplotlib.pyplot as plt

tree = Phylo.read("tree.nwk", "newick")
fig = Phylo.draw(tree)
fig.savefig("tree.png", dpi=150)
print("saved tree.png")
```

## 要点

- `find_clades` 返回生成器；`get_terminals` / `get_nonterminals` 返回列表。
- `Phylo.draw` 需要 matplotlib；若环境无 matplotlib，改用 ASCII 打印或写 Newick 由用户外部工具绘图。
- 距离矩阵构建树请用 `Bio.Phylo.TreeConstruction.DistanceTreeConstructor`（UPGMA/NJ）。

## ⚠️ 系统发育分析质量要求

### 序列选择

- **长度一致性**：参与比对的序列长度差异应 <20%（如 16S rRNA：所有序列应在 1300-1600bp 范围内）
- **完整性**：优先使用完整基因序列，避免 partial 序列（partial 会导致比对失真）
- **同源性**：确保比对的是同源基因（同一基因的不同物种拷贝）

### 比对质量

- 比对后检查：gap 比例应 <30%，否则考虑重新选择序列
- 使用 Gblocks 或 trimAl 质量过滤比对
- 低质量比对区域应剪除

### 支持度

- Bootstrap 值 ≥70% 才可信（1000 次重复）
- 低于 70% 的分支应标注为"低支持度"
- 报告中说明使用了什么建树方法和参数

## 出图时声明来源（fig-viewer 来源记录）

画树图（或任何图）前声明输入与参数——图卡「来源」按钮将展示原始数据来源；
未声明时系统仅能推断工作区近期数据文件：

```python
from figurelib.origin import set_source_context
set_source_context(inputs=[{'path': 'agro_tree/aln_trimmed.fasta', 'note': '16S 比对'}],
                   params={'method': 'nj', 'model': 'K2P'}, tool='figurelib.Phylo')
```
## 验收标准

- [ ] 建树输入（比对文件/序列）与构建方法（nj/upgma、模型）在结果中明示
- [ ] Newick 写出后回读校验（叶节点数一致），叶名与输入一一对应
- [ ] 树图导出前调用 `set_source_context` 声明输入与参数（来源可溯）
- [ ] 自举/支持率如报告，须注明重复数与所用工具版本
