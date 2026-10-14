#!/usr/bin/env python
"""validate_design_fixtures.py — 小型设计 fixtures 登记表 SHA 核对（G-LOOP-20261015-FX-001）

对 test/fixtures/design/ 下每个文件：
  1. 目录清点：必须恰好为登记的 6 个文件（缺文件 → FAIL；多余文件 → FAIL）
  2. README.md 登记表比对：每行 `| <文件名> | ... | <64hex> | ... |` 提取实测登记 SHA，
     与本文件实测 SHA256（hashlib 流式）比对 → 不符 = HASH_MISMATCH（FAIL）
  3. SHA256SUMS-fixture.txt 清单比对：清单引用文件必须存在、属于登记集合、
     实测哈希 == 清单值；清单不得引用未登记文件（SUMS 反向核对）
  4. 源目录对照（可选）：默认探测外置源目录 `D:\\Program\\dsh-plug-develop\\
     genie-synbio-design-20261012\\fixtures`（可用 --source 覆盖，--no-source 关闭）；
     可达时逐文件比对 SHA256（6/6 字节一致）；不可达 → SKIP 告警（不影响仓库内结论）

fail-closed：任一失败 → 输出 FAIL 明细并非零退出（exit 1）；全部通过 → PASS（exit 0）。
独立可复跑：路径均以本脚本位置推导（与 cwd 无关）。

用法：
  python scripts/validate_design_fixtures.py
  python scripts/validate_design_fixtures.py --source <dir>
  python scripts/validate_design_fixtures.py --no-source
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
FIXTURE_DIR = os.path.join(REPO_ROOT, "test", "fixtures", "design")
README_PATH = os.path.join(FIXTURE_DIR, "README.md")
KNOWN_SOURCE = r"D:\Program\dsh-plug-develop\genie-synbio-design-20261012\fixtures"

EXPECTED_FILES = [
    "fixture_circular.fna",
    "fixture_features.tsv",
    "fixture_candidates.tsv",
    "fixture_expected_vectors.json",
    "make_circular_fixture.py",
    "SHA256SUMS-fixture.txt",
]
# 登记表本体：必须存在且可解析（结构性校验），自身不做哈希自校验（避免自引用）。
REGISTRY_FILE = "README.md"
REQUIRED_MEMBERS = EXPECTED_FILES + [REGISTRY_FILE]
# 清单（SHA256SUMS-fixture.txt）只覆盖 4 个数据文件；生成器与清单自身为 README-only 登记。
MANIFEST_COVERED = {
    "fixture_circular.fna",
    "fixture_features.tsv",
    "fixture_candidates.tsv",
    "fixture_expected_vectors.json",
}

SHA_RE = re.compile(r"[0-9a-fA-F]{64}")
SUMS_LINE_RE = re.compile(r"^([0-9a-fA-F]{64})\s+\*?(.+?)\s*$")
README_ROW_RE = re.compile(r"^\|\s*`?([A-Za-z0-9][A-Za-z0-9._\-]*)`?\s*\|")


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def parse_readme_registry(readme_path):
    """解析 README 登记表：{name: sha256}；行内 64-hex 记号必须恰好 1 个。"""
    registry = {}
    with open(readme_path, encoding="utf-8") as f:
        for line in f:
            m = README_ROW_RE.match(line)
            if not m:
                continue
            name = m.group(1)
            shas = SHA_RE.findall(line)
            if len(shas) != 1:
                raise ValueError(
                    "README row for %r has %d sha tokens (expected exactly 1)" % (name, len(shas))
                )
            registry[name] = shas[0].lower()
    return registry


def parse_sums(sums_path):
    """解析 SHA256SUMS-fixture.txt：{name: sha256}。"""
    sums = {}
    with open(sums_path, encoding="utf-8") as f:
        for lineno, line in enumerate(f, 1):
            line = line.strip()
            if not line:
                continue
            m = SUMS_LINE_RE.match(line)
            if not m:
                raise ValueError("malformed SUMS line %d: %r" % (lineno, line))
            sums[m.group(2)] = m.group(1).lower()
    return sums


def main():
    ap = argparse.ArgumentParser(description="validate test/fixtures/design fixture hashes")
    ap.add_argument("--source", default=os.environ.get("GENIE_FIXTURE_SOURCE", KNOWN_SOURCE),
                    help="external fixture source dir for cross-check (default: known path)")
    ap.add_argument("--no-source", action="store_true",
                    help="skip external source cross-check entirely")
    args = ap.parse_args()

    problems = []
    notes = []

    # ---- 0. 目录清点 ----
    if not os.path.isdir(FIXTURE_DIR):
        print("FAIL  fixture dir missing: %s" % FIXTURE_DIR)
        return 1
    present = set(os.listdir(FIXTURE_DIR))
    missing = [n for n in REQUIRED_MEMBERS if n not in present]
    extra = sorted(present - set(REQUIRED_MEMBERS))
    for n in missing:
        problems.append("MISSING_FILE %s" % n)
    for n in extra:
        problems.append("UNREGISTERED_FILE %s" % n)
    print("inventory: %d required, %d present, %d missing, %d extra"
          % (len(REQUIRED_MEMBERS), len(present), len(missing), len(extra)))

    # ---- 1. README 登记表 ----
    try:
        registry = parse_readme_registry(README_PATH)
    except (OSError, ValueError) as e:
        print("FAIL  README registry unreadable: %s" % e)
        return 1
    missing_reg = [n for n in EXPECTED_FILES if n not in registry]
    extra_reg = sorted(set(registry) - set(EXPECTED_FILES))
    for n in missing_reg:
        problems.append("README_NO_ROW %s" % n)
    for n in extra_reg:
        problems.append("README_EXTRA_ROW %s" % n)
    notes.append("README registry: %d rows for %d expected files"
                 % (len(registry), len(EXPECTED_FILES)))

    # ---- 2. SUMS 清单 ----
    try:
        sums = parse_sums(os.path.join(FIXTURE_DIR, "SHA256SUMS-fixture.txt"))
    except (OSError, ValueError) as e:
        print("FAIL  SUMS unreadable: %s" % e)
        return 1
    sums_surprise = sorted(set(sums) - set(EXPECTED_FILES))
    sums_missing = sorted(set(EXPECTED_FILES) & MANIFEST_COVERED - set(sums))
    for n in sums_surprise:
        problems.append("SUMS_UNREGISTERED %s" % n)
    for n in sums_missing:
        problems.append("SUMS_MISSING_ENTRY %s" % n)
    notes.append("SUMS entries: %d (expected %d covered files)"
                 % (len(sums), len(MANIFEST_COVERED)))

    # ---- 3. 实测哈希比对 ----
    for name in EXPECTED_FILES:
        path = os.path.join(FIXTURE_DIR, name)
        if name not in present:
            continue  # 已报 MISSING_FILE
        actual = sha256_file(path)
        row_ok = (registry.get(name) == actual)
        sums_ok = None
        if name in MANIFEST_COVERED:
            sums_ok = (sums.get(name) == actual)
            if not sums_ok:
                problems.append("SUMS_HASH_MISMATCH %s (sums=%s actual=%s)"
                                % (name, sums.get(name), actual))
        if not row_ok:
            problems.append("README_HASH_MISMATCH %s (readme=%s actual=%s)"
                            % (name, registry.get(name), actual))
        print("file   %-32s readme:%s sums:%s sha=%s"
              % (name, "OK" if row_ok else "FAIL",
                 "OK" if sums_ok else ("n/a" if sums_ok is None else "FAIL"),
                 actual))

    # ---- 4. 源目录对照 ----
    if args.no_source:
        notes.append("source cross-check: disabled by --no-source")
    elif not os.path.isdir(args.source):
        print("WARN   source dir not found: %s — cross-check SKIPPED (repo-internal checks still authoritative)"
              % args.source)
        notes.append("source cross-check: SKIP (dir unreachable)")
    else:
        src_mismatch = []
        for name in EXPECTED_FILES:
            sp = os.path.join(args.source, name)
            if not os.path.isfile(sp):
                src_mismatch.append(name + ":missing-in-source")
                continue
            if sha256_file(sp) != sha256_file(os.path.join(FIXTURE_DIR, name)):
                src_mismatch.append(name + ":sha-mismatch")
        if src_mismatch:
            problems.append("SOURCE_MISMATCH %s" % ";".join(src_mismatch))
            print("source cross-check: FAIL (%s)" % ";".join(src_mismatch))
        else:
            print("source cross-check: 6/6 字节一致 (dir=%s)" % args.source)
            notes.append("source cross-check: 6/6 OK")

    for n in notes:
        print("note   %s" % n)
    if problems:
        for p in problems:
            print("FAIL   %s" % p)
        print("RESULT: FAIL")
        return 1
    print("RESULT: PASS")
    return 0


if __name__ == "__main__":
    sys.exit(main())
