#!/usr/bin/env python
"""design_ops.py — design 通道 op（v4 §A0.3 接线；仅经 designTool 通道可达）

- design_stage_artifact：validate → 写 staging/<dispatch_id>/（stage①，Python 写盘前门）
- design_casefile_validate：从 content-addressed 不可变对象重新执行校验（stage③；
  snapshot 绑定随 A2 落地）

raw 通道（/execute-tool、普通 callBio）由 TS 侧在 spawn 前拒绝（PANEL_OP_NOT_ALLOWED /
DESIGN_TOOL_REQUIRED）；本模块不设独立入口。
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


def op_design_stage_artifact(args):
    """stage①：校验通过才写 staging（fail-closed，绝不先写后验）。"""
    staging = os.environ.get("DSH_DESIGN_STAGING")
    if not staging:
        return {"ok": False, "code": "STAGING_ENV_MISSING", "error": "DSH_DESIGN_STAGING 未设置（design op 必须经 designTool 通道执行）"}
    artifact_type = args.get("artifact_type")
    if not isinstance(artifact_type, str) or not artifact_type:
        return {"ok": False, "code": "BAD_REQUEST", "error": "artifact_type 必填"}
    value = args.get("value")
    v = dv.validate_artifact(artifact_type, value)
    if not v["ok"]:
        first = (v["errors"] or [{}])[0]
        return {"ok": False, "code": "VALIDATION_FAILED",
                "error": "validation failed: " + str(first.get("code", "?")) + "@" + str(first.get("path", "?")),
                "errors": v["errors"], "artifact_type": artifact_type}
    data = (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    out_path = os.path.join(staging, artifact_type + ".json")
    with open(out_path, "wb") as fh:
        fh.write(data)
    return {"ok": True, "staged": out_path, "sha256": hashlib.sha256(data).hexdigest(), "artifact_type": artifact_type}


def op_design_casefile_validate(args):
    """stage③：从 content-addressed 对象（<sha256>.json）重校验；对象名即完整性承诺。"""
    obj = args.get("object_path") or args.get("path")
    if not isinstance(obj, str) or not os.path.exists(obj):
        return {"ok": False, "code": "OBJECT_NOT_FOUND", "error": "object_path 不存在"}
    with open(obj, "rb") as fh:
        data = fh.read()
    sha = hashlib.sha256(data).hexdigest()
    if os.path.basename(obj) != sha + ".json":
        return {"ok": False, "code": "OBJECT_HASH_MISMATCH",
                "error": "对象名与内容哈希不符（非 content-addressed）"}
    try:
        value = json.loads(data.decode("utf-8"))
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "code": "OBJECT_UNREADABLE", "error": str(exc)[:160]}
    artifact_type = args.get("artifact_type")
    if not artifact_type and isinstance(value, dict):
        at = value.get("artifact_type")
        if isinstance(at, str) and at.endswith("@1"):
            artifact_type = at[:-2]
    if not artifact_type:
        return {"ok": False, "code": "BAD_REQUEST", "error": "artifact_type 无法推定，请显式提供"}
    v = dv.validate_artifact(artifact_type, value)
    return {"ok": True, "verdict": "PASS" if v["ok"] else "FAIL", "errors": v["errors"],
            "sha256": sha, "artifact_type": artifact_type}
