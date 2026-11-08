"""What a Lightsmith backend will discretise for a problem, computed by the library before any solve.

`lightsmith.discretization(problem, method)` (see API_ASSUMPTIONS.md, "Solver layouts") returns the envelope

    {"backend", "method", "problem_kind", "layout_kind", "summary": {...}, "payload": {...},
     "estimate": {...}, "warnings": [...], "error": null | "..."}

This script prints it as JSON. It never solves.

    uv run --project ../lightsmith python scripts/solver_layout.py [--method fdtd] < spec.json
    uv run --project ../lightsmith python scripts/solver_layout.py spec.json --method dda

Studio's dev server runs it for `POST /__library/v1/layout` (vite.config.ts); make_fixtures.py snapshots the
layouts of the examples for the in-browser mock.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import lightsmith as ls


def layout(spec: dict, method: str = "auto") -> dict:
    return ls.discretization(spec, method)


def main(argv: list[str]) -> None:
    args = list(argv[1:])
    method = "auto"
    if "--method" in args:
        i = args.index("--method")
        method = args[i + 1]
        del args[i:i + 2]
    text = Path(args[0]).read_text(encoding="utf-8") if args else sys.stdin.read()
    body = json.loads(text)
    spec = body.get("simulation", body) if isinstance(body, dict) else body
    if isinstance(body, dict) and "simulation" in body:
        method = body.get("method") or method
    try:
        res = layout(spec, method)
    except Exception as e:  # noqa: BLE001
        sys.stdout.write(json.dumps({"error": type(e).__name__, "message": str(e)}))
        sys.exit(2)
    sys.stdout.write(json.dumps(res, allow_nan=False, default=float))


if __name__ == "__main__":
    main(sys.argv)
