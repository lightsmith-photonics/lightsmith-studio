# API assumptions

Every endpoint Studio calls, what it sends, and what it does with the answer. The client code lives
in:
- `src/api/compute.ts` (compute);
- `src/api/materialsDb.ts` (materials);
- `src/lib/auth.ts` (sign-in).

The in-browser mocks implement the same interfaces. Studio uses them when no server is configured,
and the Playwright tests use them too.

Status:
- **verified**: exercised against the real service, by `e2e/real-server.spec.ts` or by hand.
- **contract**: matches the service's written contract, but no live test covers it yet.
- **proposed**: Studio implements it, but the other service does not offer it yet.

Contracts:
- compute (Lightsmith Cloud): `../lightsmith-cloud/API.md` and `openapi.json`;
- materials-db: `../lightsmith-materials` (`/docs`).

Studio reaches both only through URL configuration (`src/config/runtime.ts`): build-time `VITE_*`
or runtime `config.js` (Docker `STUDIO_*`).

## Compute (`lightsmith-server`, local `http://localhost:8200`)

**Auth.**
- Local mode: none.
- Hosted mode: `Authorization: Bearer <token>` on HTTP, where the token is the signed-in Community
  session if there is one, else the API key.
- WebSockets: the token travels as subprotocols `["lightsmith.bearer", <token>]`.

**Errors.** `{error, message}`. FastAPI's `{detail: ...}` is also accepted.

| Endpoint | Studio sends | Studio uses | Status |
|---|---|---|---|
| `GET /v1/schema?all=1` | — | The JSON Schema every form is generated from. Studio accepts the `{problem: union}` envelope (current), a root `Simulation`, or a root `oneOf`. | verified |
| `GET /v1/backends` | — | `name`, `method`, `problem_kinds`, `gpu`, `available`, `unavailable_reason`, `license` and `citation` feed the method list and the support table. `options_schema` generates the per-method options forms. While the server sends `null`, Studio uses the bundled snapshot's schema for the same backend name. | verified |
| `POST /v1/supports` | `{simulation}` | `[{name, method, available, unavailable_reason, supported, reason}]`. On 404 or 405 (older servers) Studio falls back to one `/v1/estimate` per backend, cached per spec. | contract (fallback verified) |
| `GET /v1/doctor` | — | Device menu and settings. | verified |
| `POST /v1/estimate` | `{simulation, method, device}` | The whole dict, with labels for known keys. Runtime comes from `estimated_runtime_s`, else `seconds_estimate`, else a labelled heuristic. For FDTD scattering, `symmetry` (`mirrors`, `planes_nm`, `reduction`, `skipped`) and `graded_grid` are also the fallback for the 3D mirror planes when the server has no `/v1/layout`. | verified |
| `POST /v1/layout` | `{simulation, method: "fdtd"}` | The FDTD layout for the 3D view and the mesh preview; see "Proposed: FDTD layout" below. On 404 or 405 Studio falls back to the dev server's library bridge (development only), then to `/v1/estimate`. | **proposed** |
| `POST /v1/jobs` → 202 | `{simulation, kind: "solve"\|"compare", method, methods, reference, device, label}` | `job_id` (or `id`) and `status`. A 422 at submit is shown as a toast. Optimization problems are submitted as `solve`, which the API treats like `optimize`. | verified (scattering) |
| `GET /v1/jobs/{id}` | — | `status`, `progress`, `stage`, `message`, `error`, `result`. When `result` is null on success, Studio fetches `result_url`. | verified |
| `DELETE /v1/jobs/{id}` | — | Cancel. Falls back to `POST …/cancel`. | contract |
| `WS /v1/jobs/{id}/events` | — | `status`, `progress` and `log` events. `end`, or a terminal status, triggers a final GET. Studio polls if the socket fails. | verified |

**Result kinds.** Studio picks a viewer from `result.kind`, or from the result's shape for older
servers:

| `kind` | Fields Studio reads |
|---|---|
| `cross_sections` | `wavelengths_nm`, `c_ext_nm2`/`c_sca_nm2`/`c_abs_nm2`, `equivalent_radius_nm`, `near_field[]`, `far_field[]` |
| `spectrum` | `wavelengths_nm`, `angles_deg`, `polarizations`, `r`/`t`/`a` as `{pol: [angle][wl]}`, `orders[]` as `{order, r, t}` |
| `modes` | `wavelengths_nm`, `modes[wl][mode]` with `neff_real`, `neff_imag`, `ng`, `te_fraction`, `loss_db_per_cm`, `effective_area_um2`, `field{x_nm, y_nm, components{Ex..Hz: [re, im]}}` (indexed `[x][y]`) |
| `sparameters` | `wavelengths_nm`, `ports`, `s_real`/`s_imag` (indexed `[wl][out][in]`) |
| `bands` | `k_distance`, `k_labels` (`{index: label}`), `frequencies{pol: [k][band]}` (a/λ) |
| `optimization` | `history[]` with `iteration`, `objective`, `binarization`; `objective_initial`, `objective_final`, `objective_binary`; `structures`; `sparameters` |
| `emission` | `wavelengths_nm`, `purcell`, `radiative`, `efficiency`; `radiation_pattern[]` with `wavelength_nm`, `theta_deg`, `phi_deg`, `dp_domega` (`[theta][phi]`, over P0). Studio derives only the non-radiative part, `purcell − radiative`. |

`cross_sections` results may also carry `resonances[]` (`wavelength_nm`, `energy_ev`, `q`, `amplitude`), from
time-domain solvers when `outputs.resonances` is set; Studio shows them as a Q table.

`compare` returns `{reference, results: {name: <any kind>}, relative_difference}`. For
non-scattering kinds Studio overlays the per-method results in the kind's viewer.

## Proposed: FDTD layout (library and compute API)

**The gap.** Studio draws the FDTD simulation objects (TFSF box, flux monitors, CPML, auto-refined regions,
mirror planes) and previews the Yee grid on a slice. It must not compute them itself: they depend on the
library's sizing rules (padding, gaps, CPML cells, `grid: "auto"` refinement, grading, symmetry detection), and
a TypeScript copy would drift from the solver. Today the library exposes none of this:

- `lightsmith estimate` / `POST /v1/estimate` (FDTD) returns `grid` (the *run's* shape, halved by symmetry),
  `cells`, `spacing_nm`, `symmetry` (with `planes_nm`) and, on graded grids, `graded_grid` (min/max spacing,
  `max_ratio`). That is enough for the mirror planes, not for node planes or boxes.
- The node planes and boxes exist only inside the private planning code
  (`lightsmith.backends._fdtd.scattering.plan` → `Layout`; `emission.plan`).

**Proposal.** A small, read-only call next to `estimate`, which never runs the solver:

```python
ls.layout(problem, method="fdtd") -> dict          # Backend.layout(sim), optional per backend
```
```bash
lightsmith layout spec.json [--method fdtd]        # JSON on stdout, errors as for estimate
```
```http
POST /v1/layout  {"simulation": {...}, "method": "fdtd"}   ->  200 <the dict>   (lightsmith-cloud)
```
and an MCP tool `get_layout` with the same arguments. The dict, for scattering and emission problems (the
whole grid, before any mirror halving; world coordinates in nm):

```json
{
  "backend": "lightsmith-fdtd", "method": "fdtd", "problem_kind": "scattering",
  "grid": {"kind": "uniform | graded", "base_spacing_nm": 8.0, "shape": [81, 81, 81], "cells": 531441,
           "nodes_nm": [[...x], [...y], [...z]], "spacing_min_nm": [2, 2, 2], "spacing_max_nm": [8, 8, 8],
           "max_ratio": 1.25},
  "domain_nm": {"lo_nm": [...], "hi_nm": [...]},
  "pml": {"cells": 10, "inner_lo_nm": [...], "inner_hi_nm": [...]},
  "boxes": [{"name": "tfsf", "label": "...", "lo_nm": [...], "hi_nm": [...]},
            {"name": "flux_total", ...}, {"name": "flux_scattered", ...}],
  "regions": [{"source": "auto", "particle": 0, "lo_nm": [...], "hi_nm": [...], "spacing_nm": [2, 2, 2]},
              {"source": "mesh_override", "index": 0, ...}],
  "symmetry": {"mirrors": {"x": "antisymmetric (PEC)"}, "reduction": 2, "planes_nm": {"x": 0.0}, "skipped": "..."},
  "run_cells": 142884,
  "warnings": [],
  "error": null
}
```

- Emission problems have one box, `flux_radiated` (the closed radiated-power box), and no mirror planes.
- `error` carries the library's refusal (for example a graded grid with a Gaussian beam) while the geometry is
  still returned, so the user sees what they built and why it will not run. Errors that leave no geometry are
  raised as usual (422 over HTTP).
- Sizes: `nodes_nm` is one float per node plane (a few hundred per axis), never per cell.
- Periodic and layer-stack problems (a unit cell) could follow with the same shape; Studio does not ask for
  them yet.

**Reference implementation.** `scripts/fdtd_layout.py` in this repository builds exactly this dict from the
library's private planning functions, so it reuses the solver's code path rather than copying it. It is what
Studio uses until the library ships `layout`:

- the Vite dev server runs it for `POST /__library/v1/layout` (`vite.config.ts`, development only, needs `uv`
  and `../lightsmith`; off with `STUDIO_LIBRARY_BRIDGE=0`);
- `scripts/make_fixtures.py` snapshots the layouts of the FDTD templates (`src/generated/fdtd_templates.json`),
  which the in-browser mock serves for those exact specs.

Moving it into the library is a matter of putting `layout()` beside `NativeFDTD.estimate` and registering the
CLI, MCP and HTTP routes; the private imports in the script then go away.

## Materials (materials-db, `http://localhost:8100`)

| Endpoint | Studio uses | Status |
|---|---|---|
| `GET /v1/materials?per_page=100&q=` | `items[]` of `{id, name, description, datasets: [{id, name, range_nm, reference, doi}]}` | contract |
| `GET /v1/datasets/{id}/data` | `wavelength_nm`, `n`, `k` (or `n_real`/`n_imag`); null k becomes 0. Ids are encoded per path segment. | contract |
| `GET /v1/datasets/{id}/lightsmith` | A `tabulated` Material inserted into the spec. Studio falls back to the deprecated `/omniscatter` alias, then builds the material from `/data`. | contract |

## Sign-in (hosted mode)

Configured by `auth.mode` in the runtime config.

- **`community`** (**proposed** for the Community app, `../lightsmith-community`):
  1. Studio requests `GET {communityUrl}/studio/connect?return_to=<studio origin+path>&state=<nonce>`.
  2. The Community app signs the user in. It should check `return_to` against an allow-list of
     Studio origins.
  3. It responds `302 <return_to>#access_token=<JWT for the compute service>&token_type=Bearer&expires_in=<seconds>&state=<nonce>`.

  The JWT is the same one the compute service already verifies: HS256 with `PLATFORM_JWT_SECRET`,
  `sub`, `name`, `aud: "compute"`. It should be short-lived, at most an hour. Using the fragment
  keeps the token out of server logs. Studio checks `state`, stores the token in `sessionStorage`
  and removes the fragment from the address bar.
- **`oidc`** (standard):
  1. Discovery at `{issuer}/.well-known/openid-configuration`.
  2. Authorization Code flow with PKCE (S256), public client, `redirect_uri` = Studio origin + path.
  3. Token exchange at `token_endpoint`. The IdP must allow CORS on discovery and on the token
     endpoint.

  The access token must be accepted by the compute service.
- **`none`**: Studio offers only the API-key field and token paste.

## Deep links

| Form | Example |
|---|---|
| Web | `https://<studio>/?spec=<base64url(JSON) or URI-encoded JSON>`, `?spec_url=<http(s) URL>` (CORS-enabled), or `#spec=` |
| Desktop | `lightsmith-studio://open?…` with the same parameters |

`&name=` becomes the file name. `&project=` is accepted. Opening a link never runs anything.

## Runtime config (`config.js`)

`window.__STUDIO_CONFIG__ = {defaultServer, computeUrl, localComputeUrl, materialsUrl, auth: {mode,
communityUrl, oidc: {issuer, clientId, scope, audience}}}`.

The Docker entrypoint (`docker/40-studio-config.sh`) writes this file from `STUDIO_*` variables.
Empty values fall back to build-time defaults.
