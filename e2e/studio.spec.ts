// Key flows against the built-in mock compute server. Screenshots of each flow
// are written to docs/screenshots/ (they are used in the README).

import { expect, test, type Page } from "@playwright/test";

const shot = (page: Page, name: string) => page.screenshot({ path: `docs/screenshots/${name}.png` });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function spec(page: Page): Promise<any> {
  return page.evaluate(() => window.studio.getSpec());
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("server-button")).toContainText("Mock server");
  await expect(page.getByTestId("statusbar")).toContainText("spec valid");
});

test("the 3D scene's labels survive leaving and re-entering the scene, without page errors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && !/WebGL|GL Driver/.test(m.text()) && errors.push(m.text()));
  await expect(page.locator(".scene-label").first()).toBeVisible();
  const labels = await page.locator(".scene-label").allTextContents();
  expect(labels).toEqual(expect.arrayContaining(["k", "E"]));
  for (const tab of ["preview", "scene", "results", "scene"]) await page.getByTestId("center-tabs").getByTestId(`tab-${tab}`).click();
  await expect(page.locator(".scene-label").first()).toBeVisible();
  expect(await page.locator(".scene-label").allTextContents()).toEqual(expect.arrayContaining(["k", "E"]));
  expect(errors).toEqual([]);
});

test("scene builder: template, edit, undo/redo, copy/paste, live JSON", async ({ page }) => {
  await page.getByTestId("menu-new").click();
  await page.getByTestId("kind-scattering").click();
  await page.getByTestId("start-dimer").click();
  await expect(page.getByTestId("tree-particle-1")).toBeVisible();

  await page.getByTestId("tree-particle-0").click();
  const radius = page.getByTestId("input-particles/0/shape/radius_nm");
  await radius.fill("35");
  expect((await spec(page)).particles[0].shape.radius_nm).toBe(35);

  await page.getByTestId("right-tabs").getByTestId("tab-json").click();
  await expect(page.getByTestId("json-panel")).toContainText('"radius_nm": 35');
  await expect(page.getByTestId("last-op")).toContainText("replace /particles/0/shape/radius_nm");

  await page.getByTestId("undo").click();
  expect((await spec(page)).particles[0].shape.radius_nm).toBe(40);
  await page.getByTestId("redo").click();
  expect((await spec(page)).particles[0].shape.radius_nm).toBe(35);

  await page.getByTestId("tree-particle-0").click();
  await page.getByTestId("copy").click();
  await page.getByTestId("paste").click();
  await expect(page.getByTestId("tree-particle-2")).toBeVisible();
  expect((await spec(page)).particles).toHaveLength(3);

  await page.getByTestId("right-tabs").getByTestId("tab-properties").click();
  await page.getByTestId("tree-particle-2").click();
  await page.getByTestId("shape-cylinder").click();
  expect((await spec(page)).particles[2].shape.kind).toBe("cylinder");
  await page.waitForTimeout(800);
  await shot(page, "scene-builder");
});

test("materials: library picker and CSV import", async ({ page }) => {
  await page.getByTestId("tree-particle-0").click();
  await page.getByTestId("pick-material-particles/0/material").click();
  await page.getByTestId("library-search").fill("silver");
  await page.getByTestId("lib-Ag-McPeak").click();
  await expect(page.getByTestId("nk-plot")).toHaveAttribute("data-ready", "true");
  await shot(page, "material-picker");
  await page.getByTestId("material-use").click();
  expect((await spec(page)).particles[0].material).toEqual({ kind: "library", name: "Ag", dataset: "McPeak" });

  await page.getByTestId("pick-material-particles/0/material").click();
  await page.getByTestId("tab-csv").click();
  await page.getByTestId("csv-text").fill("# wl_um, n, k\n0.3, 1.5, 0.01\n0.6, 1.48, 0\n0.9, 1.47, 0");
  await page.locator("select").filter({ hasText: "nm" }).last().selectOption("um");
  await page.getByTestId("material-use").click();
  const m = (await spec(page)).particles[0].material;
  expect(m.kind).toBe("tabulated");
  expect(m.wavelength_nm).toEqual([300, 600, 900]);
});

test("run: support reasons, estimate, solve, results, near field", async ({ page }) => {
  await page.getByTestId("menu-new").click();
  await page.getByTestId("kind-scattering").click();
  await page.getByTestId("start-dimer").click();
  await page.getByTestId("right-tabs").getByTestId("tab-run").click();
  await expect(page.getByTestId("support-miepython")).toContainText("exactly one particle");
  await expect(page.getByTestId("support-lightsmith-dda")).toContainText("supported");

  await page.getByTestId("method-select").selectOption("dda");
  await page.getByTestId("estimate-btn").click();
  await expect(page.getByTestId("estimate-card")).toBeVisible();
  await expect(page.getByTestId("estimate-dipoles")).not.toBeEmpty();
  await shot(page, "estimate");

  await page.getByTestId("solve-btn").click();
  const job = page.getByTestId("job").first();
  await expect(job).toHaveAttribute("data-status", "succeeded", { timeout: 30_000 });
  await job.getByTestId("job-show").click();
  await expect(page.getByTestId("spectra-plot")).toHaveAttribute("data-ready", "true");
  await expect(page.getByTestId("near-field-plot")).toHaveAttribute("data-ready", "true");
  await page.waitForTimeout(500);
  await shot(page, "results-near-field");

  await page.getByRole("tab", { name: "Provenance & warnings" }).click();
  await expect(page.getByTestId("warnings")).toContainText("mock server");
});

test("job manager: cancel and re-run", async ({ page }) => {
  await page.getByTestId("right-tabs").getByTestId("tab-run").click();
  await page.getByTestId("solve-btn").click();
  const job = page.getByTestId("job").first();
  await job.getByTestId("job-cancel").click();
  await expect(job).toHaveAttribute("data-status", "cancelled");
  await job.getByRole("button", { name: "Re-run" }).click();
  await expect(page.getByTestId("job")).toHaveCount(2);
  await expect(page.getByTestId("job").first()).toHaveAttribute("data-status", "succeeded", { timeout: 30_000 });
});

test("compare view and far field", async ({ page }) => {
  await page.getByTestId("menu-new").click();
  await page.getByTestId("kind-scattering").click();
  await page.getByTestId("start-dielectric").click();
  await page.getByTestId("right-tabs").getByTestId("tab-run").click();
  await expect(page.getByTestId("support-lightsmith-mie")).toContainText("supported");
  await page.getByTestId("compare-btn").click();
  await expect(page.getByTestId("job").first()).toHaveAttribute("data-status", "succeeded", { timeout: 30_000 });
  await page.getByTestId("center-tabs").getByTestId("tab-compare").click();
  await expect(page.getByTestId("compare-table")).toContainText("%");
  await expect(page.getByTestId("compare-plot")).toHaveAttribute("data-ready", "true");
  await shot(page, "compare");

  await page.getByTestId("center-tabs").getByTestId("tab-results").click();
  await page.getByRole("tab", { name: "Far field" }).click();
  await expect(page.getByTestId("far-field-plot")).toHaveAttribute("data-ready", "true");
  await page.waitForTimeout(500);
  await shot(page, "far-field");
});

test("validation blocks invalid specs", async ({ page }) => {
  await page.getByTestId("tree-particle-0").click();
  await page.getByTestId("input-particles/0/shape/radius_nm").fill("-5");
  await expect(page.getByTestId("statusbar")).toContainText("spec problem");
  await page.getByTestId("right-tabs").getByTestId("tab-run").click();
  await expect(page.getByTestId("solve-btn")).toBeDisabled();
});

test("code export: Copy as Python / CLI", async ({ page }) => {
  await page.getByTestId("copy-python").click();
  await expect(page.getByTestId("code-text")).toContainText("import lightsmith as ls");
  await expect(page.getByTestId("code-text")).toContainText('ls.solve(spec, method="auto", device="auto")');
  await expect(page.getByTestId("code-text")).toContainText('"medium_index": 1.33');
  await shot(page, "copy-as-python");
  await page.getByTestId("code-dialog").getByTestId("tab-cli").click();
  await expect(page.getByTestId("code-text")).toContainText("lightsmith solve spec.json --method auto --device auto -o result.json");
});

test("deep link opens a spec", async ({ page }) => {
  const s = { particles: [{ shape: { kind: "sphere", radius_nm: 25 }, material: { kind: "constant_index", n_real: 1.5 } }], medium_index: 1.0, wavelengths: [500, 600] };
  const b64 = Buffer.from(JSON.stringify(s)).toString("base64url");
  await page.goto(`/?spec=${b64}`);
  await expect.poll(async () => (await spec(page)).medium_index).toBe(1.0);
  const loaded = await spec(page);
  expect(loaded.particles[0].shape.radius_nm).toBe(25);
  expect(loaded.kind).toBe("scattering");
  expect(page.url()).not.toContain("spec=");
});

test("scripting API drives the app", async ({ page }) => {
  await page.evaluate(() => window.studio.apply({ op: "replace", path: ["medium_index"], value: 1.5 }));
  await expect(page.getByTestId("object-tree")).toContainText("n=1.5");
  const out = await page.evaluate(async () => {
    const { job, result } = await window.studio.solve({ method: "mie" });
    return { job, backend: (result as { backend: string }).backend };
  });
  expect(out.backend).toMatch(/mie/);
  expect(await page.evaluate(() => window.studio.python())).toContain("import lightsmith as ls");
});
