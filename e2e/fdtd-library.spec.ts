/* eslint-disable @typescript-eslint/no-explicit-any */
// Previews against the library itself: the dev server's library bridge runs scripts/solver_layout.py
// with ../lightsmith (vite.config.ts). Needs uv and the library checkout; playwright.config.ts starts a dev server
// with the bridge on for this file (`npx playwright test --project=library`).

import { expect, test, type Page } from "@playwright/test";

const spec = (page: Page): Promise<any> => page.evaluate(() => window.studio.getSpec());

// each layout starts a Python process and imports the library: allow for a busy machine
test.setTimeout(300_000);

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByTestId("server-button")).toContainText("Mock server");
});

test("an edited spec gets a fresh layout from the library", async ({ page }) => {
  await page.getByTestId("menu-new").click();
  await page.getByTestId("kind-scattering").click();
  await page.getByTestId("start-fdtd-override").click();
  await expect(page.getByTestId("fdtd-source")).toContainText("snapshot");
  const before = await page.getByTestId("fdtd-grid").textContent();

  // a finer override: the library builds a new graded grid
  await page.evaluate(() => window.studio.apply({ op: "replace", path: ["options", "fdtd", "mesh_override", 0, "spacing_nm"], value: 1 }));
  await expect(page.getByTestId("fdtd-source")).toContainText("library bridge", { timeout: 180_000 });
  await expect(page.getByTestId("fdtd-source")).not.toContainText("before your last edit");
  const after = await page.getByTestId("fdtd-grid").textContent();
  expect(after).not.toEqual(before);
  await expect(page.getByTestId("fdtd-grid")).toContainText("dx 1–8 nm");
});

test("beam + mesh override + symmetry: drawn, with the library's refusal", async ({ page }) => {
  await page.getByTestId("menu-new").click();
  await page.getByTestId("kind-scattering").click();
  await page.getByTestId("start-fdtd-beam").click();
  await page.evaluate(() =>
    window.studio.apply({ op: "replace", path: ["options", "fdtd"], value: { spacing_nm: 6, symmetry: "auto", mesh_override: [{ center_nm: [200, 0, 0], size_nm: [140, 140, 140], spacing_nm: 3 }] } }),
  );
  expect((await spec(page)).illumination.kind).toBe("gaussian_beam");
  await expect(page.getByTestId("fdtd-source")).toContainText("library bridge", { timeout: 180_000 });
  await expect(page.getByTestId("fdtd-grid-kind")).toHaveText("graded");
  await expect(page.getByTestId("fdtd-note")).toContainText("plane-wave illumination only");
  await expect(page.getByTestId("fdtd-symmetry")).toContainText("Gaussian beams are not used with mirror symmetry");
  await page.getByTestId("mesh-slice").selectOption("y");
  await page.waitForTimeout(800);
  await page.screenshot({ path: "docs/screenshots/fdtd-beam-override.png" });
});

test("preview of any solver: an edited spec gets a fresh DDA lattice from the library", async ({ page }) => {
  await page.getByTestId("menu-new").click();
  await page.getByTestId("kind-scattering").click();
  await page.getByTestId("start-example").click();
  await page.getByTestId("center-tabs").getByTestId("tab-preview").click();
  await page.getByTestId("preview-backend").selectOption("lightsmith-dda");
  await expect(page.getByTestId("preview-source")).toContainText("snapshot");
  const before = await page.getByTestId("preview-summary").textContent();
  await page.evaluate(() => window.studio.apply({ op: "replace", path: ["options"], value: { dda: { dipoles_per_diameter: 24 } } }));
  await expect(page.getByTestId("preview-source")).toContainText("library bridge", { timeout: 180_000 });
  await expect(page.getByTestId("preview-summary")).toContainText("24");
  expect(await page.getByTestId("preview-summary").textContent()).not.toEqual(before);
  await expect(page.getByTestId("preview-plot")).toHaveAttribute("data-ready", "true");
});
