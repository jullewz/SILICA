#!/usr/bin/env node
// Capture the README screenshots from the real app. Development only.
// Needs Playwright and Chrome:  CHROME=/usr/bin/google-chrome node scripts/screenshots.mjs
import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  ({ chromium } = require(process.env.PLAYWRIGHT_PATH ?? "/opt/npm-tools/node_modules/playwright"));
}

const port = 5191;
const server = spawn(process.execPath, ["scripts/serve.mjs", String(port)], { stdio: "ignore" });
await new Promise((r) => setTimeout(r, 700));
await mkdir("docs/assets", { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROME ?? "/usr/bin/google-chrome",
  args: ["--no-sandbox"],
});

async function open(example) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 2 });
  page.on("pageerror", (e) => console.error("page error:", e.message));
  page.on("dialog", (d) => d.accept());
  await page.goto(`http://127.0.0.1:${port}/`);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`http://127.0.0.1:${port}/#example=${example}`);
  await page.reload();
  await page.waitForFunction(() => document.body.dataset.ready === "1");
  await page.waitForTimeout(300);
  return page;
}

try {
  let page = await open("cpu");
  for (let i = 0; i < 64; i++) await page.click("#cycle");
  await page.waitForTimeout(300);
  await page.screenshot({ path: "docs/assets/cpu.png" });
  await page.close();

  page = await open("ripple-adder");
  await page.screenshot({ path: "docs/assets/adder.png" });
  await page.close();

  page = await open("half-adder");
  await page.click('[data-panel="expr"]');
  await page.fill("#expr", "a & !b | b & c | !a & !c");
  await page.click("#build-expr");
  await page.waitForTimeout(400);
  await page.click('[data-panel="table"]');
  await page.click("#build-table");
  await page.waitForTimeout(300);
  await page.screenshot({ path: "docs/assets/synthesis.png" });
  await page.close();

  page = await open("counter");
  await page.click("#run");
  await page.waitForTimeout(2600);
  await page.screenshot({ path: "docs/assets/counter.png" });
  await page.close();
  console.log("wrote docs/assets/{cpu,adder,synthesis,counter}.png");
} finally {
  await browser.close();
  server.kill();
}
