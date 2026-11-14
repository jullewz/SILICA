#!/usr/bin/env node
// Generate docs/components.md from the component definitions. Run `npm run build` first.
import { writeFile } from "node:fs/promises";
import { CATEGORIES, COMPONENTS } from "../dist/src/core/components.js";

let md = `# Components

This page is generated from \`src/core/components.ts\` by \`node scripts/components-doc.mjs\`. Do not edit it by hand.

Ports are listed in order: inputs first, then outputs. Widths in parentheses use the default parameters.

`;
for (const cat of CATEGORIES) {
  const defs = [...COMPONENTS.values()].filter((d) => d.category === cat);
  if (!defs.length) continue;
  md += `## ${cat}\n\n`;
  for (const d of defs) {
    const p = Object.fromEntries(d.params.map((s) => [s.key, s.default]));
    const lib = { subcircuitPins: () => null };
    const ports = d.ports(p, lib);
    const ins =
      ports
        .filter((x) => x.dir === "in")
        .map((x) => `${x.name} (${x.width})`)
        .join(", ") || "none";
    const outs =
      ports
        .filter((x) => x.dir === "out")
        .map((x) => `${x.name} (${x.width})`)
        .join(", ") || "none";
    const params =
      d.params
        .map(
          (s) =>
            `\`${s.key}\`${s.min !== undefined ? ` ${s.min}–${s.max ?? "∞"}` : ""}${s.options ? `: ${s.options.join(", ")}` : ""}`,
        )
        .join(", ") || "none";
    md += `**${d.name}** (\`${d.kind}\`). ${d.description}\n\n- inputs: ${ins}\n- outputs: ${outs}\n- parameters: ${params}\n\n`;
  }
}
await writeFile("docs/components.md", md);
console.log(`docs/components.md: ${COMPONENTS.size} components`);
