---
language: python
---

# 出版级绘图专题

> 插件定位：**可视化顾问**（先思考后绘制），不是画图机器人。决策层 skill `bio-figure` + 执行层协议 `bio-proto-pub-figure` + 三个 fig 工具 + `figurelib` 库。

## 1. 三工具分工（记牢）

| 工具 | 职责 | 时机 |
|---|---|---|
| `bio_fig_qa` | 环境预检：CJK 字体、期刊预设 | **画图前**（中文图必查 cjk_ready） |
| `bio_fig_profile` | 数据剖析 + 图型建议 + 风险警告 | **选图前**（永远先跑，再决定画什么） |
| `bio_fig_export` | 图文件合规审计（DPI/格式/尺寸/字体） | **导出后**（FAIL 回改重导） |

画图本身在 `bio_python` 里完成（figurelib 可 import）。Figure 对象不能跨工具传递——自检/导出都在同一段代码里做完。

## 2. 标准闭环（8 步，顺序不可跳）

```
0. 问清论证目标（这张图要说服读者什么？）——用户没说清就主动问
1. bio_fig_profile → 列类型/样本量/分布/异常/相关 + suggestions
2. 选图：按数据形态+论证目标查 bio-figure 决策表，给推荐+理由+备选
3. 查期刊规格（bio-figure 内的期刊表：Nature 单栏 3.5in/7-8pt/300dpi…）
4. bio_fig_qa → 中文图确认 cjk_ready，false 就改英文标签
5. bio_python 绘制（配方见 bio-proto-pub-figure）
6. audit_layout(fig) 程序自检（缺字/裁切/刻度重叠）
7. export_figure(...) 按最终尺寸导出 PDF/SVG/PNG + 灰度预览
8. bio_fig_export 审计 → FAIL 回改 → 直到 PASS
```

## 3. figurelib API 速查

```python
from figurelib.setup_style import setup_style       # setup_style(journal='nature', lang='zh', serif_for_zh=False)
from figurelib.profile_data import profile_data     # profile_data('data.csv', group_cols=['group'])
from figurelib.export_figure import export_figure   # export_figure(fig, 'figs/fig1', formats=['pdf','svg','png'], size_inches=(3.5,2.625), dpi=300, grayscale_preview=True)
from figurelib.check_figure import check_figure     # check_figure('fig1.pdf', min_dpi=300, target_inches=(3.5,2.625))
from figurelib.layout_tools import finalize_figure, add_panel_labels  # finalize_figure(fig); add_panel_labels(fig, style='nature'|'ieee')
from figurelib.visual_qa import audit_layout, render_preview         # audit_layout(fig) → [(severity, msg), ...]
```

## 4. 中文图（方框问题的根治）

- 根因：默认字体无 CJK 字符表。**画前 `bio_fig_qa` 探测**。
- `setup_style(lang='zh')` 自动按优先级找 `Noto Sans CJK SC > Source Han Sans SC > SimHei > Microsoft YaHei`，并修负号方框（`axes.unicode_minus=False`）。
- cjk_ready=false 时：**改用英文标签**，或提示用户安装 Noto Sans CJK（给下载链接）。
- 中文期刊混排约定（宋体正文 + Times 数字）：`setup_style(lang='zh', serif_for_zh=True)`。

## 5. 主动拦截（顾问职责：不默默照做）

用户要求触发以下错误时，先说明再给替代方案，用户坚持才照做（留下劝阻记录）：

| 用户要求 | 问题 | 替代方案 |
|---|---|---|
| n<10/组 均值柱状图 | 掩盖分布，审稿人怀疑 | 箱线/小提琴 + stripplot 叠加每个点 |
| 双 Y 轴 | 捏造视觉相关性 | 拆上下子图共享 x |
| 饼图展示占比 | 人眼判角度差 3 倍 | 横向柱状（按值排序） |
| rainbow/jet 热图 | 感知不均匀、造假峰 | viridis / RdBu_r |
| 一图塞多个结论 | 没论点 | 拆图，一图一结论 |

完整 18 条陷阱见 bio-figure skill。

## 6. 五条硬性原则

1. **按最终尺寸出图**：figsize 直接设论文实际尺寸（Nature 单栏 3.5in），导出后禁止在 Word/LaTeX 缩放（字号是绝对 pt）。
2. **矢量优先**：线/柱/散点/热图 → PDF/SVG/EPS；显微图才用 PNG/TIFF(300-600dpi)；**数据图绝不用 JPEG**。
3. **色盲友好**：colorblind 调色板 + 冗余编码（线型/marker）+ 灰度预览检查。
4. **字号**：正文 7-9pt，最小 ≥6pt（按最终尺寸）。
5. **误差必有交代**：图注写误差类型（SD/SEM/95%CI）+ n + 检验方法 + 校正。

## 7. AI 读图复核（能力边界）

scipilot 原版有"渲 PNG → 多模态读图核对"环节。dsh 插件本身**无多模态能力**：
- 机器自检全保留（audit_layout + bio_fig_export）。
- 若当前 dsh 会话的模型支持读图：把 `export_figure` 的 PNG 预览交给模型复核（图例压数据/子图对齐/灰度可分），发现问题回改重渲。
- 不支持读图就依赖程序自检 + 清单核对，并在结论中说明此局限。

## 8. 高频坑

- 显著性标注必须先跑统计检验（bio-proto-statistics），图注写校正方法。
- 表达热图别用 jet（P14）。
- 子图 a/b/c 用 `add_panel_labels`，别手摆 `ax.text`（会错位）。
- 导出前 `finalize_figure(fig)` 兜底版面；`audit_layout` 只对 Figure 对象有效（落盘文件只能走 bio_fig_export）。
- bio_fig_export 的 PDF 审计需要 pypdf（不在环境）→ 字体嵌入检查会降级为 INFO 提示，这不是失败；PNG 审计（DPI/尺寸）是完整能力。
