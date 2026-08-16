# E2E 回归场景（dev-only，不进发布包）

真实驱动 dsh 3080 实例验证端到端行为。每个脚本对应一轮已验证的场景：

| 脚本 | 验证内容 | 关键证据 |
|------|----------|---------|
| `dsh_e2e_enrichr.py` | bio_enrichr 真实调用（KEGG 富集） | tool/call + 真实 p 值 |
| `dsh_e2e_pubmed.py` | pubmed_search → abstract → ref_genome 组合 | 三工具调用序列 |
| `dsh_e2e_acr_log.py` | ACR 自愈（needs_repair → 修复重试）+ bio_log 回溯 | bio_python×2 + 日志条目 |
| `dsh_e2e_memory.py` | 失败→修复配对沉淀经验 + bio_memory 查询 | error_lessons.json |
| `dsh_e2e_protocol.py` | 协议库命中（决策树映射 → 加载协议 skill） | skill(bio-proto-*) 调用 |

## 运行前提

1. dsh 3080 实例运行中（`启动DSH-Web.cmd`，插件为最新同步版本）
2. `C:\Users\shuai\deepseek-harness\scripts\dsh_bio_client.py` 可用（脚本自动 sys.path 注入）
3. 代理正常（Enrichr/NCBI/Ensembl 走系统代理）

## 运行

```bash
python scripts/e2e/dsh_e2e_enrichr.py
```

每轮 ~2-5 分钟（agent 多轮）。全部跑一遍 = 5 轮完整回归。
