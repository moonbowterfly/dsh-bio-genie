#!/usr/bin/env python3
"""dsh-bio execution bridge.

This script is the single entry point the ``bio_python`` tool spawns. It reads a
JSON envelope from stdin, executes the supplied Python source inside the bundled
Biopython environment, and writes one JSON result object to stdout. stdout/stderr
of the *user program* are captured and carried inside that result object, so the
bridge's own stdout is always exactly one line of JSON that the plugin can parse.

Envelope (stdin):
    {"code": "<python source>", "cwd": "<optional working directory>"}

Result (stdout, one JSON object):
    {"ok": true, "stdout": "...", "stderr": "...", "result": <json-or-null>}

`result` is the value of a top-level variable named ``result`` if the user code
assigned one and it is JSON-serializable; otherwise it is ``null``. The model is
taught to assign ``result = ...`` when it wants a structured value back.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import sys
import traceback

# Hard cap on captured stdout/stderr so a runaway program cannot balloon the
# plugin's memory; the harness spill policy already handles model-facing size.
MAX_CAPTURE_CHARS = 1_000_000


def _json_safe(value):
    """Return value if JSON-serializable, else its repr as a fallback string."""
    try:
        json.dumps(value)
        return value
    except (TypeError, ValueError):
        return repr(value)


def main() -> int:
    raw = sys.stdin.read()
    try:
        payload = json.loads(raw) if raw.strip() else {}
    except json.JSONDecodeError as exc:
        print(json.dumps({"ok": False, "stdout": "", "stderr": "", "error": f"invalid bridge envelope: {exc}"}))
        return 0

    code = payload.get("code") or ""
    cwd = payload.get("cwd")

    if cwd and os.path.isdir(cwd):
        os.chdir(cwd)

    # Fail fast and clearly if Biopython is missing from this environment; the
    # plugin surfaces this so the user can re-run the bootstrap.
    try:
        import Bio  # noqa: F401
    except ImportError as exc:
        print(json.dumps({
            "ok": False,
            "stdout": "",
            "stderr": "",
            "error": f"Biopython is not importable in the bundled environment: {exc}",
        }))
        return 0

    out = io.StringIO()
    err = io.StringIO()
    namespace = {"__name__": "__main__"}

    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
            compiled = compile(code, "<dsh-bio>", "exec")
            exec(compiled, namespace)  # noqa: S102 - executing user-provided analysis code is the point
    except SystemExit:
        pass
    except BaseException:  # noqa: BLE001 - report any failure back to the model verbatim
        err.write(traceback.format_exc())

    result = namespace.get("result") if "result" in namespace else None
    stdout_text = out.getvalue()
    stderr_text = err.getvalue()
    truncated = len(stdout_text) > MAX_CAPTURE_CHARS or len(stderr_text) > MAX_CAPTURE_CHARS
    print(json.dumps({
        "ok": True,
        "stdout": stdout_text[:MAX_CAPTURE_CHARS],
        "stderr": stderr_text[:MAX_CAPTURE_CHARS],
        "result": _json_safe(result) if result is not None else None,
        "truncated": truncated,
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
