# contract packet 工作区 — dsh-bio-genie 合成生物设计功能（v1.0-arch → v1.0-实现升级材料）

**状态**: **rev3 修复轮完成（v0.13 实施）**。历史链：构建四增量 → 审阅轮 1 判定「否——5×P0」→ rev2（v0.12 K1–K5）→ 复验轮 2 判定「否——4×P0（残余）」→ **本目录 = rev3**：①生成链修复（`schema_helpers` ← `pattern-library.json`；链闭环 = make_meta→make_schemas→make_manifest→make_index→lint→双端编译，**字节稳定复现**）；②两-keyword 契约全面归一（probe T8/T9 改写为「数据文档永不编译」验证、L10/length_accounting/validator-init evidence 同步）；③K3 执行化修正（**domain-先行 + Unicode 标量计数 + 双端精确 stable code 断言与比对**；schema 语料 99、样例 40）；④c14n loader 门（先验 manifest/hash，`REGISTRY_UNRESOLVED` fail-closed；verified ranges 注入双端）；⑤只读回放（`sys.dont_write_bytecode` + 子进程环境自固定 + `check_readonly_replay.py` 树级零变验证）与 Windows 自足台架。**rev3 终态**：`packet_lint` PASS；台架 **25 杀全灭 + 生成链闭环 + 三项基线绿**；只读回放 PASS（含缓存 bit-identical）；编译 23/23 ×2；c14n 语料 58/58；schema 语料 99/99（含 😀 序反例）；样例 40/40（双端精确码）；manifest `fef3b113…`。**复验轮 3 判定「否——仅列 2 项残余」（P0-1/P0-3 已闭合）→ rev4 修复（2026-10-14）**：①c14n 双端 `--batch` CLI 自跑等价 verified loader（路径回退移除；R5b/R5c 直接 CLI 篡改负测被杀死）；②净环境回放自足（18 个 py 入口 UTF-8 pin + replay 剥离四变量 + `run_schema_corpus.mjs` stderr self-cert）。**rev4 终态**：lint PASS；台架 **27 杀全灭 + 链闭环 + 5 基线绿**；编译 23/23×2；c14n 58/58；schema 99/99；样例 40/40；**净环境 READONLY_REPLAY: PASS**（tree bit-identical）。**待做**：镜像重入链 → 复验轮 4 提交。
**归属**: req_id H-20261012-002；案例 `D:\Program\dsh-plug-develop\genie-synbio-design-20261012\`；规格基线 = 版本链 v0.1→v0.12（含 §K7 实施补记）。

## packet 组成（当前布局）
```
packet/
  README.md                 本文件（charter）
  bundle.manifest.json      bundle 索引（27 文件：schemas 23 + meta 4；自身 hash 进 packet 台账）
  schemas/                  23 个 JSON Schema（draft-07；$id = bundle://schemas/<file>.json）
  meta/                     common.defs.json（纯 Schema 共享 $defs）＋ x-canonical.meta.json ＋
                            pattern-library.json（独立非 Schema 数据资源）＋ unicode-domain-table.json（冻结域表）
  impl/                     c14n 双端参考实现（含 §1a 冻结域闸门；ranges 可经 loader 注入）
  corpus/                   synbio-c14n-corpus@1（58 例；make_cases.py / c14n_cases.json / run_corpus.py）
  schema-corpus/            synbio-schema-corpus@1（99 例；make_schema_cases.py / schema_cases.json / run_schema_corpus.py|mjs）
  build/                    生成器与检查器（make_meta / make_schemas + schemas_a|b|c / make_manifest / make_index /
                            bundle_loader.py|mjs / packet_lint.py / lint_mutation_check.py / verify_mirror.py /
                            check_readonly_replay.py / check_compile.py|mjs / schema_helpers / make_unicode_table）
  evidence/                 探针与冒烟证据（decimal 38 例 / pattern 样例 40 例 / ajv 探针 v3 / jsonschema 探针 / meta 冒烟 / conformance 环境记录）
  validator-init.json       双端验证器初始化契约（packet 级文档；keyword 注册恰两个）
  BINDINGS.json             packet 绑定（active profile / spec 链 / pattern library / 锁与语料哈希）
  locks/                    依赖闭包（node 5 包 / python 6 包，含哈希与复现说明）
  HASHES                    全量工作台账（78 条；make_index.py 生成）
```

## 与规格的对应（packet 硬契约）
- v0.8 §G1（packet 五条：$id / registry / keywords / pattern / decimal-string）
- v0.9 §H1–H3（$ref 形式 / decimal 真值表 / pattern 白名单）
- v0.10 §I1–I3（全串扫描执行器 / library 形态 / packet 绑定）
- v0.11 §J1–J3（成员映射 / annotation 定位 / 步骤 2 total）
- v0.12 §K1–K6 + **§K7（rev3 实施补记：链闭环 / 精确码 / length_accounting 等价条件 / 只读回放）**
- casefile-c14n@1 profile rev2026-10-13b（sha 见 SHA256SUMS-contracts.txt）

## 审阅门首检项（复核 11 的 P0a 清单 + 轮 1/2 增补）
1. J1 三类例：重复 pattern literal / 元数据绑定 / 未命中拒绝码 —— 由可执行 `packet_lint`（L3/L4/L10/L13）+ 负测 S4/S5/S8/S13 落地；
2. J3 三例（"-" / "--" / "-."）—— 已在 decimal 探针双端必跑集；
3. v0.9 §H2 旁 J1 交叉引用 —— 见 meta/x-canonical.meta.json patterns_registry；
4. 复验轮 2 四项残余（链断裂 / loader 旁路 / 码分叉 / 只读与自足）—— rev3 逐项修复并各自带负测（见 FIXLOG-rev3）。
```
