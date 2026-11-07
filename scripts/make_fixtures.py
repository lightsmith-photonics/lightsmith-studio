"""Solve one small example of every problem kind with the installed library.

Writes src/generated/fixtures/<kind>.json = {"spec": ..., "result": ...}. Studio uses them
as the per-kind "New project" templates (so every template is a spec the library accepted)
and as real result shapes for the viewers and tests. Run from this repo, with the library
checked out next to it (../lightsmith):

    uv run --project ../lightsmith python scripts/make_fixtures.py [kind ... | fdtd]

A kind whose solve fails keeps its spec (validated) with "result": null.

Also writes src/generated/fdtd_templates.json: Studio's FDTD scattering templates, each with the
layout the library builds for it (scripts/solver_layout.py: grid, TFSF and flux boxes, CPML,
refinement regions, mirror planes), and fixtures/fdtd/<id>.json: the library's FDTD solution of
each (on the GPU when there is one). The mock server answers those exact specs with them.

And src/generated/layouts.json: for every example (per kind, and the FDTD templates), what each backend that
supports it will discretise (scripts/solver_layout.py), for the mock's Preview tab.
"""

from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import numpy as np

try:
    import lightsmith as osc
except ImportError:  # before the rename
    import omniscatter as osc
parse_problem = __import__(f"{osc.__name__}.problems", fromlist=['parse_problem']).parse_problem

OUT = Path(__file__).resolve().parent.parent / "src" / "generated" / "fixtures"

N = lambda n: {"kind": "constant_index", "n_real": n, "n_imag": 0.0}  # noqa: E731
SI, SIO2, SIN = N(3.48), N(1.444), N(2.0)
WAVES = {"start_nm": 1500, "stop_nm": 1600, "num": 11}

SPECS: dict[str, dict] = {
    "scattering": {
        "kind": "scattering",
        "particles": [{"shape": {"kind": "sphere", "radius_nm": 40},
                       "material": {"kind": "library", "name": "Au", "dataset": "Johnson-Christy"},
                       "position_nm": [0, 0, 0]}],
        "medium_index": 1.33,
        "wavelengths": {"start_nm": 400, "stop_nm": 800, "num": 41},
        "outputs": {"near_field": {"plane": "xz", "half_width_nm": 80, "points": 41, "wavelengths_nm": [530]},
                    "far_field": {"theta_deg": list(range(0, 181, 10)), "phi_deg": [0, 90], "wavelengths_nm": [530]}},
    },
    "layer_stack": {
        "kind": "layer_stack",
        "superstrate": N(1.0),
        "layers": [{"thickness_nm": 75, "material": SIN, "coherent": True},
                   {"thickness_nm": 150, "material": {"kind": "library", "name": "SiO2", "dataset": "Malitson"}, "coherent": True}],
        "substrate": {"kind": "library", "name": "Si", "dataset": "Green-2008"},
        "wavelengths": {"start_nm": 400, "stop_nm": 1100, "num": 141},
        "angles_deg": [0, 30, 60],
        "polarizations": ["s", "p"],
    },
    "periodic": {
        "kind": "periodic",
        "lattice_a1_nm": [600, 0],
        "lattice_a2_nm": None,
        "superstrate": N(1.0),
        "layers": [{"thickness_nm": 200, "background": N(1.0),
                    "shapes": [{"name": "ridge", "profile": {"kind": "rectangle", "center_nm": [0, 0], "size_nm": [300, 300]},
                                "material": SIN}]}],
        "substrate": N(1.45),
        "wavelengths": {"start_nm": 500, "stop_nm": 900, "num": 81},
        "incidence": {"theta_deg": 0, "phi_deg": 0, "polarizations": ["s", "p"]},
    },
    "mode": {
        "kind": "mode",
        "structures": [{"name": "core", "profile": {"kind": "rectangle", "center_nm": [0, 0], "size_nm": [500, 220]}, "material": SI}],
        "background": SIO2,
        "window_center_nm": [0, 0],
        "window_size_nm": [2000, 1500],
        "wavelengths": [1500, 1550, 1600],
        "num_modes": 2,
        "include_fields": True,
    },
    "device": {
        "kind": "device",
        "dimension": 2,
        "structures": [{"name": "wg", "geometry": {"kind": "prism", "profile": {"kind": "rectangle", "center_nm": [0, 0], "size_nm": [6000, 450]},
                                                    "z_min_nm": -110, "z_max_nm": 110, "sidewall_angle_deg": 0}, "material": SI}],
        "background": SIO2,
        "domain_center_nm": [0, 0, 0],
        "domain_size_nm": [3000, 2000, 0],
        "ports": [{"name": "o1", "center_nm": [-1100, 0, 0], "size_nm": [0, 1600, 1], "direction": "+", "num_modes": 1},
                  {"name": "o2", "center_nm": [1100, 0, 0], "size_nm": [0, 1600, 1], "direction": "-", "num_modes": 1}],
        "wavelengths": [1500, 1550, 1600],
        "options": {"fdfd": {"polarization": "te", "dl_nm": 25.0}},
    },
    "bands": {
        "kind": "bands",
        "dimension": 2,
        "lattice_vectors_nm": [[500, 0, 0], [0, 500, 0]],
        "background": N(1.0),
        "structures_2d": [{"name": "rod", "profile": {"kind": "circle", "center_nm": [0, 0], "radius_nm": 100},
                           "material": {"kind": "constant_permittivity", "eps_real": 8.9, "eps_imag": 0.0}}],
        "k_path": [{"label": "Γ", "reduced": [0, 0, 0]}, {"label": "X", "reduced": [0.5, 0, 0]},
                   {"label": "M", "reduced": [0.5, 0.5, 0]}, {"label": "Γ", "reduced": [0, 0, 0]}],
        "points_per_segment": 12,
        "num_bands": 6,
        "polarization": "both",
    },
    "circuit": {
        "kind": "circuit",
        "instances": {
            "split": {"component": "coupler", "settings": {"coupling": 0.5}},
            "combine": {"component": "coupler", "settings": {"coupling": 0.5}},
            "long": {"component": "waveguide", "settings": {"length_nm": 120000, "neff": 2.4, "ng": 4.2, "wl0_nm": 1550, "loss_db_per_cm": 2.0}},
            "short": {"component": "waveguide", "settings": {"length_nm": 100000, "neff": 2.4, "ng": 4.2, "wl0_nm": 1550, "loss_db_per_cm": 2.0}},
            "dump": {"component": "terminator", "settings": {}},
        },
        "connections": [["split,o3", "long,o1"], ["long,o2", "combine,o2"], ["split,o4", "short,o1"],
                        ["short,o2", "combine,o1"], ["split,o2", "dump,o1"]],
        "ports": {"in": "split,o1", "bar": "combine,o4", "cross": "combine,o3"},
        "wavelengths": {"start_nm": 1530, "stop_nm": 1570, "num": 401},
    },
}

# Optimization wraps a device (solved by method "inverse").
SPECS["optimization"] = {
    "kind": "optimization",
    "device": {**SPECS["device"], "structures": [
        {"name": "in", "geometry": {"kind": "prism", "profile": {"kind": "rectangle", "center_nm": [-6000, 0], "size_nm": [10000, 450]},
                                    "z_min_nm": -110, "z_max_nm": 110, "sidewall_angle_deg": 0}, "material": SI},
        {"name": "out", "geometry": {"kind": "prism", "profile": {"kind": "rectangle", "center_nm": [0, 6000], "size_nm": [450, 10000]},
                                     "z_min_nm": -110, "z_max_nm": 110, "sidewall_angle_deg": 0}, "material": SI}],
        "domain_size_nm": [3200, 3200, 0],
        "ports": [{"name": "o1", "center_nm": [-1400, 0, 0], "size_nm": [0, 1800, 1], "direction": "+", "num_modes": 1},
                  {"name": "o2", "center_nm": [0, 1400, 0], "size_nm": [1800, 0, 1], "direction": "-", "num_modes": 1}]},
    "design_regions": [{"name": "design", "center_nm": [0, 0, 0], "size_nm": [2000, 2000, 220],
                        "material_low": SIO2, "material_high": SI, "init": 0.5, "filter_radius_nm": 100, "min_feature_nm": 100}],
    "objective": [{"kind": "sparameter", "out_port": "o2", "in_port": "o1", "aggregate": "min"}],
    # A short run: enough iterations for a real history, density map and exported design.
    "optimizer": {"method": "mma", "max_iter": 12, "beta_start": 4, "beta_max": 32, "beta_every": 4},
}
SPECS["optimization"]["device"] = {**SPECS["optimization"]["device"], "wavelengths": [1550],
                                   "options": {"fdfd": {"polarization": "te", "dl_nm": 40.0}}}

# A dipole 10 nm above a gold sphere, with its radiation pattern (solved by FDTD; Mie gives the rates only).
SPECS["emission"] = {
    "kind": "emission",
    "particles": [{"shape": {"kind": "sphere", "radius_nm": 40},
                   "material": {"kind": "library", "name": "Au", "dataset": "Johnson-Christy"},
                   "position_nm": [0, 0, 0]}],
    "medium_index": 1.33,
    "dipole": {"position_nm": [0, 0, 50], "orientation": [0, 0, 1]},
    "wavelengths": {"start_nm": 450, "stop_nm": 800, "num": 36},
    "radiation_pattern": {"theta_deg": list(range(0, 181, 5)), "phi_deg": [0, 90], "wavelengths_nm": [550]},
}

# FDTD scattering templates (Studio's "New project" list). Dielectric and Drude materials keep the runs small.
DRUDE_AU = {"kind": "drude", "eps_inf": 9.0, "wp_ev": 9.0, "gamma_ev": 0.07}
SI_N = {"kind": "constant_index", "n_real": 3.5, "n_imag": 0.0}
FDTD_TEMPLATES: list[dict] = [
    {"id": "fdtd-override", "name": "FDTD: dimer gap, mesh override",
     "description": "Two n = 3.5 spheres with a 10 nm gap: 8 nm cells, a 2 nm override box in the gap, and the "
                    "two mirror planes that symmetry: auto finds.",
     "spec": {"kind": "scattering", "schema_version": "0.1", "medium_index": 1.0,
              "particles": [{"shape": {"kind": "sphere", "radius_nm": 40}, "material": SI_N, "position_nm": [-45, 0, 0]},
                            {"shape": {"kind": "sphere", "radius_nm": 40}, "material": SI_N, "position_nm": [45, 0, 0]}],
              "illumination": {"kind": "plane_wave", "direction": [0, 0, 1], "polarization": [1, 0, 0]},
              "wavelengths": {"start_nm": 500, "stop_nm": 900, "num": 41},
              "outputs": {"cross_sections": True,
                          "near_field": {"plane": "xy", "offset_nm": 0, "half_width_nm": 120, "points": 61,
                                         "wavelengths_nm": [700]}},
              "options": {"fdtd": {"spacing_nm": 8, "symmetry": "auto", "grading_ratio": 1.25,
                                   "mesh_override": [{"center_nm": [0, 0, 0], "size_nm": [20, 50, 50], "spacing_nm": 2}]}}}},
    {"id": "fdtd-graded", "name": "FDTD: graded grid, plasmon ring-down",
     "description": "A 20 nm Drude (gold-like) sphere in water on grid: auto, with the resonances (wavelength "
                    "and Q) of its ring-down.",
     "spec": {"kind": "scattering", "schema_version": "0.1", "medium_index": 1.33,
              "particles": [{"shape": {"kind": "sphere", "radius_nm": 20}, "material": DRUDE_AU, "position_nm": [0, 0, 0]}],
              "illumination": {"kind": "plane_wave", "direction": [0, 0, 1], "polarization": [1, 0, 0]},
              "wavelengths": {"start_nm": 420, "stop_nm": 700, "num": 57},
              "outputs": {"cross_sections": True, "resonances": {"max_modes": 10}},
              "options": {"fdtd": {"grid": "auto", "cells_per_radius": 10}}}},
    {"id": "fdtd-beam", "name": "FDTD: focused Gaussian beam",
     "description": "A 60 nm n = 2 sphere 200 nm off the axis of a beam focused to a 1 µm waist.",
     "spec": {"kind": "scattering", "schema_version": "0.1", "medium_index": 1.0,
              "particles": [{"shape": {"kind": "sphere", "radius_nm": 60},
                             "material": {"kind": "constant_index", "n_real": 2.0, "n_imag": 0.0},
                             "position_nm": [200, 0, 0]}],
              "illumination": {"kind": "gaussian_beam", "direction": [0, 0, 1], "polarization": [1, 0, 0],
                               "waist_nm": 1000, "focus_nm": [0, 0, 0]},
              "wavelengths": {"start_nm": 500, "stop_nm": 800, "num": 31},
              "options": {"fdtd": {"spacing_nm": 6}}}},
    {"id": "fdtd-substrate", "name": "FDTD: sphere on glass, 45° incidence",
     "description": "A 40 nm n = 3.5 sphere on glass lit at 45° (s polarised): the oblique substrate source, "
                    "with the one mirror plane the incidence allows.",
     "spec": {"kind": "scattering", "schema_version": "0.1", "medium_index": 1.0,
              "particles": [{"shape": {"kind": "sphere", "radius_nm": 40}, "material": SI_N, "position_nm": [0, 0, 40]}],
              "substrate": {"material": {"kind": "constant_index", "n_real": 1.45, "n_imag": 0.0}, "interface_z_nm": 0},
              "illumination": {"kind": "plane_wave", "direction": [0.7071067811865476, 0, -0.7071067811865476],
                               "polarization": [0, 1, 0]},
              "wavelengths": {"start_nm": 500, "stop_nm": 900, "num": 41},
              "options": {"fdtd": {"spacing_nm": 5}}}},
    {"id": "fdtd-device", "name": "FDTD: 2D waveguide, TE ports",
     "description": "A 500 nm silicon strip in silica between two ports: S-parameters from the FDTD device solver "
                    "(2D, polarization te).",
     "spec": {"kind": "device", "dimension": 2, "background": SIO2,
              "structures": [{"name": "wg", "geometry": {"kind": "prism", "profile": {"kind": "rectangle", "center_nm": [0, 0],
                                                                                    "size_nm": [20000, 500]},
                                                         "z_min_nm": -110, "z_max_nm": 110, "sidewall_angle_deg": 0},
                              "material": SI}],
              "domain_center_nm": [0, 0, 0], "domain_size_nm": [3000, 4000, 0],
              "ports": [{"name": "o1", "center_nm": [-1200, 0, 0], "size_nm": [0, 3600, 1], "direction": "+", "num_modes": 1},
                        {"name": "o2", "center_nm": [1200, 0, 0], "size_nm": [0, 3600, 1], "direction": "-", "num_modes": 1}],
              "wavelengths": [1500, 1525, 1550, 1575, 1600],
              "options": {"fdtd": {"spacing_nm": 25, "polarization": "te"}}}},
]

NO_SOLVE: set[str] = set()
# Kinds solved with a given method (default: "auto" on the CPU). Mie emission has no radiation pattern, so the
# emission example runs FDTD (both rates and the pattern), on the GPU when there is one.
METHOD: dict[str, str] = {"emission": "fdtd"}
GPU_KINDS: set[str] = {"emission"}


def _finite(obj):
    if isinstance(obj, float):
        return obj if np.isfinite(obj) else None
    if isinstance(obj, dict):
        return {str(k): _finite(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_finite(v) for v in obj]
    return obj


def _decimate_fields(result: dict, max_points: int = 64) -> None:
    """Mode fields are large; keep every k-th sample so a fixture stays small."""
    for per_wl in result.get("modes") or []:
        for m in per_wl:
            f = m.get("field")
            if not f:
                continue
            sx = max(1, -(-len(f["x_nm"]) // max_points))
            sy = max(1, -(-len(f["y_nm"]) // max_points))
            f["x_nm"], f["y_nm"] = f["x_nm"][::sx], f["y_nm"][::sy]
            f["components"] = {c: [[row[::sy] for row in part[::sx]] for part in v] for c, v in f["components"].items()}


def main(kinds: list[str]) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for kind in kinds:
        spec = SPECS[kind]
        problem = parse_problem(spec)  # raises if the spec is not valid for this library
        result = None
        t0 = time.perf_counter()
        if kind not in NO_SOLVE:
            try:
                device = "gpu" if kind in GPU_KINDS and osc.doctor().get("cuda_gpus") else "cpu"
                result = osc.solve(problem, method=METHOD.get(kind, "auto"), device=device).model_dump(mode="json")
                _decimate_fields(result)
            except Exception as e:  # keep the spec; the viewer test needs only the shapes that exist
                print(f"{kind}: solve failed: {type(e).__name__}: {e}")
        text = json.dumps(_finite(json.loads(json.dumps({"spec": spec, "result": result}, default=float))), allow_nan=False)
        (OUT / f"{kind}.json").write_text(text + "\n", encoding="utf-8", newline="\n")
        print(f"{kind}: {'ok' if result else 'spec only'} in {time.perf_counter() - t0:.1f} s, "
              f"{len(text) // 1024} kB, result kind {result and result.get('kind')}")


def fdtd_templates() -> None:
    """FDTD templates with the library's layout and, when it runs, its FDTD solution."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from solver_layout import layout

    device = "gpu" if osc.doctor().get("cuda_gpus") else "cpu"
    out = []
    for t in FDTD_TEMPLATES:
        problem = parse_problem(t["spec"])
        lay = layout(t["spec"], "fdtd")
        result, t0 = None, time.perf_counter()
        if not lay.get("error"):
            try:
                result = osc.solve(problem, method="fdtd", device=device).model_dump(mode="json")
            except Exception as e:  # noqa: BLE001
                print(f"{t['id']}: solve failed: {type(e).__name__}: {e}")
        entry = {k: t[k] for k in ("id", "name", "description", "spec")} | {"layout": lay, "solved": result is not None}
        out.append(_finite(json.loads(json.dumps(entry, default=float))))
        res_path = OUT / "fdtd" / f"{t['id']}.json"
        res_path.parent.mkdir(parents=True, exist_ok=True)
        if result is not None:
            text = json.dumps(_finite(json.loads(json.dumps(result, default=float))), allow_nan=False)
            res_path.write_text(text + "\n", encoding="utf-8", newline="\n")
        elif res_path.exists():
            res_path.unlink()
        print(f"{t['id']}: layout {lay['layout_kind']} {lay['summary'].get('grid')}, "
              f"{'solved' if result else 'not solved'} in {time.perf_counter() - t0:.1f} s"
              + (f" ({lay['error']})" if lay.get("error") else ""))
    path = OUT.parent / "fdtd_templates.json"
    path.write_text(json.dumps(out, ensure_ascii=False, allow_nan=False) + "\n", encoding="utf-8", newline="\n")
    print(f"wrote {path.name} ({path.stat().st_size // 1024} kB)")


def layout_snapshots() -> None:
    """Every example's layout for every backend that can run it (the mock's Preview tab)."""
    sys.path.insert(0, str(Path(__file__).resolve().parent))
    from solver_layout import layout

    entries = [*SPECS.values(), *[t["spec"] for t in FDTD_TEMPLATES]]
    out = []
    for spec in entries:
        problem = parse_problem(spec)
        kind = problem.kind
        lays = {}
        for b in osc.all_backends():
            if kind not in (getattr(b, "problem_kinds", None) or ("scattering",)) or not b.available()[0]:
                continue
            if not b.supports(problem)[0]:
                continue
            t0 = time.perf_counter()
            try:
                lays[b.name] = layout(spec, b.name)
            except Exception as e:  # noqa: BLE001
                print(f"{kind} {b.name}: layout failed: {type(e).__name__}: {e}")
                continue
            print(f"layout {kind:12s} {b.name:24s} {lays[b.name]['layout_kind']:18s} {time.perf_counter() - t0:.1f} s")
        out.append({"spec": spec, "layouts": lays})
    path = OUT.parent / "layouts.json"
    text = json.dumps(_finite(json.loads(json.dumps(out, default=float))), ensure_ascii=False, allow_nan=False)
    path.write_text(text + "\n", encoding="utf-8", newline="\n")
    print(f"wrote {path.name} ({path.stat().st_size // 1024} kB)")


def write_templates() -> None:
    """Specs only (no results), for Studio's New-project picker; each one is validated first."""
    for spec in SPECS.values():
        parse_problem(spec)
    path = OUT.parent / "kind_templates.json"
    path.write_text(json.dumps(SPECS, indent=1, ensure_ascii=False) + "\n", encoding="utf-8", newline="\n")
    print(f"wrote {path.name}")


if __name__ == "__main__":
    args = sys.argv[1:]
    write_templates()
    if "fdtd" in args or not args:
        fdtd_templates()
    if "layouts" in args or not args:
        layout_snapshots()
    kinds = [a for a in args if a not in ("fdtd", "layouts")]
    if kinds or not args:
        main(kinds or list(SPECS))
