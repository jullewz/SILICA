#!/usr/bin/env node
// Assemble the static playground (for GitHub Pages or any static host) into ./site.
// Run `npm run build` first, or use `npm run site` which does both.
import { access, cp, mkdir, rm } from "node:fs/promises";

try {
  await access("dist/src/ui/app.js");
} catch {
  console.error("dist/ is missing. Run `npm run build` first.");
  process.exit(1);
}
await rm("site", { recursive: true, force: true });
await mkdir("site/dist/src", { recursive: true });
await cp("index.html", "site/index.html");
await cp("styles.css", "site/styles.css");
// the browser needs the language, the runtime and the playground, not the CLI or the tests
for (const dir of ["core", "ui"]) {
  await cp(`dist/src/${dir}`, `site/dist/src/${dir}`, { recursive: true, filter: (src) => !src.endsWith(".map") });
}
console.log("site/ is ready: upload it to any static host.");
