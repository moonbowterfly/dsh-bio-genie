---
language: python
---

# 序列图形化（Bio.Graphics.GenomeDiagram）

用 GenomeDiagram 绘制带注释的序列图谱（线性/环形）。

## 线性图谱

```python
from Bio import SeqIO
from Bio.Graphics import GenomeDiagram
from reportlab.lib.units import cm
from reportlab.lib import colors

record = SeqIO.read("input.gb", "genbank")

diagram = GenomeDiagram.Diagram("Genome Diagram")
track = diagram.new_track(1, name="Annotated Features")
features = track.new_set()

for feature in record.features:
    if feature.type != "gene":
        continue
    # 颜色按 strand
    color = colors.blue if feature.location.strand >= 0 else colors.red
    features.add_feature(feature, color=color, label=True)

diagram.draw(format="linear", pagesize=(30*cm, 10*cm), fragments=1,
             start=0, end=len(record))
diagram.write("diagram.png", "PNG")
print("saved diagram.png")
```

## 环形图谱

```python
from Bio import SeqIO
from Bio.Graphics import GenomeDiagram
from reportlab.lib import colors

record = SeqIO.read("plasmid.gb", "genbank")
diagram = GenomeDiagram.Diagram("Plasmid Map")
track = diagram.new_track(1, name="Features", greys=0, greytrack=1)
features = track.new_set()

for feature in record.features:
    if feature.type == "gene":
        features.add_feature(feature, color=colors.blue, label=True)

diagram.draw(format="circular", pagesize=(20, 20), start=0, end=len(record), circular=True)
diagram.write("circular.png", "PNG")
print("saved circular.png")
```

## 要点

- GenomeDiagram 依赖 `reportlab`（已随插件环境预装，见 `python/requirements.txt`；若在旧环境下缺失，重跑 `bio_env` 的 reinstall 即可）。
- `features.add_feature(feature, ...)` 需要 `SeqFeature`，常见于 GenBank 文件的 `record.features`。
- `pagesize` 单位是 cm（线性）或 pt（环形），调大以容纳更多标注。
- 生成的是 PNG/PDF；绘图后记得报告文件路径。
