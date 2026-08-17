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
