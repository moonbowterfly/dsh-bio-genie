#!/usr/bin/env python
"""design_ops.py — design 通道 op（v5 §A0.3 接线；仅经 designTool 通道可达）

- design_stage_artifact：identity 校验 → lossless parse → NFC 归一 → schema/sem → canonical
  serialize → 写 staging（stage①；磁盘 bytes = profile canonical bytes，sha256 = artifact identity）
- design_casefile_validate：从 content-addressed 不可变对象重校验（stage③）：要求磁盘 bytes
  == canonical bytes 且对象名 == 内容哈希（snapshot 绑定随 A2）

身份绑定（v5）：packet 根只取 TS 约束值（DSH_DESIGN_PACKET_FIXED；继承的 DSH_DESIGN_PACKET
已被 TS 清除），并校验 index/manifest/acceptance id 与 TS 传递期望一致（split-packet 防线）。
"""
import hashlib
import json
import os
import sys

sys.dont_write_bytecode = True

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

import design_validate as dv  # noqa: E402


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


def op_design_stage_artifact(args):
    """stage①：identity → lossless/canonical → schema/sem；通过才写 staging（canonical bytes）。"""
    staging = os.environ.get("DSH_DESIGN_STAGING")
    if not staging:
        return {"ok": False, "code": "STAGING_ENV_MISSING", "error": "DSH_DESIGN_STAGING 未设置（design op 必须经 designTool 通道执行）"}
    root = _packet_root()
    idp = _identity_problems(root)
    if idp:
        return {"ok": False, "code": "PACKET_IDENTITY_MISMATCH", "error": "identity: " + idp[0], "problems": idp}
    artifact_type = args.get("artifact_type")
    if not isinstance(artifact_type, str) or not artifact_type:
        return {"ok": False, "code": "BAD_REQUEST", "error": "artifact_type 必填"}
    raw = args.get("raw_json")
    if not isinstance(raw, str):
        return {"ok": False, "code": "BAD_REQUEST", "error": "raw_json（原始 JSON 文本）必填——canonical 层要求 raw-byte 输入"}
    ctx, errs0 = dv.load_packet_context(root)
    if ctx is None:
        return {"ok": False, "code": "PACKET_UNVERIFIED", "error": errs0[0].get("detail", "packet load failed")}
    try:
        canon_bytes, tree = dv.canonicalize_bytes(ctx, artifact_type, raw, root)
    except Exception as exc:  # noqa: BLE001
        code = getattr(exc, "code", None) or type(exc).__name__
        detail = getattr(exc, "detail", "")
        return {"ok": False, "code": "VALIDATION_FAILED",
                "error": "c14n: %s %s" % (code, detail), "errors": [{"code": code, "path": detail or "$"}]}
    v = dv.validate_with_ctx(ctx, artifact_type, tree)
    if not v["ok"]:
        first = (v["errors"] or [{}])[0]
        return {"ok": False, "code": "VALIDATION_FAILED",
                "error": "validation failed: " + str(first.get("code", "?")) + "@" + str(first.get("path", "?")),
                "errors": v["errors"], "artifact_type": artifact_type}
    out_path = os.path.join(staging, artifact_type + ".json")
    with open(out_path, "wb") as fh:
        fh.write(canon_bytes)
    return {"ok": True, "staged": out_path, "sha256": hashlib.sha256(canon_bytes).hexdigest(),
            "artifact_type": artifact_type, "canonical": True}


def op_design_casefile_validate(args):
    """stage③：从 content-addressed 对象重校验；磁盘 bytes 必须 == canonical bytes。"""
    obj = args.get("object_path") or args.get("path")
    if not isinstance(obj, str) or not os.path.exists(obj):
        return {"ok": False, "code": "OBJECT_NOT_FOUND", "error": "object_path 不存在"}
    root = _packet_root()
    idp = _identity_problems(root)
    if idp:
        return {"ok": False, "code": "PACKET_IDENTITY_MISMATCH", "error": "identity: " + idp[0], "problems": idp}
    with open(obj, "rb") as fh:
        data = fh.read()
    sha = hashlib.sha256(data).hexdigest()
    if os.path.basename(obj) != sha + ".json":
        return {"ok": False, "code": "OBJECT_HASH_MISMATCH", "error": "对象名与内容哈希不符（非 content-addressed）"}
    try:
        text = data.decode("utf-8")
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "code": "OBJECT_UNREADABLE", "error": str(exc)[:160]}
    ctx, errs0 = dv.load_packet_context(root)
    if ctx is None:
        return {"ok": False, "code": "PACKET_UNVERIFIED", "error": errs0[0].get("detail", "packet load failed")}
    artifact_type = args.get("artifact_type")
    if not artifact_type:
        try:
            probe = json.loads(text)
        except Exception:  # noqa: BLE001
            probe = None
        if isinstance(probe, dict):
            at = probe.get("artifact_type")
            if isinstance(at, str) and at.endswith("@1"):
                artifact_type = at[:-2]
    if not artifact_type:
        return {"ok": False, "code": "BAD_REQUEST", "error": "artifact_type 无法推定，请显式提供"}
    try:
        canon_bytes, tree = dv.canonicalize_bytes(ctx, artifact_type, text, root)
    except Exception as exc:  # noqa: BLE001
        code = getattr(exc, "code", None) or type(exc).__name__
        detail = getattr(exc, "detail", "")
        return {"ok": True, "verdict": "FAIL", "errors": [{"code": code, "path": detail or "$"}],
                "sha256": sha, "artifact_type": artifact_type}
    if canon_bytes != data:
        return {"ok": True, "verdict": "FAIL", "errors": [{"code": "CANONICAL_BYTES_MISMATCH", "path": "$"}],
                "sha256": sha, "artifact_type": artifact_type}
    v = dv.validate_with_ctx(ctx, artifact_type, tree)
    return {"ok": True, "verdict": "PASS" if v["ok"] else "FAIL", "errors": v["errors"],
            "sha256": sha, "artifact_type": artifact_type, "canonical": True}
