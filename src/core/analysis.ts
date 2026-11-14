/**
 * Analysis tools: truth tables, Boolean expressions, minimisation and circuit synthesis.
 *
 *   truthTable(project)       runs a combinational circuit through every input combination
 *   parseExpression(text)     reads "a & !b | c ^ d" (also: and/or/not/xor, ', +, *, juxtaposition is not used)
 *   minimize(...)             Quine–McCluskey with a greedy cover: a short sum of products
 *   synthesize(expression)    draws a two-level AND/OR circuit for an expression, with inputs on vertical rails
 */

import { buildNetlist, emptyProject, type Project } from "./circuit.js";
import { Builder } from "./examples.js";
import { toNumber, type Signal } from "./signal.js";
import { Simulator } from "./simulator.js";

// ------------------------------------------------------------------ truth tables

export interface TruthTable {
  inputs: { label: string; width: number }[];
  outputs: { label: string; width: number }[];
  /** One row per input combination: input values then output values (null for X or Z). */
  rows: (number | null)[][];
  sequential: boolean;
}

const MAX_INPUT_BITS = 16;

export function truthTable(project: Project, circuit = project.main): TruthTable {
  const netlist = buildNetlist(project, circuit);
  if (netlist.errors.length) throw new Error(netlist.errors[0]!.message);
  const sim = new Simulator(netlist);
  const ins = netlist.components.filter((c) => c.top && ["INPUT", "SWITCH", "BUTTON"].includes(c.instance.kind));
  const outs = netlist.components.filter((c) => c.top && ["OUTPUT", "LED", "PROBE"].includes(c.instance.kind));
  const order = (a: (typeof ins)[number], b: (typeof ins)[number]) =>
    a.instance.y - b.instance.y || a.instance.x - b.instance.x;
  ins.sort(order);
  outs.sort(order);
  const width = (c: (typeof ins)[number]) => Number(c.params["bits"] ?? 1);
  const label = (c: (typeof ins)[number], i: number, prefix: string) => String(c.params["label"] || `${prefix}${i}`);
  const totalBits = ins.reduce((s, c) => s + width(c), 0);
  if (totalBits > MAX_INPUT_BITS)
    throw new Error(`too many input bits for a truth table: ${totalBits} (the limit is ${MAX_INPUT_BITS})`);
  const rows: (number | null)[][] = [];
  for (let combo = 0; combo < 2 ** totalBits; combo++) {
    let shift = totalBits;
    const values: number[] = [];
    for (const c of ins) {
      const w = width(c);
      shift -= w;
      const v = (combo >>> shift) & (2 ** w - 1);
      values.push(v);
      sim.set(c.path, v, false);
    }
    const stats = sim.settle();
    if (stats.oscillating) throw new Error("the circuit oscillates for some inputs");
    rows.push([...values, ...outs.map((c) => toNumber(sim.get(c.path) as Signal))]);
  }
  return {
    inputs: ins.map((c, i) => ({ label: label(c, i, "in"), width: width(c) })),
    outputs: outs.map((c, i) => ({ label: label(c, i, "out"), width: width(c) })),
    rows,
    sequential: netlist.components.some((c) => c.def.sequential),
  };
}

// ------------------------------------------------------------------ expressions

export type Expr =
  | { op: "var"; name: string }
  | { op: "const"; value: 0 | 1 }
  | { op: "not"; a: Expr }
  | { op: "and" | "or" | "xor"; a: Expr; b: Expr };

export function parseExpression(text: string): Expr {
  const tokens = text.match(/[A-Za-z_][A-Za-z0-9_]*|[01]|\|\||&&|[()!~&|^+*'¬∧∨⊕]|\S/g) ?? [];
  let i = 0;
  const peek = () => tokens[i];
  const word = (t: string | undefined, w: string) => t !== undefined && t.toLowerCase() === w;
  const fail = (msg: string): never => {
    throw new Error(`${msg} at token ${i + 1}${tokens[i] ? ` ("${tokens[i]}")` : " (end of expression)"}`);
  };
  function or(): Expr {
    let a = xorExpr();
    while (peek() === "|" || peek() === "||" || peek() === "+" || peek() === "∨" || word(peek(), "or")) {
      i++;
      a = { op: "or", a, b: xorExpr() };
    }
    return a;
  }
  function xorExpr(): Expr {
    let a = andExpr();
    while (peek() === "^" || peek() === "⊕" || word(peek(), "xor")) {
      i++;
      a = { op: "xor", a, b: andExpr() };
    }
    return a;
  }
  function andExpr(): Expr {
    let a = unary();
    while (peek() === "&" || peek() === "&&" || peek() === "*" || peek() === "∧" || word(peek(), "and")) {
      i++;
      a = { op: "and", a, b: unary() };
    }
    return a;
  }
  function unary(): Expr {
    if (peek() === "!" || peek() === "~" || peek() === "¬" || word(peek(), "not")) {
      i++;
      return { op: "not", a: unary() };
    }
    let e = atom();
    while (peek() === "'") {
      i++;
      e = { op: "not", a: e };
    }
    return e;
  }
  function atom(): Expr {
    const t = peek();
    if (t === undefined) return fail("expected a variable, 0, 1 or (");
    if (t === "(") {
      i++;
      const e = or();
      if (peek() !== ")") fail("expected )");
      i++;
      return e;
    }
    if (t === "0" || t === "1") {
      i++;
      return { op: "const", value: t === "1" ? 1 : 0 };
    }
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(t) && !["and", "or", "not", "xor"].includes(t.toLowerCase())) {
      i++;
      return { op: "var", name: t };
    }
    return fail("unexpected token");
  }
  const e = or();
  if (i < tokens.length) fail("unexpected token");
  return e;
}

export function variables(e: Expr, out = new Set<string>()): string[] {
  if (e.op === "var") out.add(e.name);
  else if (e.op === "not") variables(e.a, out);
  else if (e.op !== "const") {
    variables(e.a, out);
    variables(e.b, out);
  }
  return [...out].sort();
}

export function evaluate(e: Expr, env: Record<string, number>): number {
  switch (e.op) {
    case "var":
      return env[e.name] ?? 0;
    case "const":
      return e.value;
    case "not":
      return evaluate(e.a, env) ^ 1;
    case "and":
      return evaluate(e.a, env) & evaluate(e.b, env);
    case "or":
      return evaluate(e.a, env) | evaluate(e.b, env);
    case "xor":
      return evaluate(e.a, env) ^ evaluate(e.b, env);
  }
}

/** Minterms of an expression over the given variables (first variable is the most significant bit). */
export function mintermsOf(e: Expr, vars: string[]): number[] {
  const out: number[] = [];
  for (let m = 0; m < 2 ** vars.length; m++) {
    const env: Record<string, number> = {};
    vars.forEach((v, k) => (env[v] = (m >>> (vars.length - 1 - k)) & 1));
    if (evaluate(e, env)) out.push(m);
  }
  return out;
}

// ------------------------------------------------------------------ Quine–McCluskey

/** An implicant: `value` on the bits in `care`; other bits are free. */
export interface Implicant {
  value: number;
  care: number;
}

export function minimize(nvars: number, minterms: number[], dontCares: number[] = []): Implicant[] {
  const all = (1 << nvars) - 1;
  const on = [...new Set(minterms)];
  if (!on.length) return [];
  if (on.length + new Set(dontCares).size === 2 ** nvars && on.length) {
    const dc = new Set(dontCares);
    if (on.every((m) => !dc.has(m))) return [{ value: 0, care: 0 }];
  }
  // combine implicants until nothing combines
  let current = new Map<string, Implicant>();
  for (const m of [...on, ...dontCares]) current.set(`${m}/${all}`, { value: m, care: all });
  const primes: Implicant[] = [];
  while (current.size) {
    const next = new Map<string, Implicant>();
    const used = new Set<string>();
    const list = [...current.entries()];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const [ka, a] = list[i]!;
        const [kb, b] = list[j]!;
        if (a.care !== b.care) continue;
        const diff = (a.value ^ b.value) & a.care;
        if (diff && (diff & (diff - 1)) === 0) {
          const care = a.care & ~diff;
          const value = a.value & care;
          next.set(`${value}/${care}`, { value, care });
          used.add(ka);
          used.add(kb);
        }
      }
    }
    for (const [k, imp] of current) if (!used.has(k)) primes.push(imp);
    current = next;
  }
  // cover the minterms: essential primes first, then greedy
  const covers = (p: Implicant, m: number) => (m & p.care) === p.value;
  const chosen: Implicant[] = [];
  let left = new Set(on);
  for (const m of on) {
    const hits = primes.filter((p) => covers(p, m));
    if (hits.length === 1 && !chosen.includes(hits[0]!)) chosen.push(hits[0]!);
  }
  for (const p of chosen) for (const m of [...left]) if (covers(p, m)) left.delete(m);
  while (left.size) {
    let best = primes[0]!;
    let bestScore = -1;
    for (const p of primes) {
      let score = 0;
      for (const m of left) if (covers(p, m)) score++;
      const literals = popcount(p.care);
      if (score > bestScore || (score === bestScore && literals < popcount(best.care))) {
        best = p;
        bestScore = score;
      }
    }
    chosen.push(best);
    left = new Set([...left].filter((m) => !covers(best, m)));
  }
  return chosen.sort((a, b) => popcount(b.care) - popcount(a.care) || a.value - b.value);
}

function popcount(n: number): number {
  let c = 0;
  while (n) {
    n &= n - 1;
    c++;
  }
  return c;
}

/** Write implicants as a sum of products, e.g. "A·B' + C". */
export function formatSop(implicants: Implicant[], vars: string[], style: "math" | "code" = "code"): string {
  if (!implicants.length) return "0";
  const n = vars.length;
  const terms = implicants.map((imp) => {
    const lits: string[] = [];
    for (let k = 0; k < n; k++) {
      const bitv = 1 << (n - 1 - k);
      if (!(imp.care & bitv)) continue;
      const neg = !(imp.value & bitv);
      lits.push(style === "math" ? `${vars[k]}${neg ? "'" : ""}` : `${neg ? "!" : ""}${vars[k]}`);
    }
    return lits.length ? lits.join(style === "math" ? "·" : " & ") : "1";
  });
  return terms.join(style === "math" ? " + " : " | ");
}

export function simplify(
  text: string,
  style: "math" | "code" = "code",
): { vars: string[]; minterms: number[]; result: string } {
  const e = parseExpression(text);
  const vars = variables(e);
  const minterms = mintermsOf(e, vars);
  return { vars, minterms, result: formatSop(minimize(vars.length, minterms), vars, style) };
}

// ------------------------------------------------------------------ synthesis

/**
 * Draw a circuit for a sum of products. Each input has a vertical rail and an inverted rail; each product is
 * an AND gate fed from the rails; an OR gate collects the products. Horizontal wires start on a rail (a
 * T-junction) and cross the other rails without connecting.
 */
export function synthesize(text: string, name = "synthesized"): Project {
  const { vars } = simplify(text);
  const e = parseExpression(text);
  const imps = minimize(vars.length, mintermsOf(e, vars));
  const p = emptyProject(name);
  p.circuits = [];
  const b = new Builder(p, name);
  const n = vars.length;
  const terms = imps.map((imp) => {
    const lits: { k: number; neg: boolean }[] = [];
    for (let k = 0; k < n; k++) {
      const bitv = 1 << (n - 1 - k);
      if (imp.care & bitv) lits.push({ k, neg: !(imp.value & bitv) });
    }
    return lits;
  });
  const railX = (k: number, neg: boolean) => 10 + 6 * k + (neg ? 3 : 0);
  const gateX = 10 + 6 * n + 4;
  const top = 2;
  // place the product terms first, so every term's output lands on an even row
  const rows: number[] = [];
  let y = top + 6;
  for (const lits of terms) {
    const offset = lits.length >= 2 ? lits.length : 1;
    if ((y + offset) % 2) y++;
    rows.push(y);
    y += 2 * Math.max(2, lits.length) + 2;
  }
  const bottom = y + 2;
  // inputs, rails and inverted rails
  vars.forEach((v, k) => {
    const id = `in_${k}`;
    b.add("INPUT", railX(k, false) - 4, top - 1, { label: v }, "E", id);
    const [ox, oy] = b.at(id, "out");
    const rx = railX(k, false);
    b.path([ox, oy], [rx, oy], [rx, bottom]);
    const notId = `not_${k}`;
    b.add("NOT", railX(k, true) - 1, oy + 2, {}, "S", notId);
    const [nix, niy] = b.at(notId, "in");
    const [nox, noy] = b.at(notId, "out");
    b.path([rx, niy - 1], [nix, niy - 1], [nix, niy]);
    b.path([nox, noy], [nox, bottom]);
  });
  const outputs: [number, number][] = [];
  terms.forEach((lits, t) => {
    const ty = rows[t]!;
    if (lits.length === 0) {
      const id = `one_${t}`;
      b.add("CONSTANT", gateX + 2, ty, { value: 1 }, "E", id);
      outputs.push(b.at(id, "out"));
    } else if (lits.length === 1) {
      const lit = lits[0]!;
      const id = `buf_${t}`;
      b.add("BUFFER", gateX + 1, ty, {}, "E", id);
      const [ix, iy] = b.at(id, "in");
      b.path([railX(lit.k, lit.neg), iy], [ix, iy]);
      outputs.push(b.at(id, "out"));
    } else {
      const id = `and_${t}`;
      b.add("AND", gateX, ty, { inputs: lits.length }, "E", id);
      lits.forEach((lit, j) => {
        const [ix, iy] = b.at(id, `in${j}`);
        b.path([railX(lit.k, lit.neg), iy], [ix, iy]);
      });
      outputs.push(b.at(id, "out"));
    }
  });
  // the OR gate, or a direct wire for a single term
  const outX = gateX + 14 + 2 * outputs.length;
  const outId = "f";
  if (outputs.length === 0) {
    b.add("CONSTANT", gateX + 2, top + 6, { value: 0 }, "E", "zero");
    b.add("OUTPUT", outX + 6, top + 5, { label: "f" }, "E", outId);
    const [zx, zy] = b.at("zero", "out");
    const [fx, fy] = b.at(outId, "in");
    b.path([zx, zy], [fx, zy], [fx, fy]);
    return p;
  }
  if (outputs.length === 1) {
    const [ox, oy] = outputs[0]!;
    b.add("OUTPUT", outX + 6, oy - 1, { label: "f" }, "E", outId);
    b.path([ox, oy], b.at(outId, "in"));
    return p;
  }
  const orTop = top + 4; // OR inputs land on odd rows, gate outputs on even rows: no accidental junctions
  b.add("OR", outX, orTop, { inputs: Math.min(8, outputs.length) }, "E", "or");
  if (outputs.length > 8) throw new Error("synthesis supports at most 8 product terms");
  outputs.forEach(([ox, oy], j) => {
    const [ix, iy] = b.at("or", `in${j}`);
    const track = gateX + 8 + 2 * j;
    b.path([ox, oy], [track, oy], [track, iy], [ix, iy]);
  });
  const [ox, oy] = b.at("or", "out");
  b.add("OUTPUT", ox + 6, oy - 1, { label: "f" }, "E", outId);
  b.path([ox, oy], b.at(outId, "in"));
  return p;
}
