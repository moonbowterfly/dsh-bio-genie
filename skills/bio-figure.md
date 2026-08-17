---
language: python
---

# 出版级科研绘图（bio-figure，可视化顾问）

> 吸收自 scipilot-figure-skill（MIT）——定位不是"画图工具"，而是"**可视化顾问**"：先剖析数据、按论证目标选图、主动拦截经典错误、按期刊规范出图、机器自检闭环。执行层配方见协议 `bio-proto-pub-figure`。

## 何时用

用户提到：论文配图、画图、数据可视化、用什么图好、箱线/柱状/散点/热图、误差棒、显著性标注、期刊投稿图、中文图表、多面板。

**即使用户只是给一批数据问"这个怎么画"，也要先用本 skill——首要能力是判断该用什么图，其次才是绘制。**

## 8 步工作流（顺序不可跳）

```
0. 理解任务    这张图要论证什么观点？数据在哪？（用户没说清就主动问）
1. 剖析数据    bio_fig_profile(path, group_cols) → 列类型/样本量/分布/异常/相关
2. 选图        按数据形态+论证目标决策（下方速查表）；给出推荐+理由+1-2 备选
3. 查规范      确定目标期刊 → 查下方期刊规格表（Nature/IEEE/中文核心）
4. 查环境      bio_fig_qa(lang) → 中文图先确认 cjk_ready，否则出方框
5. 绘制        bio_python + figurelib.setup_style + 配方（见 bio-proto-pub-figure）
6. 自检        figurelib.visual_qa.audit_layout(fig) 程序自检（缺字/裁切/刻度重叠）
7. 导出        figurelib.export_figure.export_figure(...) 按最终尺寸多格式导出
8. 审计        bio_fig_export(paths, min_dpi, width_in, height_in) 机器审计 → 回改
```

## 选图决策速查表

| 数据形态 | 推荐首选 | 不该用 |
|---|---|---|
| 1 个连续变量看分布 | 直方图 + KDE / 箱线 | 饼图 |
| 1 个分类变量看占比 | 横向柱状（按值排序） | 饼图、3D 饼 |
| 1 分类 + 1 连续，每组 n<10 | **stripplot / 点图（直接列点）** | 均值柱（**严禁**） |
| 1 分类 + 1 连续，每组 n≥10 | 箱线/小提琴 + stripplot 叠加 | 仅均值柱 |
| 2 连续看关系 | 散点 + 回归 + r 值 | 折线（除非 x 有序连续） |
| 时间/剂量 vs 连续 | 折线 + 误差带 | 柱状 |
| >3 列多变量相关 | 相关性热力图 / pairplot | 平行坐标 |
| 矩阵数据 | 热力图（viridis/RdBu_r） | 3D 表面、rainbow |
| 构成占比 | 堆叠柱 / treemap | 饼图 |
| 多组多面板（如 PCA+火山+热图） | 2×2 subplots + a/b/c 标签 | 一图塞 5 个论点 |

**同一批数据、不同论点 → 不同图**。例如药物 A/B 响应：论证"A 更有效"→ 均值+误差棒柱状；论证"个体差异大"→ 箱线+散点；论证"剂量关系"→ 折线。先问清论证目标再选图。

**维度过多就拆图**：分组组合 > 12 时建议按某维拆多面板，不硬塞。

## 18 条画图陷阱（主动拦截，不默默照做）

| # | 陷阱 | 替代方案 |
|---|---|---|
| P1 | n<10/组 画均值柱掩盖分布 | 箱线 + stripplot；或直接 stripplot |
| P2 | 双 Y 轴显示无关变量 | 拆上下子图共享 x；或标准化共轴 |
| P3 | 用饼图展示占比 | 横向柱状（按值排序） |
| P4 | 3D 柱 / 3D 饼 | 2D 柱、热力图 |
| P5 | 比例图 Y 轴不从 0 起 | 从 0 起或用 log；或加明显断裂标记 |
| P6 | 颜色映射连续值无 colorbar | 必加 colorbar + 标 label/单位 |
| P7 | x 是分类却用折线连均值 | 散点 / 点图 / 柱状 |
| P8 | 一图塞 5 个论点 | 拆图，一张图一个核心结论 |
| P9 | rainbow / jet 色图（感知不均匀、造假峰） | viridis / magma / RdBu_r |
| P10 | 误差棒不交代类型与 n | 图注写清 SD/SEM/95%CI + n + 检验方法 |
| P11 | 显著性标注无统计支撑 | 先跑检验（bio-proto-statistics），再画显著性桥 |
| P12 | 色盲不可分（红绿对比） | colorblind 调色板 + 冗余编码（线型/marker） |
| P13 | 文字字号 < 6pt（按最终尺寸打印不可读） | 正文 7-9pt，最小 ≥ 6pt |
| P14 | 表达热图用 jet | viridis / RdBu_r（表达数据尤其重要） |
| P15 | 相关性系数不写显著性 | 标 r 值和 p 值 |
| P16 | 中文/负号变方框 | setup_style(lang='zh') 配 CJK + unicode_minus=False |
| P17 | 矢量图字体未嵌入（Type 3 被拒收） | rcParams pdf.fonttype=42（export_figure 已强制） |
| P18 | 子图 a/b/c 手摆 ax.text 错位 | figurelib.layout_tools.add_panel_labels() 统一对齐 |

拦截话术示例：*"3 组各 5 个样本的均值柱状图会触发 P1：n=5 太小，柱状会让审稿人怀疑你藏了什么。建议改箱线 + stripplot 叠加每个点，5 个点直接可见。要按原方案画吗？"* 尊重用户最终决定，但留下劝阻记录。

## 五条硬性原则

1. **按最终尺寸出图，不二次缩放**：`figsize` 直接设论文实际尺寸（Nature 单栏 3.5in、双栏 7.2in；IEEE 单栏 3.5in、双栏 7.16in）。导出后绝不在 Word/LaTeX 里再缩放（matplotlib 字号是绝对单位 pt，缩放 50% 后 9pt 变 4.5pt，直接退稿）。
2. **矢量优先**：折线/柱状/散点/热图 → PDF/SVG/EPS；显微图/照片才用 PNG/TIFF（300-600 DPI）；**数据图绝不用 JPEG**。
3. **色盲友好**：`seaborn.color_palette('colorblind')` 或 Okabe-Ito + 冗余编码（线型/marker）；导出灰度预览检查可区分性。
4. **字号在最终尺寸下可读**：正文标签和刻度 7-9pt，最小 ≥ 6pt。
5. **误差必有交代**：误差棒/阴影/箱线 → 图注写清误差类型（SD/SEM/95%CI/IQR）+ 样本量 n + 检验方法 + 校正（如 Bonferroni）+ 符号定义（`* p<0.05`）。SD 和 SEM 差一个 √n，混淆 = 结论反转。

## 期刊规格速查

| 期刊 | 单栏宽 | 双栏宽 | 字号 | DPI | 矢量偏好 |
|---|---|---|---|---|---|
| Nature | 3.5 in (89mm) | 7.2 in (183mm) | 7-8pt | 300 | PDF（字体嵌入） |
| Science | 3.5 in | 7.2 in | 7-8pt | 300 | PDF |
| IEEE | 3.5 in | 7.16 in | 8pt | 600 | EPS/PDF |
| Elsevier | 90mm | 190mm | 7-10pt | 300-600 | PDF/TIFF |
| PNAS | 3.5 in | 7.2 in | 7-8pt | 300-600 | PDF |
| 中文核心 | 按期刊要求 | — | 宋体正文+Times 数字 | 300+ | PDF/TIFF |

`figurelib.setup_style(journal=..., lang=...)` 已内置对应预设（nature/science/ieee/general × zh/en）。

## 中文支持

- 中文出方框根因：默认字体（DejaVu 等）不含 CJK 字符表。
- `setup_style(lang='zh')` 自动按优先级查找 `Noto Sans CJK SC > Source Han Sans SC > SimHei > Microsoft YaHei` 并修负号方框（`axes.unicode_minus=False`）。
- 找不到任何 CJK 字体时抛清晰错误——**画中文图前先用 `bio_fig_qa` 探测 `cjk_ready`**，false 就改用英文标签或提示用户装 Noto CJK。
- 中文期刊"宋体正文 + Times New Roman 数字"混排：`setup_style(lang='zh', serif_for_zh=True)`。

## 工具映射

| 步骤 | 工具/接口 |
|---|---|
| 剖析数据 → 图型建议 | `bio_fig_profile` |
| 字体/预设环境探测 | `bio_fig_qa` |
| 绘制/自检/导出 | `bio_python` + `figurelib.*`（见 bio-proto-pub-figure） |
| 投稿前文件审计 | `bio_fig_export` |

**AI 读图复核说明**：scipilot 的视觉自检有"AI 读图"一环（渲 PNG 后多模态读图核对图例压数据/子图对齐）。dsh-bio-genie 插件本身无多模态能力——机器自检（audit_layout + bio_fig_export）全保留；若 dsh 会话的模型支持读图，可将 preview PNG 交给模型复核，否则以程序自检 + 清单核对为准。
