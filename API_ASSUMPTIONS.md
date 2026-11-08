# API assumptions

Every endpoint Studio calls, what it sends, and what it does with the answer. The client code lives
in:
- `src/api/compute.ts` (compute);
- `src/api/materialsDb.ts` (materials);
- `src/lib/auth.ts` (sign-in).

The in-browser mocks implement the same interfaces. Studio uses them when no server is configured,
and the Playwright tests use them too.

Status:
- **verified**: exercised against the real service, by `e2e/real-server.spec.ts` (`npm run test:e2e` starts a local
  compute server for it) or by hand.
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
| `POST /v1/supports` | `{simulation}` | `[{name, method, available, unavailable_reason, supported, reason}]`. On 404 or 405 (older servers) Studio falls back to one `/v1/estimate` per backend, cached per spec. | verified |
| `GET /v1/doctor` | — | Device menu and settings. | verified |
| `POST /v1/estimate` | `{simulation, method, device}` | The whole dict, with labels for known keys. Runtime comes from `estimated_runtime_s`, else `seconds_estimate`, else a labelled heuristic. When the server has no `/v1/discretization`, the estimate's figures fill the Preview tab, and for FDTD scattering its `symmetry` (`mirrors`, `planes_nm`, `reduction`, `skipped`) gives the 3D mirror planes. | verified |
| `POST /v1/discretization` | `{simulation, method}` | What the backend will discretise (any backend), for the Preview tab, the FDTD objects in the 3D view and the mesh slice; see "Solver layouts" below. On 404 or 405 (servers before it) Studio falls back to the dev server's library bridge (development only), then to `/v1/estimate`. | verified (every problem kind) |
| `POST /v1/jobs` → 202 | `{simulation, kind: "solve"\|"compare"\|"sweep", method, methods, reference, device, label, sweep}` | `job_id` (or `id`) and `status`. A 422 at submit is shown as a toast. Optimization problems are submitted as `solve`, which the API treats like `optimize`. `kind: "sweep"` with `sweep: {path, values}`: see "Comparisons and sweeps". | verified (every problem kind; compare, sweeps) |
| `GET /v1/jobs/{id}` | — | `status`, `progress`, `stage`, `message`, `error`, `result`. When `result` is null on success, Studio fetches `result_url`. | verified |
| `DELETE /v1/jobs/{id}` | — | Cancel. Falls back to `POST …/cancel`. | verified |
| `WS /v1/jobs/{id}/events` | — | `status`, `progress` and `log` events. `end`, or a terminal status, triggers a final GET. Studio polls if the socket fails. | verified |

**Result kinds.** Studio picks a viewer from `result.kind`, or from the result's shape for older
servers:

| `kind` | Fields Studio reads |
|---|---|
| `cross_sections` | `wavelengths_nm`, `c_ext_nm2`/`c_sca_nm2`/`c_abs_nm2`, `equivalent_radius_nm`, `near_field[]` (`enhancement`, and `e_real`/`e_imag` as `[component][axis1][axis2]` when present), `far_field[]` |
| `spectrum` | `wavelengths_nm`, `angles_deg`, `polarizations`, `r`/`t`/`a` as `{pol: [angle][wl]}`, `orders[]` as `{order, r, t}`, `r_amplitude`/`t_amplitude` as `{pol: [angle][wl][re, im]}` when present |
| `modes` | `wavelengths_nm`, `modes[wl][mode]` with `neff_real`, `neff_imag`, `ng`, `te_fraction`, `loss_db_per_cm`, `effective_area_um2`, `field{x_nm, y_nm, components{Ex..Hz: [re, im]}}` (indexed `[x][y]`) |
| `sparameters` | `wavelengths_nm`, `ports`, `s_real`/`s_imag` (indexed `[wl][out][in]`) |
| `bands` | `k_distance`, `k_labels` (`{index: label}`), `frequencies{pol: [k][band]}` (a/λ) |
| `optimization` | `history[]` with `iteration`, `objective`, `binarization`; `objective_initial`, `objective_final`, `objective_binary`; `designs[]` (`density`, `raw` as `[x][y]`, or `[x][y][z]` on `z_nm` for volumetric regions, shown by z slice); `structures`; `final_device` (opens as a device problem); `sparameters` |
| `emission` | `wavelengths_nm`, `purcell`, `radiative`, `efficiency`; `radiation_pattern[]` with `wavelength_nm`, `theta_deg`, `phi_deg`, `dp_domega` (`[theta][phi]`, over P0). Studio derives only the non-radiative part, `purcell − radiative`. |

`cross_sections` results may also carry `resonances[]` (`wavelength_nm`, `energy_ev`, `q`, `amplitude`), from
time-domain solvers when `outputs.resonances` is set; Studio shows them as a Q table.

`compare` returns `{reference, results: {name: <any kind>}, relative_difference}`. Studio overlays the
per-method results in the kind's viewer and differences them in the Compare tab (see "Comparisons
and sweeps").

## Solver layouts (library and compute API)

For every backend, Studio shows what the solver will discretise before the run: the FDTD Yee grid, boxes and
CPML (and unit cells, and device grids with ports); the DDA dipole lattice; the BEM surface mesh; the Mie and
T-matrix multipole orders; the RCWA harmonics and layers; the FDE and FDFD grids; the EME and BPM cells; the PWE
k-path and plane waves; the inverse-design grid and design regions. Studio never computes any of these: they
depend on each backend's sizing rules, and a TypeScript copy would drift from the solvers.

**Status.** In the library's `main` (`lightsmith/discretize.py`, `Backend.discretization()`, `ls.discretization`,
`lightsmith discretization`, the MCP tool `get_discretization`, `tests/test_discretization.py`,
`docs/discretization.md`; named so because `lightsmith.layout` is the GDS module) and the compute server's `main`
(`POST /v1/discretization`, run in the sandboxed estimate worker). Servers older than that have only
`POST /v1/estimate`, whose figures (dipoles, unknowns, `grid` shapes, `n_max`, `harmonics`, `num_plane_waves`, FDTD
`symmetry.planes_nm`) hold no positions, nodes, meshes, cells or port planes: Studio then shows the figures.

**The API.** One optional, read-only `discretization()` per backend, next to `estimate`, which never solves:

```python
ls.discretization(problem, method="auto") -> dict  # Backend.discretization(problem, device), optional
```
```bash
lightsmith discretization spec.json [--method dda] # JSON on stdout, errors as for estimate
```
```http
POST /v1/discretization  {"simulation": {...}, "method": "auto"}   ->  200 <the envelope>   (lightsmith-cloud)
```
and an MCP tool `get_discretization` with the same arguments. `method` resolves as for `solve`.

**Common envelope** (every backend):

```json
{
  "backend": "lightsmith-dda", "method": "dda", "problem_kind": "scattering",
  "layout_kind": "dipole_lattice",
  "summary": {"dipoles": 2176, "spacing (nm)": 4.98, "...": "..."},
  "payload": {"...": "per layout_kind, below"},
  "estimate": {"...": "the backend's estimate() for the same problem"},
  "warnings": [],
  "error": null
}
```

- `summary` is an ordered map of the key figures, already labelled; a GUI or an agent can show it as is.
- `error` carries the library's refusal (for example a graded FDTD grid with a Gaussian beam) while the
  geometry is still returned where it can be computed. Errors that leave no geometry are raised as usual (422
  over HTTP).
- Backends without a layout return `layout_kind: "none"`, a `summary` from their estimate, and `payload.note`.
- Sizes stay small: node planes per axis, never per cell; points and triangles are capped and subsampled, with
  the true counts and the `stride` reported.

**Payloads** (world coordinates in nm):

| `layout_kind` | Backends | Payload | Library source (private today) |
|---|---|---|---|
| `yee_grid` | FDTD scattering, emission | `grid` (`kind`, `shape`, `cells`, `nodes_nm[3]`, `spacing_min/max_nm`, `max_ratio`), `domain_nm`, `pml` (`cells`, inner faces), `boxes[]` (tfsf, flux_total, flux_scattered; emission: flux_radiated), `regions[]` (auto, mesh_override), `symmetry` | `_fdtd.scattering` (`grid_regions`, `spacing`, `_bbox`), `_fdtd.setup` (`graded_layout`, `scattering_layout`), `_fdtd.symmetry.find`, `_fdtd.emission.plan` |
| `device_grid` | FDTD and FDFD devices, inverse design | `nodes_nm[2 or 3]`, `pml_inner_lo/hi_nm`, `ports[]` (`name`, `axis`, `direction`, `source_nm`, FDTD `monitor_nm`, `window_nm`, `num_modes`), `two_d`; inverse: `design_regions[]` (`shape`, extent, `filter_radius_cells`) | `_fdtd.device.plan` (`grid`, `frames`); `FDFD.engine(p).grid` / `.ports`; `inverse.parametrization.region_map` on `FDFD.design_grid` |
| `dipole_lattice` | DDA | `spacing_nm`, `dipoles_per_diameter`, `grid`, `n_dipoles`, `points_nm[]`, `material_slot[]`, `stride`, `discretization`, `extrapolate` | `dda._lattice(sim, npd, discretization)` |
| `surface_mesh` | BEM | `mesh_size_nm`, `verts_nm[]`, `tris[]`, `tri_surface[]`, `n_triangles`, `n_edges`, `stride` | `NativeBEM._mesh_size`, `_bem.mesh.build_mesh` |
| `multipoles` | Mie (per wavelength), T-matrix (per particle) | Mie: `wavelengths_nm`, `n_max[]`, `size_parameter[]`; T-matrix: `lmax[]`, `modes`, `lmax_global`, `positions_nm` | `mie_native.NativeMie._setup`, `_n_max`; `tmatrix_treams._Plan` |
| `harmonics` | RCWA | `orders_max`, `harmonics[]` (m, n), `layers[]` (`thickness_nm`, `patterned`) | `rcwa._orders`, `_rcwa.fourier.harmonic_set` |
| `cross_section_grid` | FDE | `x_nm`, `y_nm`, `dx_nm`, `dy_nm`, `pml_cells`, `symmetry`, `boundary`, `num_modes` | `fde._grid` |
| `cells` | EME, BPM | `axis`, `lo_nm`, `hi_nm`, `cells[]` (`start_nm`, `stop_nm`; BPM: `steps`, `dz_nm`), `cross_section`; EME: `modes_per_cell`; BPM: `step_nm` | `NativeEME._setup` / `NativeBPM._setup`, `_eme.slice_device` |
| `plane_waves` | PWE | `k_reduced[]`, `k_distance[]`, `k_labels`, per polarisation `solver`, `num_plane_waves`, `matrix_size`, FFT `grid`, dense `g_indices[]` | `pwe._cell`, `pwe.k_path`, `_pwe.engine.make_plan` |
| `unit_cell` | FDTD periodic, layer stacks | `x_nm`, `y_nm`, `z_nm` (depth below the top of the stack), `planes_nm` (reflection monitor, source, stack top and bottom, transmission monitor), `pml_cells`, `pml_inner_z_nm`, layer tops and thicknesses, `invariant` | `_fdtd.periodic.make_cell` |
| `none` | TMM, quasistatic, circuits | `note`; the summary holds the estimate's figures | — |

Mie's payload also names the order `rule`: Wiscombe's for `lightsmith-mie`, and `miepython`'s own
`wiscombe_terms` for `miepython`.

**In Studio.**

- `scripts/solver_layout.py` (the dev server's library bridge, and `make_fixtures.py`) calls
  `lightsmith.discretization` and prints the envelope.
- The Vite dev server runs it for `POST /__library/v1/layout` (`vite.config.ts`, development only, needs `uv` and
  `../lightsmith`; off with `STUDIO_LIBRARY_BRIDGE=0`), when the server has no layout to offer (the mock on an edited
  spec, older servers).
- `scripts/make_fixtures.py` snapshots the layouts of every example (and the default sphere) for every backend
  that runs it (`src/generated/layouts.json`, and the FDTD templates in `fdtd_templates.json`), which the
  in-browser mock serves for those exact specs, together with the estimate recorded alongside.

## Comparisons and sweeps

- **Compare** uses `POST /v1/jobs` with `kind: "compare"` and `methods`, and also overlays any finished runs of
  the same problem kind. Differences are computed in Studio from the results' own arrays (curves per result
  kind: cross sections, R/T/A, n_eff, |S|², bands, decay rates, objective history), relative to a chosen
  reference with the library's floor (10⁻³ of the reference's largest value). Runs on different x grids are
  interpolated onto the reference's.
- **Sweeps** change one number (a spec field, or `options[method][field]`, created if absent) over a list of
  values. Studio checks every swept spec against the schema first and skips the values it rejects, then submits
  `POST /v1/jobs` with `kind: "sweep"` and `sweep: {path, values}`: one job, which the server runs value by value
  in one worker. The result is `{kind: "sweep", path, values, method, results: [one result per value, or null],
  errors: {index: {error, message}}}`; in hosted mode each value is priced and the job's credit estimate is
  their sum. A server without sweep jobs rejects the kind (422 naming `kind`, or 404/405); Studio then submits
  one `solve` job per value instead, with the same results in the Sweep tab. The in-browser mock runs sweep jobs
  like the server. Solves stay independent either way: the swept field changes each solver's set-up.

## Materials (materials-db, `http://localhost:8100`)

| Endpoint | Studio uses | Status |
|---|---|---|
| `GET /v1/materials?per_page=100&q=` | `items[]` of `{id, name, description, datasets: [{id, name, range_nm, reference, doi}]}` | contract |
| `GET /v1/datasets/{id}/data` | `wavelength_nm`, `n`, `k` (or `n_real`/`n_imag`); null k becomes 0. Ids are encoded per path segment. | contract |
| `GET /v1/datasets/{id}/lightsmith` | A `tabulated` Material inserted into the spec. Studio falls back to the deprecated `/omniscatter` alias, then builds the material from `/data`. | contract |

## Sign-in (hosted mode)

Configured by `auth.mode` in the runtime config.

- **`community`** (implemented in `../lightsmith-community`, `src/app/studio/connect/route.ts`):
  1. Studio requests `GET {communityUrl}/studio/connect?return_to=<studio origin+path>&state=<nonce>`.
  2. The Community app signs the user in. It refuses any `return_to` that is not on the origin of its
     `STUDIO_URL` or in `STUDIO_CONNECT_ORIGINS` (400, no redirect).
  3. It responds `302 <return_to>#access_token=<JWT for the compute service>&token_type=Bearer&expires_in=<seconds>&state=<nonce>`.

  The JWT is the same one the compute service already verifies: HS256 with `PLATFORM_JWT_SECRET`,
  `sub`, `name`, `aud: "compute"`, always with `role: "user"`, for an hour. Using the fragment
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
