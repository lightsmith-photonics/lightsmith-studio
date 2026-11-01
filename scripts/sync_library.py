"""Snapshot what Studio needs from the Lightsmith library into src/generated/.

Run with `npm run sync:library` (uses the library's uv project in ../lightsmith).
The snapshot is the offline fallback and the source for the mock servers; at
runtime Studio prefers the live compute server (`GET /v1/schema`, ...).

Writes:
  schema.json           JSON Schema of every problem kind (or of Simulation on older libraries)
  backends.json         Backend.info() for every backend, plus `options_schema` when the
                        backend validates its options with a pydantic model
  doctor.json           doctor() on this machine (example payload for the mock)
  library.json          bundled material datasets: metadata and (downsampled) n, k
  (fixtures/<kind>.json come from scripts/make_fixtures.py)
"""

from __future__ import annotations

import json
import typing
from pathlib import Path

import numpy as np

try:
    import lightsmith as osc
except ImportError:  # before the rename
    import omniscatter as osc
all_backends = osc.all_backends

OUT = Path(__file__).resolve().parent.parent / "src" / "generated"
MAX_POINTS = 160


def _write(name: str, obj) -> None:
    path = OUT / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, indent=1, default=float) + "\n", encoding="utf-8")
    print(f"wrote {path.relative_to(OUT.parent.parent)} ({path.stat().st_size // 1024} kB)")


def _schema() -> dict:
    try:
        problem_json_schema = __import__(f"{osc.__name__}.problems", fromlist=['x']).problem_json_schema
    except ImportError:
        return osc.json_schema()
    return problem_json_schema()


def _options_schema(backend) -> dict | None:
    fn = getattr(backend, "_options", None)
    if fn is None:
        return None
    try:
        model = typing.get_type_hints(fn).get("return")
    except Exception:
        return None
    return model.model_json_schema() if hasattr(model, "model_json_schema") else None


def _downsample(wl, n, k):
    wl, n, k = map(np.asarray, (wl, n, k))
    if len(wl) > MAX_POINTS:
        idx = np.unique(np.linspace(0, len(wl) - 1, MAX_POINTS).round().astype(int))
        wl, n, k = wl[idx], n[idx], k[idx]
    return [round(float(x), 4) for x in wl], [float(f"{x:.5g}") for x in n], [float(f"{x:.5g}") for x in k]


def _library() -> list[dict]:
    rows = []
    for r in osc.list_materials():
        tab = osc.load_material(r["name"], r["dataset"])
        wl, n, k = _downsample(tab.wavelength_nm, tab.n_real, tab.n_imag)
        rows.append({key: r[key] for key in ("name", "description", "aliases", "dataset", "default", "dataset_aliases",
                                               "range_nm", "has_k", "comments", "reference", "doi", "url", "license",
                                               "material_json")} | {"wavelength_nm": wl, "n": n, "k": k})
    return rows


def main() -> None:
    _write("schema.json", _schema())
    _write("backends.json", [{**b.info(), "options_schema": _options_schema(b)} for b in all_backends()])
    _write("doctor.json", osc.doctor())
    _write("library.json", _library())
    print("solved examples per problem kind: scripts/make_fixtures.py (slow; run when result shapes change)")


if __name__ == "__main__":
    main()
