// Studio against a real compute server (../lightsmith-cloud). Skipped unless
// STUDIO_COMPUTE_URL is set, e.g.
//   LIGHTSMITH_CORS_ORIGINS=http://localhost:5174 uv run lightsmith-server   (in ../lightsmith-cloud)
//   STUDIO_COMPUTE_URL=http://localhost:8200 npx playwright test real-server

import { expect, test } from "@playwright/test";

const url = process.env.STUDIO_COMPUTE_URL;
test.skip(!url, "set STUDIO_COMPUTE_URL to run against a live compute server");

const small = {
  kind: "scattering",
  particles: [{ shape: { kind: "sphere", radius_nm: 40 }, material: { kind: "library", name: "Au", dataset: "Johnson-Christy" }, position_nm: [0, 0, 0] }],
  medium_index: 1.33,
  wavelengths: { start_nm: 450, stop_nm: 650, num: 9 },
  outputs: { cross_sections: true, near_field: { plane: "xz", half_width_nm: 80, points: 41, wavelengths_nm: [530] }, far_field: null },
  options: { dda: { dipoles_per_diameter: 10 } },
};

test.beforeEach(async ({ page }) => {
  await page.addInitScript(
    ([u, s]) => {
      if (sessionStorage.getItem("seeded")) return;
      sessionStorage.setItem("seeded", "1");
      localStorage.setItem("studio:settings", JSON.stringify({ mode: "local", localUrl: u }));
      localStorage.setItem("studio:autosave", JSON.stringify(s));
    },
    [url!, small] as const,
  );
  await page.goto("/");
  await expect(page.getByTestId("server-button")).toContainText("Local");
  await expect(page.getByTestId("statusbar")).toContainText("live from server");
});

test("live: supports reasons, estimate, solve with near field, compare", async ({ page }) => {
  test.setTimeout(900_000);
  await page.getByTestId("right-tabs").getByTestId("tab-run").click();
  await expect(page.locator('[data-testid^="support-"][data-testid$="-mie"]')).toContainText("supported", { timeout: 30_000 });
  await expect(page.getByTestId("support-miepython")).toContainText("near_field", { timeout: 30_000 });

  await page.getByTestId("method-select").selectOption("dda");
  await page.getByTestId("estimate-btn").click();
  await expect(page.getByTestId("estimate-dipoles")).not.toBeEmpty({ timeout: 120_000 });

  await page.getByTestId("method-select").selectOption("auto");
  await page.getByTestId("solve-btn").click();
  const job = page.getByTestId("job").first();
  await expect(job).toHaveAttribute("data-status", "succeeded", { timeout: 300_000 });
  await job.getByTestId("job-show").click();
  await expect(page.getByTestId("spectra-plot")).toHaveAttribute("data-ready", "true");
  await expect(page.getByTestId("near-field-plot")).toHaveAttribute("data-ready", "true");
  await page.waitForTimeout(500);
  await page.screenshot({ path: "docs/screenshots/live-server-results.png" });

  await page.getByTestId("right-tabs").getByTestId("tab-run").click();
  const fdtd = page.getByRole("checkbox", { name: /-fdtd$/ });
  if (await fdtd.count()) await fdtd.uncheck();
  await page.getByTestId("compare-btn").click();
  await expect(page.getByTestId("job")).toHaveCount(2);
  await expect(page.getByTestId("job").first()).toHaveAttribute("data-status", "succeeded", { timeout: 300_000 });
  await page.getByTestId("center-tabs").getByTestId("tab-compare").click();
  await expect(page.getByTestId("compare-table")).toContainText("%");
  await page.waitForTimeout(500);
  await page.screenshot({ path: "docs/screenshots/live-server-compare.png" });
});

test("live: a thin-film stack solves and shows R/T/A", async ({ page }) => {
  test.setTimeout(300_000);
  await page.getByTestId("menu-new").click();
  await page.getByTestId("kind-layer_stack").click();
  await page.getByTestId("start-example").click();
  await page.getByTestId("right-tabs").getByTestId("tab-run").click();
  await expect(page.locator('[data-testid^="support-"][data-testid$="-tmm"]')).toContainText("supported", { timeout: 60_000 });
  await page.getByTestId("solve-btn").click();
  const job = page.getByTestId("job").first();
  await expect(job).toHaveAttribute("data-status", "succeeded", { timeout: 240_000 });
  await job.getByTestId("job-show").click();
  await expect(page.getByTestId("spectrum-plot")).toHaveAttribute("data-ready", "true");
  await expect(page.getByText("solved EXAMPLE")).toHaveCount(0);
  await page.waitForTimeout(500);
  await page.screenshot({ path: "docs/screenshots/live-server-layer-stack.png" });
});
