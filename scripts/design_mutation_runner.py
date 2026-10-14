#!/usr/bin/env python
"""design_mutation_runner.py — 设计模块变异执行器（A0/D1 交付件）

按机器可读矩阵（design/mutation-matrix.json，v0.4 §C7）对单条或全部可运行变异
执行「注入 → 运行目标门 → 断言门以期望失败类别报红 → try/finally 还原」闭环。

核心语义（v0.3 §8 A0 / v0.4 §C7）：
  - killed 判定 = 门退出码非零 **且** observed_failure_class == expected_failure_class；
  - 禁止把泛化失败（parse error / 命令缺失 / 行为断言泛化红）当作「击杀」——
    门红了但输出不含期望失败类别 → killed=false + survivor_reason 说明；
  - 还原失败必须显式报错退出（exit 2），绝不留被改坏的工作区；
  - 还原后对注入文件做字节级回读验证（与注入前备份逐字节一致）。

用法：
  python scripts/design_mutation_runner.py --matrix design/mutation-matrix.json --id M1
  python scripts/design_mutation_runner.py --matrix design/mutation-matrix.json --all-runnable
  python scripts/design_mutation_runner.py --matrix design/mutation-matrix.json --id M1 --out reports/m1.json

退出码：
  0 = 全部执行条目被击杀（或跳过 not_yet_runnable）；
  1 = 存在执行条目未被击杀（survivor）或矩阵/参数错误；
  2 = 还原失败（工作区安全事件，显式报错）。
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHILD_ENV = {
    "PYTHONUTF8": "1",
    "PYTHONIOENCODING": "utf-8",
    "PYTHONDONTWRITEBYTECODE": "1",
}
CODE_RE = re.compile(r'"code"\s*:\s*"([A-Za-z0-9_]+)"')


def _jsonable(o):
    return o


def log(msg):
    print(msg, file=sys.stderr)


def load_matrix(path):
    """读取矩阵；返回 (ok, matrix|detail)。"""
    if not os.path.isfile(path):
        return False, "matrix file missing: %s" % path
    try:
        with open(path, "r", encoding="utf-8") as fh:
            doc = json.load(fh)
    except Exception as e:  # noqa: BLE001
        return False, "matrix unreadable: %s" % e
    if not isinstance(doc, dict) or "mutations" not in doc:
        return False, "matrix must be an object with a mutations array"
    return True, doc


def resolve_target(repo_root, target):
    """注入目标解析：相对路径以 repo_root 为基准并做 containment 检查；绝对路径必须真实存在。"""
    if os.path.isabs(target):
        return os.path.normpath(target)
    abs_path = os.path.normpath(os.path.join(repo_root, target))
    root = os.path.normpath(repo_root)
    if abs_path != root and not abs_path.startswith(root + os.sep):
        raise ValueError("injection target escapes repo root: %s" % target)
    return abs_path


def apply_injection(inj, repo_root):
    """执行注入。返回 {ok, detail, backup}；backup 供 finally 还原（None = 未改动）。"""
    if not isinstance(inj, dict):
        return {"ok": False, "detail": "injection entry must be an object", "backup": None}
    kind = inj.get("kind")
    target = inj.get("target")
    if kind == "not_yet_runnable" or kind is None:
        return {"ok": False, "detail": "not runnable injection kind", "backup": None}
    if not isinstance(target, str) or not target:
        return {"ok": False, "detail": "injection target missing", "backup": None}
    try:
        path = resolve_target(repo_root, target)
    except ValueError as e:
        return {"ok": False, "detail": str(e), "backup": None}
    if not os.path.isfile(path):
        return {"ok": False, "detail": "injection target not a file: %s" % target, "backup": None}

    if kind == "append_bytes":
        with open(path, "rb") as fh:
            orig = fh.read()
        delta = inj.get("delta", " ")
        if isinstance(delta, str):
            delta = delta.encode("utf-8")
        if not isinstance(delta, bytes):
            return {"ok": False, "detail": "delta must be str or bytes", "backup": None}
        with open(path, "wb") as fh:
            fh.write(orig + delta)
        return {
            "ok": True,
            "detail": "appended %d byte(s) to %s" % (len(delta), target),
            "backup": {"path": path, "existed": True, "bytes": orig},
        }

    if kind == "replace_text":
        old = inj.get("old")
        new = inj.get("new")
        if not isinstance(old, str) or not isinstance(new, str):
            return {"ok": False, "detail": "replace_text requires old/new strings", "backup": None}
        try:
            with open(path, "rb") as fh:
                orig = fh.read()
            text = orig.decode("utf-8")
        except UnicodeDecodeError:
            return {"ok": False, "detail": "target not utf-8 text: %s" % target, "backup": None}
        count = text.count(old)
        if count != 1:
            return {"ok": False, "detail": "anchor count %d (expected 1) in %s" % (count, target), "backup": None}
        mutated = text.replace(old, new).encode("utf-8")
        with open(path, "wb") as fh:
            fh.write(mutated)
        return {
            "ok": True,
            "detail": "replaced anchor in %s" % target,
            "backup": {"path": path, "existed": True, "bytes": orig},
        }

    if kind == "delete_file":
        with open(path, "rb") as fh:
            orig = fh.read()
        os.remove(path)
        return {
            "ok": True,
            "detail": "deleted %s" % target,
            "backup": {"path": path, "existed": True, "bytes": orig},
        }

    return {"ok": False, "detail": "unknown injection kind: %s" % kind, "backup": None}


def restore_backup(backup):
    """还原注入；返回 (ok, detail)。还原后做字节回读验证。"""
    if backup is None:
        return True, "nothing to restore"
    path = backup.get("path")
    existed = backup.get("existed", True)
    expected = backup.get("bytes")
    try:
        if existed:
            with open(path, "wb") as fh:
                fh.write(expected)
            with open(path, "rb") as fh:
                got = fh.read()
            if got != expected:
                return False, "restore verification failed (bytes differ): %s" % path
            return True, "restored %d byte(s) to %s (verified)" % (len(expected), path)
        return False, "backup recorded nonexistent file (unsupported)"
    except Exception as e:  # noqa: BLE001
        return False, "restore failed for %s: %s" % (path, e)


def run_gate(gate, repo_root):
    """运行目标门。返回 {reached, exit_code, output, timeout}。"""
    command = gate.get("command")
    if not isinstance(command, list) or not command:
        return {"reached": False, "exit_code": None, "output": "", "timeout": False,
                "detail": "target_gate.command must be a non-empty array"}
    timeout_ms = int(gate.get("timeout_ms", 120000))
    env = dict(os.environ)
    env.update(CHILD_ENV)
    try:
        proc = subprocess.run(
            [str(c) for c in command],
            cwd=repo_root,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout_ms / 1000.0,
            env=env,
        )
    except subprocess.TimeoutExpired:
        return {"reached": False, "exit_code": None, "output": "", "timeout": True,
                "detail": "gate timed out after %d ms" % timeout_ms}
    except Exception as e:  # noqa: BLE001
        return {"reached": False, "exit_code": None, "output": "", "timeout": False,
                "detail": "gate spawn failed: %s" % e}
    output = (proc.stdout or "") + (proc.stderr or "")
    return {"reached": True, "exit_code": proc.returncode, "output": output, "timeout": False,
            "detail": None}


def extract_failure_class(output, expected):
    """从门输出提取 observed_failure_class：
    1) 期望类别作为精确子串出现 → 返回 expected（最强证据）；
    2) 否则提取 JSON "code" 字段（首个）；
    3) 否则 GENERIC_FAILURE（泛化失败 —— 不计击杀）。
    """
    if expected and expected in output:
        return expected
    m = CODE_RE.search(output)
    if m:
        return m.group(1)
    return "GENERIC_FAILURE"


def sha256hex(data):
    return hashlib.sha256(data).hexdigest()


def mutant_hash_of(inj, repo_root):
    """注入后目标文件的 sha256（A0 mutant_hash）。不可执行注入返回 None。"""
    target = inj.get("target") if isinstance(inj, dict) else None
    kind = inj.get("kind") if isinstance(inj, dict) else None
    if kind == "not_yet_runnable" or kind is None or not isinstance(target, str):
        return None
    try:
        path = resolve_target(repo_root, target)
    except ValueError:
        return None
    if not os.path.isfile(path):
        return None
    with open(path, "rb") as fh:
        return sha256hex(fh.read())


def run_one(mutation, repo_root, opts):
    """执行单条变异；返回报告 dict。还原由本函数 try/finally 保证。"""
    m_id = mutation.get("mutation_id", "?")
    expected = mutation.get("expected_failure_class")
    check_id = mutation.get("check_id")
    target_gate = mutation.get("target_gate") if isinstance(mutation.get("target_gate"), dict) else {}

    if mutation.get("not_yet_runnable", False):
        return {
            "mutation_id": m_id,
            "name": mutation.get("name"),
            "owner": mutation.get("owner"),
            "executed": False,
            "skipped": True,
            "injection_precondition_passed": False,
            "injection_detail": "not_yet_runnable (no gate yet)",
            "baseline_status": "not_checked",
            "target_gate_reached": False,
            "target_gate": target_gate.get("planned"),
            "expected_failure_class": expected,
            "observed_failure_class": None,
            "observed_failure_code": None,
            "gate_exit_code": None,
            "killed": False,
            "target_assertion_id": check_id,
            "survivor_reason": "not_yet_runnable: %s" % (target_gate.get("planned") or "gate not built"),
            "restore_verified": None,
            "mutant_sha256": None,
        }

    backup = None
    injection_ok = False
    injection_detail = "not attempted"
    mutant_sha = None
    try:
        # ── baseline（可选；默认不跑以控制时长）──────────────────────────
        baseline_status = "not_checked"
        if opts.check_baseline:
            bg = run_gate(target_gate, repo_root)
            baseline_status = "green" if (bg["reached"] and bg["exit_code"] == 0) else (
                "red_before_injection!" if bg["reached"] else "gate_unrunnable")
            if baseline_status != "green":
                return {
                    "mutation_id": m_id,
                    "name": mutation.get("name"),
                    "owner": mutation.get("owner"),
                    "executed": True,
                    "skipped": False,
                    "injection_precondition_passed": False,
                    "injection_detail": "baseline gate not green before injection",
                    "baseline_status": baseline_status,
                    "target_gate_reached": bg["reached"],
                    "target_gate": target_gate.get("command"),
                    "expected_failure_class": expected,
                    "observed_failure_class": None,
                    "observed_failure_code": None,
                    "gate_exit_code": bg["exit_code"],
                    "killed": False,
                    "target_assertion_id": check_id,
                    "survivor_reason": "baseline gate was not green (harness problem, not a mutation)",
                    "restore_verified": True,
                    "mutant_sha256": None,
                }

        # ── 注入 ────────────────────────────────────────────────────────
        inj = mutation.get("injection")
        res = apply_injection(inj, repo_root)
        injection_ok = res["ok"]
        injection_detail = res["detail"]
        backup = res["backup"]
        if not injection_ok:
            return {
                "mutation_id": m_id,
                "name": mutation.get("name"),
                "owner": mutation.get("owner"),
                "executed": True,
                "skipped": False,
                "injection_precondition_passed": False,
                "injection_detail": injection_detail,
                "baseline_status": baseline_status,
                "target_gate_reached": False,
                "target_gate": target_gate.get("command"),
                "expected_failure_class": expected,
                "observed_failure_class": None,
                "observed_failure_code": None,
                "gate_exit_code": None,
                "killed": False,
                "target_assertion_id": check_id,
                "survivor_reason": "injection precondition failed: %s" % injection_detail,
                "restore_verified": True,
                "mutant_sha256": None,
            }
        # 注入后状态哈希（delete_file 注入后文件不存在 → 记为 null + deleted 标记）
        mutant_sha = None
        inj_kind = inj.get("kind") if isinstance(inj, dict) else None
        if inj_kind != "delete_file":
            try:
                with open(resolve_target(repo_root, inj.get("target")), "rb") as fh:
                    mutant_sha = sha256hex(fh.read())
            except OSError:
                mutant_sha = None
        else:
            mutant_sha = "DELETED"

        # ── 运行目标门 ───────────────────────────────────────────────────
        gate = run_gate(target_gate, repo_root)
        observed = extract_failure_class(gate["output"], expected) if gate["reached"] else None
        gate_red = gate["reached"] and gate["exit_code"] != 0
        killed = gate_red and observed == expected
        survivor_reason = None
        if gate_red and observed != expected:
            survivor_reason = (
                "gate red but expected failure class %r not observed (observed=%r); "
                "generic failure does not count as a kill" % (expected, observed)
            )
        elif not gate_red and gate["reached"]:
            survivor_reason = "gate exited 0 under mutation (survived)"
        elif not gate["reached"]:
            survivor_reason = "gate not reached: %s" % (gate.get("detail") or "unknown")

        return {
            "mutation_id": m_id,
            "name": mutation.get("name"),
            "owner": mutation.get("owner"),
            "executed": True,
            "skipped": False,
            "injection_precondition_passed": True,
            "injection_detail": injection_detail,
            "baseline_status": baseline_status,
            "target_gate_reached": gate["reached"],
            "target_gate": target_gate.get("command"),
            "expected_failure_class": expected,
            "observed_failure_class": observed,
            "observed_failure_code": observed,
            "gate_exit_code": gate["exit_code"],
            "gate_timed_out": gate["timeout"],
            "killed": killed,
            "target_assertion_id": check_id,
            "survivor_reason": survivor_reason,
            "restore_verified": None,  # 在 finally 中填充
            "mutant_sha256": mutant_sha,
        }
    finally:
        if backup is not None:
            ok, detail = restore_backup(backup)
            # 把还原结果写回最近一次返回的报告（在 finally 中无法改 return 值，
            # 因此在 run_one 外层用返回字典的浅拷贝修正 —— 见 run_mutations）。
            restore_ctx = {"ok": ok, "detail": detail}
            if not ok:
                log("RESTORE_FAILED: %s" % detail)
                restore_ctx["fatal"] = True
            _RESTORE_STATE.append(restore_ctx)


_RESTORE_STATE = []


def run_mutations(matrix, ids, repo_root, opts):
    """执行矩阵子集；返回 (reports, exit_code, restore_failed)。"""
    by_id = {}
    for m in matrix.get("mutations", []):
        mid = m.get("mutation_id")
        if isinstance(mid, str):
            by_id[mid] = m
    if ids:
        missing = [i for i in ids if i not in by_id]
        if missing:
            raise SystemExit("unknown mutation_id(s): %s" % ", ".join(missing))
        selected = [by_id[i] for i in ids]
    else:
        selected = [m for m in matrix.get("mutations", []) if not m.get("not_yet_runnable", False)]

    reports = []
    restore_failed = False
    for m in selected:
        _RESTORE_STATE.clear()
        rep = run_one(m, repo_root, opts)
        if _RESTORE_STATE:
            st = _RESTORE_STATE[0]
            rep = dict(rep)
            rep["restore_verified"] = st["ok"]
            if not st["ok"]:
                rep["survivor_reason"] = "RESTORE_FAILED: %s" % st["detail"]
                restore_failed = True
        reports.append(rep)

    executed = [r for r in reports if r.get("executed")]
    killed = [r for r in reports if r.get("killed")]
    survived = [r for r in reports if r.get("executed") and not r.get("killed")]
    skipped = [r for r in reports if r.get("skipped")]
    precond_failed = [r for r in reports if r.get("executed") and not r.get("injection_precondition_passed")]

    summary = {
        "total": len(reports),
        "executed": len(executed),
        "killed": len(killed),
        "survived": len(survived),
        "skipped": len(skipped),
        "precondition_failed": len(precond_failed),
        "restore_failures": 1 if restore_failed else 0,
    }

    if restore_failed:
        code = 2
    elif survived:
        code = 1
    else:
        code = 0
    return reports, summary, code


def main(argv=None):
    ap = argparse.ArgumentParser(description="design mutation runner (A0/D1)")
    ap.add_argument("--matrix", required=True, help="path to mutation matrix JSON")
    ap.add_argument("--id", action="append", help="mutation_id to run (repeatable)")
    ap.add_argument("--all-runnable", action="store_true", help="run every runnable mutation in the matrix")
    ap.add_argument("--check-baseline", action="store_true",
                    help="run each gate once before injection to verify it is green")
    ap.add_argument("--out", help="optional file to write the JSON report to")
    args = ap.parse_args(argv)

    ok, matrix = load_matrix(args.matrix)
    if not ok:
        print(json.dumps({"runner": "design_mutation_runner.py", "error": matrix}, ensure_ascii=False, indent=2))
        return 1

    if args.id and args.all_runnable:
        print(json.dumps({"runner": "design_mutation_runner.py", "error": "--id and --all-runnable are mutually exclusive"},
                         ensure_ascii=False, indent=2))
        return 1
    ids = args.id or []

    try:
        reports, summary, code = run_mutations(matrix, ids, REPO_ROOT, args)
    except SystemExit as e:
        print(json.dumps({"runner": "design_mutation_runner.py", "error": str(e)}, ensure_ascii=False, indent=2))
        return 1

    report = {
        "runner": "design_mutation_runner.py",
        "matrix": args.matrix,
        "repo_root": REPO_ROOT,
        "results": reports,
        "summary": summary,
    }
    payload = json.dumps(report, ensure_ascii=False, indent=2)
    if args.out:
        out_dir = os.path.dirname(os.path.abspath(args.out))
        if out_dir and not os.path.isdir(out_dir):
            try:
                os.makedirs(out_dir, exist_ok=True)
            except OSError as e:
                print(json.dumps({"runner": "design_mutation_runner.py", "error": "cannot create --out dir: %s" % e},
                                 ensure_ascii=False, indent=2))
                return 1
        with open(args.out, "w", encoding="utf-8") as fh:
            fh.write(payload + "\n")
    print(payload)
    return code


if __name__ == "__main__":
    sys.exit(main())
