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
    await expect(job).toHaveAttribute("data-status", "succeeded", { timeout: 30_000 });
    await job.getByTestId("job-show").click();
    await expect(page.getByTestId(k.viewer)).toBeVisible();
    await expect(page.getByTestId(k.plot!)).toHaveAttribute("data-ready", "true");
    await page.waitForTimeout(500);
    await page.screenshot({ path: `docs/screenshots/kind-${k.kind}-results.png`, fullPage: false });
  });
}

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
