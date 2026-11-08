/* eslint-disable @typescript-eslint/no-explicit-any */
// FDTD set-up in the 3D scene, against the mock server: the FDTD templates come with the library's layout
// (scripts/fdtd_layout.py) and solution (scripts/make_fixtures.py), so the boxes, CPML, mirror planes, mesh
// slice and Q table shown here are the library's. Screenshots go to docs/screenshots/fdtd-*.png.

import { expect, test, type Page } from "@playwright/test";

const shot = (page: Page, name: string) => page.screenshot({ path: `docs/screenshots/${name}.png` });
const spec = (page: Page): Promise<any> => page.evaluate(() => window.studio.getSpec());

async function template(page: Page, id: string) {
  await page.getByTestId("menu-new").click();
  await page.getByTestId("kind-scattering").click();
  await page.getByTestId(`start-${id}`).click();
  await expect(page.getByTestId("new-project")).toBeHidden();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("server-button")).toContainText("Mock server");
});

test("FDTD layout: graded grid, mirror planes, mesh override and mesh slice", async ({ page }) => {
  await template(page, "fdtd-override");
  const legend = page.getByTestId("fdtd-legend");
  await expect(legend.getByTestId("fdtd-grid-kind")).toHaveText("graded");
  await expect(legend.getByTestId("fdtd-symmetry")).toContainText("x PEC");
  await expect(legend.getByTestId("fdtd-symmetry")).toContainText("y PMC");
  await expect(legend.getByTestId("fdtd-symmetry")).toContainText("4× smaller run");
  await expect(legend.getByTestId("fdtd-source")).toContainText("snapshot");
  await expect(page.getByTestId("tree-override-0")).toContainText("2 nm");
  await page.waitForTimeout(600);
  await shot(page, "fdtd-layout");

  // the override box: generated form from the FDTD options model, with cell counts and the library's region
  await page.getByTestId("tree-override-0").click();
  await expect(page.getByTestId("override-cells")).toContainText("x: 10 cells");
  await expect(page.getByTestId("override-cells")).toContainText("the library's region");

  // mesh slice through the gap, viewed along z
  await page.getByTestId("mesh-slice").selectOption("z");
  await page.getByTestId("mesh-look").click();
  await page.waitForTimeout(600);
  await shot(page, "fdtd-mesh");

  // the estimate is the library's too: cells after the mirror halving
  await page.getByTestId("right-tabs").getByTestId("tab-run").click();
  await page.getByTestId("method-select").selectOption("fdtd");
  await page.getByTestId("estimate-btn").click();
  await expect(page.getByTestId("estimate-card")).toContainText("planes_nm");
  await expect(page.getByTestId("estimate-card")).toContainText("the library's estimate");
});

test("mesh overrides: add, edit, undo; the layout goes stale until the library answers", async ({ page }) => {
  await template(page, "fdtd-override");
  await expect(page.getByTestId("fdtd-source")).toContainText("snapshot");
  await page.getByTestId("tree-particle-1").click();
  await page.getByTestId("add-mesh-override").click();
  let s = await spec(page);
  expect(s.options.fdtd.mesh_override).toHaveLength(2);
  expect(s.options.fdtd.mesh_override[1].center_nm).toEqual([45, 0, 0]);
  expect(s.options.fdtd.mesh_override[1].spacing_nm).toBe(2);
  await expect(page.getByTestId("tree-override-1")).toBeVisible();

  await page.getByTestId("input-options/fdtd/mesh_override/1/spacing_nm").fill("1.5");
  s = await spec(page);
  expect(s.options.fdtd.mesh_override[1].spacing_nm).toBe(1.5);
  // the mock has no library: the last layout stays, marked as older than the spec
  await expect(page.getByTestId("fdtd-source")).toContainText("before your last edit");
  await expect(page.getByTestId("fdtd-note")).toContainText("shipped examples only");

  await page.evaluate(() => window.studio.undo());
  await page.evaluate(() => window.studio.undo());
  expect((await spec(page)).options.fdtd.mesh_override).toHaveLength(1);
  await expect(page.getByTestId("fdtd-source")).not.toContainText("before your last edit");
});

test("Gaussian beam: focus and waist drawn; only FDTD runs it; the library refuses it on a graded grid", async ({ page }) => {
  await template(page, "fdtd-beam");
  await expect(page.getByTestId("fdtd-symmetry")).toContainText("Gaussian beams are not used with mirror symmetry");
  await expect(page.getByTestId("object-tree")).toContainText("beam w₀ 1000 nm");
  await page.waitForTimeout(800);
  await shot(page, "fdtd-beam");

  await page.getByTestId("right-tabs").getByTestId("tab-run").click();
  await expect(page.getByTestId("support-lightsmith-fdtd")).toContainText("supported");
  await expect(page.getByTestId("support-lightsmith-dda")).toContainText("gaussian_beam illumination");

  // beam + mesh override + symmetry: Studio draws all of it and shows the library's refusal (graded grids are
  // plane-wave only), from the layout of the same spec as solved by the library (scripts/make_fixtures.py)
  await page.evaluate(() =>
    window.studio.apply({ op: "replace", path: ["options", "fdtd"], value: { spacing_nm: 6, symmetry: "auto", mesh_override: [{ center_nm: [200, 0, 0], size_nm: [140, 140, 140], spacing_nm: 3 }] } }),
  );
  const s = await spec(page);
  expect(s.illumination.kind).toBe("gaussian_beam");
  expect(s.options.fdtd.mesh_override).toHaveLength(1);
  await expect(page.getByTestId("tree-override-0")).toContainText("3 nm");
});

test("plane wave → Gaussian beam from the environment editor", async ({ page }) => {
  await template(page, "fdtd-override");
  await page.getByTestId("tree-illumination").click();
  await page.getByTestId("ill-beam").click();
  let s = await spec(page);
  expect(s.illumination).toMatchObject({ kind: "gaussian_beam", waist_nm: 1000, direction: [0, 0, 1], polarization: [1, 0, 0] });
  await expect(page.getByTestId("statusbar")).toContainText("spec valid");
  await page.getByTestId("ill-plane").click();
  s = await spec(page);
  expect(s.illumination.kind).toBe("plane_wave");
});

test("FDTD ring-down: resonance (Q) table", async ({ page }) => {
  await template(page, "fdtd-graded");
  await expect(page.getByTestId("fdtd-grid-kind")).toHaveText("graded");
  await page.getByTestId("right-tabs").getByTestId("tab-run").click();
  await expect(page.getByTestId("support-lightsmith-mie")).toContainText("resonances output");
  await page.getByTestId("solve-btn").click();
  const job = page.getByTestId("job").first();
  await expect(job).toHaveAttribute("data-status", "succeeded", { timeout: 120_000 });
  await job.getByTestId("job-show").click();
  await expect(page.getByTestId("spectra-plot")).toHaveAttribute("data-ready", "true");
  await page.getByTestId("tab-res").click();
  const table = page.getByTestId("resonance-table");
  await expect(table).toBeVisible();
  await expect(table.locator("tbody tr")).toHaveCount(10);
  await expect(table.locator("tbody tr").first()).toContainText("499.46");
  await page.waitForTimeout(500);
  await shot(page, "fdtd-resonances");
});

test("FDTD on a substrate at 45°: one mirror plane", async ({ page }) => {
  await template(page, "fdtd-substrate");
  await expect(page.getByTestId("fdtd-symmetry")).toContainText("y PEC");
  await expect(page.getByTestId("fdtd-symmetry")).toContainText("2× smaller run");
});
