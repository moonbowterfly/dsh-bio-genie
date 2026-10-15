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
from pathlib import Path

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

sys.path.insert(0, os.path.join(REPO, "python"))
import design_casefile as dcf  # noqa: E402

CHECK_IDS = [
    "SNAPSHOT_BINDING", "MANIFEST_COMPLETE", "MANIFEST_DISK_HASH", "SCHEMA",
    "R1_CRN_NEQ_GEM", "R2_SCORE_NEQ_BOUND", "R3_PROXY_NEQ_CAPACITY", "DAG_ACYCLIC",
]


def run_op(op, args, extra_env=None):
    """spawn design_casefile.py 独立 dispatcher；返回 (exit_code, envelope)。"""
    req = json.dumps({"op": op, "args": args})
    env = dict(os.environ)
    env.update(ENV_BASE)
    if extra_env:
        env.update(extra_env)
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


def stage_report(case, audit_view_id=None, source_snapshot_sha=None, name="b4-stage"):
    """Run the actual Python private render phase into a TS-shaped staging dir."""
    source_snapshot_sha = source_snapshot_sha or case["snapshot_sha"]
    audit_view_id = [] if audit_view_id is None else audit_view_id
    stage_dir = os.path.join(case["case_dir"], "staging", name)
    os.makedirs(stage_dir, exist_ok=False)
    code, envl = run_op(
        "design_casefile_export",
        {
            "casefile_dir": case["case_dir"],
            "_stage_report": True,
            "source_snapshot_sha": source_snapshot_sha,
            "audit_view_id": audit_view_id,
        },
        {"DSH_DESIGN_STAGING": stage_dir},
    )
    return code, envl, stage_dir


def commit_staged_report(case, parent_snapshot_sha, staged_path):
    """Exercise the real TS-only B4 transaction without giving Python write authority."""
    module_uri = Path(os.path.join(REPO, "src", "design-casefile.js")).as_uri()
    script = """
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { commitReportFinalizeTransaction } from %s
const [caseDir, parent, reportPath] = process.argv.slice(1)
const result = commitReportFinalizeTransaction({
  caseDir,
  objectsDir: join(caseDir, 'objects'),
  snapshotsDir: join(caseDir, 'snapshots'),
}, { reportBytes: readFileSync(reportPath), expectHead: parent })
process.stdout.write(JSON.stringify(result))
""" % json.dumps(module_uri)
    proc = subprocess.run(
        ["node", "--input-type=module", "-e", script, case["case_dir"], parent_snapshot_sha, staged_path],
        capture_output=True,
        cwd=REPO,
        timeout=180,
    )
    assert proc.returncode == 0, proc.stderr.decode("utf-8", "replace")
    return json.loads(proc.stdout.decode("utf-8") or "{}")


def finalize_case(case, audit_view_id=None):
    """B4 test helper: Python render-only stage then TS commit S_n → S_(n+1)."""
    parent = case["snapshot_sha"]
    code, envl, stage_dir = stage_report(case, audit_view_id=audit_view_id, source_snapshot_sha=parent)
    assert envelope_ok(code, envl), envl
    staged_path = os.path.join(stage_dir, "report.md")
    tx = commit_staged_report(case, parent, staged_path)
    assert tx.get("ok") is True, tx
    return {
        "parent_snapshot_sha": parent,
        "snapshot_sha": tx["snapshot_sha"],
        "report_artifact_id": tx["report_artifact_id"],
        "report_bytes": open(staged_path, "rb").read(),
        "stage_envelope": envl,
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

def _export(case, fmt="both", snapshot_sha=None):
    args = {"casefile_dir": case["case_dir"], "format": fmt}
    if snapshot_sha is not None:
        args["snapshot_sha"] = snapshot_sha
    code, envl = run_op("design_casefile_export", args)
    return code, envl


def test_export_requires_finalized_report(built_cases, tmp_path):
    """The standalone Python exporter is pure: it cannot advance S_n itself."""
    case = fresh_case(built_cases, "clean", tmp_path)
    head_before = open(os.path.join(case["case_dir"], "HEAD.json"), "rb").read()
    code, envl = _export(case)
    assert code != 0 and envl["status"] == "INVALID_INPUT"
    assert envl["reason_code"] == "REPORT_FINALIZE_REQUIRED"
    assert envl["artifact_refs"] == []
    assert open(os.path.join(case["case_dir"], "HEAD.json"), "rb").read() == head_before


def test_export_gate_refused_on_invalid(built_cases, tmp_path):
    """validate 未过 → 拒绝导出（非零退出），不产出任何文件。"""
    case = fresh_case(built_cases, "clean", tmp_path)
    _tamper_object(case, "condition_card")
    code, envl = _export(case)
    assert code != 0 and envl["status"] == "INVALID_INPUT"
    assert envl["reason_code"] == "VALIDATE_GATE_FAILED"
    assert envl["artifact_refs"] == []
    assert status_of(envl, "MANIFEST_DISK_HASH")["status"] == "FAIL"


def test_report_forbidden_fields_rejected_before_commit(built_cases, tmp_path):
    """All eight B4 entropy classes are rejected by both Python and TS gates."""
    case = fresh_case(built_cases, "clean", tmp_path)
    code, envl, stage_dir = stage_report(case)
    assert envelope_ok(code, envl)
    base = open(os.path.join(stage_dir, "report.md"), "rb").read()
    head_path = os.path.join(case["case_dir"], "HEAD.json")
    objects_dir = os.path.join(case["case_dir"], "objects")
    snapshots_dir = os.path.join(case["case_dir"], "snapshots")
    before_head = open(head_path, "rb").read()
    before_objects = sorted(os.listdir(objects_dir))
    before_snapshots = sorted(os.listdir(snapshots_dir))
    mutations = {
        "REPORT_FORBIDDEN_CASE_INSTANCE_ID": "\ncase\n",
        "REPORT_FORBIDDEN_WORKDIR": "\n" + case["workdir"] + "\n",
        "REPORT_FORBIDDEN_TEMP_PATH": "\nC:/temp/report-work\n",
        "REPORT_FORBIDDEN_RUN_UUID": "\n01234567-89ab-4cde-8fab-0123456789ab\n",
        "REPORT_FORBIDDEN_REAL_TIME": "\n2026-10-15\n",
        "REPORT_FORBIDDEN_STDERR": "\nstderr raw worker text\n",
        "REPORT_FORBIDDEN_BUNDLE_PATH": "\nexports/final/bundle.zip\n",
        "REPORT_FORBIDDEN_SNAPSHOT_SHA": "\n" + case["snapshot_sha"] + "\n",
    }
    for index, (expected, suffix) in enumerate(mutations.items()):
        mutated = base + suffix.encode("utf-8")
        py_ok, py_code, _detail, _text = dcf._validate_case_report_bytes(mutated, case_dir=case["case_dir"], source_snapshot_sha=case["snapshot_sha"])
        assert not py_ok and py_code == expected
        path = os.path.join(stage_dir, "mut-%02d.md" % index)
        with open(path, "wb") as fh:
            fh.write(mutated)
        tx = commit_staged_report(case, case["snapshot_sha"], path)
        assert tx.get("ok") is False and tx.get("code") == expected, tx
        assert open(head_path, "rb").read() == before_head
        assert sorted(os.listdir(objects_dir)) == before_objects
        assert sorted(os.listdir(snapshots_dir)) == before_snapshots


def test_export_report_allowed_fields(built_cases, tmp_path):
    case = fresh_case(built_cases, "clean", tmp_path)
    finalize_case(case)
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
    """R4/R-5：同一 (S_n, audit_view) 的 report 字节确定；同快照导出字节稳定。"""
    case_a = fresh_case(built_cases, "clean", tmp_path / "a")
    case_b = fresh_case(built_cases, "clean", tmp_path / "b")
    fin_a = finalize_case(case_a)
    fin_b = finalize_case(case_b)
    assert fin_a["report_bytes"] == fin_b["report_bytes"], "report 字节不一致（存在运行时熵）"
    code1, envl1 = _export(case_a)
    code2, envl2 = _export(case_a)
    assert envelope_ok(code1, envl1) and envelope_ok(code2, envl2)
    assert envl1["snapshot_sha"] == fin_a["snapshot_sha"] and envl2["snapshot_sha"] == fin_a["snapshot_sha"]
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
    finalize_case(case)
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
    """finalize 后的纯导出为导出侧产物，不改变科学快照（R5）。"""
    case = fresh_case(built_cases, "clean", tmp_path)
    fin = finalize_case(case)
    snap = os.path.join(case["case_dir"], "snapshots", case["snapshot_sha"] + ".json")
    head = os.path.join(case["case_dir"], "HEAD.json")
    objects = os.path.join(case["case_dir"], "objects")
    snap_before = open(snap, "rb").read()
    head_before = open(head, encoding="utf-8").read()
    objs_before = sorted(os.listdir(objects))
    code, envl = _export(case)
    assert envelope_ok(code, envl)
    assert envl["snapshot_sha"] == fin["snapshot_sha"]
    assert open(snap, "rb").read() == snap_before
    assert open(head, encoding="utf-8").read() == head_before
    assert sorted(os.listdir(objects)) == objs_before


def test_export_format_report_only(built_cases, tmp_path):
    case = fresh_case(built_cases, "clean", tmp_path)
    fin = finalize_case(case)
    code, envl = _export(case, fmt="report")
    assert envelope_ok(code, envl)
    assert envl["snapshot_sha"] == fin["snapshot_sha"]
    assert len(envl["artifact_refs"]) == 1 and envl["artifact_refs"][0].endswith("report.md")


def test_export_format_zip_only(built_cases, tmp_path):
    case = fresh_case(built_cases, "clean", tmp_path)
    fin = finalize_case(case)
    code, envl = _export(case, fmt="zip")
    assert envelope_ok(code, envl)
    assert envl["snapshot_sha"] == fin["snapshot_sha"]
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
