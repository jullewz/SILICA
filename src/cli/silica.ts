#!/usr/bin/env node
/**
 * silica: run, test and analyse circuits from the command line.
 *
 *   silica examples                         list the built-in examples
 *   silica export cpu -o cpu.json           save an example as a project file
 *   silica run cpu --cycles 40 --watch PC,A,output
 *   silica run my.json --set A=5 --set B=9 --watch Sum
 *   silica table half-adder.json            truth table and simplified expressions
 *   silica simplify "a & b | a & !b"        minimise a Boolean expression
 *   silica synth "a ^ b ^ c" -o parity.json build a circuit for an expression
 *   silica check my.json                    report wiring problems
 */

import { readFileSync, writeFileSync } from "node:fs";
import { formatSop, minimize, simplify, synthesize, truthTable } from "../core/analysis.js";
import { buildNetlist, type Project } from "../core/circuit.js";
import { EXAMPLES } from "../core/examples.js";
import { fromJSON, toJSON } from "../core/serialize.js";
import { format, type Radix } from "../core/signal.js";
import { Simulator } from "../core/simulator.js";

const USE_COLOR = process.stdout.isTTY && !process.env["NO_COLOR"];
const violet = (s: string) => (USE_COLOR ? `\x1b[38;5;141m${s}\x1b[0m` : s);
const dim = (s: string) => (USE_COLOR ? `\x1b[38;5;245m${s}\x1b[0m` : s);
const red = (s: string) => (USE_COLOR ? `\x1b[38;5;203m${s}\x1b[0m` : s);

function fail(message: string): never {
  process.stderr.write(red(`error: ${message}`) + "\n");
  process.exit(1);
}

function load(source: string): Project {
  const ex = EXAMPLES.find((e) => e.id === source);
  if (ex) return ex.build();
  try {
    return fromJSON(readFileSync(source, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT")
      fail(`no file or example named "${source}". Try: silica examples`);
    fail((e as Error).message);
  }
}

interface Options {
  positional: string[];
  flags: Map<string, string[]>;
}

function parseArgs(argv: string[]): Options {
  const positional: string[] = [];
  const flags = new Map<string, string[]>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--") || (a.startsWith("-") && a.length === 2)) {
      const key = a.replace(/^-+/, "");
      const takesValue = !["help", "h", "version", "v", "hex"].includes(key);
      const value = takesValue ? argv[++i] : "true";
      if (value === undefined) fail(`${a} needs a value`);
      flags.set(key, [...(flags.get(key) ?? []), value]);
    } else positional.push(a);
  }
  return { positional, flags };
}

const one = (o: Options, key: string, alt?: string): string | undefined =>
  (o.flags.get(key) ?? (alt ? o.flags.get(alt) : undefined))?.at(-1);

function cmdRun(o: Options): void {
  const project = load(o.positional[0] ?? fail("which circuit? silica run FILE"));
  const name = one(o, "circuit") ?? project.main;
  const netlist = buildNetlist(project, name);
  if (netlist.errors.length) fail(netlist.errors.map((e) => e.message).join("; "));
  const sim = new Simulator(netlist);
  for (const s of o.flags.get("set") ?? []) {
    const [label, value] = s.split("=");
    if (!label || value === undefined) fail(`--set expects LABEL=VALUE, got "${s}"`);
    try {
      sim.set(label, value.startsWith("0x") ? parseInt(value, 16) : Number(value));
    } catch (e) {
      fail((e as Error).message);
    }
  }
  const labels = (one(o, "watch", "w") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const watch = labels.length
    ? labels
    : netlist.components
        .filter((c) => c.top && ["OUTPUT", "PROBE", "LED", "HEX"].includes(c.instance.kind) && c.params["label"])
        .map((c) => String(c.params["label"]));
  const radix: Radix = one(o, "hex") ? "hex" : "dec";
  const cycles = Number(one(o, "cycles", "n") ?? "0");
  const widths = watch.map((w) => Math.max(w.length, 6));
  const header = ["cycle", ...watch].map((h, i) => h.padStart(i === 0 ? 5 : widths[i - 1]!)).join("  ");
  console.log(violet(header));
  const show = (cycle: number) => {
    const cells = watch.map((w, i) => {
      let v: string;
      try {
        v = format(sim.get(w), radix);
      } catch {
        fail(`nothing labelled "${w}" in circuit "${name}"`);
      }
      return v.padStart(widths[i]!);
    });
    console.log([String(cycle).padStart(5), ...cells].join("  "));
  };
  show(0);
  for (let c = 1; c <= cycles; c++) {
    const stats = sim.cycle();
    if (stats.oscillating) fail(`the circuit oscillates during cycle ${c}`);
    show(c);
  }
}

function cmdTable(o: Options): void {
  const project = load(o.positional[0] ?? fail("which circuit? silica table FILE"));
  const t = truthTable(project, one(o, "circuit") ?? project.main);
  const heads = [...t.inputs.map((c) => c.label), "│", ...t.outputs.map((c) => c.label)];
  const w = heads.map((h) => Math.max(h.length, 2));
  console.log(violet(heads.map((h, i) => h.padStart(w[i]!)).join(" ")));
  for (const row of t.rows) {
    const cells = [...row.slice(0, t.inputs.length), "│", ...row.slice(t.inputs.length)];
    console.log(cells.map((v, i) => (v === null ? "X" : String(v)).padStart(w[i]!)).join(" "));
  }
  if (t.inputs.every((c) => c.width === 1)) {
    t.outputs.forEach((out, k) => {
      if (out.width !== 1) return;
      const ones = t.rows.map((r, m) => (r[t.inputs.length + k] === 1 ? m : -1)).filter((m) => m >= 0);
      console.log(
        `${dim(out.label + " =")} ${formatSop(
          minimize(t.inputs.length, ones),
          t.inputs.map((c) => c.label),
        )}`,
      );
    });
  }
  if (t.sequential) console.log(dim("note: the circuit has memory; this shows its response from the starting state"));
}

function cmdCheck(o: Options): void {
  const project = load(o.positional[0] ?? fail("which circuit? silica check FILE"));
  let problems = 0;
  for (const c of project.circuits) {
    try {
      const nl = buildNetlist(project, c.name);
      for (const e of nl.errors) {
        problems++;
        console.log(`${c.name}: ${e.message} (at ${e.where})`);
      }
      const sim = new Simulator(nl);
      if (sim.stats.oscillating) {
        problems++;
        console.log(`${c.name}: oscillates at start-up`);
      }
      const conflicts = sim.conflicts.filter(Boolean).length;
      if (conflicts) {
        problems++;
        console.log(`${c.name}: ${conflicts} net(s) with conflicting drivers`);
      }
    } catch (e) {
      problems++;
      console.log(`${c.name}: ${(e as Error).message}`);
    }
  }
  if (problems) process.exit(1);
  console.log(`ok: ${project.circuits.length} circuit(s), no problems found`);
}

function help(): void {
  console.log(`${violet("silica")} · digital logic from the command line · created by jullewz

  silica examples                          list the built-in examples
  silica export EXAMPLE [-o FILE]          write an example as a project file
  silica run FILE|EXAMPLE [--cycles N] [--watch A,B] [--set LABEL=VALUE] [--hex] [--circuit NAME]
  silica table FILE|EXAMPLE [--circuit NAME]
  silica simplify "EXPRESSION"
  silica synth "EXPRESSION" [-o FILE]
  silica check FILE|EXAMPLE

Expressions use & | ^ ! (or and, or, xor, not, and a trailing ' for NOT).`);
}

function main(argv: string[]): void {
  const [cmd, ...rest] = argv;
  const o = parseArgs(rest);
  switch (cmd) {
    case "examples":
      for (const e of EXAMPLES) console.log(`${violet(e.id.padEnd(14))} ${e.title}: ${dim(e.description)}`);
      return;
    case "export": {
      const id = o.positional[0] ?? fail("which example? silica export EXAMPLE");
      const ex = EXAMPLES.find((e) => e.id === id) ?? fail(`no example "${id}"`);
      const text = toJSON(ex.build());
      const out = one(o, "o", "out");
      if (out) writeFileSync(out, text + "\n");
      else console.log(text);
      return;
    }
    case "run":
      return cmdRun(o);
    case "table":
      return cmdTable(o);
    case "check":
      return cmdCheck(o);
    case "simplify": {
      const text = o.positional.join(" ") || fail('silica simplify "a & b | a & !b"');
      try {
        const r = simplify(text);
        console.log(r.result);
      } catch (e) {
        fail((e as Error).message);
      }
      return;
    }
    case "synth": {
      const text = o.positional.join(" ") || fail('silica synth "a ^ b"');
      let p: Project;
      try {
        p = synthesize(text);
      } catch (e) {
        fail((e as Error).message);
      }
      const json = toJSON(p);
      const out = one(o, "o", "out");
      if (out) {
        writeFileSync(out, json + "\n");
        console.log(`wrote ${out}: ${simplify(text).result}`);
      } else console.log(json);
      return;
    }
    case "--version":
    case "-v":
      console.log("silica 0.1.0");
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      return help();
    default:
      fail(`unknown command "${cmd}". Run silica help`);
  }
}

main(process.argv.slice(2));
