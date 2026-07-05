#!/usr/bin/env python3
"""Python skill harness.

Reads a single JSON object from stdin: { "source": <str>, "args": <obj> }.
The source must define a top-level `run(args)` function. Its return value is serialised
to JSON and written to stdout as { "ok": true, "result": ... }. Any error is reported as
{ "ok": false, "error": <str> } with a non-zero exit code so the parent can trip the breaker.

Communication is a clean JSON stream (no shared filesystem contract), per spec §3.
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
