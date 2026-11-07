import { defineConfig, devices } from "@playwright/test";

// Key-flow tests run against the dev server with the built-in mock compute
// server (VITE_DEFAULT_SERVER=mock), so they need neither Python nor network.
// STUDIO_LIBRARY_BRIDGE=1 also turns on the dev server's library bridge (FDTD layouts
// from ../lightsmith; vite.config.ts) for e2e/fdtd-library.spec.ts.
const PORT = 5174;

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  // the first Plotly chart of a run loads a 4.8 MB chunk through the dev server: allow a cold start
  expect: { timeout: 30_000 },
  fullyParallel: false,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    launchOptions: { args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] },
  },
  webServer: {
    command: `npx vite --port ${PORT} --strictPort`,
    port: PORT,
    reuseExistingServer: true,
    env: { VITE_DEFAULT_SERVER: "mock", STUDIO_LIBRARY_BRIDGE: process.env.STUDIO_LIBRARY_BRIDGE ?? "0" },
    timeout: 120_000,
  },
});
