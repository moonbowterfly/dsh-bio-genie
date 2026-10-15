#!/usr/bin/env python
"""design_casefile.py — casefile validate / export（正式工具级；B1-part-2，req G-LOOP-20261015-B1P2-001）

实现规格（版本链摘录）：
  - validate（v0.1 §6.5 + v0.2 §6.5/§3.4）：输入 casefile_dir + strict（默认 true）；
    逐检查项验证报告（check_id + PASS/FAIL/SKIP 三态）；任一 required check = FAIL →
    顶层 INVALID_INPUT、非零退出、禁止 export。绑定不可变 snapshot（从 snapshot 文件重校验，
    不读可变尾部）。三条红线（R1/R2/R3，v0.2 §3.2）按当前快照内实际存在工件做可得性反向核查；
    不适用项 SKIP 并记录原因，不得静默跳过。
  - export（v0.1 §6.6 + v0.2 §6.6 + v0.5 §D2）：输入 casefile_dir + format ∈ {"zip","report"}
    （默认两者）；输出 report.md（含证据分级与假设清单）+ bundle.zip（全工件 + 哈希清单）；
    不可重放项必须列出；validate 未过 → 拒绝导出（非零退出）；绑定同一 snapshot；
    解压可重验（哈希清单可独立复核）。
  - report.md 禁含：case_instance_id、真实 workdir、临时路径、run UUID、真实时间、
    stderr 原文、bundle 输出路径、snapshot_sha。可含：case_content_id、policy_hash、
    artifact IDs、claim IDs、固定 audit-record IDs。
  - 结果信封（v0.4 §C4）：{status, reason_code, artifact_refs[], detail}（本文件另附
    checks[] 供逐检查项报告；A5 落地 src/design-envelope.js 前按本契约先行定义接口）。

三层状态词表（禁止混用）：
  工具调用层  OK / BLOCKED / NOT_RUN / OUT_OF_DOMAIN / DEPENDENCY_UNAVAILABLE /
              INVALID_INPUT / EXECUTION_ERROR
  validator   PASS / FAIL / SKIP
  科学结论    SUPPORTED / CONDITIONAL / INDETERMINATE / BLOCKED（本文件不产出科学结论，
              claim 方向原样转录至报告，结论分级归 report-finalize/B4）

执行与退出码（独立 dispatcher；区别于 bio_ops.py 的 P2-1 全 exit-0 契约）：
  0 = OK；1 = 验证失败/导出被拒（status=INVALID_INPUT 等）；2 = 用法错误（未知 op/坏参数）；
  3 = 内部异常（status=EXECUTION_ERROR）。stdout 始终输出单行 JSON 信封（含 ok 字段，
  与 worker 协议一致）。

身份绑定：packet 根只取 TS 约束值（DSH_DESIGN_PACKET_FIXED；继承的 DSH_DESIGN_PACKET 已清），
并校验 index/manifest/acceptance id 与 TS 传递期望一致（split-packet 防线，同 design_ops.py）。
"""
import hashlib
import json
import os
import re
import sys
import zipfile

sys.dont_write_bytecode = True

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import design_validate as dv  # noqa: E402

# 检查项清单（check_id → (required, 说明)；stable，跨版本不变）
CHECKS = [
    ("SNAPSHOT_BINDING", True, "HEAD→快照绑定：HEAD 可读、快照文件存在且为 canonical 字节、文件名==嵌入 snapshot_sha、嵌入值==sha256(canonical(manifest_without_snapshot_sha))"),
    ("MANIFEST_COMPLETE", True, "manifest 条目齐全：无重复 artifact_id；每条目在 objects/ 有对应磁盘对象（缺条目 → FAIL）"),
    ("MANIFEST_DISK_HASH", True, "manifest 与磁盘 hash 一致：对象名==内容 sha256；磁盘字节==类型 canonical 字节"),
    ("SCHEMA", True, "全部工件 schema 校验（draft-07 + sem 层 + c14n 层）"),
    ("R1_CRN_NEQ_GEM", True, "红线 R1：consequence 只接受经复核的 constraint_gem（model_ref 必须解析为 metabolic_model_ref@1，不得为 kinetic_crn_ref@1；sbml_ref 链完整）"),
    ("R2_SCORE_NEQ_BOUND", True, "红线 R2：表达分数不得被用作 bound（无 coupling 授权时）；diff 的 rule_id 必须经 coupling_profile 授权，定性模式不得产生数值 bound"),
    ("R3_PROXY_NEQ_CAPACITY", True, "红线 R3：coupling_profile@1 是唯一且强制的跨层入口；每个 bound diff 反向核查 唯一 coupling_profile→rule_id→证据/假设 ID→GPR mapping proof 链完整性"),
    ("DAG_ACYCLIC", True, "provenance_dag 无环；edge 端点必须存在于 nodes"),
]

VALIDATOR_PASS = "PASS"
VALIDATOR_FAIL = "FAIL"
VALIDATOR_SKIP = "SKIP"

H64_RE = re.compile(r"^[0-9a-f]{64}$")
CASE_REPORT_TYPE = "case_report@1"
CASE_REPORT_HEADER = "# 设计 casefile 最终报告\n"
MAX_CASE_REPORT_BYTES = 16 * 1024 * 1024


def _report_forbidden_codes(text, case_dir=None, source_snapshot_sha=None):
    """Return stable B4 rejection codes for runtime entropy in report bytes."""
    codes = []

    def add(code):
        if code not in codes:
            codes.append(code)

    normalized = text.replace("\\", "/").lower()
    if re.search(r"\bcase_instance_id\b", text, flags=re.IGNORECASE):
        add("REPORT_FORBIDDEN_CASE_INSTANCE_ID")
    if case_dir:
        case_abs = os.path.abspath(case_dir)
        roots = [case_abs]
        # <workdir>/result/design/<case> -> <workdir>
        try:
            roots.append(os.path.dirname(os.path.dirname(os.path.dirname(case_abs))))
        except Exception:  # noqa: BLE001
            pass
        for root in roots:
            candidate = os.path.abspath(root).replace("\\", "/").lower()
            if candidate and candidate in normalized:
                add("REPORT_FORBIDDEN_WORKDIR")
        case_name = os.path.basename(case_abs)
        if case_name and re.search(r"(^|[^A-Za-z0-9._-])" + re.escape(case_name) + r"($|[^A-Za-z0-9._-])", text, flags=re.IGNORECASE):
            add("REPORT_FORBIDDEN_CASE_INSTANCE_ID")
    if re.search(r"(?:^|[\\/])(tmp|temp)(?:[\\/]|$)", text, flags=re.IGNORECASE):
        add("REPORT_FORBIDDEN_TEMP_PATH")
    if re.search(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b", text, flags=re.IGNORECASE):
        add("REPORT_FORBIDDEN_RUN_UUID")
    if re.search(r"\b\d{4}-\d{2}-\d{2}\b", text):
        add("REPORT_FORBIDDEN_REAL_TIME")
    if re.search(r"\bstderr\b", text, flags=re.IGNORECASE):
        add("REPORT_FORBIDDEN_STDERR")
    if re.search(r"\bbundle\.zip\b", text, flags=re.IGNORECASE) or re.search(r"(?:^|[\\/])exports(?:[\\/]|$)", text, flags=re.IGNORECASE):
        add("REPORT_FORBIDDEN_BUNDLE_PATH")
    if re.search(r"\bsnapshot_sha\b", text, flags=re.IGNORECASE) or (source_snapshot_sha and source_snapshot_sha in text):
        add("REPORT_FORBIDDEN_SNAPSHOT_SHA")
    return codes


def _validate_case_report_bytes(data, case_dir=None, source_snapshot_sha=None):
    """Validate the sole raw-byte artifact admitted by B4.

    The frozen packet has no JSON schema for `case_report@1`, so both the
    Python validator and the TS transaction enforce this exact, narrow byte
    contract.  It is intentionally not a generic unknown-artifact bypass.
    """
    if not isinstance(data, (bytes, bytearray)):
        return False, "CASE_REPORT_BYTES_INVALID", "report bytes required", None
    data = bytes(data)
    if len(data) == 0 or len(data) > MAX_CASE_REPORT_BYTES:
        return False, "CASE_REPORT_SIZE_INVALID", "report byte length invalid", None
    try:
        text = data.decode("utf-8")
    except Exception as exc:  # noqa: BLE001
        return False, "CASE_REPORT_NOT_UTF8", "report is not utf-8: " + str(exc)[:80], None
    if text.encode("utf-8") != data:
        return False, "CASE_REPORT_NOT_UTF8", "report utf-8 round-trip mismatch", None
    if "\r" in text or not text.endswith("\n"):
        return False, "CASE_REPORT_LINE_ENDING_INVALID", "report must use LF and end with LF", None
    if not text.startswith(CASE_REPORT_HEADER):
        return False, "CASE_REPORT_HEADER_INVALID", "report header invalid", None
    codes = _report_forbidden_codes(text, case_dir=case_dir, source_snapshot_sha=source_snapshot_sha)
    if codes:
        return False, codes[0], ",".join(codes), None
    return True, None, None, text


def _canonical_audit_view(value):
    """Validate the v0.6 wire form: lexicographically ordered H64 array.

    Receipt-sequence ordering would require an immutable receipt prefix index,
    which this casefile does not have.  The direct hash-list form is therefore
    canonical ASCII lexical order and never consults the mutable receipt tail.
    """
    if not isinstance(value, list):
        return None, "INVALID_AUDIT_VIEW_ID", "audit_view_id must be an array"
    if len(value) > 1024:
        return None, "INVALID_AUDIT_VIEW_ID", "audit_view_id too long"
    out = []
    seen = set()
    for item in value:
        if not isinstance(item, str) or not H64_RE.fullmatch(item):
            return None, "INVALID_AUDIT_VIEW_ID", "audit record id must be lowercase sha256"
        if item in seen:
            return None, "INVALID_AUDIT_VIEW_ID", "duplicate audit record id"
        seen.add(item)
        out.append(item)
    if out != sorted(out):
        return None, "AUDIT_VIEW_NOT_CANONICAL", "audit_view_id must use ASCII lexical hash order"
    return out, None, None


def _packet_root():
    fixed = os.environ.get("DSH_DESIGN_PACKET_FIXED")
    if fixed:
        return fixed
    return os.environ.get("DSH_DESIGN_PACKET") or dv.PACKET_DIR


def _identity_problems(root):
    return dv.verify_dispatch_identity(
        root,
        os.environ.get("DSH_DESIGN_EXPECT_INDEX_SHA"),
        os.environ.get("DSH_DESIGN_EXPECT_MANIFEST_SHA"),
        os.environ.get("DSH_DESIGN_ACCEPTANCE_ID"),
    )


def _envelope(status, reason_code, artifact_refs, detail, checks=None):
    env = {
        "status": status,
        "reason_code": reason_code,
        "artifact_refs": list(artifact_refs or []),
        "detail": detail or "",
    }
    if checks is not None:
        env["checks"] = checks
    if status != "OK":
        env["code"] = reason_code
        env["error"] = detail or reason_code
    return env


def _serialize_tree(ctx, stem, tree, root):
    """按 packet c14n profile 序列化一棵已解析/归一树（含注解推导）。"""
    import importlib.util
    impl_path = os.path.join(root, "impl", "c14n.py")
    spec = importlib.util.spec_from_file_location("dsh_packet_c14n_ser", impl_path)
    c14n = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(c14n)
    c14n.set_domain_ranges(ctx["ranges"])
    tree = c14n._normalize(tree, "$")
    ann = dv.derive_annotations(ctx, stem, tree)
    return c14n._serialize(tree, "$", ann).encode("utf-8")


def _read_file_bytes(path, limit):
    with open(path, "rb") as fh:
        data = fh.read(limit + 1)
    if len(data) > limit:
        raise ValueError("file exceeds size limit")
    return data


def _load_snapshot(case_dir, root, ctx, sha):
    """读快照文件并做三层一致性核验。返回 (manifest_tree, problems[(code, detail)])。"""
    snap_path = os.path.join(case_dir, "snapshots", sha + ".json")
    if not os.path.exists(snap_path):
        return None, [("SNAPSHOT_FILE_MISSING", "snapshot file missing: snapshots/" + sha[:12] + ".json")]
    try:
        data = _read_file_bytes(snap_path, 64 * 1024 * 1024)
    except Exception as exc:  # noqa: BLE001
        return None, [("SNAPSHOT_UNREADABLE", "snapshot unreadable: " + str(exc)[:120])]
    try:
        text = data.decode("utf-8")
    except Exception as exc:  # noqa: BLE001
        return None, [("SNAPSHOT_UNREADABLE", "snapshot not utf-8: " + str(exc)[:120])]
    try:
        canon, tree = dv.canonicalize_bytes(ctx, "case_manifest", text, root)
    except Exception as exc:  # noqa: BLE001
        code = getattr(exc, "code", None) or type(exc).__name__
        return None, [("SNAPSHOT_NONCANONICAL", "snapshot c14n failed: " + str(code) + " " + str(getattr(exc, "detail", ""))[:120])]
    if canon != data:
        return None, [("SNAPSHOT_NONCANONICAL", "snapshot bytes are not canonical")]
    embedded = tree.get("snapshot_sha")
    if embedded != sha:
        return None, [("SNAPSHOT_SHA_MISMATCH", "snapshot file name != embedded snapshot_sha")]
    without = {k: v for k, v in tree.items() if k != "snapshot_sha"}
    try:
        canon_without = _serialize_tree(ctx, "case_manifest", without, root)
    except Exception as exc:  # noqa: BLE001
        return None, [("SNAPSHOT_SHA_MISMATCH", "snapshot recompute failed: " + str(exc)[:120])]
    if hashlib.sha256(canon_without).hexdigest() != embedded:
        return None, [("SNAPSHOT_SHA_MISMATCH", "embedded snapshot_sha != sha256(canonical(manifest_without_snapshot_sha))")]
    return tree, []


def _object_verify(ctx, root, case_dir, artifact_id, artifact_type):
    """单对象复核：存在 + 名==内容哈希 + 字节 canonical + schema。返回 (ok, problems[(code, detail)], stem)。"""
    obj_path = os.path.join(case_dir, "objects", artifact_id)
    if not os.path.exists(obj_path):
        return False, [("OBJECT_MISSING", "object missing: " + artifact_id[:12])], None
    try:
        data = _read_file_bytes(obj_path, 128 * 1024 * 1024)
    except Exception as exc:  # noqa: BLE001
        return False, [("OBJECT_UNREADABLE", "object unreadable: " + artifact_id[:12] + " " + str(exc)[:120])], None
    if hashlib.sha256(data).hexdigest() != artifact_id:
        return False, [("OBJECT_HASH_MISMATCH", "object name != content sha256: " + artifact_id[:12])], None
    if not artifact_type.endswith("@1"):
        return False, [("OBJECT_TYPE_INVALID", "artifact type not @1: " + str(artifact_type))], None
    stem = artifact_type[:-2]
    if artifact_type == CASE_REPORT_TYPE:
        ok, code, detail, _text = _validate_case_report_bytes(data, case_dir=case_dir)
        if not ok:
            return False, [(code, "report object invalid: " + detail)], stem
        return True, [], stem
    try:
        text = data.decode("utf-8")
    except Exception as exc:  # noqa: BLE001
        return False, [("OBJECT_UNREADABLE", "object not utf-8: " + artifact_id[:12] + " " + str(exc)[:120])], None
    try:
        canon, tree = dv.canonicalize_bytes(ctx, stem, text, root)
    except Exception as exc:  # noqa: BLE001
        code = getattr(exc, "code", None) or type(exc).__name__
        return False, [("OBJECT_NONCANONICAL", "object c14n failed: " + artifact_id[:12] + " " + str(code) + " " + str(getattr(exc, "detail", ""))[:120])], None
    if canon != data:
        return False, [("OBJECT_NONCANONICAL", "object bytes not canonical: " + artifact_id[:12])], None
    v = dv.validate_with_ctx(ctx, stem, tree)
    if not v["ok"]:
        first = (v["errors"] or [{}])[0]
        return False, [("SCHEMA_VIOLATION", "object schema failed: " + artifact_id[:12] + " " + str(first.get("code", "?")) + "@" + str(first.get("path", "?"))), v["errors"]], stem
    return True, [], stem


def _artifact_index(case_dir, manifest):
    """按 manifest 构建工件索引：id → {type, value, stem}。返回 (index, problems)。"""
    index = {}
    problems = []
    for entry in manifest.get("artifacts") or []:
        aid = entry.get("artifact_id")
        atype = entry.get("type")
        if not isinstance(aid, str) or not isinstance(atype, str):
            problems.append("manifest entry malformed")
            continue
        obj_path = os.path.join(case_dir, "objects", aid)
        try:
            data = _read_file_bytes(obj_path, 128 * 1024 * 1024)
        except Exception:  # noqa: BLE001
            continue  # 缺失/不可读由 MANIFEST_COMPLETE / MANIFEST_DISK_HASH 检出
        if atype == CASE_REPORT_TYPE:
            index[aid] = {"type": atype, "value": None, "stem": "case_report", "raw": data}
            continue
        try:
            value = json.loads(data.decode("utf-8"))
        except Exception:  # noqa: BLE001
            value = None
        index[aid] = {"type": atype, "value": value, "stem": atype[:-2] if atype.endswith("@1") else None}
    return index, problems


def _by_type(index):
    out = {}
    for aid, info in index.items():
        out.setdefault(info["type"], []).append((aid, info))
    for t in out:
        out[t].sort(key=lambda x: x[0])
    return out


def _resolve_ref(index, ref):
    """artifactRef {artifact_id,...} → 索引条目或 None。"""
    if not isinstance(ref, dict) or not isinstance(ref.get("artifact_id"), str):
        return None
    return index.get(ref["artifact_id"])


def _run_checks(case_dir, root, ctx, snapshot_sha=None):
    """Validate HEAD by default, or one immutable explicit snapshot.

    `snapshot_sha` is used by report-finalize after its TS transaction so the
    validate/export pair cannot silently switch to a newer mutable HEAD.
    """
    checks = []
    fail_codes = []

    def add(check_id, status, detail, code=None):
        checks.append({"check_id": check_id, "required": True, "status": status, "detail": detail or ""})
        if status == VALIDATOR_FAIL:
            fail_codes.append(code or check_id)

    # ── 基础：HEAD / explicit immutable snapshot → snapshot binding ────
    head_ok = False
    requested_snapshot = snapshot_sha
    snapshot_sha = None
    manifest = None
    if requested_snapshot is not None:
        if not isinstance(requested_snapshot, str) or not H64_RE.fullmatch(requested_snapshot):
            add("SNAPSHOT_BINDING", VALIDATOR_FAIL, "explicit snapshot sha invalid", "SNAPSHOT_SHA_INVALID")
        else:
            snapshot_sha = requested_snapshot
            manifest, problems = _load_snapshot(case_dir, root, ctx, snapshot_sha)
            if manifest is None:
                code, detail = problems[0]
                add("SNAPSHOT_BINDING", VALIDATOR_FAIL, detail, code)
            else:
                head_ok = True
                add("SNAPSHOT_BINDING", VALIDATOR_PASS, "explicit immutable snapshot binding verified")
    else:
        head_path = os.path.join(case_dir, "HEAD.json")
        if not os.path.exists(head_path):
            add("SNAPSHOT_BINDING", VALIDATOR_FAIL, "HEAD.json 不存在（尚无已提交快照，无法绑定不可变 snapshot）", "SNAPSHOT_MISSING")
        else:
            try:
                with open(head_path, encoding="utf-8") as fh:
                    head = json.load(fh)
            except Exception as exc:  # noqa: BLE001
                head = None
                add("SNAPSHOT_BINDING", VALIDATOR_FAIL, "HEAD.json 不可读: " + str(exc)[:120], "SNAPSHOT_UNREADABLE")
            if head is not None:
                snapshot_sha = head.get("snapshot_sha")
                if not isinstance(snapshot_sha, str) or not H64_RE.fullmatch(snapshot_sha):
                    add("SNAPSHOT_BINDING", VALIDATOR_FAIL, "HEAD snapshot_sha 非法（非 64-hex）", "SNAPSHOT_SHA_INVALID")
                else:
                    manifest, problems = _load_snapshot(case_dir, root, ctx, snapshot_sha)
                    if manifest is None:
                        code, detail = problems[0]
                        add("SNAPSHOT_BINDING", VALIDATOR_FAIL, detail, code)
                    else:
                        head_ok = True
                        add("SNAPSHOT_BINDING", VALIDATOR_PASS, "快照绑定成功（HEAD → snapshots/<sha>.json，字节 canonical，嵌入 hash 复核一致）")

    index = {}
    if head_ok:
        v = dv.validate_with_ctx(ctx, "case_manifest", manifest)
        # ── MANIFEST_COMPLETE ──────────────────────────────────────────
        entries = manifest.get("artifacts") or []
        manifest_problem = None
        seen = set()
        dup = None
        if not v["ok"]:
            first = (v["errors"] or [{}])[0]
            manifest_problem = ("manifest schema 违规: " + str(first.get("code", "?")) + "@" + str(first.get("path", "?")), "MANIFEST_SCHEMA_VIOLATION")
        if manifest_problem is None:
            for entry in entries:
                aid = entry.get("artifact_id")
                if aid in seen:
                    dup = aid
                    break
                seen.add(aid)
            if dup:
                manifest_problem = ("manifest 重复 artifact_id: " + str(dup)[:12], "MANIFEST_DUPLICATE_ARTIFACT")
        if manifest_problem is None:
            missing = [e.get("artifact_id") for e in entries if not os.path.exists(os.path.join(case_dir, "objects", str(e.get("artifact_id"))))]
            if missing:
                manifest_problem = ("缺 manifest 条目（磁盘无对象）: " + str(missing[0])[:12] + "（共 %d 条）" % len(missing), "MANIFEST_ENTRY_MISSING")
        if manifest_problem is None:
            reports = [e for e in entries if e.get("type") == CASE_REPORT_TYPE]
            if len(reports) > 1:
                manifest_problem = ("snapshot contains multiple case reports", "CASE_REPORT_MULTIPLE")
            elif reports:
                report = reports[0]
                expected_inputs = sorted(e.get("artifact_id") for e in entries if e is not report)
                actual_inputs = report.get("inputs")
                if (report.get("canonical_path") != "report.md" or report.get("producer") != "report-finalize"
                        or report.get("schema_major") != "1" or not isinstance(actual_inputs, list)
                        or actual_inputs != expected_inputs):
                    manifest_problem = ("case report binding metadata invalid", "CASE_REPORT_BINDING_INVALID")
        if manifest_problem:
            add("MANIFEST_COMPLETE", VALIDATOR_FAIL, manifest_problem[0], manifest_problem[1])
        else:
            add("MANIFEST_COMPLETE", VALIDATOR_PASS, "%d 条 manifest 条目均在磁盘有对应对象" % len(entries))

        index, idx_problems = _artifact_index(case_dir, manifest)

        # ── MANIFEST_DISK_HASH ─────────────────────────────────────────
        hash_fail = None
        canonical_fail = None
        for entry in entries:
            aid = entry.get("artifact_id")
            atype = entry.get("type")
            if not isinstance(aid, str) or not isinstance(atype, str):
                hash_fail = hash_fail or ("manifest 条目缺 artifact_id/type", "MANIFEST_MALFORMED")
                continue
            ok, problems, _stem = _object_verify(ctx, root, case_dir, aid, atype)
            if not ok:
                code, detail = problems[0]
                if code in ("OBJECT_MISSING", "OBJECT_HASH_MISMATCH"):
                    hash_fail = hash_fail or (detail, code)
                else:
                    canonical_fail = canonical_fail or (detail, code)
        if hash_fail:
            add("MANIFEST_DISK_HASH", VALIDATOR_FAIL, hash_fail[0], hash_fail[1])
        elif canonical_fail:
            add("MANIFEST_DISK_HASH", VALIDATOR_FAIL, canonical_fail[0], canonical_fail[1])
        else:
            add("MANIFEST_DISK_HASH", VALIDATOR_PASS, "全部对象名==内容 sha256 且磁盘字节==canonical 字节（%d 个对象）" % len(entries))

        # ── SCHEMA ─────────────────────────────────────────────────────
        schema_fail = None
        for entry in entries:
            aid = entry.get("artifact_id")
            atype = entry.get("type")
            if not isinstance(aid, str) or not isinstance(atype, str) or not atype.endswith("@1"):
                schema_fail = schema_fail or (aid or "?") + ": 类型非法"
                continue
            obj_path = os.path.join(case_dir, "objects", aid)
            if atype == CASE_REPORT_TYPE:
                try:
                    data = _read_file_bytes(obj_path, MAX_CASE_REPORT_BYTES)
                    ok_report, report_code, report_detail, _text = _validate_case_report_bytes(data, case_dir=case_dir)
                except Exception as exc:  # noqa: BLE001
                    ok_report, report_code, report_detail = False, "CASE_REPORT_UNREADABLE", str(exc)[:80]
                if not ok_report:
                    schema_fail = schema_fail or (aid[:12] + ": " + report_code + " " + report_detail)
                continue
            try:
                data = _read_file_bytes(obj_path, 128 * 1024 * 1024)
                tree = json.loads(data.decode("utf-8"))
            except Exception as exc:  # noqa: BLE001
                schema_fail = schema_fail or (aid[:12] + ": 解析失败 " + str(exc)[:80])
                continue
            v = dv.validate_with_ctx(ctx, atype[:-2], tree)
            if not v["ok"]:
                first = (v["errors"] or [{}])[0]
                schema_fail = schema_fail or (aid[:12] + ": " + str(first.get("code", "?")) + "@" + str(first.get("path", "?")))
        if schema_fail:
            add("SCHEMA", VALIDATOR_FAIL, schema_fail, "SCHEMA_VIOLATION")
        else:
            add("SCHEMA", VALIDATOR_PASS, "全部工件通过 schema/sem/c14n 校验（%d 个工件）" % len(entries))

        # ── 三条红线反向核查（仅对快照内实际存在的工件执行）────────────
        by_type = _by_type(index)
        runs = by_type.get("consequence_run@1", [])

        # R1
        if not runs:
            add("R1_CRN_NEQ_GEM", VALIDATOR_SKIP, "SKIP：快照内无 consequence_run@1 工件（不适用）")
        else:
            r1_fail = None
            for aid, info in runs:
                value = info["value"] or {}
                model_ref = _resolve_ref(index, value.get("model_ref"))
                if model_ref is None:
                    r1_fail = r1_fail or (aid[:12] + ": model_ref 未解析到快照内工件")
                    continue
                if model_ref["type"] != "metabolic_model_ref@1":
                    r1_fail = r1_fail or (aid[:12] + ": model_ref 类型为 " + model_ref["type"] + "（红线 R1：consequence 只接受 constraint_gem/metabolic_model_ref@1，不得使用 kinetic_crn_ref@1）")
                    continue
                mm = model_ref["value"] or {}
                sbml_ref = _resolve_ref(index, mm.get("sbml_ref"))
                if sbml_ref is None:
                    r1_fail = r1_fail or (aid[:12] + ": metabolic_model_ref.sbml_ref 断链（SBML/FBC 源未入快照）")
            if r1_fail:
                add("R1_CRN_NEQ_GEM", VALIDATOR_FAIL, r1_fail, "R1_MODEL_REF_INVALID")
            else:
                add("R1_CRN_NEQ_GEM", VALIDATOR_PASS, "%d 个 consequence_run 的 model_ref 均为 metabolic_model_ref@1 且 sbml_ref 链完整" % len(runs))

        # R2 / R3（需要 bound diff）
        diff_runs = []
        for aid, info in runs:
            value = info["value"] or {}
            diffs = []
            for sc in value.get("scenarios") or []:
                diffs.extend(sc.get("diffs") or [])
            if diffs:
                diff_runs.append((aid, value))
        if not diff_runs:
            add("R2_SCORE_NEQ_BOUND", VALIDATOR_SKIP, "SKIP：无含 bound diff 的 consequence_run（不适用）")
            add("R3_PROXY_NEQ_CAPACITY", VALIDATOR_SKIP, "SKIP：无含 bound diff 的 consequence_run（不适用）")
        else:
            # 每个 run 解析其唯一 coupling_profile
            r2_fail = None
            r3_fail = None
            for aid, value in diff_runs:
                profile = _resolve_ref(index, value.get("coupling_ref"))
                if profile is None or profile["type"] != "coupling_profile@1":
                    r3_fail = r3_fail or (aid[:12] + ": coupling_ref 未解析到 coupling_profile@1（红线 R3：coupling_profile@1 是唯一且强制的跨层入口）")
                    r2_fail = r2_fail or (aid[:12] + ": 无授权 coupling_profile，bound diff 不可授权")
                    continue
                prof_value = profile["value"] or {}
                mode = prof_value.get("mode")
                rules = prof_value.get("rules") or []
                rule_by_id = {r.get("rule_id"): r for r in rules if isinstance(r, dict) and isinstance(r.get("rule_id"), str)}
                rule_ids = set(rule_by_id)
                for sc in value.get("scenarios") or []:
                    for diff in sc.get("diffs") or []:
                        rid = diff.get("rule_id")
                        if rid not in rule_ids:
                            r2_fail = r2_fail or (aid[:12] + ": diff rule_id=" + str(rid) + " 不在 coupling_profile 授权规则内（红线 R2：表达分数/未授权值不得用作 bound）")
                        elif mode == "qualitative_direction":
                            r2_fail = r2_fail or (aid[:12] + ": coupling mode=qualitative_direction 却产出数值 bound diff（红线 R2）")
                        else:
                            rule = rule_by_id[rid]
                            gpr_ref = _resolve_ref(index, rule.get("gpr_proof_ref"))
                            if gpr_ref is None or gpr_ref["type"] != "gpr_proof@1":
                                r3_fail = r3_fail or (aid[:12] + ": rule " + str(rid) + " gpr_proof_ref 断链（非 gpr_proof@1）")
                            for eref in rule.get("evidence_refs") or []:
                                target = index.get(eref) if isinstance(eref, str) else None
                                if target is None or target["type"] != "evidence_item@1":
                                    r3_fail = r3_fail or (aid[:12] + ": rule " + str(rid) + " evidence_ref 断链 " + str(eref)[:12])
                            for aref in rule.get("assumption_refs") or []:
                                target = index.get(aref) if isinstance(aref, str) else None
                                if target is None or target["type"] != "condition_card@1":
                                    r3_fail = r3_fail or (aid[:12] + ": rule " + str(rid) + " assumption_ref 断链 " + str(aref)[:12])
                for sc in value.get("scenarios") or []:
                    for pid in sc.get("mapping_proof_ids") or []:
                        target = index.get(pid) if isinstance(pid, str) else None
                        if target is None or target["type"] != "gpr_proof@1":
                            r3_fail = r3_fail or (aid[:12] + ": mapping_proof_id 断链 " + str(pid)[:12])
            if r2_fail:
                add("R2_SCORE_NEQ_BOUND", VALIDATOR_FAIL, r2_fail, "R2_UNAUTHORIZED_BOUND")
            else:
                add("R2_SCORE_NEQ_BOUND", VALIDATOR_PASS, "%d 个 bound diff 全部经 coupling_profile 授权" % sum(len([d for sc in v2.get("scenarios") or [] for d in sc.get("diffs") or []]) for _a, v2 in diff_runs))
            if r3_fail:
                add("R3_PROXY_NEQ_CAPACITY", VALIDATOR_FAIL, r3_fail, "R3_CHAIN_BROKEN")
            else:
                add("R3_PROXY_NEQ_CAPACITY", VALIDATOR_PASS, "每个 bound diff 的 唯一 coupling_profile→rule_id→证据/假设 ID→GPR mapping proof 链完整")

        # ── DAG 无环 ───────────────────────────────────────────────────
        dags = by_type.get("provenance_dag@1", [])
        if not dags:
            add("DAG_ACYCLIC", VALIDATOR_SKIP, "SKIP：快照内无 provenance_dag@1 工件（不适用）")
        else:
            dag_fail = None
            for aid, info in dags:
                value = info["value"] or {}
                nodes = {n.get("id") for n in value.get("nodes") or [] if isinstance(n.get("id"), str)}
                edges = value.get("edges") or []
                for e in edges:
                    if e.get("from") not in nodes or e.get("to") not in nodes:
                        dag_fail = dag_fail or (aid[:12] + ": edge 端点不在 nodes 中（" + str(e.get("from"))[:12] + "→" + str(e.get("to"))[:12] + "）")
                        break
                if dag_fail:
                    break
                # DFS 三色环检测
                adj = {}
                for e in edges:
                    adj.setdefault(e.get("from"), []).append(e.get("to"))
                color = {}

                def visit(nid):
                    color[nid] = 1
                    for nxt in adj.get(nid, []):
                        c = color.get(nxt, 0)
                        if c == 1:
                            return False
                        if c == 0 and not visit(nxt):
                            return False
                    color[nid] = 2
                    return True

                for nid in sorted(nodes):
                    if color.get(nid, 0) == 0 and not visit(nid):
                        dag_fail = dag_fail or (aid[:12] + ": DAG 存在环")
                        break
            if dag_fail:
                add("DAG_ACYCLIC", VALIDATOR_FAIL, dag_fail, "DAG_CYCLE")
            else:
                add("DAG_ACYCLIC", VALIDATOR_PASS, "%d 个 provenance_dag 无环且端点完整" % len(dags))

    overall_ok = not fail_codes
    return checks, overall_ok, (fail_codes[0] if fail_codes else None)


def op_design_casefile_validate(args):
    """正式工具级 validate：casefile_dir + strict；逐检查项报告；FAIL → INVALID_INPUT。"""
    case_dir = args.get("casefile_dir")
    if not isinstance(case_dir, str) or not case_dir:
        return _envelope("INVALID_INPUT", "INVALID_CASEFILE_DIR", [], "casefile_dir 必填（case 根目录）")
    case_dir = os.path.abspath(case_dir)
    if not os.path.isdir(case_dir):
        return _envelope("INVALID_INPUT", "INVALID_CASEFILE_DIR", [], "casefile_dir 不存在或不是目录")
    strict = args.get("strict", True)
    if not isinstance(strict, bool):
        return _envelope("INVALID_INPUT", "INVALID_STRICT", [], "strict 必须为布尔值")
    explicit_snapshot = args.get("snapshot_sha")
    if explicit_snapshot is not None and (not isinstance(explicit_snapshot, str) or not H64_RE.fullmatch(explicit_snapshot)):
        return _envelope("INVALID_INPUT", "SNAPSHOT_SHA_INVALID", [], "snapshot_sha must be lowercase sha256")
    root = _packet_root()
    idp = _identity_problems(root)
    if idp:
        return _envelope("DEPENDENCY_UNAVAILABLE", "PACKET_IDENTITY_MISMATCH", [], "identity: " + idp[0])
    ctx, errs0 = dv.load_packet_context(root)
    if ctx is None:
        return _envelope("DEPENDENCY_UNAVAILABLE", "PACKET_UNVERIFIED", [], errs0[0].get("detail", "packet load failed"))
    try:
        checks, overall_ok, first_fail = _run_checks(case_dir, root, ctx, snapshot_sha=explicit_snapshot)
    except Exception as exc:  # noqa: BLE001
        return _envelope("EXECUTION_ERROR", "INTERNAL_ERROR", [], "validate 内部异常: " + str(exc)[:160])
    snapshot_sha = explicit_snapshot
    if snapshot_sha is None:
        try:
            head_path = os.path.join(case_dir, "HEAD.json")
            if os.path.exists(head_path):
                with open(head_path, encoding="utf-8") as fh:
                    snapshot_sha = json.load(fh).get("snapshot_sha")
        except Exception:  # noqa: BLE001
            pass
    env = _envelope(
        "OK" if overall_ok else "INVALID_INPUT",
        "OK" if overall_ok else (first_fail or "VALIDATION_FAILED"),
        [],
        ("strict=%s；%d 项检查（PASS %d / FAIL %d / SKIP %d）" % (
            strict,
            len(checks),
            sum(1 for c in checks if c["status"] == VALIDATOR_PASS),
            sum(1 for c in checks if c["status"] == VALIDATOR_FAIL),
            sum(1 for c in checks if c["status"] == VALIDATOR_SKIP),
        )),
        checks,
    )
    if snapshot_sha:
        env["snapshot_sha"] = snapshot_sha
    return env


def _legacy_report_md(case_dir, manifest, index, by_type, checks, snapshot_sha):
    """确定性 report.md（禁含：case_instance_id/真实 workdir/临时路径/run UUID/真实时间/
    stderr 原文/bundle 输出路径/snapshot_sha）。所有内容由快照数据派生，无运行时熵。"""
    lines = []
    lines.append("# 设计 casefile 导出报告")
    lines.append("")
    lines.append("- case_content_id: " + str(manifest.get("case_content_id", "")))
    policy = manifest.get("policy") or {}
    lines.append("- policy_id: " + str(policy.get("policy_id", "")))
    lines.append("- policy_version: " + str(policy.get("policy_version", "")))
    lines.append("- policy_hash: " + str(policy.get("policy_hash", "")))
    entries = manifest.get("artifacts") or []
    lines.append("- 工件统计: %d 个工件 / %d 种类型" % (len(entries), len(by_type)))
    lines.append("")
    lines.append("## 验证摘要")
    lines.append("")
    lines.append("| check_id | status | required |")
    lines.append("| --- | --- | --- |")
    for c in sorted(checks, key=lambda x: x["check_id"]):
        lines.append("| %s | %s | %s |" % (c["check_id"], c["status"], "yes" if c["required"] else "no"))
    lines.append("")
    lines.append("## 工件清单")
    lines.append("")
    lines.append("| artifact_id | type | producer | inputs |")
    lines.append("| --- | --- | --- | --- |")
    for aid, info in sorted(index.items(), key=lambda x: (x[1]["type"], x[0])):
        entry = next((e for e in entries if e.get("artifact_id") == aid), {})
        inputs = ",".join(sorted(entry.get("inputs") or []))
        lines.append("| %s | %s | %s | %s |" % (aid, info["type"], entry.get("producer", ""), inputs))
    lines.append("")
    lines.append("## 证据分级")
    lines.append("")
    evs = by_type.get("evidence_item@1", [])
    if evs:
        lines.append("| artifact_id | match_grade | source | host | readout |")
        lines.append("| --- | --- | --- | --- | --- |")
        for aid, info in evs:
            v = info["value"] or {}
            src = v.get("source_ref") or {}
            host = v.get("host") or {}
            ro = v.get("readout") or {}
            lines.append("| %s | %s | %s | %s | %s %s%s |" % (
                aid, v.get("match_grade", ""),
                str(src.get("kind", "")) + ":" + str(src.get("id", "")),
                str(host.get("organism", "")),
                str(ro.get("metric", "")), str(ro.get("value", "")), str(ro.get("unit", "")),
            ))
    else:
        lines.append("（无 evidence_item@1 工件）")
    lines.append("")
    lines.append("## 假设清单")
    lines.append("")
    cards = by_type.get("condition_card@1", [])
    if cards:
        lines.append("### 假设卡片（condition_card@1）")
        lines.append("")
        lines.append("| artifact_id | medium | culture_mode | readout |")
        lines.append("| --- | --- | --- | --- |")
        for aid, info in cards:
            v = info["value"] or {}
            med = v.get("medium") or {}
            ro = v.get("readout") or {}
            lines.append("| %s | %s | %s | %s |" % (aid, str(med.get("name", "")) + "(" + ",".join(med.get("carbon_sources") or []) + ")", v.get("culture_mode", ""), str(ro.get("kind", "")) + ":" + str(ro.get("unit", ""))))
        lines.append("")
    profs = by_type.get("coupling_profile@1", [])
    if profs:
        lines.append("### coupling 规则（coupling_profile@1）")
        lines.append("")
        lines.append("| profile_id | rule_id | input_kind | confidence | operation | derived_bound | unit | evidence_refs | assumption_refs |")
        lines.append("| --- | --- | --- | --- | --- | --- | --- | --- | --- |")
        for aid, info in profs:
            v = info["value"] or {}
            for rule in sorted([r for r in v.get("rules") or [] if isinstance(r, dict)], key=lambda r: str(r.get("rule_id"))):
                lines.append("| %s | %s | %s | %s | %s | %s | %s | %s | %s |" % (
                    aid, rule.get("rule_id", ""), rule.get("input_kind", ""), rule.get("confidence", ""),
                    rule.get("operation", ""), rule.get("derived_bound", ""), rule.get("unit", ""),
                    ",".join(sorted(rule.get("evidence_refs") or [])),
                    ",".join(sorted(rule.get("assumption_refs") or [])),
                ))
        lines.append("")
    lines.append("## 结论记录（claims）")
    lines.append("")
    claims = []
    for aid, info in by_type.get("consequence_run@1", []):
        v = info["value"] or {}
        for ct in v.get("claim_targets") or []:
            claims.append((str(ct.get("claim_id", "")), ct, aid))
    if claims:
        lines.append("| claim_id | kind | direction | run | scenario |")
        lines.append("| --- | --- | --- | --- | --- |")
        for cid, ct, run_aid in sorted(claims, key=lambda x: x[0]):
            lines.append("| %s | %s | %s | %s | %s |" % (cid, ct.get("kind", ""), ct.get("direction", ""), run_aid, ""))
        lines.append("")
        lines.append("（direction 为 claim 记录原样转录；科学结论分级 SUPPORTED/CONDITIONAL/INDETERMINATE/BLOCKED 由 report-finalize/B4 产生，本报告不推断。）")
    else:
        lines.append("（无 claim 记录）")
    lines.append("")
    lines.append("## 不可重放项清单")
    lines.append("")
    lines.append("以下条目无法仅凭快照字节重放，需外部运行时/审计记录/原始外部文件：")
    lines.append("")
    lines.append("| item | 原因 |")
    lines.append("| --- | --- |")
    for aid, info in by_type.get("consequence_run@1", []):
        v = info["value"] or {}
        solver = (v.get("baseline") or {}).get("solver") or {}
        lines.append("| consequence_run %s 求解结果（solver %s %s，baseline %s） | 需外部求解器运行时，FBA/FVA/PFBA 数值不可由快照重算 |" % (
            aid, solver.get("id", ""), solver.get("version", ""), (v.get("baseline") or {}).get("status", "")))
        for sc in sorted([s for s in v.get("scenarios") or [] if isinstance(s, dict)], key=lambda s: str(s.get("name"))):
            lines.append("| consequence_run %s 场景 %s fba/fva/pfba 结果 | 需外部求解器运行时，数值不可由快照重算 |" % (aid, str(sc.get("name", ""))))
    for aid, info in by_type.get("tool_result@1", []):
        lines.append("| tool_result %s（审计运行记录） | audit overlay，非科学输入 |" % aid)
    for aid, info in by_type.get("gem_card_raw@1", []):
        lines.append("| gem_card_raw %s（外部原始卡片字节） | 需原始外部文件复核 |" % aid)
    if not any(t in by_type for t in ("consequence_run@1", "tool_result@1", "gem_card_raw@1")):
        lines.append("| （无） | 本快照无不可重放项 |")
    lines.append("")
    return "\n".join(lines) + "\n"


def _legacy_build_bundle(case_dir, manifest, index, report_text, out_zip_path):
    """bundle.zip：snapshot.json + objects/<id> + report.md + hashes.sha256；确定性。
    hashes.sha256 覆盖 zip 内全部其他条目（可独立复核）；条目按名排序、固定时间戳、STORE。"""
    entries = {}  # relpath -> bytes
    snap_path = os.path.join(case_dir, "snapshots", str(manifest.get("snapshot_sha", "")) + ".json")
    if os.path.exists(snap_path):
        with open(snap_path, "rb") as fh:
            entries["snapshot.json"] = fh.read()
    for aid in sorted(index.keys()):
        obj_path = os.path.join(case_dir, "objects", aid)
        with open(obj_path, "rb") as fh:
            entries["objects/" + aid] = fh.read()
    entries["report.md"] = report_text.encode("utf-8")
    hash_lines = []
    for rel in sorted(entries.keys()):
        hash_lines.append("%s  %s" % (hashlib.sha256(entries[rel]).hexdigest(), rel))
    entries["hashes.sha256"] = ("\n".join(hash_lines) + "\n").encode("utf-8")
    with zipfile.ZipFile(out_zip_path, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as zf:
        for rel in sorted(entries.keys()):
            info = zipfile.ZipInfo(rel, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_STORED
            info.external_attr = (0o644 << 16)
            zf.writestr(info, entries[rel])
    return sorted(entries.keys())


def op_design_casefile_export(args):
    """正式工具级 export：validate 门禁 → report.md + bundle.zip（导出侧产物，不改科学快照）。"""
    case_dir = args.get("casefile_dir")
    if not isinstance(case_dir, str) or not case_dir:
        return _envelope("INVALID_INPUT", "INVALID_CASEFILE_DIR", [], "casefile_dir 必填（case 根目录）")
    case_dir = os.path.abspath(case_dir)
    if not os.path.isdir(case_dir):
        return _envelope("INVALID_INPUT", "INVALID_CASEFILE_DIR", [], "casefile_dir 不存在或不是目录")
    fmt = args.get("format", "both")
    if fmt not in ("zip", "report", "both"):
        return _envelope("INVALID_INPUT", "INVALID_FORMAT", [], "format 必须为 zip/report/both")
    root = _packet_root()
    idp = _identity_problems(root)
    if idp:
        return _envelope("DEPENDENCY_UNAVAILABLE", "PACKET_IDENTITY_MISMATCH", [], "identity: " + idp[0])
    ctx, errs0 = dv.load_packet_context(root)
    if ctx is None:
        return _envelope("DEPENDENCY_UNAVAILABLE", "PACKET_UNVERIFIED", [], errs0[0].get("detail", "packet load failed"))
    try:
        checks, overall_ok, first_fail = _run_checks(case_dir, root, ctx)
    except Exception as exc:  # noqa: BLE001
        return _envelope("EXECUTION_ERROR", "INTERNAL_ERROR", [], "export 内部异常: " + str(exc)[:160])
    if not overall_ok:
        return _envelope("INVALID_INPUT", "VALIDATE_GATE_FAILED", [],
                         "validate 未通过（首失败 check: %s）→ 拒绝导出" % (first_fail or "?"), checks)
    # 绑定同一 snapshot
    snapshot_sha = None
    manifest = None
    index = {}
    head_path = os.path.join(case_dir, "HEAD.json")
    if os.path.exists(head_path):
        with open(head_path, encoding="utf-8") as fh:
            snapshot_sha = json.load(fh).get("snapshot_sha")
    if snapshot_sha:
        _m, problems = _load_snapshot(case_dir, root, ctx, snapshot_sha)
        if _m is None:
            return _envelope("EXECUTION_ERROR", "SNAPSHOT_UNREADABLE", [], problems[0])
        manifest = _m
        index, _p = _artifact_index(case_dir, manifest)
    else:
        return _envelope("EXECUTION_ERROR", "SNAPSHOT_MISSING", [], "无 HEAD snapshot，无法导出")
    by_type = _by_type(index)
    report_text = _legacy_report_md(case_dir, manifest, index, by_type, checks, snapshot_sha)
    export_root = os.path.join(os.path.dirname(case_dir), "exports", snapshot_sha[:12])
    os.makedirs(export_root, exist_ok=True)
    artifact_refs = []
    if fmt in ("report", "both"):
        report_path = os.path.join(export_root, "report.md")
        with open(report_path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write(report_text)
        artifact_refs.append(report_path)
    if fmt in ("zip", "both"):
        bundle_path = os.path.join(export_root, "bundle.zip")
        _legacy_build_bundle(case_dir, manifest, index, report_text, bundle_path)
        artifact_refs.append(bundle_path)
    env = _envelope("OK", "OK", artifact_refs,
                    "export 完成：report.md + bundle.zip（%d 个工件 + 哈希清单；不可重放项已列于报告）" % len(index))
    env["checks"] = checks
    if snapshot_sha:
        env["snapshot_sha"] = snapshot_sha
    return env


def _load_packet_context_or_envelope():
    """Load the frozen packet once for a B4 private render or pure export."""
    root = _packet_root()
    identity = _identity_problems(root)
    if identity:
        return None, None, _envelope("DEPENDENCY_UNAVAILABLE", "PACKET_IDENTITY_MISMATCH", [], "identity: " + identity[0])
    ctx, errors = dv.load_packet_context(root)
    if ctx is None:
        return None, None, _envelope("DEPENDENCY_UNAVAILABLE", "PACKET_UNVERIFIED", [], errors[0].get("detail", "packet load failed"))
    return root, ctx, None


def _read_target_snapshot(args, case_dir):
    """Select an explicit immutable target, falling back to one HEAD read."""
    target = args.get("snapshot_sha")
    if target is not None:
        if not isinstance(target, str) or not H64_RE.fullmatch(target):
            return None, _envelope("INVALID_INPUT", "SNAPSHOT_SHA_INVALID", [], "snapshot_sha must be lowercase sha256")
        return target, None
    try:
        with open(os.path.join(case_dir, "HEAD.json"), encoding="utf-8") as fh:
            target = json.load(fh).get("snapshot_sha")
    except Exception as exc:  # noqa: BLE001
        return None, _envelope("INVALID_INPUT", "SNAPSHOT_MISSING", [], "HEAD unavailable: " + str(exc)[:120])
    if not isinstance(target, str) or not H64_RE.fullmatch(target):
        return None, _envelope("INVALID_INPUT", "SNAPSHOT_SHA_INVALID", [], "HEAD snapshot sha invalid")
    return target, None


def _report_md_b4(manifest, index, by_type, checks, audit_view_id):
    """Render deterministic B4 report bytes from immutable S_n data only.

    The report intentionally prints only IDs, fixed vocabularies and counts.
    Free producer/source/solver strings could carry runtime entropy through an
    otherwise valid scientific object and are therefore not report fields.
    """
    lines = [CASE_REPORT_HEADER.rstrip("\n"), ""]
    lines.append("- case_content_id: " + str(manifest.get("case_content_id", "")))
    lines.append("- policy_hash: " + str((manifest.get("policy") or {}).get("policy_hash", "")))
    source_entries = [entry for entry in (manifest.get("artifacts") or []) if entry.get("type") != CASE_REPORT_TYPE]
    lines.append("- artifact_count: %d" % len(source_entries))
    lines.append("")

    lines.append("## 审计视图")
    lines.append("")
    if audit_view_id:
        for audit_id in audit_view_id:
            lines.append("- audit_record_id: " + audit_id)
    else:
        lines.append("- audit_record_id: none")
    lines.append("")

    lines.append("## 验证摘要")
    lines.append("")
    lines.append("| check_id | status | required |")
    lines.append("| --- | --- | --- |")
    for check in sorted(checks, key=lambda item: item["check_id"]):
        lines.append("| %s | %s | %s |" % (check["check_id"], check["status"], "yes" if check["required"] else "no"))
    lines.append("")

    lines.append("## 工件清单")
    lines.append("")
    lines.append("| artifact_id | type | inputs |")
    lines.append("| --- | --- | --- |")
    entry_by_id = {entry.get("artifact_id"): entry for entry in source_entries}
    for artifact_id, info in sorted(index.items(), key=lambda item: (item[1]["type"], item[0])):
        if info["type"] == CASE_REPORT_TYPE:
            continue
        entry = entry_by_id.get(artifact_id) or {}
        lines.append("| %s | %s | %s |" % (artifact_id, info["type"], ",".join(sorted(entry.get("inputs") or []))))
    lines.append("")

    lines.append("## 证据分级")
    lines.append("")
    evidence = by_type.get("evidence_item@1", [])
    if evidence:
        lines.append("| artifact_id | match_grade |")
        lines.append("| --- | --- |")
        for artifact_id, info in evidence:
            lines.append("| %s | %s |" % (artifact_id, (info["value"] or {}).get("match_grade", "")))
    else:
        lines.append("（无 evidence_item@1 工件）")
    lines.append("")

    lines.append("## 假设清单")
    lines.append("")
    cards = by_type.get("condition_card@1", [])
    profiles = by_type.get("coupling_profile@1", [])
    if cards or profiles:
        lines.append("| artifact_id | category | item_count |")
        lines.append("| --- | --- | --- |")
        for artifact_id, _info in cards:
            lines.append("| %s | condition_card@1 | 1 |" % artifact_id)
        for artifact_id, info in profiles:
            count = len([rule for rule in (info["value"] or {}).get("rules") or [] if isinstance(rule, dict)])
            lines.append("| %s | coupling_profile@1 | %d |" % (artifact_id, count))
    else:
        lines.append("（无 condition_card@1 或 coupling_profile@1 工件）")
    lines.append("")

    lines.append("## 结论记录（claims）")
    lines.append("")
    claim_id_re = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")
    registered_claims = []
    for artifact_id, info in by_type.get("claim@1", []):
        claim_id = (info["value"] or {}).get("claim_id")
        if isinstance(claim_id, str) and claim_id_re.fullmatch(claim_id):
            registered_claims.append((claim_id, artifact_id))
    if registered_claims:
        lines.append("| claim_id | artifact_id |")
        lines.append("| --- | --- |")
        for claim_id, artifact_id in sorted(registered_claims):
            lines.append("| %s | %s |" % (claim_id, artifact_id))
        lines.append("")
        lines.append("仅呈现已注册 claim@1 标识；不由运行记录推断科学状态。")
    else:
        lines.append("（无可渲染已注册 claim@1；运行记录中的 target 不被提升为科学结论）")
    lines.append("")

    lines.append("## 不可重放项清单")
    lines.append("")
    nonreplay = []
    for artifact_type in ("consequence_run@1", "gem_card_raw@1"):
        for artifact_id, _info in by_type.get(artifact_type, []):
            nonreplay.append((artifact_id, artifact_type))
    lines.append("| artifact_id | category |")
    lines.append("| --- | --- |")
    if nonreplay:
        for artifact_id, artifact_type in sorted(nonreplay):
            lines.append("| %s | %s |" % (artifact_id, artifact_type))
    else:
        lines.append("| none | none |")
    return "\n".join(lines) + "\n"


def _stage_report_finalize(args):
    """Private render phase: write report.md only into TS-owned staging."""
    case_dir = args.get("casefile_dir")
    if not isinstance(case_dir, str) or not case_dir:
        return _envelope("INVALID_INPUT", "INVALID_CASEFILE_DIR", [], "casefile_dir required")
    case_dir = os.path.abspath(case_dir)
    if not os.path.isdir(case_dir):
        return _envelope("INVALID_INPUT", "INVALID_CASEFILE_DIR", [], "casefile_dir missing")
    source_snapshot_sha = args.get("source_snapshot_sha")
    if not isinstance(source_snapshot_sha, str) or not H64_RE.fullmatch(source_snapshot_sha):
        return _envelope("INVALID_INPUT", "REPORT_PARENT_INVALID", [], "source_snapshot_sha must be lowercase sha256")
    if "audit_view_id" not in args:
        return _envelope("INVALID_INPUT", "INVALID_AUDIT_VIEW_ID", [], "audit_view_id required")
    audit_view_id, audit_code, audit_detail = _canonical_audit_view(args.get("audit_view_id"))
    if audit_code:
        return _envelope("INVALID_INPUT", audit_code, [], audit_detail)
    staging_dir = os.environ.get("DSH_DESIGN_STAGING")
    staging_root = os.path.realpath(os.path.join(case_dir, "staging"))
    staging_real = os.path.realpath(staging_dir) if staging_dir else ""
    try:
        contained = bool(staging_real) and os.path.commonpath([staging_root, staging_real]) == staging_root
    except ValueError:
        contained = False
    if not contained or not os.path.isdir(staging_real) or os.path.islink(staging_dir):
        return _envelope("INVALID_INPUT", "STAGING_DIR_INVALID", [], "TS-owned staging directory required")
    root, ctx, error = _load_packet_context_or_envelope()
    if error:
        return error
    try:
        checks, overall_ok, first_fail = _run_checks(case_dir, root, ctx, snapshot_sha=source_snapshot_sha)
    except Exception as exc:  # noqa: BLE001
        return _envelope("EXECUTION_ERROR", "INTERNAL_ERROR", [], "report render failed: " + str(exc)[:160])
    if not overall_ok:
        return _envelope("INVALID_INPUT", "VALIDATE_GATE_FAILED", [], "source snapshot validation failed: " + str(first_fail or "?"), checks)
    manifest, problems = _load_snapshot(case_dir, root, ctx, source_snapshot_sha)
    if manifest is None:
        return _envelope("EXECUTION_ERROR", "SNAPSHOT_UNREADABLE", [], problems[0][1] if problems else "source snapshot unavailable")
    if any(entry.get("type") == CASE_REPORT_TYPE for entry in manifest.get("artifacts") or []):
        return _envelope("INVALID_INPUT", "REPORT_ALREADY_FINALIZED", [], "source snapshot already has case_report@1", checks)
    index, _problems = _artifact_index(case_dir, manifest)
    report_bytes = _report_md_b4(manifest, index, _by_type(index), checks, audit_view_id).encode("utf-8")
    valid, code, detail, _text = _validate_case_report_bytes(report_bytes, case_dir=case_dir, source_snapshot_sha=source_snapshot_sha)
    if not valid:
        return _envelope("INVALID_INPUT", code, [], detail, checks)
    report_id = hashlib.sha256(report_bytes).hexdigest()
    staged_path = os.path.join(staging_real, "report.md")
    if os.path.lexists(staged_path):
        return _envelope("INVALID_INPUT", "STAGING_REPORT_EXISTS", [], "fresh report staging target required", checks)
    try:
        with open(staged_path, "xb") as fh:
            fh.write(report_bytes)
            fh.flush()
            os.fsync(fh.fileno())
    except Exception as exc:  # noqa: BLE001
        return _envelope("EXECUTION_ERROR", "STAGING_WRITE_FAILED", [], "report staging write failed: " + str(exc)[:120], checks)
    env = _envelope("OK", "OK", [{"artifact_id": report_id, "expected_sha256": report_id, "relative_path": "report.md"}], "deterministic report staged", checks)
    env["source_snapshot_sha"] = source_snapshot_sha
    env["report_sha256"] = report_id
    env["audit_view_id"] = audit_view_id
    return env


def _build_bundle_b4(case_dir, manifest, index, report_bytes, out_zip_path):
    """Build deterministic export bytes from the already-committed report."""
    entries = {}
    snap_path = os.path.join(case_dir, "snapshots", str(manifest.get("snapshot_sha", "")) + ".json")
    with open(snap_path, "rb") as fh:
        entries["snapshot.json"] = fh.read()
    for artifact_id in sorted(index.keys()):
        with open(os.path.join(case_dir, "objects", artifact_id), "rb") as fh:
            entries["objects/" + artifact_id] = fh.read()
    entries["report.md"] = bytes(report_bytes)
    entries["hashes.sha256"] = ("\n".join(
        "%s  %s" % (hashlib.sha256(entries[rel]).hexdigest(), rel)
        for rel in sorted(entries.keys())
    ) + "\n").encode("utf-8")
    with zipfile.ZipFile(out_zip_path, "w", compression=zipfile.ZIP_STORED, allowZip64=True) as zf:
        for rel in sorted(entries.keys()):
            info = zipfile.ZipInfo(rel, date_time=(1980, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_STORED
            info.external_attr = (0o644 << 16)
            zf.writestr(info, entries[rel])
    return sorted(entries.keys())


def op_design_casefile_export(args):
    """B4 pure export, plus its private TS-owned report render prephase."""
    if args.get("_stage_report") is True:
        return _stage_report_finalize(args)
    if "_stage_report" in args:
        return _envelope("INVALID_INPUT", "STAGE_MODE_INVALID", [], "_stage_report must be true when supplied")
    case_dir = args.get("casefile_dir")
    if not isinstance(case_dir, str) or not case_dir:
        return _envelope("INVALID_INPUT", "INVALID_CASEFILE_DIR", [], "casefile_dir required")
    case_dir = os.path.abspath(case_dir)
    if not os.path.isdir(case_dir):
        return _envelope("INVALID_INPUT", "INVALID_CASEFILE_DIR", [], "casefile_dir missing")
    fmt = args.get("format", "both")
    if fmt not in ("zip", "report", "both"):
        return _envelope("INVALID_INPUT", "INVALID_FORMAT", [], "format must be zip/report/both")
    snapshot_sha, target_error = _read_target_snapshot(args, case_dir)
    if target_error:
        return target_error
    root, ctx, error = _load_packet_context_or_envelope()
    if error:
        return error
    try:
        checks, overall_ok, first_fail = _run_checks(case_dir, root, ctx, snapshot_sha=snapshot_sha)
    except Exception as exc:  # noqa: BLE001
        return _envelope("EXECUTION_ERROR", "INTERNAL_ERROR", [], "export internal error: " + str(exc)[:160])
    if not overall_ok:
        return _envelope("INVALID_INPUT", "VALIDATE_GATE_FAILED", [], "validation failed: " + str(first_fail or "?"), checks)
    manifest, problems = _load_snapshot(case_dir, root, ctx, snapshot_sha)
    if manifest is None:
        return _envelope("EXECUTION_ERROR", "SNAPSHOT_UNREADABLE", [], problems[0][1] if problems else "snapshot unavailable", checks)
    reports = [entry for entry in manifest.get("artifacts") or [] if entry.get("type") == CASE_REPORT_TYPE]
    if len(reports) != 1:
        return _envelope("INVALID_INPUT", "REPORT_FINALIZE_REQUIRED", [], "immutable snapshot must contain exactly one finalized report", checks)
    report_id = reports[0].get("artifact_id")
    if not isinstance(report_id, str) or not H64_RE.fullmatch(report_id):
        return _envelope("INVALID_INPUT", "REPORT_FINALIZE_REQUIRED", [], "finalized report artifact id invalid", checks)
    try:
        report_bytes = _read_file_bytes(os.path.join(case_dir, "objects", report_id), MAX_CASE_REPORT_BYTES)
    except Exception as exc:  # noqa: BLE001
        return _envelope("INVALID_INPUT", "REPORT_FINALIZE_REQUIRED", [], "finalized report unreadable: " + str(exc)[:80], checks)
    if hashlib.sha256(report_bytes).hexdigest() != report_id:
        return _envelope("INVALID_INPUT", "OBJECT_HASH_MISMATCH", [], "finalized report hash mismatch", checks)
    valid, code, detail, _text = _validate_case_report_bytes(report_bytes, case_dir=case_dir)
    if not valid:
        return _envelope("INVALID_INPUT", code, [], detail, checks)
    index, _problems = _artifact_index(case_dir, manifest)
    export_root = os.path.join(os.path.dirname(case_dir), "exports", snapshot_sha[:12])
    os.makedirs(export_root, exist_ok=True)
    artifact_refs = []
    if fmt in ("report", "both"):
        report_path = os.path.join(export_root, "report.md")
        with open(report_path, "wb") as fh:
            fh.write(report_bytes)
        artifact_refs.append(report_path)
    if fmt in ("zip", "both"):
        bundle_path = os.path.join(export_root, "bundle.zip")
        _build_bundle_b4(case_dir, manifest, index, report_bytes, bundle_path)
        artifact_refs.append(bundle_path)
    env = _envelope("OK", "OK", artifact_refs, "export completed from finalized immutable report (%d objects)" % len(index), checks)
    env["snapshot_sha"] = snapshot_sha
    env["report_artifact_id"] = report_id
    return env


# ── 独立 dispatcher（OPS 表；区别于 bio_ops.py 的 P2-1 exit-0 契约）─────────
OPS = {
    "design_casefile_validate": op_design_casefile_validate,
    "design_casefile_export": op_design_casefile_export,
}


def main():
    raw = sys.stdin.buffer.read().decode("utf-8", errors="replace")
    if not raw.strip():
        print(json.dumps({"ok": False, "status": "INVALID_INPUT", "reason_code": "EMPTY_REQUEST",
                          "artifact_refs": [], "detail": "empty request"}))
        return 2
    try:
        req = json.loads(raw)
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "status": "INVALID_INPUT", "reason_code": "BAD_REQUEST",
                          "artifact_refs": [], "detail": "request not json: " + str(exc)[:80]}))
        return 2
    op = req.get("op")
    args = req.get("args") or {}
    if not isinstance(op, str) or op not in OPS:
        print(json.dumps({"ok": False, "status": "INVALID_INPUT", "reason_code": "UNKNOWN_OP",
                          "artifact_refs": [], "detail": "unknown op: " + str(op)}))
        return 2
    try:
        env = OPS[op](args)
        ok = env.get("status") == "OK"
        print(json.dumps(dict(env, ok=ok), ensure_ascii=False))
        return 0 if ok else 1
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "status": "EXECUTION_ERROR", "reason_code": "INTERNAL_ERROR",
                          "artifact_refs": [], "detail": str(exc)[:200]}))
        return 3


if __name__ == "__main__":
    sys.exit(main())
