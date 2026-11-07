/* eslint-disable @typescript-eslint/no-explicit-any */
// Every solver, not just FDTD: the Preview tab (what each backend will discretise, from the library's layouts
// of the shipped examples), Compare across backends for any problem kind, parameter sweeps, and the solver strip
// of the 2D editors. Against the mock; screenshots go to docs/screenshots/.

import { expect, test, type Page } from "@playwright/test";

const shot = (page: Page, name: string) => page.screenshot({ path: `docs/screenshots/${name}.png` });
const spec = (page: Page): Promise<any> => page.evaluate(() => window.studio.getSpec());

async function start(page: Page, kind: string, id = "example") {
  await page.getByTestId("menu-new").click();
  await page.getByTestId(`kind-${kind}`).click();
  await page.getByTestId(`start-${id}`).click();
  await expect(page.getByTestId("new-project")).toBeHidden();
}

async function preview(page: Page, backend: string) {
  await page.getByTestId("center-tabs").getByTestId("tab-preview").click();
  await page.getByTestId("preview-backend").selectOption(backend);
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("server-button")).toContainText("Mock server");
});

const CASES: { kind: string; start?: string; backend: string; text: RegExp; plot?: string; shot?: string }[] = [
  { kind: "scattering", backend: "lightsmith-dda", text: /dipoles/, plot: "preview-plot", shot: "preview-dda" },
  { kind: "scattering", backend: "lightsmith-bem", text: /triangles/, plot: "preview-plot", shot: "preview-bem" },
  { kind: "scattering", backend: "lightsmith-mie", text: /multipole order/, plot: "preview-plot", shot: "preview-mie" },
  { kind: "scattering", backend: "treams", text: /lmax/, plot: "preview-plot" },
  { kind: "scattering", backend: "lightsmith-fdtd", text: /CPML cells/, plot: "preview-plot" },
  { kind: "mode", backend: "lightsmith-fde", text: /boundary/, plot: "preview-plot", shot: "preview-fde" },
  { kind: "periodic", backend: "lightsmith-rcwa", text: /harmonics/, plot: "preview-plot", shot: "preview-rcwa" },
  { kind: "layer_stack", backend: "lightsmith-tmm", text: /nothing to discretise/ },
  { kind: "layer_stack", backend: "lightsmith-fdtd", text: /CPML cells \(z\)/, plot: "preview-plot", shot: "preview-fdtd-cell" },
  { kind: "periodic", backend: "lightsmith-fdtd", text: /cell size/, plot: "preview-plot" },
  { kind: "scattering", start: "sphere", backend: "miepython", text: /miepython's wiscombe_terms/, plot: "preview-plot" },
  { kind: "scattering", start: "sphere", backend: "lightsmith-quasistatic", text: /nothing to discretise/ },
  { kind: "bands", backend: "lightsmith-pwe", text: /k-points/, plot: "preview-plot", shot: "preview-pwe" },
  { kind: "device", backend: "lightsmith-eme", text: /modes per cell/, plot: "preview-cells-plot", shot: "preview-eme" },
  { kind: "device", backend: "lightsmith-bpm", text: /step/, plot: "preview-cells-plot" },
  { kind: "device", backend: "lightsmith-fdfd", text: /PML cells/, plot: "preview-plot" },
  { kind: "device", start: "fdtd-device", backend: "lightsmith-fdtd", text: /te \(E in the xy plane\)/, plot: "preview-plot", shot: "preview-fdtd-device" },
  { kind: "optimization", backend: "lightsmith-inverse", text: /design regions/, plot: "preview-plot", shot: "preview-inverse" },
  { kind: "circuit", backend: "lightsmith-circuit", text: /nothing to discretise/ },
];

for (const c of CASES) {
  test(`preview: ${c.kind} · ${c.backend}`, async ({ page }) => {
    await start(page, c.kind, c.start);
    await preview(page, c.backend);
    await expect(page.getByTestId("preview-summary")).toContainText(c.text);
    await expect(page.getByTestId("preview-source")).toContainText("snapshot");
    if (c.plot) await expect(page.getByTestId(c.plot)).toHaveAttribute("data-ready", "true");
    if (c.shot) {
      await page.waitForTimeout(600);
      await shot(page, c.shot);
    }
  });
}

test("preview: an edited spec keeps the last layout, marked stale", async ({ page }) => {
  await start(page, "scattering");
  await preview(page, "lightsmith-dda");
  await expect(page.getByTestId("preview-summary")).toContainText("dipoles");
  await page.evaluate(() => window.studio.apply({ op: "replace", path: ["particles", 0, "shape", "radius_nm"], value: 45 }));
  await expect(page.getByTestId("preview-source")).toContainText("before your last edit");
});

test("compare: several backends, overlay and differences, any problem kind", async ({ page }) => {
  await start(page, "scattering");
  await page.getByTestId("right-tabs").getByTestId("tab-run").click();
  await expect(page.getByTestId("compare-btn")).toContainText("(5)");
  await page.getByTestId("compare-btn").click();
  await expect(page.getByTestId("job").first()).toHaveAttribute("data-status", "succeeded", { timeout: 30_000 });
  await page.getByTestId("center-tabs").getByTestId("tab-compare").click();
  await expect(page.getByTestId("compare-overlay-plot")).toHaveAttribute("data-ready", "true");
  await expect(page.getByTestId("compare-plot")).toHaveAttribute("data-ready", "true");
  await expect(page.getByTestId("compare-table")).toContainText("%");
  await page.getByTestId("compare-quantity").selectOption("c_sca_nm2");
  await page.getByTestId("compare-mode").selectOption("abs");
  await page.waitForTimeout(500);
  await shot(page, "compare-backends");

  // devices: S-parameters from several backends (the mock answers each with the library's example)
  await start(page, "device");
  await page.getByTestId("right-tabs").getByTestId("tab-run").click();
  await expect(page.getByTestId("compare-btn")).toContainText("(4)");
  await page.getByTestId("compare-btn").click();
  await expect(page.getByTestId("job").first()).toHaveAttribute("data-status", "succeeded", { timeout: 30_000 });
  await page.getByTestId("center-tabs").getByTestId("tab-compare").click();
  await page.getByTestId("compare-kind").selectOption("sparameters");
  await expect(page.getByTestId("compare-quantity")).toContainText("|S");
  await expect(page.getByTestId("compare-table").locator("tbody tr")).toHaveCount(3);
  await expect(page.getByTestId("compare-table")).toContainText("0 %");
});

test("sweep: a geometry field over a range, reduced to a peak position", async ({ page }) => {
  await start(page, "scattering", "sphere");
  await page.getByTestId("right-tabs").getByTestId("tab-run").click();
  await page.getByTestId("method-select").selectOption("lightsmith-mie");
  await page.getByTestId("sweep-setup").locator("summary").click();
  await page.getByTestId("sweep-param").selectOption("particles.0.shape.radius_nm");
  await page.getByTestId("sweep-start").fill("30");
  await page.getByTestId("sweep-stop").fill("70");
  await page.getByTestId("sweep-num").fill("5");
  await page.getByTestId("sweep-run").click();
  await expect(page.getByTestId("sweep-view")).toBeVisible();
  await expect(page.getByTestId("sweep-view")).toContainText("5/5 done", { timeout: 30_000 });
  await page.getByTestId("sweep-metric").selectOption("peak_x");
  await expect(page.getByTestId("sweep-plot")).toHaveAttribute("data-ready", "true");
  const rows = page.getByTestId("sweep-table").locator("tbody tr");
  await expect(rows).toHaveCount(5);
  // a bigger gold sphere red-shifts its plasmon peak
  const first = Number(await rows.nth(0).locator("td").nth(2).textContent());
  const last = Number(await rows.nth(4).locator("td").nth(2).textContent());
  expect(last).toBeGreaterThan(first);
  await page.waitForTimeout(500);
  await shot(page, "sweep");
  // the sweep's specs are complete library specs
  expect((await spec(page)).particles[0].shape.radius_nm).toBe(40);
});

test("sweep: a solver option (options.<method>.<field>) is created in the swept specs", async ({ page }) => {
  await start(page, "scattering", "sphere");
  await page.getByTestId("right-tabs").getByTestId("tab-run").click();
  await page.getByTestId("method-select").selectOption("dda");
  await page.getByTestId("sweep-setup").locator("summary").click();
  await page.getByTestId("sweep-param").selectOption("options.dda.dipoles_per_diameter");
  await page.getByTestId("sweep-start").fill("16");
  await page.getByTestId("sweep-stop").fill("24");
  await page.getByTestId("sweep-num").fill("3");
  await page.getByTestId("sweep-run").click();
  await expect(page.getByTestId("sweep-view")).toContainText("3/3 done", { timeout: 30_000 });
  // one sweep job (the mock, like the compute server, runs sweep jobs) carrying the path and values
  const jobs = await page.evaluate(() => (JSON.parse(localStorage.getItem("studio:jobs") ?? "[]") as any[]).filter((j) => j.sweep));
  expect(jobs).toHaveLength(1);
  expect(jobs[0].operation).toBe("sweep");
  expect(jobs[0].sweep).toMatchObject({ path: ["options", "dda", "dipoles_per_diameter"], values: [16, 20, 24] });
  await expect(page.getByTestId("sweep-table").locator("tbody tr")).toHaveCount(3);
});

test("device editor: solver chips and 2D polarization for FDTD", async ({ page }) => {
  await start(page, "device", "fdtd-device");
  await expect(page.getByTestId("solver-strip")).toContainText("fdtd");
  await page.getByTestId("solver-fdtd").click();
  await expect(page.getByTestId("pol-te")).toHaveClass(/active/);
  await page.getByTestId("pol-tm").click();
  expect((await spec(page)).options.fdtd.polarization).toBe("tm");
  await page.getByTestId("right-tabs").getByTestId("tab-run").click();
  await expect(page.getByTestId("method-select")).toHaveValue("fdtd");
  await expect(page.getByTestId("support-lightsmith-fdtd")).toContainText("supported");
  await page.getByTestId("pol-te").click();
  await page.getByTestId("solve-btn").click();
  const job = page.getByTestId("job").first();
  await expect(job).toHaveAttribute("data-status", "succeeded", { timeout: 30_000 });
  await job.getByTestId("job-show").click();
  await expect(page.getByTestId("sparam-viewer")).toBeVisible();
  await page.getByTestId("tab-prov").click();
  await expect(page.getByTestId("warnings")).toContainText("exact spec");
  await page.waitForTimeout(400);
  await page.getByTestId("center-tabs").getByTestId("tab-scene").click();
  await page.waitForTimeout(300);
  await shot(page, "device-fdtd-scene");
});
