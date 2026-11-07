"""The FDTD simulation layout of a problem, computed by the Lightsmith library: Yee node planes (uniform or
graded), TFSF box, flux boxes, CPML, refinement regions and mirror-symmetry planes.

This is the reference implementation of the `layout` API Studio proposes to the library (API_ASSUMPTIONS.md,
"Proposed: FDTD layout"). The library has no public call for it yet, so this script reads the FDTD backend's
private planning functions (`lightsmith.backends._fdtd`); it calls exactly what `estimate` and `solve` call, so
the grid and boxes are the ones a run would use. When the library publishes `layout`, Studio uses that instead
and this script goes away.

    uv run --project ../lightsmith python scripts/fdtd_layout.py < spec.json > layout.json
    uv run --project ../lightsmith python scripts/fdtd_layout.py spec.json

Studio's dev server runs it for `POST /__library/v1/layout` (vite.config.ts), and make_fixtures.py uses
`layout()` to snapshot the FDTD templates' layouts for the in-browser mock.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np

import lightsmith as ls
from lightsmith.problems import EmissionProblem, parse_problem
from lightsmith.spec import Simulation

ROUND = 6  # decimals of nm in the output (node planes are float sums)


def _r(x) -> list:
    return [round(float(v), ROUND) for v in np.asarray(x, dtype=float).ravel()]


def _box(lay, name: str, label: str, lo, hi) -> dict:
    return {"name": name, "label": label, "lo_nm": _r(lay.world(np.asarray(lo, dtype=float))),
            "hi_nm": _r(lay.world(np.asarray(hi, dtype=float)))}


def _nodes(lay) -> list[list[float]]:
    if lay.grid is not None:
        return [_r(lay.grid.nodes[a]) for a in range(3)]
    return [_r(lay.origin[a] + np.arange(lay.shape[a]) * lay.dx) for a in range(3)]


def layout(spec: dict) -> dict:
    """The layout of `spec` for the FDTD backend (scattering and emission problems)."""
    from lightsmith.backends.fdtd import NativeFDTD as FDTDBackend
    from lightsmith.backends._fdtd import emission, scattering, symmetry
    from lightsmith.backends._fdtd.setup import graded_layout, scattering_layout

    prob = parse_problem(spec)
    if not isinstance(prob, (Simulation, EmissionProblem)):
        raise ValueError(f"no FDTD layout for problem kind '{prob.kind}' (scattering and emission only)")
    out: dict = {"backend": FDTDBackend.name, "method": FDTDBackend.method, "problem_kind": prob.kind,
                 "regions": [], "warnings": [], "error": None}
    opts = FDTDBackend._options(prob)
    warnings: list[str] = []
    if isinstance(prob, EmissionProblem):
        p = emission.plan(prob, opts, single=False, warnings=warnings)
        lay, sym, regions, n_override = p["layout"], {"mirrors": {}, "reduction": 1,
                                                     "skipped": "emission runs use the whole grid"}, [], 0
        boxes = [_box(lay, "flux_radiated", "radiated-power box", *lay.sca)]
    else:
        # As scattering.plan, but the whole grid: plan keeps one half per mirror plane (symmetry.halve).
        mirror, sym = symmetry.find(prob, opts)
        regions, n_override = [], len(opts.mesh_override)
        if scattering.graded(opts):
            why = scattering.graded_unsupported(prob)
            if why:
                out["error"] = f"FDTD: {why}; use grid='uniform' without mesh_override"
            base, regions = scattering.grid_regions(prob, opts)
            lay = graded_layout(prob, opts, base, regions, scattering._bbox(prob), mirror, opts.grading_ratio)
        else:
            lay = scattering_layout(prob, opts, scattering.spacing(prob, opts), scattering._bbox(prob))
        boxes = [_box(lay, "tfsf", "TFSF source box", *lay.tfsf),
                 _box(lay, "flux_total", "total-field flux box (C_abs)", *lay.tot),
                 _box(lay, "flux_scattered", "scattered-field flux box (C_sca, far field)", *lay.sca)]
    n_auto = len(regions) - n_override
    for i, r in enumerate(regions):
        src = {"source": "auto", "particle": i} if i < n_auto else {"source": "mesh_override", "index": i - n_auto}
        out["regions"].append({**src, "lo_nm": _r(r.lo), "hi_nm": _r(r.hi), "spacing_nm": _r(r.spacing)})
    nodes = _nodes(lay)
    widths = [np.diff(n) for n in nodes]
    grid = {"kind": "graded" if lay.grid is not None else "uniform", "base_spacing_nm": float(lay.dx),
            "shape": [int(v) for v in lay.shape], "cells": int(lay.cells), "nodes_nm": nodes,
            "spacing_min_nm": [float(w.min()) for w in widths], "spacing_max_nm": [float(w.max()) for w in widths]}
    if lay.grid is not None:
        grid["max_ratio"] = float(lay.grid.max_ratio())
    n = lay.pml
    out.update(grid=grid, domain_nm={"lo_nm": [n_[0] for n_ in nodes], "hi_nm": [n_[-1] for n_ in nodes]},
               pml={"cells": int(n), "inner_lo_nm": [n_[n] for n_ in nodes], "inner_hi_nm": [n_[-1 - n] for n_ in nodes]},
               boxes=boxes, symmetry=sym)
    # The library's own estimate: the cells a run uses (halved by symmetry) and its errors and warnings.
    try:
        est = ls.estimate(prob, method=FDTDBackend.name, device="cpu")
        est = est if isinstance(est, dict) else est.model_dump()
        out["run_cells"] = est.get("cells")
        out["warnings"] = list(dict.fromkeys([*warnings, *(est.get("warnings") or [])]))
    except Exception as e:  # noqa: BLE001 (the library's reason is the message the user needs)
        out["error"] = out["error"] or f"{type(e).__name__}: {e}"
        out["warnings"] = warnings
    return out


def main(argv: list[str]) -> None:
    text = Path(argv[1]).read_text(encoding="utf-8") if len(argv) > 1 else sys.stdin.read()
    body = json.loads(text)
    spec = body.get("simulation", body) if isinstance(body, dict) else body
    try:
        res = layout(spec)
    except Exception as e:  # noqa: BLE001
        sys.stdout.write(json.dumps({"error": type(e).__name__, "message": str(e)}))
        sys.exit(2)
    sys.stdout.write(json.dumps(res, allow_nan=False))


if __name__ == "__main__":
    main(sys.argv)
