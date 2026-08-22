---
language: python
---

# DNA/质粒设计工具

> PCR 引物设计、密码子优化、DNA 组装、质粒图谱。

## 工具速查

| 工具 | 用途 | 关键参数 |
|------|------|----------|
| `bio_primer_design` | PCR 引物 | sequence★, product_size, tm_target |
| `bio_seq_optimize` | 密码子优化 | sequence★, organism |
| `bio_assembly_design` | 组装策略 | fragments★, method |
| `bio_plasmid_map` | 质粒图谱 | name, features★ |

## 典型工作流

### 1. 基因克隆全流程
```
bio_seq_optimize(sequence="ATGCGT...", organism="ecoli")   # 1. 密码子优化
bio_primer_design(sequence="优化后序列", product_size=1200)  # 2. 设计引物
bio_assembly_design(fragments=[frag1, frag2], method="gibson")  # 3. 设计组装
bio_plasmid_map(name="pET28a", features=[...])            # 4. 绘制图谱
```

### 2. 密码子优化 + 验证
```
bio_seq_optimize(sequence="ATGCGTAAAGAT...", organism="ecoli")
→ 优化序列 + 变更率 + GC%
→ 用 bio_seq_analyze 验证 GC 含量合理
```

### 3. 多片段 Gibson 组装
```
bio_assembly_design(fragments=[vector, insert1, insert2], method="auto")
→ 推荐方法 + 15-40bp 重叠序列 + 实验协议
```

## 组装方法选择

| 方法 | 片段数 | 总长度 | 特点 |
|------|--------|--------|------|
| Gibson Assembly | 2-6 | <15kb | 最简单，一步完成 |
| Golden Gate | >6 | 不限 | 可同时组装 >10 个片段 |
| 限制酶克隆 | 2-3 | 不限 | 需手动选酶，定向性好 |
| 自动推荐 | method="auto" | — | 根据片段数/长度自动选择 |

## 密码子优化宿主

| 宿主 | organism | 特点 |
|------|----------|------|
| 大肠杆菌 | ecoli | AT-rich 密码子偏好 |
| 人类 | human | GC-rich 密码子偏好 |
| 酵母 | yeast | 偏好 TTG 起始 |

## 质粒图谱特征类型

| type | 符号 | 示例 |
|------|------|------|
| regulatory | ═══ | 启动子、RBS、终止子 |
| cds | ═══ | 编码序列 |
| origin | ─ ─ ─ | 复制起点 |
| marker | ▓▓▓ | 抗性基因 |
| reporter | ░░░ | GFP、lacZ |

## 注意事项

- 引物设计时 `product_size` 不能超过模板长度
- 密码子优化基于简化表；生产环境建议用 CAI/ECAI 精细优化
- 组装时 `fragments` 列表顺序 = 组装顺序（5'→3'）
- 质粒图谱 `features` 用 JSON 格式传入
- `bio_seq_restriction` 可检查片段内部是否有酶切位点冲突
