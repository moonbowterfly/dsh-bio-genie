---
language: python
---

# 蛋白质结构（Bio.PDB）

解析 PDB/mmCIF、遍历原子/残基/链、计算距离、结构叠加。

## 解析结构

```python
from Bio.PDB import PDBParser, MMCIFParser

p = PDBParser(QUIET=True)                 # PDB 文本
structure = p.get_structure("1abc", "1abc.pdb")

# 或 mmCIF
m = MMCIFParser(QUIET=True)
structure = m.get_structure("1abc", "1abc.cif")

print(structure.header)                    # 头部信息
model = structure[0]                       # 第一个 model
chain = model["A"]                         # 链 A
```

## 遍历原子 / 残基 / 链

```python
from Bio.PDB import PDBParser

structure = PDBParser(QUIET=True).get_structure("s", "1abc.pdb")

for model in structure:
    for chain in model:
        for residue in chain:
            if residue.id[0] != " ":        # 跳过水等异源残基
                continue
            for atom in residue:
                print(chain.id, residue.get_resname(), residue.id[1],
                      atom.name, atom.coord)
```

## 计算原子距离

```python
from Bio.PDB import PDBParser

structure = PDBParser(QUIET=True).get_structure("s", "1abc.pdb")
atoms = list(structure.get_atoms())
a, b = atoms[0], atoms[100]
print("distance:", a - b)                   # 重载减法 = 欧氏距离
```

## 结构叠加（Superimposer）

```python
from Bio.PDB import PDBParser, Superimposer

p = PDBParser(QUIET=True)
fixed = p.get_structure("a", "a.pdb")[0]
moving = p.get_structure("b", "b.pdb")[0]

sup = Superimposer()
fixed_atoms = [r["CA"] for r in fixed.get_residues() if "CA" in r]
moving_atoms = [r["CA"] for r in moving.get_residues() if "CA" in r]
sup.set_atoms(fixed_atoms, moving_atoms)
sup.apply(moving.get_atoms())
print("RMSD:", round(sup.rms, 3))
print("rotation:", sup.rotran[0])
print("translation:", sup.rotran[1])
```

## 保存 / 序列提取

```python
from Bio.PDB import PDBParser, PDBIO, PPBuilder

structure = PDBParser(QUIET=True).get_structure("s", "1abc.pdb")

# 保存结构
io = PDBIO()
io.set_structure(structure)
io.save("out.pdb")

# 从结构提取序列
for pp in PPBuilder().build_peptides(structure):
    print(pp.get_sequence())
```

## 要点

- `residue.id[1]` 是残基编号；`residue.id[0]` 非空格表示插入码/异源标记。
- `get_atoms()` / `get_residues()` / `get_chains()` 都是生成器。
- PDB 下载可用 `Bio.PDB.PDBList().retrieve_pdb_file("1abc", pdir=".")`（需网络）。
- 想算二级结构需外部 DSSP：`Bio.PDB.DSSP`（需 dssp 二进制）。
