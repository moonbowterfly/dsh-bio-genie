# 工具函数与密码子表（Bio.SeqUtils / Bio.Data）

## 遗传密码子表

```python
from Bio.Data import CodonTable

t = CodonTable.unambiguous_dna_by_name["Standard"]   # 或 by_id[1]
print(t.start_codons, t.stop_codons)

# 单个密码子
print(t.forward_table["ATG"])     # -> 'M'
print(t.back_table["M"])          # -> ['ATG']

# 遍历所有标准表
for name, table in CodonTable.unambiguous_dna_by_name.items():
    print(name, table.id)
```

## 密码子使用偏好

```python
from Bio.Seq import Seq
from Bio.SeqUtils import CodonUsage

s = Seq("ATGAAACGCATTAGCACCACCATTACCACCACCATTACCACCACCATTACCACCACCATTACCAC")
print(CodonUsage.CodonAdaptationIndex(s))   # 密码子适应指数
```

## 常用小工具

```python
from Bio.SeqUtils import GC, gc_fraction, molecular_weight, melting_temp, GC_skew, nt_search, seq1, seq3

s = "ATGAAACGCATTAGCACCACCATTACCACCACCATTACCACCACCATTACCACCACCATTACCAC"
print(gc_fraction(s))
print(molecular_weight(s))
print(melting_temp(s))
print(GC_skew(s, window=5))

# 查找短序列在长序列中的所有位置（含错配）
from Bio.SeqUtils import nt_search
print(nt_search(s, "AAACG"))
```

## 蛋白质理化参数（ProtParam）

```python
from Bio.SeqUtils import ProtParam

p = ProtParam.ProteinAnalysis("MKLVWDTVLKGKKI")
print("MW:", p.molecular_weight())
print("pI:", p.isoelectric_point())
print("aromaticity:", p.aromaticity())
print("secondary structure fraction:", p.secondary_structure_fraction())
print("amino acid %:", p.get_amino_acids_percent())
```

## 要点

- `CodonTable` 表 id：标准=1、细菌/叶绿体=11、线粒体=2 等。
- `molecular_weight` 对 DNA 与蛋白自动按 `seq_type` 区分，蛋白序列务必 `seq_type="protein"`。
- `ProtParam.ProteinAnalysis` 对短肽某些方法会告警（如 secondary_structure），忽略即可。
