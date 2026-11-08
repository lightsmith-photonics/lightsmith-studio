/* eslint-disable @typescript-eslint/no-explicit-any */
// Every problem kind: New project -> example -> scene editor -> solve (mock: the library's solved
// example) -> the result viewer for that kind. Screenshots go to docs/screenshots/kind-*.png.

import { expect, test, type Page } from "@playwright/test";

const KINDS: { kind: string; scene: string; viewer?: string; plot?: string }[] = [
  { kind: "layer_stack", scene: "layer-stack", viewer: "spectrum-viewer", plot: "spectrum-plot" },
  { kind: "periodic", scene: "periodic-stack", viewer: "spectrum-viewer", plot: "orders-plot" },
  { kind: "mode", scene: "cross-section", viewer: "modes-viewer", plot: "mode-field-plot" },
  { kind: "device", scene: "cross-section", viewer: "sparam-viewer", plot: "smatrix-plot" },
  { kind: "bands", scene: "cross-section", viewer: "bands-viewer", plot: "bands-plot" },
  { kind: "circuit", scene: "netlist", viewer: "sparam-viewer", plot: "sparam-plot" },
  { kind: "optimization", scene: "cross-section", viewer: "design-view", plot: "design-plot" },
  { kind: "emission", scene: "viewport", viewer: "emission-viewer", plot: "emission-plot" },
];

async function newProject(page: Page, kind: string) {
  await page.getByTestId("menu-new").click();
  await page.getByTestId(`kind-${kind}`).click();
  await page.getByTestId("start-example").click();
  await expect(page.getByTestId("new-project")).toBeHidden();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("server-button")).toContainText("Mock server");
});

for (const k of KINDS) {
  test(`${k.kind}: example, scene, solve, viewer`, async ({ page }) => {
    await newProject(page, k.kind);
    expect(await page.evaluate(() => (window.studio.getSpec() as any).kind)).toBe(k.kind);
    await expect(page.getByTestId("statusbar")).toContainText("spec valid");
    await expect(page.getByTestId(k.scene)).toBeVisible();
    await page.waitForTimeout(300);
    await page.screenshot({ path: `docs/screenshots/kind-${k.kind}-scene.png` });
    if (!k.viewer) return;

    await page.getByTestId("right-tabs").getByTestId("tab-run").click();
    await page.getByTestId("solve-btn").click();
    const job = page.getByTestId("job").first();
    await expect(job).toHaveAttribute("data-status", "succeeded", { timeout: 120_000 });
    await job.getByTestId("job-show").click();
    await expect(page.getByTestId(k.viewer)).toBeVisible();
    await expect(page.getByTestId(k.plot!)).toHaveAttribute("data-ready", "true");
    // a mock result says so, over the viewer
    await expect(page.getByTestId("mock-notice")).toContainText("mock server");
    await page.waitForTimeout(500);
    await page.screenshot({ path: `docs/screenshots/kind-${k.kind}-results.png`, fullPage: false });
  });
}

// A blank problem of every kind: schema defaults only, usually incomplete. The scene and the other tabs must cope.
for (const kind of ["scattering", ...KINDS.map((k) => k.kind)]) {
  test(`${kind}: a blank start opens in every tab`, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await page.getByTestId("menu-new").click();
    await page.getByTestId(`kind-${kind}`).click();
    await page.getByTestId("start-blank").click();
    await expect(page.getByTestId("new-project")).toBeHidden();
    expect(await page.evaluate(() => (window.studio.getSpec() as any).kind)).toBe(kind);
    await expect(page.getByTestId("viewport")).toBeVisible();
    for (const [tab, view] of [["preview", "preview-view"], ["results", "results"], ["compare", "compare-view"], ["sweep", "sweep-view"]]) {
      await page.getByTestId("center-tabs").getByTestId(`tab-${tab}`).click();
      await expect(page.getByTestId(view)).toBeVisible();
    }
    for (const tab of ["properties", "run", "json"]) await page.getByTestId("right-tabs").getByTestId(`tab-${tab}`).click();
    expect(errors).toEqual([]);
  });
}

// Solver options of every kind: a form per method and backend, generated from the backend's options schema.
const OPTION_FIELDS: { kind: string; method: string; field: string; value: string; expected: number }[] = [
  { kind: "layer_stack", method: "rcwa", field: "raster_points", value: "128", expected: 128 },
  { kind: "periodic", method: "fdtd", field: "cells_per_wavelength", value: "24", expected: 24 },
  { kind: "mode", method: "fde", field: "pml_cells", value: "14", expected: 14 },
  { kind: "device", method: "fdfd", field: "cells_per_wavelength", value: "24", expected: 24 },
  { kind: "bands", method: "pwe", field: "max_iter", value: "300", expected: 300 },
  { kind: "emission", method: "fdtd", field: "cells_per_wavelength", value: "24", expected: 24 },
];

for (const o of OPTION_FIELDS) {
  test(`${o.kind}: solver options have generated forms`, async ({ page }) => {
    await newProject(page, o.kind);
    await page.getByTestId("tree-options").click();
    const group = page.getByTestId(`options-${o.method}`);
    await expect(group).toBeVisible();
    const input = page.getByTestId(`input-options/${o.method}/${o.field}`);
    // a group whose options are set starts open
    if (!(await input.isVisible())) await group.locator("summary").first().click();
    await input.fill(o.value);
    await input.blur();
    expect((await page.evaluate(() => (window.studio.getSpec() as any).options))[o.method][o.field]).toBe(o.expected);
    await expect(page.getByTestId("statusbar")).toContainText("spec valid");
  });
}

test("circuit: the solver's options have a generated form", async ({ page }) => {
  await newProject(page, "circuit");
  await page.getByTestId("tree-options").click();
  await expect(page.getByTestId("options-circuit")).toBeVisible();
  await page.getByTestId("options-circuit").locator("summary").first().click();
  await expect(page.getByTestId("options-circuit").locator('[data-path="options/circuit/algorithm"]')).toBeVisible();
});

test("inverse design: the problem's and the device's options, with the FDFD solver's form", async ({ page }) => {
  await newProject(page, "optimization");
  await page.getByTestId("tree-options").click();
  await page.getByTestId("options-fdfd").locator("summary").first().click();
  await page.getByTestId("input-options/fdfd/cells_per_wavelength").fill("24");
  await page.getByTestId("input-options/fdfd/cells_per_wavelength").blur();
  expect((await page.evaluate(() => (window.studio.getSpec() as any).options)).fdfd.cells_per_wavelength).toBe(24);

  await page.getByTestId("tree-device/options").click();
  await expect(page.getByTestId("options-fdfd")).toBeVisible();
  const input = page.getByTestId("input-device/options/fdfd/cells_per_wavelength");
  if (!(await input.isVisible())) await page.getByTestId("options-fdfd").locator("summary").first().click();
  await input.fill("26");
  await input.blur();
  expect((await page.evaluate(() => (window.studio.getSpec() as any).device.options)).fdfd.cells_per_wavelength).toBe(26);
  await expect(page.getByTestId("statusbar")).toContainText("spec valid");
});

test("emission: dipole and particles in the tree, the forms and the 3D scene", async ({ page }) => {
  await newProject(page, "emission");
  await page.getByTestId("tree-dipole").click();
  const z = page.getByTestId("input-dipole/position_nm/2");
  await z.fill("70");
  await z.blur();
  expect((await page.evaluate(() => (window.studio.getSpec() as any).dipole)).position_nm[2]).toBe(70);
  await page.getByTestId("input-dipole/orientation/0").fill("1");
  await page.getByTestId("input-dipole/orientation/0").blur();
  expect((await page.evaluate(() => (window.studio.getSpec() as any).dipole)).orientation[0]).toBe(1);

  await page.getByTestId("add-particle").click();
  await page.getByTestId("add-cylinder").click();
  const particles = await page.evaluate(() => (window.studio.getSpec() as any).particles);
  expect(particles).toHaveLength(2);
  expect(particles[1].shape.kind).toBe("cylinder");
  await expect(page.getByTestId("tree-particle-1")).toContainText("Cylinder");
  await expect(page.getByTestId("properties").locator('[data-path="particles/1/shape/radius_nm"]')).toBeVisible();
  await expect(page.getByTestId("statusbar")).toContainText("spec valid");
  // Mie needs one sphere: the Run panel says so, with the library's reason
  await page.getByTestId("right-tabs").getByTestId("tab-run").click();
  await expect(page.getByTestId("support-lightsmith-mie")).toContainText("one sphere");
});

test("inverse design: the final device opens as a device problem", async ({ page }) => {
  await newProject(page, "optimization");
  await page.getByTestId("right-tabs").getByTestId("tab-run").click();
  await page.getByTestId("solve-btn").click();
  const job = page.getByTestId("job").first();
  await expect(job).toHaveAttribute("data-status", "succeeded", { timeout: 120_000 });
  await job.getByTestId("job-show").click();
  await page.getByTestId("open-final-device").click();
  const s = await page.evaluate(() => window.studio.getSpec() as any);
  expect(s.kind).toBe("device");
  expect(s.structures.some((x: any) => /design/.test(x.name ?? ""))).toBe(true);
  await expect(page.getByTestId("cross-section")).toBeVisible();
  await expect(page.getByTestId("statusbar")).toContainText("spec valid");
});

test("thin films: the phase of the complex amplitudes", async ({ page }) => {
  await newProject(page, "layer_stack");
  await page.getByTestId("right-tabs").getByTestId("tab-run").click();
  await page.getByTestId("solve-btn").click();
  const job = page.getByTestId("job").first();
  await expect(job).toHaveAttribute("data-status", "succeeded", { timeout: 120_000 });
  await job.getByTestId("job-show").click();
  await expect(page.getByTestId("amplitude-plot")).toHaveAttribute("data-ready", "true");
  await page.getByTestId("amplitude-which").selectOption("t");
  await expect(page.getByTestId("amplitude-plot")).toHaveAttribute("data-ready", "true");
});

test("scattering: the resonances output is editable from the object tree", async ({ page }) => {
  await newProject(page, "scattering");
  await page.getByTestId("tree-outputs/resonances").click();
  await page.getByTestId("enable-resonances").click();
  expect((await page.evaluate(() => (window.studio.getSpec() as any).outputs)).resonances).toEqual({});
  await expect(page.getByTestId("properties").locator('[data-path="outputs/resonances/max_modes"]')).toBeVisible();
  await page.getByTestId("right-tabs").getByTestId("tab-run").click();
  await expect(page.getByTestId("support-lightsmith-mie")).toContainText("resonances output");
});

test("2D editor: dragging a structure moves it (undoably)", async ({ page }) => {
  await newProject(page, "mode");
  const before = await page.evaluate(() => (window.studio.getSpec() as any).structures[0].profile.center_nm);
  const shape = page.getByTestId("shape-structures/0");
  const box = (await shape.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 6 });
  await page.mouse.up();
  const after = await page.evaluate(() => (window.studio.getSpec() as any).structures[0].profile.center_nm);
  expect(after[0]).toBeGreaterThan(before[0]);
  expect(await page.evaluate(() => (window.studio.getSpec() as any).structures[0].profile.kind)).toBe("rectangle");
  await page.evaluate(() => window.studio.undo());
  expect(await page.evaluate(() => (window.studio.getSpec() as any).structures[0].profile.center_nm)).toEqual(before);
});

test("layer stack editor: add, reorder and remove layers", async ({ page }) => {
  await newProject(page, "layer_stack");
  const n0 = await page.evaluate(() => (window.studio.getSpec() as any).layers.length);
  await page.getByTestId("stack-layer-0").click();
  await page.getByTestId("add-layer").click();
  await page.getByRole("button", { name: "Au 30 nm" }).click();
  const layers = await page.evaluate(() => (window.studio.getSpec() as any).layers);
  expect(layers).toHaveLength(n0 + 1);
  expect(layers[1].material.name).toBe("Au");
  await page.getByRole("button", { name: "↑" }).click();
  expect((await page.evaluate(() => (window.studio.getSpec() as any).layers))[0].material.name).toBe("Au");
  await page.getByRole("button", { name: "Remove" }).click();
  expect(await page.evaluate(() => (window.studio.getSpec() as any).layers.length)).toBe(n0);
});
