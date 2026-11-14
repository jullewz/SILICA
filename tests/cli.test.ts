import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/cli/silica.js", import.meta.url));
const run = (...args: string[]) =>
  execFileSync(process.execPath, [cli, ...args], { encoding: "utf8", env: { ...process.env, NO_COLOR: "1" } });

describe("command line", () => {
  it("runs the CPU and prints its output each cycle", () => {
    const out = run("run", "cpu", "--cycles", "70", "--watch", "output");
    const values = out
      .trim()
      .split("\n")
      .slice(1)
      .map((l) => Number(l.trim().split(/\s+/)[1]));
    assert.deepEqual([...new Set(values)], [0, 1, 2, 3, 5, 8]);
  });

  it("sets inputs by label", () => {
    const out = run("run", "ripple-adder", "--set", "A=7", "--set", "B=12", "--watch", "Sum,Carry");
    assert.match(out, /0\s+3\s+1/);
  });

  it("prints truth tables with simplified expressions", () => {
    const out = run("table", "half-adder");
    assert.match(out, /S = !A & B \| A & !B/);
    assert.match(out, /C = A & B/);
  });

  it("simplifies and synthesizes expressions", () => {
    assert.equal(run("simplify", "a & b | a & !b").trim(), "a");
    const dir = mkdtempSync(join(tmpdir(), "silica-"));
    const file = join(dir, "maj.json");
    run("synth", "a & b | b & c | a & c", "-o", file);
    const table = run("table", file);
    assert.match(table, /f = /);
    assert.equal(JSON.parse(readFileSync(file, "utf8")).format, "silica");
    assert.match(run("check", file), /no problems/);
  });

  it("exports examples and fails clearly on bad input", () => {
    assert.equal(JSON.parse(run("export", "counter")).main, "counter");
    const bad = spawnSync(process.execPath, [cli, "run", "missing.json"], { encoding: "utf8" });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /no file or example named/);
  });
});
