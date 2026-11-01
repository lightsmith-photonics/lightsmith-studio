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
- compute: `services/compute/API.md` and `openapi.json`;
- materials-db: `services/materials-db` (`/docs`).

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
| `POST /v1/estimate` | `{simulation, method, device}` | The whole dict, with labels for known keys. Runtime comes from `estimated_runtime_s`, else `seconds_estimate`, else a labelled heuristic. | verified |
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

`compare` returns `{reference, results: {name: <any kind>}, relative_difference}`. For
non-scattering kinds Studio overlays the per-method results in the kind's viewer.

## Materials (`services/materials-db`, `http://localhost:8100`)

| Endpoint | Studio uses | Status |
|---|---|---|
| `GET /v1/materials?per_page=100&q=` | `items[]` of `{id, name, description, datasets: [{id, name, range_nm, reference, doi}]}` | contract |
| `GET /v1/datasets/{id}/data` | `wavelength_nm`, `n`, `k` (or `n_real`/`n_imag`); null k becomes 0. Ids are encoded per path segment. | contract |
| `GET /v1/datasets/{id}/lightsmith` | A `tabulated` Material inserted into the spec. Studio falls back to the deprecated `/omniscatter` alias, then builds the material from `/data`. | contract |

## Sign-in (hosted mode)

Configured by `auth.mode` in the runtime config.

- **`community`** (**proposed** for the Community app, `apps/web`):
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
