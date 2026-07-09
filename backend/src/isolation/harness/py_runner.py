#!/usr/bin/env python3
"""Python skill harness (in-container variant).

Identical contract to the backend's `tools/sandbox/py-runner/runner.py`: reads a single JSON
object from stdin — { "source": <str>, "args": <obj> } — where `source` defines a top-level
`run(args)` function. The return value is serialised to stdout as { "ok": true, "result": ... };
any error becomes { "ok": false, "error": <str> } with a non-zero exit code.

This file is `docker cp`'d into the agent container at /opt/pleiades/py_runner.py at create time,
so Python skills run with the exact same protocol whether isolated or not.
"""
import json
import sys
import traceback


def main() -> int:
    try:
        payload = json.loads(sys.stdin.read() or "{}")
    except json.JSONDecodeError as exc:
        sys.stdout.write(json.dumps({"ok": False, "error": f"invalid input json: {exc}"}))
        return 1

    source = payload.get("source", "")
    args = payload.get("args", {})

    sandbox_globals: dict = {"__name__": "__skill__"}
    try:
        exec(compile(source, "<skill>", "exec"), sandbox_globals)  # noqa: S102 - sandboxed by container
        run = sandbox_globals.get("run")
        if not callable(run):
            raise ValueError("skill must define a top-level `run(args)` function")
        result = run(args)
        sys.stdout.write(json.dumps({"ok": True, "result": result}, default=str))
        return 0
    except Exception:  # noqa: BLE001 - surface any skill failure to the parent
        sys.stdout.write(json.dumps({"ok": False, "error": traceback.format_exc()}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
