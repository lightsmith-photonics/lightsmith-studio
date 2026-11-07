"""What a Lightsmith backend will discretise for a problem, computed by the library before any solve.

Reference implementation of the `layout` API Studio proposes to the library (API_ASSUMPTIONS.md, "Proposed:
solver layouts"): one optional `layout()` per backend, with a common envelope

    {"backend", "method", "problem_kind", "layout_kind", "summary": {...}, "payload": {...},
     "estimate": {...}, "warnings": [...], "error": null | "..."}

and a payload per `layout_kind`:

    yee_grid          FDTD scattering / emission: node planes, TFSF and flux boxes, CPML, regions, mirror planes
    device_grid       FDTD and FDFD devices, inverse design: node planes, PML, ports (and design regions)
    dipole_lattice    DDA: the occupied dipole positions and spacing
    surface_mesh      BEM: vertices and triangles
    multipoles        Mie and T-matrix: the multipole order per wavelength or per particle
    harmonics         RCWA: the Fourier orders and the layers (uniform in z)
    cross_section_grid  FDE: node planes, PML, boundary
    cells             EME (modes per cell) and BPM (steps per cell): cells along the propagation axis
    plane_waves       PWE: the k-path and the plane waves per polarisation
    none              nothing to discretise (TMM, quasistatic, circuits): the estimate says what is solved

The library has no public call for any of this yet, so the script reads private planning functions
(`lightsmith.backends._*`) that `estimate` and `solve` call themselves; it never solves. Backends or kinds it
does not cover get `layout_kind: "none"` with the library's estimate.

    uv run --project ../lightsmith python scripts/solver_layout.py [--method fdtd] < spec.json
    uv run --project ../lightsmith python scripts/solver_layout.py spec.json --method dda

Studio's dev server runs it for `POST /__library/v1/layout` (vite.config.ts); make_fixtures.py snapshots the
layouts of the examples for the in-browser mock.
"""

from __future__ import annotations

import json
import math
import sys
from pathlib import Path

import numpy as np

import lightsmith as ls
from lightsmith.problems import parse_problem

ROUND = 6
MAX_POINTS = 20000  # dipole positions sent at most (evenly subsampled beyond)
MAX_TRIS = 40000


def _r(x, nd: int = ROUND) -> list:
    return [round(float(v), nd) for v in np.asarray(x, dtype=float).ravel()]


def _cpu():
    from lightsmith.device import resolve_device

    return resolve_device("cpu")


def _resolve(problem, method: str):
    """The backend `method` names (a method or a backend name; "auto" as solve would pick)."""
    from lightsmith.api import _resolve as resolve

    return resolve(problem, method)


# --- FDTD -------------------------------------------------------------------------------------------------


def _box(lay, name: str, label: str, lo, hi) -> dict:
    return {"name": name, "label": label, "lo_nm": _r(lay.world(np.asarray(lo, dtype=float))),
            "hi_nm": _r(lay.world(np.asarray(hi, dtype=float)))}


def _fdtd_open(problem, backend) -> dict:
    """FDTD scattering and emission: the whole grid (before mirror halving), boxes, CPML, regions, mirrors."""
    from lightsmith.backends._fdtd import emission, scattering, symmetry
    from lightsmith.backends._fdtd.setup import graded_layout, scattering_layout
    from lightsmith.problems import EmissionProblem

    opts = backend._options(problem)
    warnings: list[str] = []
    error = None
    regions, n_override = [], 0
    if isinstance(problem, EmissionProblem):
        p = emission.plan(problem, opts, single=False, warnings=warnings)
        lay = p["layout"]
        sym = {"mirrors": {}, "reduction": 1, "skipped": "emission runs use the whole grid"}
        boxes = [_box(lay, "flux_radiated", "radiated-power box", *lay.sca)]
    else:
        mirror, sym = symmetry.find(problem, opts)
        n_override = len(opts.mesh_override)
        if scattering.graded(opts):
            why = scattering.graded_unsupported(problem)
            if why:
                error = f"FDTD: {why}; use grid='uniform' without mesh_override"
            base, regions = scattering.grid_regions(problem, opts)
            lay = graded_layout(problem, opts, base, regions, scattering._bbox(problem), mirror, opts.grading_ratio)
        else:
            lay = scattering_layout(problem, opts, scattering.spacing(problem, opts), scattering._bbox(problem))
        boxes = [_box(lay, "tfsf", "TFSF source box", *lay.tfsf),
                 _box(lay, "flux_total", "total-field flux box (C_abs)", *lay.tot),
                 _box(lay, "flux_scattered", "scattered-field flux box (C_sca, far field)", *lay.sca)]
    n_auto = len(regions) - n_override
    regs = []
    for i, r in enumerate(regions):
        src = {"source": "auto", "particle": i} if i < n_auto else {"source": "mesh_override", "index": i - n_auto}
        regs.append({**src, "lo_nm": _r(r.lo), "hi_nm": _r(r.hi), "spacing_nm": _r(r.spacing)})
    if lay.grid is not None:
        nodes = [_r(lay.grid.nodes[a]) for a in range(3)]
    else:
        nodes = [_r(lay.origin[a] + np.arange(lay.shape[a]) * lay.dx) for a in range(3)]
    widths = [np.diff(n) for n in nodes]
    grid = {"kind": "graded" if lay.grid is not None else "uniform", "base_spacing_nm": float(lay.dx),
            "shape": [int(v) for v in lay.shape], "cells": int(lay.cells), "nodes_nm": nodes,
            "spacing_min_nm": [float(w.min()) for w in widths], "spacing_max_nm": [float(w.max()) for w in widths]}
    if lay.grid is not None:
        grid["max_ratio"] = float(lay.grid.max_ratio())
    n = lay.pml
    payload = {"grid": grid, "domain_nm": {"lo_nm": [v[0] for v in nodes], "hi_nm": [v[-1] for v in nodes]},
               "pml": {"cells": int(n), "inner_lo_nm": [v[n] for v in nodes], "inner_hi_nm": [v[-1 - n] for v in nodes]},
               "boxes": boxes, "regions": regs, "symmetry": sym}
    summary = {"grid": f"{grid['kind']} {' × '.join(map(str, grid['shape']))}", "cells": grid["cells"],
               "cell size (nm)": f"{min(grid['spacing_min_nm']):.4g}–{max(grid['spacing_max_nm']):.4g}",
               "CPML cells": int(n), "mirror planes": ", ".join(f"{a} {m.split()[0]}" for a, m in sym["mirrors"].items()) or "none"}
    return {"layout_kind": "yee_grid", "summary": summary, "payload": payload, "warnings": warnings, "error": error}


def _device_grid_payload(nodes, pml_lo, pml_hi, ports, two_d: bool) -> dict:
    return {"nodes_nm": nodes, "pml_inner_lo_nm": pml_lo, "pml_inner_hi_nm": pml_hi, "ports": ports, "two_d": two_d}


def _fdtd_device(problem, backend) -> dict:
    from lightsmith.backends._fdtd import device as dv

    opts = backend._options(problem)
    p = dv.plan(problem, opts, single=False)
    g, frames = p["grid"], p["frames"]
    nodes = [_r(g.origin[a] + np.arange(g.shape[a]) * g.dx) for a in range(3)]
    lo = [nodes[a][g.interior[a][0]] for a in range(3)]
    hi = [nodes[a][g.interior[a][1]] for a in range(3)]
    ports = []
    for f in frames:
        win = {}
        for t, lo_i, n_i in ((f.t1, f.lo[0], f.n[0]), (f.t2, f.lo[1], f.n[1])):
            win["xyz"[t]] = [nodes[t][lo_i], nodes[t][min(lo_i + n_i, len(nodes[t]) - 1)]]
        ports.append({"name": f.name, "axis": "xyz"[f.a], "direction": "+" if f.d > 0 else "-",
                      "source_nm": nodes[f.a][f.k_p], "monitor_nm": nodes[f.a][f.k_m], "window_nm": win,
                      "num_modes": int(f.num_modes)})
    pol = opts.polarization or "te"
    summary = {"grid": " × ".join(map(str, g.shape)), "cells": int(g.cells), "cell size (nm)": round(float(g.dx), 4),
               "PML cells": int(g.n_pml), "runs (port modes)": int(p["runs"]),
               "dimension": "2D (z invariant)" if g.two_d else "3D"}
    if g.two_d:
        summary["polarization"] = f"{pol} ({'E in the xy plane' if pol == 'te' else 'E along z'})"
    return {"layout_kind": "device_grid", "summary": summary,
            "payload": {**_device_grid_payload(nodes, lo, hi, ports, g.two_d), "domain_lo_nm": lo, "domain_hi_nm": hi,
                        "note": "the domain includes an 8-cell buffer per side beyond domain_size_nm"},
            "warnings": list(p["warnings"]), "error": None}


# --- FDFD and inverse design ----------------------------------------------------------------------------


def _fdfd(problem, backend, design_regions=None) -> dict:
    eng = backend.engine(problem)
    g = eng.grid
    axes = [g.x, g.y] + ([g.z] if hasattr(g, "z") else [])
    nodes = [_r(a) for a in axes]
    pml_lo, pml_hi = [], []
    for a in range(len(axes)):
        i0, i1 = g.interior(a)
        pml_lo.append(nodes[a][i0])
        pml_hi.append(nodes[a][max(i0, i1 - 1)])
    ports = []
    for pg in eng.ports:
        ax = pg.axis
        t = 1 - ax if len(axes) == 2 else None
        port = {"name": pg.name, "axis": "xyz"[ax], "direction": "+" if pg.d > 0 else "-",
                "source_nm": nodes[ax][pg.i0], "num_modes": int(pg.num_modes)}
        if t is not None:
            port["window_nm"] = {"xyz"[t]: [nodes[t][pg.lo], nodes[t][min(pg.hi, len(nodes[t]) - 1)]]}
        elif hasattr(pg, "window"):
            port["window_nm"] = {"window": _r(pg.window)}
        ports.append(port)
    opts = backend._options(problem)
    summary = {"grid": " × ".join(str(len(a)) for a in axes), "cells": int(np.prod([len(a) for a in axes])),
               "cell size (nm)": round(float(g.dl), 4), "PML cells": int(opts.pml_cells),
               "dimension": "3D" if len(axes) == 3 else "2D"}
    if len(axes) == 2:
        summary["polarization"] = opts.polarization
    payload = _device_grid_payload(nodes, pml_lo, pml_hi, ports, len(axes) == 2)
    if design_regions:
        payload["design_regions"] = design_regions(g)
        summary["design regions"] = ", ".join(f"{d['name']} {' × '.join(map(str, d['shape']))}" for d in payload["design_regions"])
    return {"layout_kind": "device_grid", "summary": summary, "payload": payload, "warnings": [], "error": None}


def _inverse(problem) -> dict:
    from lightsmith.backends.fdfd import FDFD
    from lightsmith.inverse.parametrization import region_map
    from lightsmith.problems import wavelength_array

    dev = problem.device
    merged = dict(dev.options)
    for k, v in (problem.options or {}).items():  # the optimiser merges the problem's options (topopt.py)
        merged[k] = {**merged.get(k, {}), **v}
    dev = dev.model_copy(update={"options": merged})
    wl = float(np.mean(wavelength_array(dev.wavelengths)))

    def regions(grid):
        out = []
        for r in problem.design_regions:
            m = region_map(r.name, r.center_nm, r.size_nm, grid, r.material_low.eps(wl), r.material_high.eps(wl),
                           parametrization=r.parametrization, filter_radius_nm=r.filter_radius_nm, eta=r.eta,
                           min_feature_nm=r.min_feature_nm, symmetry=tuple(r.symmetry))
            out.append({"name": r.name, "shape": [int(s) for s in m.shape], "x_nm": [m.x_nm[0], m.x_nm[-1]],
                        "y_nm": [m.y_nm[0], m.y_nm[-1]], "filter_radius_cells": round(r.filter_radius_nm / float(m.dl_nm), 3),
                        "pixels": int(np.prod(m.shape))})
        return out

    return _fdfd(dev, FDFD, regions)


# --- particles: DDA, BEM, Mie, T-matrix -------------------------------------------------------------------


def _dda(problem, backend) -> dict:
    from lightsmith.backends import dda

    opts = backend._options(problem)
    npd = opts.dipoles_per_diameter or dda._default_npd(problem)
    npds = sorted({int(npd), *[int(n) for n in (opts.extrapolate or [])]})
    lat = dda._lattice(problem, max(npds), opts.discretization)
    occ = lat.occupied
    pts = lat.pts[occ]
    slot = np.argmax(lat.frac[:, occ], axis=0) if lat.frac.ndim == 4 else np.zeros(len(pts), int)
    stride = max(1, math.ceil(len(pts) / MAX_POINTS))
    payload = {"spacing_nm": float(lat.d), "dipoles_per_diameter": int(lat.npd), "grid": [int(v) for v in lat.n],
               "n_dipoles": int(len(pts)), "stride": stride, "points_nm": [_r(p, 3) for p in pts[::stride]],
               "material_slot": [int(s) for s in slot[::stride]], "discretization": opts.discretization,
               "extrapolate": npds if len(npds) > 1 else None}
    summary = {"dipoles": int(len(pts)), "spacing (nm)": round(float(lat.d), 4), "dipoles per diameter": int(lat.npd),
               "lattice": " × ".join(str(int(v)) for v in lat.n), "discretization": opts.discretization}
    if len(npds) > 1:
        summary["extrapolation lattices"] = ", ".join(map(str, npds))
    return {"layout_kind": "dipole_lattice", "summary": summary, "payload": payload, "warnings": [], "error": None}


def _bem(problem, backend) -> dict:
    from lightsmith.backends._bem.mesh import build_mesh

    opts = backend._options(problem)
    h = backend._mesh_size(problem, opts)
    mesh = build_mesh(problem, h, opts.volume_correction)
    tris = np.asarray(mesh.tris)
    stride = max(1, math.ceil(len(tris) / MAX_TRIS))
    payload = {"mesh_size_nm": float(h), "verts_nm": [_r(v, 3) for v in mesh.verts], "tris": tris[::stride].tolist(),
               "tri_surface": np.asarray(mesh.tri_surface)[::stride].tolist(), "n_triangles": int(len(tris)),
               "n_edges": int(mesh.n_edges), "stride": stride, "surfaces": len(mesh.surfaces)}
    summary = {"triangles": int(len(tris)), "edges": int(mesh.n_edges), "unknowns": 2 * int(mesh.n_edges),
               "target element size (nm)": round(float(h), 4), "mean edge (nm)": round(float(mesh.mean_edge_length()), 4),
               "surfaces": len(mesh.surfaces)}
    return {"layout_kind": "surface_mesh", "summary": summary, "payload": payload, "warnings": [], "error": None}


def _mie(problem, backend) -> dict:
    from lightsmith.backends import mie_native as mn
    from lightsmith.problems import EmissionProblem

    if isinstance(problem, EmissionProblem):
        return {"layout_kind": "none", "summary": {"multipoles": "orders up to convergence at the dipole distance"},
                "payload": {}, "warnings": [], "error": None}
    wl = problem.wavelength_array()
    _, x, m = mn.NativeMie._setup(problem, wl)
    per = [int(mn._n_max([xi[j:j + 1] for xi in x], [mi[j:j + 1] for mi in m])) for j in range(len(wl))]
    opts = mn.NativeMie._options(problem)
    note = None
    if backend.name != mn.NativeMie.name:
        note = (f"{backend.name} chooses its order internally; shown is the Wiscombe rule the library's own Mie "
                "solver uses")
    payload = {"wavelengths_nm": _r(wl, 4), "n_max": per, "size_parameter": _r(np.max(np.abs(np.asarray(x)), axis=0), 5),
               "fixed_n_max": opts.n_max, "note": note}
    summary = {"multipole order n_max": f"{min(per)}–{max(per)}" if min(per) != max(per) else max(per),
               "layers": len(x), "largest size parameter": round(float(np.max(np.abs(x[-1]))), 4)}
    if opts.n_max:
        summary["n_max (option)"] = opts.n_max
    return {"layout_kind": "multipoles", "summary": summary, "payload": payload,
            "warnings": [note] if note else [], "error": None}


def _tmatrix(problem, backend) -> dict:
    from lightsmith.backends import tmatrix_treams as tt

    opts = backend._options(problem)
    plan = tt._Plan(problem, opts)
    payload = {"lmax": [int(v) for v in plan.lmax], "modes": int(plan.modes),
               "lmax_global": int(plan.lmax_global) if plan.lmax_global is not None else None,
               "positions_nm": [_r(p, 4) for p in np.asarray(plan.positions)],
               "r_circumscribing_nm": float(plan.r_circumscribing)}
    summary = {"lmax per particle": ", ".join(map(str, payload["lmax"])), "modes (unknowns)": payload["modes"]}
    if payload["lmax_global"] is not None:
        summary["lmax (global)"] = payload["lmax_global"]
    return {"layout_kind": "multipoles", "summary": summary, "payload": payload, "warnings": [], "error": None}


# --- periodic, modes, bands, devices -------------------------------------------------------------------


def _rcwa(problem, backend) -> dict:
    from lightsmith.backends import rcwa
    from lightsmith.backends._rcwa.fourier import Lattice, harmonic_set
    from lightsmith.problems import LayerStackProblem

    opts = backend._options(problem)
    M, N = rcwa._orders(problem, opts)
    if isinstance(problem, LayerStackProblem):
        dim, layers = 0, [{"thickness_nm": float(l.thickness_nm), "patterned": False} for l in problem.layers]
    else:
        dim = Lattice(problem.lattice_a1_nm, problem.lattice_a2_nm).dim
        layers = [{"thickness_nm": float(l.thickness_nm), "patterned": bool(l.shapes), "shapes": len(l.shapes)} for l in problem.layers]
    h = harmonic_set(max(dim, 1), M, N) if dim else np.zeros((1, 2), int)
    payload = {"orders_max": [M, N], "harmonics": h.tolist(), "dim": dim, "layers": layers,
               "lattice_a1_nm": getattr(problem, "lattice_a1_nm", None), "lattice_a2_nm": getattr(problem, "lattice_a2_nm", None),
               "note": "each layer is uniform in z: the layers are the spec's own layers (no automatic slicing)"}
    summary = {"harmonics": int(len(h)), "orders": f"|m| ≤ {M}" + (f", |n| ≤ {N}" if dim == 2 else ""),
               "layers": len(layers), "patterned layers": sum(1 for l in layers if l["patterned"])}
    return {"layout_kind": "harmonics", "summary": summary, "payload": payload, "warnings": [], "error": None}


def _fde_grid_payload(grid) -> dict:
    nx = _r(grid.nodes(0, False))
    ny = _r(grid.nodes(1, False))
    return {"x_nm": nx, "y_nm": ny, "dx_nm": float(grid.dx), "dy_nm": float(grid.dy),
            "pml_cells": [list(map(int, p)) for p in grid.pml], "symmetry": list(grid.symmetry),
            "bc_min": list(grid.bc_min)}


def _fde(problem, backend) -> dict:
    from lightsmith.backends import fde

    opts = backend._options(problem)
    grid, boundary = fde._grid(problem, opts)
    payload = {**_fde_grid_payload(grid), "boundary": boundary, "num_modes": int(problem.num_modes)}
    summary = {"grid": f"{grid.nx} × {grid.ny}", "cells": int(grid.size), "cell size (nm)": f"{grid.dx:.4g} × {grid.dy:.4g}",
               "boundary": boundary, "PML cells": str(grid.pml), "modes": int(problem.num_modes)}
    return {"layout_kind": "cross_section_grid", "summary": summary, "payload": payload, "warnings": [], "error": None}


def _cells(problem, backend, bpm: bool) -> dict:
    from lightsmith.backends._eme import slice_device

    p = backend_resolved(backend, problem)
    if bpm:
        st = backend._setup(p)
        opts, grid, axis, lo, hi = st["opts"], st["grid"], st["axis"], st["lo"], st["hi"]
        cells = slice_device(p.structures, p.background, axis, lo, hi, grid, p.dimension, p.domain_center_nm[2], None,
                             None, opts.subsamples, opts.subpixel, cells_per_step=opts.taper_grid_cells_per_slice,
                             taper_cells_range=(1, opts.max_taper_slices))
        step = float(st["step"])
    else:
        opts, axis, lo, hi, _, grid, pol, num_modes = backend._setup(p)
        cells = slice_device(p.structures, p.background, axis, lo, hi, grid, p.dimension, p.domain_center_nm[2],
                             opts.taper_cells, opts.max_cell_length_nm, opts.subsamples, opts.subpixel)
    out = []
    for c in cells:
        d = {"start_nm": round(float(c.start), 4), "stop_nm": round(float(c.stop), 4)}
        if bpm:
            n = max(1, math.ceil(c.length / step - 1e-9))
            d.update(steps=int(n), dz_nm=round(float(c.length / n), 4))
        out.append(d)
    payload = {"axis": "xyz"[axis], "lo_nm": float(lo), "hi_nm": float(hi), "cells": out,
               "cross_section": _fde_grid_payload(grid)}
    summary = {"propagation axis": "xyz"[axis], "length (nm)": round(float(hi - lo), 3), "cells": len(out),
               "cross-section grid": f"{grid.nx} × {grid.ny}"}
    if bpm:
        payload["step_nm"] = step
        summary["step (nm)"] = round(step, 4)
        summary["steps"] = sum(c["steps"] for c in out)
    else:
        payload["modes_per_cell"] = int(num_modes)
        summary["modes per cell"] = int(num_modes)
    return {"layout_kind": "cells", "summary": summary, "payload": payload, "warnings": [], "error": None}


def backend_resolved(backend, problem):
    mod = sys.modules[backend.__module__]
    return mod._resolved(problem) if hasattr(mod, "_resolved") else problem


def _pwe(problem, backend) -> dict:
    from lightsmith.backends import pwe
    from lightsmith.backends._pwe.engine import make_plan

    opts = backend._options(problem)
    warnings: list[str] = []
    cell, ref_wl = pwe._cell(problem, opts, warnings)
    red, cart, dist, labels = pwe.k_path(problem)
    per = {}
    for key, pol in pwe._pols(problem).items():
        plan = make_plan(cell, pol, opts, _cpu())
        entry = {"solver": plan.solver, "num_plane_waves": int(plan.num_plane_waves), "matrix_size": int(plan.matrix_size),
                 "grid": list(plan.grid) if plan.grid is not None else None}
        if plan.idx is not None:
            entry["g_indices"] = np.asarray(plan.idx).tolist()[:4000]
        per[key] = entry
    payload = {"k_reduced": [_r(k, 5) for k in red], "k_distance": _r(dist, 5),
               "k_labels": {str(k): v for k, v in labels.items()}, "polarizations": per,
               "lattice_vectors_nm": [list(map(float, v)) for v in problem.lattice_vectors_nm[:problem.dimension]]}
    summary = {"k-points": int(len(red)), **{f"plane waves ({k})": f"{v['num_plane_waves']} ({v['solver']})" for k, v in per.items()}}
    return {"layout_kind": "plane_waves", "summary": summary, "payload": payload, "warnings": warnings, "error": None}


# --- dispatch ---------------------------------------------------------------------------------------------


def _plan(problem, backend) -> dict:
    kind, name = problem.kind, backend.name
    method = backend.method
    if method == "fdtd":
        return _fdtd_device(problem, backend) if kind == "device" else _fdtd_open(problem, backend) \
            if kind in ("scattering", "emission") else None
    if method == "fdfd" and kind == "device":
        return _fdfd(problem, backend)
    if method == "inverse":
        return _inverse(problem)
    if method == "dda":
        return _dda(problem, backend)
    if method == "bem":
        return _bem(problem, backend)
    if method == "mie":
        return _mie(problem, backend)
    if method == "tmatrix" and name != "lightsmith-tmatrix-native":
        return _tmatrix(problem, backend)
    if method == "rcwa":
        return _rcwa(problem, backend)
    if method == "fde":
        return _fde(problem, backend)
    if method in ("eme", "bpm"):
        return _cells(problem, backend, bpm=method == "bpm")
    if method == "pwe":
        return _pwe(problem, backend)
    return None


NOTHING = {
    "tmm": "the transfer matrices of the spec's layers: exact, nothing to discretise",
    "quasistatic": "closed-form polarisabilities: nothing to discretise",
    "circuit": "the netlist's compact models: nothing to discretise",
}


def layout(spec: dict, method: str = "auto") -> dict:
    problem = parse_problem(spec)
    backend = _resolve(problem, method)
    out = {"backend": backend.name, "method": backend.method, "problem_kind": problem.kind, "layout_kind": "none",
           "summary": {}, "payload": {}, "estimate": None, "warnings": [], "error": None}
    try:
        est = ls.estimate(problem, method=backend.name, device="cpu")
        out["estimate"] = json.loads(json.dumps(est, default=lambda o: o.tolist() if hasattr(o, "tolist") else str(o)))
    except Exception as e:  # noqa: BLE001 (the library's reason is what the user needs)
        out["error"] = f"{type(e).__name__}: {e}"
    try:
        planned = _plan(problem, backend)
    except Exception as e:  # noqa: BLE001
        planned = None
        out["error"] = out["error"] or f"{type(e).__name__}: {e}"
    if planned:
        err = planned.pop("error", None)
        out.update(planned)
        out["error"] = err or out["error"]
    else:
        note = NOTHING.get(backend.method, "no layout for this backend yet; the library's estimate follows")
        skip = {"backend", "method", "framework", "device", "gpu_name", "warnings", "notes", "fits"}
        figures = {k: v for k, v in (out["estimate"] or {}).items()
                   if k not in skip and (isinstance(v, (int, float, str)) or (isinstance(v, list) and len(v) <= 4
                                                                              and all(isinstance(x, (int, float)) for x in v)))}
        out["summary"] = {"discretisation": note, **figures}
        out["payload"] = {"note": note}
    est = out["estimate"] or {}
    out["warnings"] = list(dict.fromkeys([*out["warnings"], *(est.get("warnings") or [])]))
    return out


def main(argv: list[str]) -> None:
    args = [a for a in argv[1:]]
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
