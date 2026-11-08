/* eslint-disable @typescript-eslint/no-explicit-any */
// Studio against a real compute server (../lightsmith-cloud), started by playwright.config.ts: every problem kind is
// edited, previewed, solved by the library and shown in its viewer; compare, sweeps and the generated code are
// exercised on real results. Jobs are small and run one at a time on the server. To use your own server:
//   LIGHTSMITH_CORS_ORIGINS=http://localhost:5174 uv run lightsmith-server   (in ../lightsmith-cloud)
//   STUDIO_COMPUTE_URL=http://localhost:8200 npx playwright test --project=live

import { spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

const url = process.env.STUDIO_COMPUTE_URL ?? "http://localhost:8231";

// Real solves, one at a time on the server, beside whatever else the machine and its GPU are doing: each job starts
// a process that imports the library and initialises CUDA, which takes minutes when another process fills the GPU.
// (CUDA_VISIBLE_DEVICES= npm run test:e2e runs the live project on the CPU.)
test.describe.configure({ timeout: 1_800_000 });
const JOB = { timeout: 1_200_000 };

const small = {
  kind: "scattering",
  particles: [{ shape: { kind: "sphere", radius_nm: 40 }, material: { kind: "library", name: "Au", dataset: "Johnson-Christy" }, position_nm: [0, 0, 0] }],
  medium_index: 1.33,
  wavelengths: { start_nm: 450, stop_nm: 650, num: 9 },
  outputs: { cross_sections: true, near_field: { plane: "xz", half_width_nm: 80, points: 41, wavelengths_nm: [530] }, far_field: null },
  options: { dda: { dipoles_per_diameter: 10 } },
};

const spec = (page: Page): Promise<any> => page.evaluate(() => window.studio.getSpec());

async function newProject(page: Page, kind: string, id = "example") {
  await page.getByTestId("menu-new").click();
  await page.getByTestId(`kind-${kind}`).click();
  await page.getByTestId(`start-${id}`).click();
  await expect(page.getByTestId("new-project")).toBeHidden();
}

const runTab = (page: Page) => page.getByTestId("right-tabs").getByTestId("tab-run").click();

/** Solve the current spec, wait for the job, open its results. */
async function solve(page: Page) {
  await runTab(page);
  const before = await page.getByTestId("job").count();
  await page.getByTestId("solve-btn").click();
  await expect(page.getByTestId("job")).toHaveCount(before + 1);
  const job = page.getByTestId("job").first();
  await expect(job).toHaveAttribute("data-status", "succeeded", JOB);
  await job.getByTestId("job-show").click();
}

/** FDTD at 8 nm cells, not the example's 2 nm: 22k cells instead of 1.4M, so a solve takes seconds even on the CPU. */
const coarseFdtd = (page: Page) => page.evaluate(() => window.studio.apply({ op: "replace", path: ["options"], value: { fdtd: { spacing_nm: 8 } } }));

/** The latest result, as Studio stored it. */
const lastResult = (page: Page): Promise<any> => page.evaluate(() => window.studio.result(window.studio.jobs()[0].key));

// A cold server's estimate worker imports the library and initialises CUDA on its first request, and with the GPU
// busy that can outlast the server's 60 s limit on one estimate ("the problem is too large"). Warm it up first.
test.beforeAll(async ({ request }) => {
  test.setTimeout(900_000);
  await expect
    .poll(async () => (await request.post(`${url}/v1/estimate`, { data: { simulation: small, method: "lightsmith-dda", device: "auto" }, timeout: 180_000 })).status(), { timeout: 800_000, intervals: [5_000] })
    .toBe(200);
});

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ([u, s]) => {
      if (sessionStorage.getItem("seeded")) return;
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem("studio:settings", JSON.stringify({ mode: "local", localUrl: u }));
      localStorage.setItem("studio:autosave", JSON.stringify(s));
    },
    [url, small] as const,
  );
  await page.goto("/");
  await expect(page.getByTestId("server-button")).toContainText("Local");
  // a cold server imports every backend on its first requests
  await expect(page.getByTestId("statusbar")).toContainText("live from server", { timeout: 300_000 });
});

test("live: supports reasons, estimate, solve with near field, compare", async ({ page }) => {
  await runTab(page);
  await expect(page.locator('[data-testid^="support-"][data-testid$="-mie"]')).toContainText("supported", { timeout: 120_000 }); // a cold server imports every backend first
  await expect(page.getByTestId("support-miepython")).toContainText("near_field", { timeout: 30_000 });

  await page.getByTestId("method-select").selectOption("dda");
  // (the server may restart its estimate worker in between: see beforeAll)
  await expect(async () => {
    await page.getByTestId("estimate-btn").click();
    await expect(page.getByTestId("estimate-dipoles")).not.toBeEmpty({ timeout: 90_000 });
  }).toPass({ timeout: 400_000 });

  await page.getByTestId("method-select").selectOption("auto");
  await page.getByTestId("solve-btn").click();
  const job = page.getByTestId("job").first();
  await expect(job).toHaveAttribute("data-status", "succeeded", JOB);
  await job.getByTestId("job-show").click();
  await expect(page.getByTestId("spectra-plot")).toHaveAttribute("data-ready", "true");
  await expect(page.getByTestId("near-field-plot")).toHaveAttribute("data-ready", "true");
  await expect(page.getByTestId("mock-notice")).toHaveCount(0);
  await page.waitForTimeout(500);
  await page.screenshot({ path: "docs/screenshots/live-server-results.png" });
  // the field's components, when the backend returns them
  await page.getByTestId("near-field-component").selectOption("2");
  await expect(page.getByTestId("near-field-plot")).toHaveAttribute("data-ready", "true");

  await runTab(page);
  const fdtd = page.getByRole("checkbox", { name: /-fdtd$/ });
  if (await fdtd.count()) await fdtd.uncheck();
  await page.getByTestId("compare-btn").click();
  await expect(page.getByTestId("job")).toHaveCount(2);
  await expect(page.getByTestId("job").first()).toHaveAttribute("data-status", "succeeded", JOB);
  await page.getByTestId("center-tabs").getByTestId("tab-compare").click();
  await expect(page.getByTestId("compare-table")).toContainText("%");
  await expect(page.getByTestId("compare-overlay-plot")).toHaveAttribute("data-ready", "true");
  // different methods really differ here: nothing in the numbers comes from Studio
  const cmp = await lastResult(page);
  const others = Object.keys(cmp.results).filter((m) => m !== cmp.reference);
  expect(others.length).toBeGreaterThan(0);
  expect(Math.max(...others.map((m) => cmp.relative_difference[m].c_ext_nm2.max))).toBeGreaterThan(0);
  await page.waitForTimeout(500);
  await page.screenshot({ path: "docs/screenshots/live-server-compare.png" });
});

// Every problem kind: its example, in its scene editor, previewed by the server, solved, in its viewer.
const KINDS: { kind: string; scene: string; viewer: string; plot: string; preview: string; layout: string }[] = [
  { kind: "layer_stack", scene: "layer-stack", viewer: "spectrum-viewer", plot: "spectrum-plot", preview: "discretisation", layout: "none" },
  { kind: "periodic", scene: "periodic-stack", viewer: "spectrum-viewer", plot: "orders-plot", preview: "harmonics", layout: "harmonics" },
  { kind: "mode", scene: "cross-section", viewer: "modes-viewer", plot: "mode-field-plot", preview: "PML cells", layout: "cross_section_grid" },
  { kind: "device", scene: "cross-section", viewer: "sparam-viewer", plot: "smatrix-plot", preview: "modes per cell", layout: "cells" },
  { kind: "bands", scene: "cross-section", viewer: "bands-viewer", plot: "bands-plot", preview: "k-points", layout: "plane_waves" },
  { kind: "circuit", scene: "netlist", viewer: "sparam-viewer", plot: "sparam-plot", preview: "instances", layout: "none" },
  { kind: "optimization", scene: "cross-section", viewer: "design-view", plot: "design-plot", preview: "design regions", layout: "device_grid" },
  { kind: "emission", scene: "viewport", viewer: "emission-viewer", plot: "emission-plot", preview: "CPML cells", layout: "yee_grid" },
];

for (const k of KINDS) {
  test(`live: ${k.kind}: scene, server preview, solve, viewer`, async ({ page }) => {
    await newProject(page, k.kind);
    expect((await spec(page)).kind).toBe(k.kind);
    await expect(page.getByTestId("statusbar")).toContainText("spec valid");
    await expect(page.getByTestId(k.scene)).toBeVisible();

    await page.getByTestId("center-tabs").getByTestId("tab-preview").click();
    await expect(page.getByTestId("preview-summary")).toContainText(k.preview, { timeout: 120_000 });
    await expect(page.getByTestId("preview-source")).toContainText("(server)");

    if (k.kind === "emission") await coarseFdtd(page);
    await solve(page);
    await expect(page.getByTestId(k.viewer)).toBeVisible();
    await expect(page.getByTestId(k.plot)).toHaveAttribute("data-ready", "true");
    // the library's solution of this spec, not the mock's example
    const r = await lastResult(page);
    await expect(page.getByTestId("mock-notice")).toHaveCount(0);
    expect(JSON.stringify(r.warnings ?? [])).not.toContain("mock server");
    expect(r.provenance?.mock).toBeUndefined();
    await page.waitForTimeout(500);
    await page.screenshot({ path: `docs/screenshots/live-server-${k.kind}.png` });
  });
}

test("live: a running job can be cancelled", async ({ page }) => {
  await newProject(page, "emission");
  await runTab(page);
  await page.getByTestId("solve-btn").click();
  const job = page.getByTestId("job").first();
  await expect(job).toHaveAttribute("data-status", /queued|running/);
  await job.getByTestId("job-cancel").click();
  await expect(job).toHaveAttribute("data-status", "cancelled", { timeout: 60_000 });
  const id = await page.evaluate(() => window.studio.jobs()[0].id);
  await expect.poll(async () => (await page.request.get(`${url}/v1/jobs/${id}`)).json().then((j) => j.status), { timeout: 120_000 }).toBe("cancelled");
});

test("live: an edited spec gets its own solution", async ({ page }) => {
  await newProject(page, "layer_stack");
  await solve(page);
  const first = await lastResult(page);
  await expect(page.getByText("solved EXAMPLE")).toHaveCount(0);
  await page.evaluate(() => window.studio.apply({ op: "replace", path: ["layers", 0, "thickness_nm"], value: 120 }));
  await solve(page);
  const second = await lastResult(page);
  expect(second.backend).toBe("lightsmith-tmm");
  expect(second.r.s[0]).not.toEqual(first.r.s[0]);
  await page.waitForTimeout(500);
  await page.screenshot({ path: "docs/screenshots/live-server-layer-stack.png" });
});

test("live: Preview from POST /v1/discretization, for several solvers", async ({ page }) => {
  await page.getByTestId("center-tabs").getByTestId("tab-preview").click();
  for (const [backend, text] of [
    ["lightsmith-dda", "dipoles"],
    ["lightsmith-bem", "triangles"],
    ["lightsmith-mie", "multipole order"],
    ["lightsmith-fdtd", "CPML cells"],
  ] as const) {
    await page.getByTestId("preview-backend").selectOption(backend);
    await expect(page.getByTestId("preview-summary")).toContainText(text, { timeout: 120_000 });
    await expect(page.getByTestId("preview-source")).toContainText("(server)");
  }
  await page.getByTestId("preview-backend").selectOption("lightsmith-dda");
  await expect(page.getByTestId("preview-plot")).toHaveAttribute("data-ready", "true", { timeout: 60_000 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: "docs/screenshots/live-server-preview.png" });
});

test("live: an edited FDTD set-up: the 3D view's layout comes from the server", async ({ page }) => {
  await newProject(page, "scattering", "fdtd-override");
  await expect(page.getByTestId("fdtd-source")).toContainText("server", { timeout: 120_000 });
  const before = await page.getByTestId("fdtd-grid").textContent();
  await page.evaluate(() => window.studio.apply({ op: "replace", path: ["options", "fdtd", "mesh_override", 0, "spacing_nm"], value: 1 }));
  await expect(page.getByTestId("fdtd-grid")).toContainText("dx 1–8 nm", { timeout: 60_000 });
  expect(await page.getByTestId("fdtd-grid").textContent()).not.toEqual(before);
  await expect(page.getByTestId("fdtd-source")).not.toContainText("before your last edit");
});

test("live: a parameter sweep runs as one server job, and re-runs", async ({ page }) => {
  await runTab(page);
  await page.getByTestId("method-select").selectOption("lightsmith-mie");
  await page.getByTestId("sweep-setup").locator("summary").click();
  await page.getByTestId("sweep-param").selectOption("particles.0.shape.radius_nm");
  await page.getByTestId("sweep-start").fill("30");
  await page.getByTestId("sweep-stop").fill("50");
  await page.getByTestId("sweep-num").fill("3");
  await page.getByTestId("sweep-run").click();
  await expect(page.getByTestId("sweep-view")).toContainText("one server job");
  await expect(page.getByTestId("sweep-view")).toContainText("3/3 done", JOB);
  await expect(page.getByTestId("sweep-table").locator("tbody tr")).toHaveCount(3);
  await expect(page.getByTestId("job")).toHaveCount(1);
  await expect(page.getByTestId("sweep-plot")).toHaveAttribute("data-ready", "true");
  await page.waitForTimeout(500);
  await page.screenshot({ path: "docs/screenshots/sweep.png" });

  await page.getByTestId("job").first().getByRole("button", { name: "Re-run" }).click();
  await expect(page.getByTestId("job")).toHaveCount(2);
  await expect(page.getByTestId("job").first()).toHaveAttribute("data-status", "succeeded", JOB);
  const again = await page.evaluate(() => window.studio.jobs()[0].sweep);
  expect(again?.values).toEqual([30, 40, 50]);
});

test("live: sweep of a non-scattering problem: a layer's thickness", async ({ page }) => {
  await newProject(page, "layer_stack");
  await runTab(page);
  await page.getByTestId("method-select").selectOption("lightsmith-tmm");
  await page.getByTestId("sweep-setup").locator("summary").click();
  await page.getByTestId("sweep-param").selectOption("layers.0.thickness_nm");
  await page.getByTestId("sweep-start").fill("60");
  await page.getByTestId("sweep-stop").fill("90");
  await page.getByTestId("sweep-num").fill("3");
  await page.getByTestId("sweep-run").click();
  await expect(page.getByTestId("sweep-view")).toContainText("3/3 done", JOB);
  const res = await lastResult(page);
  expect(res.kind).toBe("sweep");
  expect(res.results[0].r.s[0]).not.toEqual(res.results[2].r.s[0]);
});

test("live: compare devices across EME and BPM, with their real differences", async ({ page }) => {
  await newProject(page, "device");
  await runTab(page);
  await expect(page.getByTestId("support-lightsmith-eme")).toContainText("supported", { timeout: 120_000 });
  await page.getByRole("checkbox", { name: "lightsmith-fdfd" }).uncheck();
  await page.getByRole("checkbox", { name: "lightsmith-fdtd" }).uncheck();
  await expect(page.getByTestId("compare-btn")).toContainText("(2)");
  await page.getByTestId("compare-btn").click();
  await expect(page.getByTestId("job").first()).toHaveAttribute("data-status", "succeeded", JOB);
  await page.getByTestId("center-tabs").getByTestId("tab-compare").click();
  await expect(page.getByTestId("compare-quantity")).toContainText("|S");
  await expect(page.getByTestId("compare-table").locator("tbody tr")).toHaveCount(1);
  const cmp = await lastResult(page);
  expect(Object.keys(cmp.results).sort()).toEqual(["lightsmith-bpm", "lightsmith-eme"]);
});

test("live: emission without a radiation pattern: Mie and FDTD, compared", async ({ page }) => {
  await newProject(page, "emission");
  await page.evaluate(() => window.studio.apply({ op: "replace", path: ["radiation_pattern"], value: null }));
  await coarseFdtd(page);
  await runTab(page);
  await expect(page.getByTestId("support-lightsmith-mie")).toContainText("supported", { timeout: 120_000 });
  await expect(page.getByTestId("compare-btn")).toContainText("(2)");
  await page.getByTestId("compare-btn").click();
  await expect(page.getByTestId("job").first()).toHaveAttribute("data-status", "succeeded", JOB);
  await page.getByTestId("center-tabs").getByTestId("tab-compare").click();
  await expect(page.getByTestId("compare-overlay-plot")).toHaveAttribute("data-ready", "true");
  await expect(page.getByTestId("compare-table")).toContainText("%");
  const cmp = await lastResult(page);
  expect(Object.keys(cmp.results).sort()).toEqual(["lightsmith-fdtd", "lightsmith-mie"]);
  await page.waitForTimeout(500);
  await page.screenshot({ path: "docs/screenshots/compare-backends.png" });
});

test("live: a 3D volumetric inverse design: a z slice of the library's density", async ({ page }) => {
  // tiny: 8k cells at 100 nm, two iterations, on the CPU (as the library's own 3D gradient test)
  const SIO2 = { kind: "constant_index", n_real: 1.444, n_imag: 0 };
  const SI = { kind: "constant_index", n_real: 3.48, n_imag: 0 };
  const wg = (x: number) => ({ name: `wg${x}`, geometry: { kind: "box", center_nm: [x, 0, 0], size_nm: [5000, 400, 220] }, material: SI });
  const problem = {
    kind: "optimization",
    device: {
      kind: "device",
      dimension: 3,
      background: SIO2,
      structures: [wg(-2600), wg(2600)],
      domain_size_nm: [2000, 800, 600],
      wavelengths: [1550],
      ports: [
        { name: "o1", center_nm: [-500, 0, 0], size_nm: [0, 720, 520], direction: "+" },
        { name: "o2", center_nm: [500, 0, 0], size_nm: [0, 720, 520], direction: "-" },
      ],
      options: { fdfd: { dl_nm: 100, pml_cells: 5, solver: "bicgstab", tol: 1e-9 } },
    },
    design_regions: [{ name: "gap", center_nm: [0, 0, 0], size_nm: [200, 480, 220], material_low: SIO2, material_high: SI, init: 0.5, filter_radius_nm: 120, parametrization: "volumetric" }],
    objective: [{ kind: "sparameter", out_port: "o2", in_port: "o1" }],
    optimizer: { method: "mma", max_iter: 2, beta_every: 1000 },
  };
  await page.evaluate((p) => window.studio.setSpec(p), problem);
  await expect(page.getByTestId("statusbar")).toContainText("spec valid");
  await expect(page.getByTestId("cross-section")).toBeVisible();
  await runTab(page);
  await page.getByTestId("device-select").selectOption("cpu");
  await solve(page);
  await expect(page.getByTestId("design-plot")).toHaveAttribute("data-ready", "true");
  const res = await lastResult(page);
  expect(res.designs[0].parametrization).toBe("volumetric");
  const z = page.getByTestId("design-z");
  await expect(z.locator("option")).toHaveCount(res.designs[0].z_nm.length);
  await z.selectOption("0");
  await expect(page.getByTestId("design-plot")).toHaveAttribute("data-ready", "true");
  await expect(page.getByTestId("design-view")).toContainText("% solid");
});

// The "Run this outside Studio" code, run for real with the library next to Studio, on the CPU.
function runPython(code: string, cwd: string) {
  const res = spawnSync("uv", ["run", "--no-sync", "--project", resolve("../lightsmith"), "python", "-"], { input: code, cwd, encoding: "utf8", timeout: 240_000, env: { ...process.env, CUDA_VISIBLE_DEVICES: "" } });
  expect(res.status, `${res.stdout}\n${res.stderr}`).toBe(0);
  return res.stdout;
}

test("live: Copy as Python runs for non-scattering problems", async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), "studio-python-"));
  try {
    await newProject(page, "device");
    await page.evaluate(() => window.studio.setRun({ method: "lightsmith-eme", device: "cpu" }));
    const py = await page.evaluate(() => window.studio.python("solve"));
    expect(runPython(py, dir)).toContain("written to result.json");
    expect(existsSync(join(dir, "result.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, "result.json"), "utf8")).kind).toBe("sparameters");

    await page.evaluate(() => window.studio.setRun({ compareMethods: ["lightsmith-eme", "lightsmith-bpm"] }));
    expect(runPython(await page.evaluate(() => window.studio.python("compare")), dir)).toContain("lightsmith-bpm");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
