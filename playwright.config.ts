import { defineConfig, devices } from "@playwright/test";

// Key-flow tests run against the dev server with the built-in mock compute
// server (VITE_DEFAULT_SERVER=mock), so they need neither Python nor network.
const PORT = 5174;

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
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
    env: { VITE_DEFAULT_SERVER: "mock" },
    timeout: 120_000,
  },
});
