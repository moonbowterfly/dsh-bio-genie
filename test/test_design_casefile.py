# -*- coding: utf-8 -*-
"""B1-part-2 正式工具级 validate / export 的 Python 层测试（req G-LOOP-20261015-B1P2-001）。

真 casefile：经 A1/A2 生产路径（node test/design-casefile-builder.mjs → commitTransaction）
构建真实 case + 不可变快照，再对 python/design_casefile.py 独立 dispatcher 做门禁逐条负例：
manifest 篡改 / 工件篡改 / 红线注入（R1/R2/R3）/ 缺条目 / DAG 环 → FAIL 且进程非零退出。
export：validate 门禁拒绝、report.md 禁含/可含清单自动化断言、bundle.zip 哈希清单独立复核、
确定性、不改科学快照。
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import zipfile

import pytest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILDER = os.path.join(REPO, "test", "design-casefile-builder.mjs")
DISPATCHER = os.path.join(REPO, "python", "design_casefile.py")
PYTHON = sys.executable  # pytest 在仓库 venv 下运行
PACKET_FIXED = os.path.join(REPO, "design", "packet")

ENV_BASE = {
    "DSH_DESIGN_PACKET_FIXED": PACKET_FIXED,
    "DSH_DESIGN_PACKET": "",
    "DSH_DESIGN_EXPECT_INDEX_SHA": "",
    "DSH_DESIGN_EXPECT_MANIFEST_SHA": "",
    "DSH_DESIGN_ACCEPTANCE_ID": "",
}

CHECK_IDS = [
    "SNAPSHOT_BINDING", "MANIFEST_COMPLETE", "MANIFEST_DISK_HASH", "SCHEMA",
    "R1_CRN_NEQ_GEM", "R2_SCORE_NEQ_BOUND", "R3_PROXY_NEQ_CAPACITY", "DAG_ACYCLIC",
]


def run_op(op, args):
    """spawn design_casefile.py 独立 dispatcher；返回 (exit_code, envelope)。"""
    req = json.dumps({"op": op, "args": args})
    env = dict(os.environ)
    env.update(ENV_BASE)
    proc = subprocess.run(
        [PYTHON, "-I", DISPATCHER],
        input=req.encode("utf-8"),
        capture_output=True,
        env=env,
        timeout=180,
    )
    envl = json.loads(proc.stdout.decode("utf-8").strip() or "{}")
    return proc.returncode, envl


def build_case(mode, out_dir):
    """用 A1/A2 生产路径建真实 case。返回 dict（workdir/case_dir/snapshot_sha/ids）。"""
    proc = subprocess.run(
        ["node", BUILDER, out_dir, mode],
        capture_output=True,
        cwd=REPO,
        timeout=300,
    )
    assert proc.returncode == 0, "builder failed: " + proc.stderr.decode("utf-8", "replace")
    return json.loads(proc.stdout.decode("utf-8").strip())


@pytest.fixture(scope="session")
def built_cases(tmp_path_factory):
    """session 级：每种模式建一次真实 case，测试内按需复制（避免逐测试重建）。"""
    base = tmp_path_factory.mktemp("design-cases")
    out = {}
    for mode in ("clean", "lite", "r1", "r2", "r3", "r3b", "r3c", "dag_cycle"):
        out[mode] = build_case(mode, str(base / mode))
    return out


def fresh_case(built_cases, mode, tmp_path):
    """复制已构建 case 到本测试私有目录（快照/对象字节不变）。"""
    src = built_cases[mode]
    dst = str(tmp_path / "case")
    shutil.copytree(src["case_dir"], dst)
    return {
        "workdir": str(tmp_path),
        "case_dir": dst,
        "snapshot_sha": src["snapshot_sha"],
        "ids": src["ids"],
    }


def envelope_ok(exit_code, envl):
    return exit_code == 0 and envl.get("status") == "OK" and envl.get("reason_code") == "OK"


def status_of(envl, check_id):
    for c in envl.get("checks") or []:
        if c["check_id"] == check_id:
            return c
    return None


@pytest.fixture(autouse=True)
def _clean_env():
    """防止宿主 DSH_DESIGN_* 环境变量泄漏影响测试。"""
    saved = {k: os.environ.get(k) for k in ("DSH_DESIGN_PACKET", "DSH_DESIGN_PACKET_FIXED")}
    for k in saved:
        os.environ.pop(k, None)
    yield
    for k, v in saved.items():
        if v is None:
            os.environ.pop(k, None)
        else:
            os.environ[k] = v


# ── validate：正例与三态 ────────────────────────────────────────────────

def test_validate_clean_pass(built_cases, tmp_path):
    case = fresh_case(built_cases, "clean", tmp_path)
    code, envl = run_op("design_casefile_validate", {"casefile_dir": case["case_dir"]})
    assert envelope_ok(code, envl)
    checks = envl["checks"]
    assert [c["check_id"] for c in checks] == CHECK_IDS
    assert all(c["status"] == "PASS" and c["required"] is True for c in checks)
    assert envl["snapshot_sha"] == case["snapshot_sha"]


def test_validate_lite_skip_is_recorded_not_silent(built_cases, tmp_path):
    """不适用项 SKIP 并记录原因（不得静默跳过）。"""
    case = fresh_case(built_cases, "lite", tmp_path)
    code, envl = run_op("design_casefile_validate", {"casefile_dir": case["case_dir"]})
    assert envelope_ok(code, envl)
    for cid in ("R1_CRN_NEQ_GEM", "R2_SCORE_NEQ_BOUND", "R3_PROXY_NEQ_CAPACITY", "DAG_ACYCLIC"):
        c = status_of(envl, cid)
        assert c["status"] == "SKIP" and c["detail"].startswith("SKIP："), cid


def test_validate_strict_false_keeps_gate(built_cases, tmp_path):
    case = fresh_case(built_cases, "clean", tmp_path)
    code, envl = run_op("design_casefile_validate", {"casefile_dir": case["case_dir"], "strict": False})
    assert envelope_ok(code, envl)


# ── validate：三条红线注入（快照内实际工件反向核查）────────────────────

@pytest.mark.parametrize("mode,check_id,reason", [
    ("r1", "R1_CRN_NEQ_GEM", "R1_MODEL_REF_INVALID"),
    ("r2", "R2_SCORE_NEQ_BOUND", "R2_UNAUTHORIZED_BOUND"),
    ("r3", "R3_PROXY_NEQ_CAPACITY", "R3_CHAIN_BROKEN"),
    ("r3b", "R3_PROXY_NEQ_CAPACITY", "R3_CHAIN_BROKEN"),
    ("r3c", "R3_PROXY_NEQ_CAPACITY", "R3_CHAIN_BROKEN"),
])
def test_validate_redline_injection(built_cases, tmp_path, mode, check_id, reason):
    case = fresh_case(built_cases, mode, tmp_path)
    code, envl = run_op("design_casefile_validate", {"casefile_dir": case["case_dir"]})
    assert code != 0
    assert envl["status"] == "INVALID_INPUT"
    assert envl["reason_code"] == reason
    assert status_of(envl, check_id)["status"] == "FAIL"


def test_validate_dag_cycle(built_cases, tmp_path):
    case = fresh_case(built_cases, "dag_cycle", tmp_path)
    code, envl = run_op("design_casefile_validate", {"casefile_dir": case["case_dir"]})
    assert code != 0 and envl["status"] == "INVALID_INPUT" and envl["reason_code"] == "DAG_CYCLE"
    assert status_of(envl, "DAG_ACYCLIC")["status"] == "FAIL"


# ── validate：磁盘/快照篡改与缺条目 → FAIL 非零 ─────────────────────────

def _tamper_object(case, artifact_key):
    obj = os.path.join(case["case_dir"], "objects", case["ids"][artifact_key])
    with open(obj, "rb") as fh:
        orig = fh.read()
    with open(obj, "wb") as fh:
        fh.write(orig + b"X")


def test_validate_object_tamper_hash_mismatch(built_cases, tmp_path):
    case = fresh_case(built_cases, "clean", tmp_path)
    _tamper_object(case, "condition_card")
    code, envl = run_op("design_casefile_validate", {"casefile_dir": case["case_dir"]})
    assert code != 0 and envl["status"] == "INVALID_INPUT"
    assert envl["reason_code"] == "OBJECT_HASH_MISMATCH"
    assert status_of(envl, "MANIFEST_DISK_HASH")["status"] == "FAIL"


def test_validate_missing_object_entry(built_cases, tmp_path):
    case = fresh_case(built_cases, "clean", tmp_path)
    os.remove(os.path.join(case["case_dir"], "objects", case["ids"]["evidence_item"]))
    code, envl = run_op("design_casefile_validate", {"casefile_dir": case["case_dir"]})
    assert code != 0 and envl["status"] == "INVALID_INPUT"
    assert envl["reason_code"] == "MANIFEST_ENTRY_MISSING"
    assert status_of(envl, "MANIFEST_COMPLETE")["status"] == "FAIL"


def test_validate_snapshot_tamper(built_cases, tmp_path):
    case = fresh_case(built_cases, "clean", tmp_path)
    snap = os.path.join(case["case_dir"], "snapshots", case["snapshot_sha"] + ".json")
    with open(snap, "rb") as fh:
        orig = fh.read()
    with open(snap, "wb") as fh:
        fh.write(orig[:-1] + (b"Z" if orig[-1:] != b"Z" else b"Y"))
    code, envl = run_op("design_casefile_validate", {"casefile_dir": case["case_dir"]})
    assert code != 0 and envl["status"] == "INVALID_INPUT"
    assert status_of(envl, "SNAPSHOT_BINDING")["status"] == "FAIL"


def test_validate_bogus_head(built_cases, tmp_path):
    case = fresh_case(built_cases, "clean", tmp_path)
    head = os.path.join(case["case_dir"], "HEAD.json")
    with open(head, "w", encoding="utf-8") as fh:
        json.dump({"snapshot_sha": "f" * 64}, fh)
    code, envl = run_op("design_casefile_validate", {"casefile_dir": case["case_dir"]})
    assert code != 0 and envl["status"] == "INVALID_INPUT"
    assert status_of(envl, "SNAPSHOT_BINDING")["status"] == "FAIL"


def test_validate_no_head(built_cases, tmp_path):
    case = fresh_case(built_cases, "clean", tmp_path)
    os.remove(os.path.join(case["case_dir"], "HEAD.json"))
    code, envl = run_op("design_casefile_validate", {"casefile_dir": case["case_dir"]})
    assert code != 0 and envl["status"] == "INVALID_INPUT"
    assert envl["reason_code"] == "SNAPSHOT_MISSING"
    assert status_of(envl, "SNAPSHOT_BINDING")["status"] == "FAIL"


# ── dispatcher 契约 ─────────────────────────────────────────────────────

def test_unknown_op_nonzero():
    code, envl = run_op("design_bogus_op", {})
    assert code != 0
    assert envl["status"] == "INVALID_INPUT" and envl["reason_code"] == "UNKNOWN_OP"


def test_missing_casefile_dir():
    code, envl = run_op("design_casefile_validate", {})
    assert code != 0 and envl["status"] == "INVALID_INPUT"
    assert envl["reason_code"] == "INVALID_CASEFILE_DIR"


def test_envelope_contract_keys(built_cases, tmp_path):
    """C4 信封 {status, reason_code, artifact_refs[], detail}（OK 与 FAIL 两态）。"""
    case = fresh_case(built_cases, "clean", tmp_path)
    code, envl = run_op("design_casefile_validate", {"casefile_dir": case["case_dir"]})
    for key in ("status", "reason_code", "artifact_refs", "detail"):
        assert key in envl, key
    assert isinstance(envl["artifact_refs"], list)
    code2, envl2 = run_op("design_casefile_validate", {"casefile_dir": case["case_dir"] + "-none"})
    assert code2 != 0
    for key in ("status", "reason_code", "artifact_refs", "detail"):
        assert key in envl2, key


# ── export：门禁 / report.md 禁含可含 / bundle 可重验 / 确定性 / 不改快照 ──

def _export(case, fmt="both"):
    code, envl = run_op("design_casefile_export", {"casefile_dir": case["case_dir"], "format": fmt})
    return code, envl


def test_export_clean(built_cases, tmp_path):
    case = fresh_case(built_cases, "clean", tmp_path)
    code, envl = _export(case)
    assert envelope_ok(code, envl)
    assert len(envl["artifact_refs"]) == 2
    report, bundle = envl["artifact_refs"]
    assert report.endswith("report.md") and os.path.exists(report)
    assert bundle.endswith("bundle.zip") and os.path.exists(bundle)


def test_export_gate_refused_on_invalid(built_cases, tmp_path):
    """validate 未过 → 拒绝导出（非零退出），不产出任何文件。"""
    case = fresh_case(built_cases, "clean", tmp_path)
    _tamper_object(case, "condition_card")
    code, envl = _export(case)
    assert code != 0 and envl["status"] == "INVALID_INPUT"
    assert envl["reason_code"] == "VALIDATE_GATE_FAILED"
    assert envl["artifact_refs"] == []
    assert status_of(envl, "MANIFEST_DISK_HASH")["status"] == "FAIL"


def test_export_report_forbidden_fields(built_cases, tmp_path):
    """R-3 自动化断言：report.md 禁含字段出现 → FAIL。"""
    case = fresh_case(built_cases, "clean", tmp_path)
    code, envl = _export(case)
    assert envelope_ok(code, envl)
    report = envl["artifact_refs"][0]
    text = open(report, encoding="utf-8").read()
    bundle_dir = os.path.dirname(envl["artifact_refs"][1])
    checks = {
        "case_instance_id (目录名)": "validate-case" in text,
        "真实 workdir": case["workdir"] in text,
        "临时路径/tmp|temp": bool(re.search(r"[/\\](tmp|temp)[/\\]", text)),
        "run UUID v4": bool(re.search(r"[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}", text)),
        "真实时间 (ISO 日期)": bool(re.search(r"\d{4}-\d{2}-\d{2}", text)),
        "stderr 原文": "stderr" in text,
        "bundle 输出路径": bundle_dir in text,
        "snapshot_sha": case["snapshot_sha"] in text,
    }
    bad = [k for k, v in checks.items() if v]
    assert not bad, "report 含禁含字段: " + json.dumps(bad)


def test_export_report_allowed_fields(built_cases, tmp_path):
    case = fresh_case(built_cases, "clean", tmp_path)
    code, envl = _export(case)
    assert envelope_ok(code, envl)
    text = open(envl["artifact_refs"][0], encoding="utf-8").read()
    assert "case_content_id:" in text
    assert "policy_hash:" in text
    for key, aid in case["ids"].items():
        assert aid in text, key
    assert "## 证据分级" in text and "## 假设清单" in text
    assert "## 不可重放项清单" in text


def test_export_report_deterministic(built_cases, tmp_path):
    """R-5：同输入同字节输出（report 无运行时熵）。"""
    case = fresh_case(built_cases, "clean", tmp_path)
    code1, envl1 = _export(case)
    code2, envl2 = _export(case)
    assert envelope_ok(code1, envl1) and envelope_ok(code2, envl2)
    text1 = open(envl1["artifact_refs"][0], "rb").read()
    text2 = open(envl2["artifact_refs"][0], "rb").read()
    assert text1 == text2, "report 字节不一致（存在运行时熵）"
    # bundle 条目集合 + 各条目字节稳定
    with zipfile.ZipFile(envl1["artifact_refs"][1]) as z1, zipfile.ZipFile(envl2["artifact_refs"][1]) as z2:
        assert z1.namelist() == z2.namelist()
        for name in z1.namelist():
            assert z1.read(name) == z2.read(name), name


def test_export_bundle_hash_list_independent_verify(built_cases, tmp_path):
    """解压可重验：哈希清单可独立复核（含全部工件 + snapshot.json + report.md）。"""
    case = fresh_case(built_cases, "clean", tmp_path)
    code, envl = _export(case)
    assert envelope_ok(code, envl)
    bundle = envl["artifact_refs"][1]
    with zipfile.ZipFile(bundle) as zf:
        names = zf.namelist()
        assert "snapshot.json" in names and "hashes.sha256" in names
        assert "report.md" in names
        for key, aid in case["ids"].items():
            assert "objects/" + aid in names, key
        hashes = zf.read("hashes.sha256").decode("utf-8").strip().split("\n")
        assert len(hashes) == len(names) - 1  # 哈希清单覆盖除自身外全部条目
        for line in hashes:
            expected, rel = line.split("  ")
            actual = hashlib.sha256(zf.read(rel)).hexdigest()
            assert actual == expected, "hash 复核失败: " + rel


def test_export_does_not_change_snapshot(built_cases, tmp_path):
    """export 产物为导出侧产物，不改变科学快照。"""
    case = fresh_case(built_cases, "clean", tmp_path)
    snap = os.path.join(case["case_dir"], "snapshots", case["snapshot_sha"] + ".json")
    head = os.path.join(case["case_dir"], "HEAD.json")
    objects = os.path.join(case["case_dir"], "objects")
    snap_before = open(snap, "rb").read()
    head_before = open(head, encoding="utf-8").read()
    objs_before = sorted(os.listdir(objects))
    code, envl = _export(case)
    assert envelope_ok(code, envl)
    assert open(snap, "rb").read() == snap_before
    assert open(head, encoding="utf-8").read() == head_before
    assert sorted(os.listdir(objects)) == objs_before


def test_export_format_report_only(built_cases, tmp_path):
    case = fresh_case(built_cases, "clean", tmp_path)
    code, envl = _export(case, fmt="report")
    assert envelope_ok(code, envl)
    assert len(envl["artifact_refs"]) == 1 and envl["artifact_refs"][0].endswith("report.md")


def test_export_format_zip_only(built_cases, tmp_path):
    case = fresh_case(built_cases, "clean", tmp_path)
    code, envl = _export(case, fmt="zip")
    assert envelope_ok(code, envl)
    assert len(envl["artifact_refs"]) == 1 and envl["artifact_refs"][0].endswith("bundle.zip")


def test_export_invalid_format(built_cases, tmp_path):
    case = fresh_case(built_cases, "clean", tmp_path)
    code, envl = run_op("design_casefile_export", {"casefile_dir": case["case_dir"], "format": "tar"})
    assert code != 0 and envl["status"] == "INVALID_INPUT" and envl["reason_code"] == "INVALID_FORMAT"


def test_bio_ops_dispatcher_routes_export():
    """bio_ops.py OPS 已注册 export（经 bio_ops 主 dispatcher 路由，信封协议一致）。"""
    env = dict(os.environ)
    env.update(ENV_BASE)
    req = json.dumps({"op": "design_casefile_export", "args": {"casefile_dir": "no-such-dir"}})
    proc = subprocess.run(
        [PYTHON, "-I", os.path.join(REPO, "python", "bio_ops.py")],
        input=req.encode("utf-8"),
        capture_output=True,
        env=env,
        timeout=180,
    )
    envl = json.loads(proc.stdout.decode("utf-8").strip() or "{}")
    assert proc.returncode == 0  # bio_ops 受 P2-1 契约约束：exit 0
    assert envl.get("ok") is False and envl.get("code") == "INVALID_CASEFILE_DIR"
