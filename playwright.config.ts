import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

// `npm run test:e2e` runs everything, with nothing skipped. It starts:
//   - the dev server with the built-in mock compute server (VITE_DEFAULT_SERVER=mock): the "mock" project, which
//     needs neither Python nor network;
//   - a second dev server with the library bridge on (layouts from ../lightsmith; vite.config.ts): the "library"
//     project, e2e/fdtd-library.spec.ts;
//   - a local compute server (../lightsmith-cloud, `uv sync --extra gpu` there once): the "live" project,
//     e2e/real-server.spec.ts, which solves every problem kind for real. Its jobs run one at a time.
// STUDIO_COMPUTE_URL points the live project at a compute server of your own instead (allow the origin
// http://localhost:5174 with LIGHTSMITH_CORS_ORIGINS). `npx playwright test --project=mock` runs the mock flows alone.
const MOCK_PORT = 5174;
const BRIDGE_PORT = 5175;
const COMPUTE_PORT = 8231;

// `--project=<name>` starts only what that project needs.
const only = process.argv.filter((a) => a.startsWith("--project=")).map((a) => a.split("=")[1]);
const wants = (project: string) => !only.length || only.includes(project);

const vite = (port: number, bridge: "0" | "1") => ({
  command: `npx vite --port ${port} --strictPort`,
  port,
  reuseExistingServer: true,
  env: { VITE_DEFAULT_SERVER: "mock", STUDIO_LIBRARY_BRIDGE: bridge },
  timeout: 120_000,
});

export default defineConfig({
  testDir: "e2e",
  // generous: software WebGL and a 4.8 MB Plotly chunk through the dev server, often beside other work on the machine
  timeout: 300_000,
  expect: { timeout: 120_000 },
  fullyParallel: false,
  workers: 3,
  reporter: [["list"]],
  use: {
    ...devices["Desktop Chrome"],
    viewport: { width: 1440, height: 900 },
    trace: "retain-on-failure",
    launchOptions: {
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
      // a browser binary of your own, when `npx playwright install chromium` is not an option
      ...(process.env.STUDIO_E2E_CHROMIUM ? { executablePath: process.env.STUDIO_E2E_CHROMIUM } : {}),
    },
  },
  projects: [
    { name: "mock", testIgnore: /fdtd-library|real-server/, use: { baseURL: `http://localhost:${MOCK_PORT}` } },
    { name: "library", testMatch: /fdtd-library/, use: { baseURL: `http://localhost:${BRIDGE_PORT}` } },
    { name: "live", testMatch: /real-server/, use: { baseURL: `http://localhost:${MOCK_PORT}` } },
  ],
  webServer: [
    ...(wants("mock") || wants("live") ? [vite(MOCK_PORT, "0")] : []),
    ...(wants("library") ? [vite(BRIDGE_PORT, "1")] : []),
    ...(wants("live") && !process.env.STUDIO_COMPUTE_URL
      ? [
          {
            // --no-sync: never touch the server's environment from a test run
            command: `uv run --no-sync --project ../lightsmith-cloud lightsmith-server --mode local --port ${COMPUTE_PORT} --data-dir "${join(tmpdir(), "lightsmith-studio-e2e")}"`,
            url: `http://localhost:${COMPUTE_PORT}/v1/health`,
            reuseExistingServer: true,
            env: { LIGHTSMITH_CORS_ORIGINS: `http://localhost:${MOCK_PORT}` },
            timeout: 180_000,
          },
        ]
      : []),
  ],
});
