# Lightsmith Studio

A GUI for setting up, running and analysing photonics simulations with the
Lightsmith library (repository `PlasmonHub`, expected next to this one). It does everything the library does, and nothing it can't:
- every form is generated from the library's JSON Schema;
- every action is a JSON edit to the same spec the `lightsmith` CLI reads.

The same build runs in three ways:
- in a browser;
- in a Docker image for the hosted service;
- as a desktop app wrapped with Tauri.

![Scene builder](docs/screenshots/scene-builder.png)

The product name, app name, deep-link scheme and the library's package/CLI names live in one file:
[`src/config/brand.ts`](src/config/brand.ts).

## Problem kinds

**New…** opens the project picker. The list of kinds comes from the live schema, so a kind added to
the library appears automatically, with generated editors.

| Kind | Scene editor | Result viewer |
|---|---|---|
| `scattering` | 3D viewport: particles to scale, move gizmo, substrate, k/E arrows, near-field plane | spectra (C or Q; ext/sca/abs), compare, near-field heatmap, far-field polar/3D |
| `layer_stack` | layer stack editor: add from presets, reorder, remove; superstrate and substrate; n at mid-band | R/T/A vs λ per angle and polarization, R/T/A vs angle map |
| `periodic` | patterned-layer stack, plus a 2D unit-cell editor with neighbouring cells shown | R/T/A plus diffraction-order efficiencies |
| `mode` | 2D cross-section editor: drag structures, simulation window | n_eff/n_g/loss/TE-fraction/A_eff table, n_eff(λ), field heatmaps (\|E\|², \|H\|², components) with outlines |
| `device` | top view: structures (prism/box/ball footprints), ports with direction, domain | \|S\|² in dB or linear, unwrapped phase, \|S\| matrix vs λ, power-balance check |
| `bands` | unit-cell editor with lattice vectors and tiled neighbours; 3D crystals shown in top view | band diagram with k labels, gaps shaded per polarization and complete gaps, gap table (a/λ and nm) |
| `circuit` | netlist graph: instances, connections, external ports | S-parameters, as for devices |
| `optimization` | the device top view plus hatched design regions | objective and binarization history, S-parameters of the final design |

- **Starting points.** Every kind has an *Example*, which the library solved when the snapshot was
  taken (`scripts/make_fixtures.py`), and a *Blank* start from schema defaults. Scattering also has
  eight templates: sphere, dimer, core–shell, rod, spheroid, trimer, Si sphere, and sphere on glass.
- **Editing in the scene.** Clicking an object in the scene selects it in the object tree. Its
  Properties panel shows the generated form, with the material picker for every material field.
  Drags are undoable spec ops.
- **Materials.** The picker draws on the bundled library, the materials-db service, models
  (constant n or ε, Drude, Drude–Lorentz) and CSV import, with n/k previews.
- **Running.**
  - The Run panel lists each backend's verdict, using the library's own reasons from
    `POST /v1/supports`.
  - Device choice and per-backend option forms come from each backend's `options_schema`.
  - Estimate gives memory and runtime before you run.
  - Solve and Compare send jobs with live progress over WebSocket; you can cancel and re-run.
- **Files and sharing.** Open and save spec JSON (recent files, drag and drop). Deep links take the
  form `?spec=`, `?spec_url=` and `lightsmith-studio://open?spec=`. "Copy as Python / CLI / curl /
  MCP" is available, and `window.studio` scripting with a live JSON panel.

## Run it (web, development)

```bash
cd lightsmith-studio
npm install
npm run dev            # http://localhost:5173
```

On first start Studio looks for a compute server at `http://localhost:8200`. If none answers, it
uses the **built-in mock server** and says so in the status bar. In the mock:
- Scattering is computed in the browser: exact Mie for one sphere (checked against the library to
  <0.5 %), quasi-static otherwise.
- Every other kind answers with the library's solved example for that kind. The result carries a
  warning saying it is not a solution of your spec.

**Against a real local server:**

```bash
cd ../lightsmith-cloud
uv sync --extra gpu
uv run lightsmith-server
```

Then choose **Server settings → Local server**. The status bar should say "live from server".
`http://localhost:5173` and the Tauri origins are allowed by default. For other origins, use
`LIGHTSMITH_CORS_ORIGINS`.

## Docker (web mode, hosted)

```bash
cd lightsmith-studio
docker build -t lightsmith-studio .
docker run --rm -p 8080:8080 \
  -e STUDIO_COMPUTE_URL=https://compute.example.org \
  -e STUDIO_MATERIALS_URL=https://materials.example.org \
  -e STUDIO_COMMUNITY_URL=https://community.example.org \
  lightsmith-studio
```

The image is built in two stages:
1. `node:22.12.0-alpine3.21` builds the static app.
2. `nginxinc/nginx-unprivileged:1.27.3-alpine3.20` serves it as uid 101 on port 8080.

The image:
- has a `HEALTHCHECK` against `/healthz`;
- is about 55 MB;
- writes `/config.js` at container start from these variables, so one image serves any deployment:

| Variable | Meaning |
|---|---|
| `STUDIO_COMPUTE_URL` | hosted compute base URL; empty = same origin as Studio |
| `STUDIO_MATERIALS_URL` | materials-db base URL; empty = bundled library only |
| `STUDIO_DEFAULT_SERVER` | `hosted` (default when a compute URL is set), `local` or `mock` |
| `STUDIO_LOCAL_COMPUTE_URL` | default `http://localhost:8200` |
| `STUDIO_AUTH_MODE` | `none`, `oidc` or `community`; inferred from the variables below |
| `STUDIO_OIDC_ISSUER`, `STUDIO_OIDC_CLIENT_ID`, `STUDIO_OIDC_SCOPE`, `STUDIO_OIDC_AUDIENCE` | standard OIDC sign-in |
| `STUDIO_COMMUNITY_URL` | Community app, for the token handoff sign-in |
| `STUDIO_FRAME_ANCESTORS` | CSP `frame-ancestors`: who may embed Studio; default `'self'` |

nginx serves:
- the single-page app, with `/index.html` as the fallback;
- `/assets/*` as immutable;
- `config.js` with `no-store`;
- a CSP, `nosniff` and a referrer policy.

For a plain static host, edit `dist/config.js` by hand. Build-time defaults are also available as
Vite variables: `VITE_COMPUTE_URL`, `VITE_MATERIALS_URL`, `VITE_DEFAULT_SERVER`,
`VITE_OIDC_ISSUER`/`VITE_OIDC_CLIENT_ID`/`VITE_OIDC_SCOPE`, and `VITE_COMMUNITY_URL`.

## Signing in (hosted mode)

Studio keeps no user database. In hosted mode it gets a bearer token for the compute service from
the user's **Lightsmith Community** account, in one of two ways:

- **`community`: token handoff.** Studio redirects to
  `{COMMUNITY_URL}/studio/connect?return_to=<studio url>&state=<nonce>`. The Community app signs the
  user in and redirects back to
  `<return_to>#access_token=<compute JWT>&token_type=Bearer&expires_in=<s>&state=<nonce>`.
  > **The Community app does not have this endpoint yet.** The contract is in
  > API_ASSUMPTIONS.md and the shared notes.
- **`oidc`.** Standard Authorization Code flow with PKCE. Use it when the Community app (or the
  deployment's identity provider) acts as an OpenID provider. The IdP must allow Studio's URL as a
  redirect URI and allow CORS on discovery and on the token endpoint.

The token is kept in `sessionStorage`, per tab. The toolbar shows the signed-in name and offers
sign-out. Server settings also accept an API key (`osk_…`) or a pasted access token, for the
desktop app or for scripts.

## Desktop app (Tauri)

The same web build in a native window. It adds:
- native file dialogs with real paths;
- native export dialogs;
- the `lightsmith-studio://` URL scheme, forwarded to the running window.

Prerequisites, which Studio does not install:
- Rust (rustup);
- **Windows**: the MSVC C++ build tools and WebView2;
- **macOS**: the Xcode command-line tools;
- **Linux**: `libwebkit2gtk-4.1-dev build-essential libssl-dev libayatana-appindicator3-dev librsvg2-dev`.

See https://v2.tauri.app/start/prerequisites/.

```bash
npm run tauri dev
npm run tauri build                          # installers in src-tauri/target/release/bundle/
npm run tauri build -- --debug --no-bundle   # quick local exe
```

On first launch the app registers the `lightsmith-studio://` scheme for the current user.

## Scripting

```js
studio.getSpec(); studio.apply([{ op: "replace", path: ["medium_index"], value: 1.5 }])
studio.undo(); studio.redo(); studio.validate()
studio.setRun({ method: "dda", device: "gpu" }); await studio.estimate()
const { job, result } = await studio.solve(); await studio.compare({ methods: ["mie", "dda"] })
studio.python(); studio.cli("solve", "bash"); studio.onChange((spec, ops) => console.log(ops))
```

Embedding pages can `postMessage({studio: "getSpec"|"setSpec"|"apply"|"validate", id, ...})`.

## Parity guarantee

- **Generated forms.** `src/schema/SchemaForm.tsx` generates an editor for any node pydantic
  emits. Hand-made editors (materials, presets, scenes) are layered on top and never replace the
  field set.
- **Parity test.** `src/test/parity.test.tsx` walks the schema of **every problem kind**. It fails
  if:
  - any field gets the "unsupported" editor;
  - any property of any definition renders no editor.

  It also renders every backend's options schema, and a negative control proves the test can fail.
  To run it against a live server:

  ```bash
  STUDIO_SCHEMA_URL="http://localhost:8200/v1/schema" npm test
  ```
- **Templates.** `src/test/kinds.test.ts` checks that every kind's template validates against the
  schema, and that every solved example's result kind has a viewer.
- **Snapshot.** `npm run sync:library` refreshes the library snapshot: schema, backends with options
  schemas, and bundled n/k data. `uv run --project ../PlasmonHub python scripts/make_fixtures.py`
  re-solves the per-kind examples. It is slow: RCWA takes minutes.

## Tests

```bash
npm test                                   # Vitest: logic, parity, kinds, auth, config
npm run test:e2e                           # Playwright, against the mock: scattering flows + every problem kind
STUDIO_COMPUTE_URL=http://localhost:8200 npx playwright test real-server   # against a live compute server
```

Screenshots from the e2e runs are in `docs/screenshots/`.

## Layout

```
src/config/      brand.ts (names), runtime.ts (deployment config)
src/schema/      schema helpers, generated form, validation
src/state/       spec store (undo/redo, ops), connection, jobs, kinds, templates, actions
src/api/         compute + materials clients, in-browser mock server
src/components/  viewport (3D), kinds/ (2D/stack/netlist scenes), viewers/ (result kinds), panels, dialogs
src/lib/         auth (OIDC / Community), codegen, deep links, files, CSV, scripting
src/generated/   library snapshot and solved examples
docker/          nginx template, runtime-config entrypoint
src-tauri/       desktop shell
e2e/             Playwright flows
```

See [API_ASSUMPTIONS.md](API_ASSUMPTIONS.md) for every endpoint Studio relies on.

## Licence

MIT, like the rest of Lightsmith. The bundled material data are CC0 (refractiveindex.info); the
picker shows each dataset's citation.
