"""Solve one small example of every problem kind with the installed library.

Writes src/generated/fixtures/<kind>.json = {"spec": ..., "result": ...}. Studio uses them
as the per-kind "New project" templates (so every template is a spec the library accepted)
and as real result shapes for the viewers and tests. Run from this repo, with the library
checked out next to it (../PlasmonHub):

    uv run --project ../PlasmonHub python scripts/make_fixtures.py [kind ...]

A kind whose solve fails keeps its spec (validated) with "result": null.
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

NO_SOLVE: set[str] = set()


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
                result = osc.solve(problem, device="cpu").model_dump(mode="json")
                _decimate_fields(result)
            except Exception as e:  # keep the spec; the viewer test needs only the shapes that exist
                print(f"{kind}: solve failed: {type(e).__name__}: {e}")
        text = json.dumps(_finite(json.loads(json.dumps({"spec": spec, "result": result}, default=float))), allow_nan=False)
        (OUT / f"{kind}.json").write_text(text + "\n", encoding="utf-8")
        print(f"{kind}: {'ok' if result else 'spec only'} in {time.perf_counter() - t0:.1f} s, "
              f"{len(text) // 1024} kB, result kind {result and result.get('kind')}")


def write_templates() -> None:
    """Specs only (no results), for Studio's New-project picker; each one is validated first."""
    for spec in SPECS.values():
        parse_problem(spec)
    path = OUT.parent / "kind_templates.json"
    path.write_text(json.dumps(SPECS, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"wrote {path.name}")


if __name__ == "__main__":
    write_templates()
    main(sys.argv[1:] or list(SPECS))
