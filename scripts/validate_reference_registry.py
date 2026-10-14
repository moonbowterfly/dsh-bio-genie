#!/usr/bin/env python
"""validate_reference_registry.py — reference bundle 登记表 SHA 核对（G-LOOP-20261015-RR-001）

对 design/reference-bundle/REFERENCE-REGISTRY.md §1 登记表内每个文件：
  1. 存在性：缺文件 → DEPENDENCY_UNAVAILABLE（FAIL，非零退出）
  2. SHA256 实测（hashlib 流式）与登记表列值比对 → 不符 = HASH_MISMATCH（FAIL）
  3. 三方一致：凡被 SHA256SUMS-*.txt 覆盖的文件，实测 == 登记表 == SUMS 值
  4. SUMS 反向核对：SUMS 引用的文件必须存在、已登记、且实测哈希一致

fail-closed：任一失败 → 输出 FAIL 明细并非零退出；全部通过 → PASS（exit 0）。
独立可复跑：--reference-dir 缺省自动探测（env GENIE_REFERENCE_DIR → 已知外置路径
→ 仓库内 reference/ 镜像）；--registry 缺省指向
design/reference-bundle/REFERENCE-REGISTRY.md（本脚本仓库内配套路径，与 cwd 无关）。

用法：
  python scripts/validate_reference_registry.py
  python scripts/validate_reference_registry.py --reference-dir <path> [--registry <path>]
"""
import argparse
import hashlib
import os
import re
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
sys.dont_write_bytecode = True

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEFAULT_REGISTRY = os.path.join(REPO_ROOT, "design", "reference-bundle",
                                "REFERENCE-REGISTRY.md")
KNOWN_EXTERNAL = r"D:\Program\dsh-plug-develop\genie-synbio-design-20261012\reference"

NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._\-]*$")
SHA_RE = re.compile(r"^[0-9a-fA-F]{64}$")
SUMS_LINE_RE = re.compile(r"^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$")


def detect_reference_dir():
    """缺省探测顺序：env GENIE_REFERENCE_DIR → 已知外置路径 → 仓库内 reference/ 镜像。"""
    cands = []
    env = os.environ.get("GENIE_REFERENCE_DIR")
    if env:
        cands.append(env)
    cands.append(KNOWN_EXTERNAL)
    cands.append(os.path.join(REPO_ROOT, "reference"))
    for c in cands:
        if c and os.path.isdir(c):
            return c
    return None


def sha256_file(path, chunk=1 << 20):
    h = hashlib.sha256()
    with open(path, "rb") as fh:
        while True:
            block = fh.read(chunk)
            if not block:
                break
            h.update(block)
    return h.hexdigest()


def parse_registry(path):
    """解析登记表 §1 主表 → [(name, sha_lower), ...]；格式错误抛 ValueError。"""
    rows = []
    in_main = False
    with open(path, encoding="utf-8-sig") as fh:
        for raw in fh:
            line = raw.rstrip("\r\n")
            if line.startswith("## "):
                if in_main:
                    break
                if "资产登记表" in line:
                    in_main = True
                continue
            if not in_main or not line.startswith("|"):
                continue
            cells = [c.strip() for c in line.strip("|").split("|")]
            if not cells or cells[0] == "文件名":
                continue  # 表头
            if not cells[0] or set(cells[0]) <= set("-: "):
                continue  # 分隔行
            if len(cells) < 5 or not NAME_RE.match(cells[0]):
                continue  # 非数据行
            sha = cells[4]
            if not SHA_RE.match(sha):
                raise ValueError("登记表 §1 数据行格式错误: name=%r sha=%r" % (cells[0], sha))
            rows.append((cells[0], sha.lower()))
    if not rows:
        raise ValueError("登记表未解析到任何数据行（§1 资产登记表）")
    return rows


def parse_sums_files(refdir):
    """解析目录内 SHA256SUMS-*.txt → ({name: sha_lower}, [sums 文件名, ...])。"""
    mapping = {}
    files = []
    for fn in sorted(os.listdir(refdir)):
        if fn.startswith("SHA256SUMS-") and fn.endswith(".txt"):
            files.append(fn)
            with open(os.path.join(refdir, fn), encoding="utf-8-sig") as fh:
                for raw in fh:
                    m = SUMS_LINE_RE.match(raw.strip())
                    if not m:
                        raise ValueError("SUMS 文件格式错误: %s 行 %r" % (fn, raw.strip()[:80]))
                    mapping[m.group(2).strip()] = m.group(1).lower()
    return mapping, files


def main():
    ap = argparse.ArgumentParser(
        description="reference bundle 登记表 SHA 核对（G-LOOP-20261015-RR-001）")
    ap.add_argument("--reference-dir", default=None,
                    help="reference 资产目录（缺省自动探测）")
    ap.add_argument("--registry", default=DEFAULT_REGISTRY, help="登记表路径")
    args = ap.parse_args()

    refdir = args.reference_dir if args.reference_dir else detect_reference_dir()
    errors = []

    print("registry   : %s" % args.registry)
    print("ref dir    : %s" % (refdir or "<未探测到>"))

    if refdir is None or not os.path.isdir(refdir):
        print("FAIL")
        print("DEPENDENCY_UNAVAILABLE: reference 目录不存在（可 --reference-dir 显式指定）")
        return 1
    if not os.path.isfile(args.registry):
        print("FAIL")
        print("DEPENDENCY_UNAVAILABLE: 登记表不存在: %s" % args.registry)
        return 1

    try:
        rows = parse_registry(args.registry)
        sums, sums_files = parse_sums_files(refdir)
    except ValueError as exc:
        print("FAIL")
        print("registry parse error: %s" % exc)
        return 1

    print("sums files : %s" % (", ".join(sums_files) if sums_files else "<无>"))
    print("registered : %d 文件" % len(rows))

    # ── 1) 逐行核对（登记表行即权威清单）──────────────────────────────
    for name, reg_sha in rows:
        path = os.path.join(refdir, name)
        if not os.path.isfile(path):
            print("FAIL  %-38s DEPENDENCY_UNAVAILABLE: 缺文件" % name)
            errors.append(name)
            continue
        meas = sha256_file(path)
        sums_sha = sums.get(name)
        problems = []
        if meas != reg_sha:
            problems.append("登记表不符 (measured=%s registered=%s)" % (meas, reg_sha))
        if sums_sha is not None and meas != sums_sha:
            problems.append("SUMS 不符 (measured=%s sums=%s)" % (meas, sums_sha))
        if problems:
            print("FAIL  %-38s %s" % (name, "; ".join(problems)))
            errors.append(name)
        else:
            extra = "三方一致(实测=登记=SUMS)" if sums_sha is not None else "登记值=实测(清单/台账类, 无 SUMS 覆盖)"
            print("PASS  %-38s %s  %s" % (name, meas[:16] + "…", extra))

    # ── 2) SUMS 反向核对（SUMS 引用必须存在、已登记、哈希一致）────────
    for name, sums_sha in sorted(sums.items()):
        if name not in dict(rows):
            print("FAIL  SUMS 引用未登记文件: %s" % name)
            errors.append(name)
            continue
        path = os.path.join(refdir, name)
        if not os.path.isfile(path):
            print("FAIL  SUMS 引用缺文件: %s" % name)
            errors.append(name)
            continue
        if sha256_file(path) != sums_sha:
            print("FAIL  SUMS 与实测不符: %s" % name)
            errors.append(name)

    print("RESULT: %s" % ("PASS" if not errors else "FAIL"))
    if errors:
        print("failures: %d" % len(errors))
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
