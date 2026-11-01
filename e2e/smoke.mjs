// Ad-hoc: open Studio and screenshot (node e2e/smoke.mjs <url> <out.png>)
import { chromium } from "@playwright/test";
const [url, out] = process.argv.slice(2);
const b = await chromium.launch({ args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const p = await b.newPage({ viewport: { width: 1440, height: 900 } });
const logs = [];
p.on("console", (m) => (m.type() === "error" || m.type() === "warning") && logs.push(`${m.type()}: ${m.text()}`));
p.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
await p.goto(url, { timeout: 120000 });
await p.waitForTimeout(4000);
await p.screenshot({ path: out });
console.log(logs.join("\n") || "no console errors");
await b.close();
