/// <reference types="vitest/config" />
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const LIBRARY = resolve(__dirname, "../lightsmith");

/**
 * Development only: `POST /__library/v1/layout` runs scripts/fdtd_layout.py with the library checked out next
 * to Studio, so the mesh preview shows the library's own grid before any compute server offers the proposed
 * `/v1/layout` (API_ASSUMPTIONS.md). Answers 501 when there is no library or `uv`. Off with
 * STUDIO_LIBRARY_BRIDGE=0 (the Playwright mock runs use it off, so they need no Python).
 */
function libraryBridge(): Plugin {
  return {
    name: "lightsmith-library-bridge",
    apply: "serve",
    configureServer(server) {
      if (process.env.STUDIO_LIBRARY_BRIDGE === "0") return;
      server.middlewares.use("/__library/v1/layout", (req, res) => {
        const reply = (status: number, body: unknown) => {
          res.statusCode = status;
          res.setHeader("Content-Type", "application/json");
          res.end(typeof body === "string" ? body : JSON.stringify(body));
        };
        if (req.method !== "POST") return reply(405, { error: "MethodNotAllowed", message: "POST a {simulation} body" });
        if (!existsSync(LIBRARY)) return reply(501, { error: "NoLibrary", message: `no library checkout at ${LIBRARY}` });
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          const child = spawn("uv", ["run", "--project", LIBRARY, "python", resolve(__dirname, "scripts/fdtd_layout.py")], { stdio: ["pipe", "pipe", "pipe"] });
          let out = "";
          let err = "";
          child.stdout.on("data", (c) => (out += c));
          child.stderr.on("data", (c) => (err += c));
          child.on("error", (e) => reply(501, { error: "NoUv", message: `cannot run uv: ${e.message}` }));
          child.on("close", (code) => {
            if (res.writableEnded) return;
            if (code === 0) return reply(200, out);
            if (code === 2 && out) return reply(422, out); // the library refused the spec: {error, message}
            reply(500, { error: "BridgeError", message: (err.trim().split("\n").pop() ?? "") || `fdtd_layout.py exited with ${code}` });
          });
          child.stdin.end(body);
        });
      });
    },
  };
}

// Studio is a static single-page app: the same build is served by the hosted
// service (any static host, `base` is relative) and embedded by Tauri.
export default defineConfig({
  base: "./",
  plugins: [react(), libraryBridge()],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  envPrefix: ["VITE_", "TAURI_ENV_"],
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 6000,
    rollupOptions: {
      output: {
        manualChunks: {
          plotly: ["plotly.js-dist-min"],
          three: ["three", "@react-three/fiber", "@react-three/drei"],
        },
      },
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
    setupFiles: ["src/test/setup.ts"],
  },
});
