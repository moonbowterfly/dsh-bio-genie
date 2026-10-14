# dsh-bio-genie「基因组感知的基因线路设计 + 设计后果推理」V1 设计规格

**v0.12 · 冻结候选（对 packet-review-1 五项阻断的修复 + 正式勘误） ｜ 2026-10-13 ｜ 主笔: Hermes bsp**
**req_id: H-20261012-002 / seq: SPEC-FREEZE-9（随 packet rev2 复验轮提交）**
**基线**: v0.11 + packet 独立审阅报告（`genie-synbio-design-packet-review-1-2026-10-13.md`，sha256 `0c40692f07287fa3a8a56e01f8ca08a3ffaa6e152faafa318be26031af11f8d2`，判定「否——仅列阻断项」P0-1..P0-5）
**性质**: 修复 packet-review-1 全部五项阻断；其余沿版本链 v0.1→v0.11。

---

## K1. [P0-1] pattern library 迁址 —— 消除第三 extension keyword（采纳审阅选项 2）

- 新增 **`meta/pattern-library.json`**：独立、hash-bound、**非 Schema** metadata resource：
  `{"$id": "bundle://meta/pattern-library.json", "patterns": {<name>: {pattern, match_mode, domain, max_len}, ...}}`。
  **不声明 `$schema`；任何 validator 不得编译它、不得为它注册任何 keyword**（结构性消除第三 keyword 需求）。
- `meta/common.defs.json`：**删除根级 `patterns` 键**（纯 Schema：$schema/$id/title/definitions）。其 `definitions` 中 pattern 字面量与 library 逐字节一致（由 lint 强制，见 K3）。
- **J1 指针更新**（勘误）：引用形式改为 `bundle://meta/pattern-library.json#/patterns/<name>/pattern`；「UTF-8 字节逐字节等于且仅等于」、重复字面量 `PATTERN_LIBRARY_AMBIGUOUS`、命中条目元数据为必须执行的约束——均保持不变（执行化见 K3）。
- **inventory 勘误**：meta/ = `x-canonical.meta.json` + `common.defs.json` + `pattern-library.json` + `unicode-domain-table.json`（4 个；F1.2 清单随之更新）。
- `validator-init.json`：keyword 注册**恰好两个**（`x-canonical`、`x-decimal-string`）；不得出现第三注册。L13 校验（见 K3）。
- 说明：不改写"仅两个 extension keyword"的冻结约束本体；被解除方（loader 侧注册）被结构性移除。

## K2. [P0-2] manifest 驱动注册协议（可执行化）

- 新增 **`build/bundle_loader.py`** 与 **`build/bundle_loader.mjs`**（双端同构语义）：
  1. 读取 `bundle.manifest.json`；校验条目形状、路径唯一、**数量=实际清单**；
  2. 逐项校验：文件存在、sha256 相符、$id == `bundle://<manifest-path>`；
  3. 校验**无缺项、无清单外文件**（schemas/ 与 meta/ 目录与清单精确相等）；
  4. **仅按清单精确列表**预注册（Python `referencing.Registry` / Ajv `addSchema`）；**禁止**目录扫描、network/file retrieve、动态 loader。
- **全部** runner（compile、c14n corpus、schema corpus、pattern tests、packet lint）必须经由 loader 取得 bundle；违规 → `REGISTRY_UNRESOLVED` fail-closed。
- 固定负测（4 杀手例进 mutation suite）：缺 `x-canonical.meta.json`、manifest hash 篡改、未登记文件注入、manifest 外 `$ref`。

## K3. [P0-3] pattern 元数据可执行化 + 真 full-match wrapper

- **matcher 语义（双端同构，显式 wrapper，禁裸 search/.test）**：
  - Node：`new RegExp("^(?:" + lit + ")$", "u")`；
  - Python：`re.fullmatch(lit)`；
  - 附 **matcher selftest**（双端必跑）：以**非锚定字面量**证明 wrapper 为全串语义（`("a","xa")->False` 等对抗例）——裸 `.test()`/`re.search` 退化必被杀死。
- **domain / max_len 实际执行**（命中条目元数据）：`domain="ascii"` → 匹配前先拒非 ASCII（稳定码 `PATTERN_DOMAIN_VIOLATION`）；`max_len`（按 Unicode 字符计）超限 → 拒（`PATTERN_MAX_LEN`）。
- **final-packet lint 可执行化**（`build/packet_lint.py`，对最终交付字节运行）：L3 唯一成员映射（无匹配 `PATTERN_NOT_IN_LIBRARY`）、L4 重复字面量、L10 `patterns` 键**仅**允许出现在 pattern-library.json、L13 keyword 注册恰两个、其余 L1–L12 + manifest/索引核验。
- `build/make_schemas.py` 定位澄清：**生成器**（其内部 C1–C8 为生成期断言，不再作为"门"的声明）；权威门 = packet_lint + bundle_loader。
- 负测固定化（进 mutation suite，预登记断言）：duplicate literal、schema 注入 `patterns`、wrapper 退化、domain 违规、max_len 违规。

## K4. [P0-4] Unicode 规范化域闸门（NFC 前；采纳审阅选项 2）

- 新增 **`meta/unicode-domain-table.json`**：**冻结的规范化域** = UCD 15.0 assigned（category != Cn，含私用区）+ 非字符（版本间稳定）；由 CPython 3.12 `unicodedata` 派生；双端共用同一字节表。
- `casefile-c14n@1` 管线（rev 更新）：**在 NFC 之前**新增闸门——任何 scalar 不在冻结表内 → 稳定码 **`UNICODE_OUT_OF_FROZEN_DOMAIN`**，拒绝（fail-closed，不归一、不重试）。
- corpus 增补：审阅方实际反例（`A + U+0315 + U+1ACF` 排序分叉）、表边界样例；mutation：绕过闸门必须被 corpus 杀死。
- profile 文本 rev 更新 + hash 更新（BINDINGS 同步）。
- 说明：选择「冻结表拒绝」而非「双端版本一致化（Node ICU 不可控）」或「域收窄」；代价 = V1 拒绝 UCD 15.0 之后的 scalar（记录为已知边界）。

## K5. [P0-5] canonical root、只读复跑与镜像政策

- **canonical root**：全部 runner 以自身位置推导 packet root 或接受显式 `--packet-root`/`PACKET_ROOT`；无任何机器绝对路径（build 自检）。
- **只读默认**：正常 replay 不写 packet——结果输出仅写显式 `--output-dir` 或系统临时目录；`run_corpus.py` 默认不再写 `corpus/results_node.json`（仅 `--freeze/--write-results` 时写）。
- **自证头**：每个 runner 启动打印 `packet root + manifest sha256 + （存在时）index sha256 + read-only: no packet writes`。
- **镜像政策**：声明改为「**按索引集合逐文件 byte-for-byte 一致**」；`__pycache__`/`*.pyc` 明确排除并如实报告；新增 `build/verify_mirror.py` 执行该验证。
- Node 依赖解析：`createRequire(AJV_WORKSPACE)`（rev2 已实现并实测）；locks/README 命令同步更新。

## K6. 勘误与非阻断项并入（review §"升级前必须排入 P0a / acceptance"）

- README 规范版本标注更正：G=v0.8、H=v0.9、I=v0.10、J=v0.11；"J1 已落地"按 K3 新状态改写。
- `packet_acceptance` 外层记录（模板已在案）：绑定 packet manifest + `SHA256SUMS-packet.txt` + HASHES + BINDINGS + 审阅报告 + review policy + producer + 存储位置 + 撤销/过期；避免自引用；checksum 索引自指向由外层 acceptance chain 承接。
- 所有 normal replay 命令附只读断言（K5）。

## 处置表（packet-review-1 → v0.12）

| # | 审阅发现 | 处置 | 落点 |
|---|---|---|---|
| P0-1 | 第三 Ajv keyword 违反冻结契约 | library 迁址为独立非 Schema resource；注册恰两个（L13） | §K1 |
| P0-2 | registry 协议未由 manifest 驱动 | bundle_loader 双端 + 全 runner 接入 + 4 杀手例 | §K2 |
| P0-3 | J1/I2 未执行；Node 实为裸 .test() | 显式 wrapper + domain/max_len 执行 + lint 可执行化 + 固定负测 | §K3 |
| P0-4 | Unicode 数据版本 NFC 分叉 | 冻结 UCD 15.0 表 + NFC 前闸门 + corpus/mutation | §K4 |
| P0-5 | 复跑根/只读/镜像不成立 | canonical root + 只读默认 + 自证头 + verify_mirror | §K5 |
| N1-N4 | 非阻断项（acceptance/版本标注/只读断言） | 全部并入 | §K6 |

## 冻结候选声明

请判定：**K1–K6 闭合判定 + packet rev2（随附新 packet 全套）复验**；通过后按既定流程物化 hash-bound `packet_acceptance` 并升级 **v1.0-实现基线**。

—— v0.12（冻结候选）完。

---

## K7. rev3 实施补记（2026-10-13；packet-review-rev2 四项残余的修复施行）

1. **生成链闭环（P0-1 解除条件 1）**：`schema_helpers` 改从 `meta/pattern-library.json` 读取；链 = make_meta → make_schemas → make_manifest → make_index → packet_lint → 双端 compile，须在临时副本内**字节稳定复现**（manifest hash 前后一致）；已入台架基线（chain check）。
2. **两-keyword 契约归一（P0-1 解除条件 2/3/4）**：`probe_ajv.mjs` 重写为 v3（T8=数据文档携带 patterns 键**永不编译**、T9=两-keyword 实例编译全 schema 集）；`validator-probe-results.txt` 重生成；L10=`meta/pattern-library.json` 唯一允许；新增最终扫描语义由 `packet_lint` 的 KEYWORD_REGISTRATION_INVALID(L13) + PATTERNS_KEYWORD_OUTSIDE_LIBRARY 承担。
3. **精确 stable code 跨端比对（P0-3 解除条件 3/4）**：schema 语料 runner 比较 `sem` 码列表逐项相等；语料新增 gvr-07/08/09（😀×64、😀×65、ASCII×65）；样例（40 例）改为**逐例断言精确码**（None=收）；新增 R6_js_order / R7_py_order 变异（域/长度序回归须以 sem-code mismatch 报红）。
4. **length_accounting 等价条件（P0-3 解除条件 2 的替代分支）**：domain=ascii 先行后，长度检查只对 ASCII 输入生效（UTF-16 码元 == Unicode 标量）；实现仍显式按标量计数（纵深防御）；该等价条件写入 `meta/x-canonical.meta.json` patterns_registry.length_accounting。
5. **c14n loader 门（P0-2 解除条件 1-3）**：`corpus/run_corpus.py` 在**任何语义计算前**经 `bundle_loader` 校验全 manifest 集，失败即 `REGISTRY_UNRESOLVED`（exit 2）；域表 ranges 以**已验证字节**注入双端（py `set_domain_ranges`；node `--domain-json` 由验证方写临时文件）；表空白篡改负测 R5 已被杀死。
6. **只读回放与 Windows 自足（P0-5 解除条件 1-4）**：全部 Python runner 置 `sys.dont_write_bytecode` + 子进程固定 `PYTHONUTF8/PYTHONIOENCODING/PYTHONDONTWRITEBYTECODE`；台架在未设置任何用户环境变量的 Windows 会话可至 ALL KILLED；`build/check_readonly_replay.py` 证明正常回放后**树级 bit-identical（含缓存）**；各 runner 自证头齐备（root + manifest sha + index sha + read-only）。

---

## K8. rev4 实施补记（2026-10-14；packet-review-rev3 两项残余的修复施行）

1. **c14n 直接 CLI 的 verified-loader 闭环（P0-2 解除条件）**：`impl/c14n.py` 与 `impl/c14n.mjs` 的 `--batch` 入口在 ranges 未注入时**自行运行等价 verified loader**（`build/bundle_loader`，manifest + 全量哈希）；失败打印 `REGISTRY_UNRESOLVED` 并 exit 2。路径上的域表**不再被直接信任**（原路径回退已移除）；协作注入路径（coordinator `set_domain_ranges` / `--domain-json`）不变。R5 增补 R5b/R5c：两个直接 CLI 在 whitespace-tamper 副本上必须 fail-closed（已杀）。
2. **无环境 Windows 回放自足（P0-5 解除条件）**：全部 18 个直接可运行的 Python 入口内建 `sys.stdout/stderr.reconfigure(encoding="utf-8")`（不依赖调用方环境；四个纯 ASCII 生成器同样补 pin 以消歧）；`build/check_readonly_replay.py` 显式从继承环境剔除 `PACKET_ROOT/PYTHONUTF8/PYTHONIOENCODING/PYTHONDONTWRITEBYTECODE`（仅向副本子进程设置 PACKET_ROOT/AJV_WORKSPACE），使「未设置用户环境变量」前提可执行；`schema-corpus/run_schema_corpus.mjs` 在 loader 成功后向 **stderr** 输出 self-cert header（root + manifest sha + index sha + read-only），stdout 保持纯 JSON。
3. **非阻断清理**：`schema_helpers.py` / `make_manifest.py` 说明文本同步；`evidence/probe_ajv.mjs` 依赖入口统一为 `AJV_WORKSPACE`。

终端验收：净环境（清除四变量）`READONLY_REPLAY: PASS`（tree bit-identical incl. caches）；直接 CLI 篡改负测 rc=2 `REGISTRY_UNRESOLVED`。
