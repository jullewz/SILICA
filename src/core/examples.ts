/**
 * Built-in example projects, from a half adder up to a small working CPU.
 * They are built with code, so tests can check that each one does what it claims.
 */

import { getDef, normalizeParams, type Params } from "./components.js";
import {
  boxOf,
  portsOf,
  projectLibrary,
  type Circuit,
  type ComponentInstance,
  type Facing,
  type Project,
  type Wire,
} from "./circuit.js";

export class Builder {
  readonly circuit: Circuit;
  private readonly project: Project;
  private counter = 0;

  constructor(project: Project, name: string) {
    this.project = project;
    let c = project.circuits.find((x) => x.name === name);
    if (!c) {
      c = { name, components: [], wires: [] };
      project.circuits.push(c);
    }
    this.circuit = c;
  }

  add(kind: string, x: number, y: number, params: Params = {}, facing: Facing = "E", id?: string): string {
    const prefix = kind === "SUBCIRCUIT" ? "u" : kind[0]!.toLowerCase();
    const cid = id ?? `${prefix}${++this.counter}`;
    this.circuit.components.push({ id: cid, kind, x, y, facing, params: normalizeParams(getDef(kind), params) });
    return cid;
  }

  get(id: string): ComponentInstance {
    const c = this.circuit.components.find((x) => x.id === id);
    if (!c) throw new Error(`no component ${id}`);
    return c;
  }

  /** Absolute position of a named port. */
  at(id: string, portName: string): [number, number] {
    const p = portsOf(this.get(id), projectLibrary(this.project)).find((x) => x.name === portName);
    if (!p) throw new Error(`${id} has no port ${portName}`);
    return [p.ax, p.ay];
  }

  /** Wire through a list of points (each step must be horizontal or vertical). */
  path(...points: [number, number][]): void {
    for (let i = 1; i < points.length; i++) {
      const [x1, y1] = points[i - 1]!;
      const [x2, y2] = points[i]!;
      if (x1 !== x2 && y1 !== y2) throw new Error(`diagonal wire from ${x1},${y1} to ${x2},${y2}`);
      this.circuit.wires.push({ x1, y1, x2, y2 } as Wire);
    }
  }

  /** Attach a labelled tunnel to a port, pointing away from the component. */
  tunnel(id: string, portName: string, label: string): void {
    const comp = this.get(id);
    const lib = projectLibrary(this.project);
    const p = portsOf(comp, lib).find((x) => x.name === portName);
    if (!p) throw new Error(`${id} has no port ${portName}`);
    const box = boxOf(comp, lib);
    const w = Math.max(3, label.length + 2);
    let facing: Facing = "E";
    let x = p.ax;
    let y = p.ay - 1;
    if (p.ax === box.x) {
      facing = "W";
      x = p.ax - w;
    } else if (p.ay === box.y + box.h) {
      facing = "S";
      x = p.ax - 1;
      y = p.ay;
    } else if (p.ay === box.y) {
      facing = "N";
      x = p.ax - 1;
      y = p.ay - w;
    }
    this.add("TUNNEL", x, y, { label, bits: p.width }, facing);
  }

  /** Attach tunnels to several ports at once: { portName: label }. */
  tunnels(id: string, map: Record<string, string>): void {
    for (const [portName, label] of Object.entries(map)) this.tunnel(id, portName, label);
  }
}

function project(main: string): Project {
  return { format: "silica", version: 1, main, circuits: [] };
}

// ------------------------------------------------------------------ examples

export function halfAdderInto(p: Project, name = "half adder"): void {
  const b = new Builder(p, name);
  b.add("INPUT", 2, 2, { label: "A" }, "E", "a");
  b.add("INPUT", 2, 8, { label: "B" }, "E", "b");
  b.add("XOR", 14, 2, {}, "E", "xor");
  b.add("AND", 14, 9, {}, "E", "and");
  b.add("OUTPUT", 24, 3, { label: "S" }, "E", "s");
  b.add("OUTPUT", 24, 10, { label: "C" }, "E", "c");
  b.add("TEXT", 2, 14, { text: "S = A xor B, C = A and B" });
  b.path([5, 3], [14, 3]);
  b.path([8, 3], [8, 10], [14, 10]);
  b.path([5, 9], [10, 9], [10, 5], [14, 5]);
  b.path([10, 9], [10, 12], [14, 12]);
  b.path([18, 4], [24, 4]);
  b.path([18, 11], [24, 11]);
}

export function fullAdderInto(p: Project, name = "full adder", half = "half adder"): void {
  if (!p.circuits.some((c) => c.name === half)) halfAdderInto(p, half);
  const b = new Builder(p, name);
  b.add("INPUT", 2, 2, { label: "A" }, "E", "a");
  b.add("INPUT", 2, 8, { label: "B" }, "E", "b");
  b.add("INPUT", 2, 14, { label: "Cin" }, "E", "cin");
  b.add("SUBCIRCUIT", 12, 4, { circuit: half }, "E", "ha1");
  b.add("SUBCIRCUIT", 24, 10, { circuit: half }, "E", "ha2");
  b.add("OR", 36, 14, {}, "E", "or");
  b.add("OUTPUT", 44, 11, { label: "S" }, "E", "s");
  b.add("OUTPUT", 44, 15, { label: "Cout" }, "E", "cout");
  b.path([5, 3], [9, 3], [9, 6], [12, 6]);
  b.path([5, 9], [10, 9], [10, 8], [12, 8]);
  b.path([18, 6], [21, 6], [21, 12], [24, 12]);
  b.path([5, 15], [20, 15], [20, 14], [24, 14]);
  b.path([18, 8], [19, 8], [19, 17], [36, 17]);
  b.path([30, 14], [33, 14], [33, 15], [36, 15]);
  b.path([30, 12], [44, 12]);
  b.path([40, 16], [44, 16]);
}

export function rippleAdderInto(p: Project, name = "4-bit adder"): void {
  if (!p.circuits.some((c) => c.name === "full adder")) fullAdderInto(p);
  const b = new Builder(p, name);
  b.add("INPUT", 2, 4, { label: "A", bits: 4, value: 5 }, "E", "a");
  b.add("INPUT", 2, 16, { label: "B", bits: 4, value: 9 }, "E", "b");
  b.add("SPLITTER", 10, 1, { bits: 4 }, "E", "sa");
  b.add("SPLITTER", 10, 13, { bits: 4 }, "E", "sb");
  b.path([5, 5], [10, 5]);
  b.path([5, 17], [10, 17]);
  for (let i = 0; i < 4; i++) {
    b.tunnel("sa", `b${i}`, `a${i}`);
    b.tunnel("sb", `b${i}`, `b${i}`);
    const id = `fa${i}`;
    b.add("SUBCIRCUIT", 30, 2 + 10 * i, { circuit: "full adder" }, "E", id);
    b.tunnels(id, { A: `a${i}`, B: `b${i}`, Cin: i === 0 ? "c0" : `c${i}`, S: `s${i}`, Cout: `c${i + 1}` });
  }
  b.add("CONSTANT", 18, 44, { value: 0 }, "E", "zero");
  b.tunnel("zero", "out", "c0");
  b.add("MERGER", 54, 3, { bits: 4 }, "E", "m");
  for (let i = 0; i < 4; i++) b.tunnel("m", `b${i}`, `s${i}`);
  b.add("OUTPUT", 62, 6, { label: "Sum", bits: 4, radix: "dec" }, "E", "sum");
  b.path([56, 7], [62, 7]);
  b.add("OUTPUT", 62, 14, { label: "Carry" }, "E", "carry");
  b.tunnel("carry", "in", "c4");
  b.add("TEXT", 2, 48, { text: "Four full adders in a chain: each carry feeds the next stage" });
}

export function latchInto(p: Project, name = "SR latch"): void {
  const b = new Builder(p, name);
  b.add("BUTTON", 2, 2, { label: "S" }, "E", "s");
  b.add("BUTTON", 2, 12, { label: "R" }, "E", "r");
  b.add("NOR", 12, 2, {}, "E", "n1");
  b.add("NOR", 12, 10, {}, "E", "n2");
  b.add("LED", 26, 2, { label: "nQ" }, "E", "nq");
  b.add("LED", 26, 10, { label: "Q" }, "E", "q");
  b.add("TEXT", 2, 17, { text: "Press S to set Q, R to reset it. Q starts unknown (X)." });
  b.path([4, 3], [12, 3]);
  b.path([4, 13], [12, 13]);
  b.path([16, 4], [20, 4], [20, 3], [26, 3]);
  b.path([16, 12], [22, 12], [22, 11], [26, 11]);
  b.path([20, 4], [20, 7], [10, 7], [10, 11], [12, 11]);
  b.path([22, 11], [22, 8], [9, 8], [9, 5], [12, 5]);
}

export function counterInto(p: Project, name = "counter"): void {
  const b = new Builder(p, name);
  b.add("CLOCK", 2, 2, { label: "clk" }, "E", "clk");
  b.add("SWITCH", 2, 8, { label: "run", value: 1 }, "E", "run");
  b.add("BUTTON", 2, 14, { label: "reset" }, "E", "reset");
  b.add("COUNTER", 12, 2, { bits: 4 }, "E", "cnt");
  b.add("HEX", 22, 1, {}, "E", "hex");
  b.add("LED", 22, 10, { label: "carry", color: "amber" }, "E", "led");
  b.path([5, 3], [12, 3]);
  b.path([4, 9], [8, 9], [8, 5], [12, 5]);
  b.path([4, 15], [10, 15], [10, 7], [12, 7]);
  b.path([16, 4], [22, 4]);
  b.path([16, 6], [19, 6], [19, 11], [22, 11]);
}

export const FIB_PROGRAM = [96, 94, 97, 95, 30, 192, 63, 174, 93, 31, 94, 29, 95, 132, 224];

/**
 * An 8-bit accumulator CPU. Each instruction is one byte: a 3-bit opcode and a 5-bit operand.
 *
 *   0 LDA a   A = RAM[a]        4 JMP a   jump to a
 *   1 ADD a   A = A + RAM[a]    5 JC a    jump to a if the last ADD carried
 *   2 STA a   RAM[a] = A        6 OUT     show A
 *   3 LDI n   A = n             7 HLT     stop
 *
 * Every instruction takes one clock cycle. The program prints Fibonacci numbers until they overflow 8 bits.
 */
export function cpuInto(p: Project, name = "8-bit CPU", program: number[] = FIB_PROGRAM): void {
  const b = new Builder(p, name);
  b.add("CLOCK", 2, 2, { label: "clk" }, "E", "clk");
  b.tunnel("clk", "out", "clk");

  // fetch
  b.add("REGISTER", 14, 10, { bits: 5, label: "PC" }, "E", "pc");
  b.tunnels("pc", { d: "pc_next", clk: "clk", en: "run", q: "pc" });
  b.add("ROM", 30, 11, { addrBits: 5, bits: 8, contents: program, label: "program" }, "E", "rom");
  b.tunnels("rom", { addr: "pc", dout: "instr" });

  // decode
  b.add("SPLITTER", 48, 2, { bits: 8 }, "E", "split");
  b.tunnel("split", "bus", "instr");
  const opNames = ["isLDA", "isADD", "isSTA", "isLDI", "isJMP", "isJC", "isOUT", "isHLT"];
  b.add("MERGER", 60, 2, { bits: 5 }, "E", "operand");
  b.add("MERGER", 60, 16, { bits: 3 }, "E", "opcode");
  for (let i = 0; i < 8; i++) {
    b.tunnel("split", `b${i}`, `i${i}`);
    if (i < 5) b.tunnel("operand", `b${i}`, `i${i}`);
    else b.tunnel("opcode", `b${i - 5}`, `i${i}`);
  }
  b.tunnel("operand", "bus", "operand");
  b.tunnel("opcode", "bus", "opcode");
  b.add("DECODER", 80, 2, { select: 3 }, "E", "dec");
  b.tunnel("dec", "sel", "opcode");
  opNames.forEach((n, i) => b.tunnel("dec", `out${i}`, n));

  // data path
  b.add("RAM", 14, 30, { addrBits: 5, bits: 8, label: "data" }, "E", "ram");
  b.tunnels("ram", { addr: "operand", din: "acc", we: "isSTA", clk: "clk", dout: "mem" });
  b.add("ADDER", 34, 30, { bits: 8 }, "E", "alu");
  b.tunnels("alu", { a: "acc", b: "mem", sum: "sum", cout: "carry" });
  b.add("EXTEND", 34, 42, { inBits: 5, outBits: 8 }, "E", "ext");
  b.tunnels("ext", { in: "operand", out: "imm" });
  b.add("MERGER", 52, 42, { bits: 2 }, "E", "asel");
  b.tunnels("asel", { b0: "isADD", b1: "isLDI", bus: "asel" });
  b.add("MUX", 52, 28, { select: 2, bits: 8 }, "E", "amux");
  b.tunnels("amux", { in0: "mem", in1: "sum", in2: "imm", in3: "mem", sel: "asel", out: "a_next" });
  b.add("OR", 70, 40, { inputs: 3 }, "E", "awe");
  b.tunnels("awe", { in0: "isLDA", in1: "isADD", in2: "isLDI", out: "a_we" });
  b.add("REGISTER", 70, 28, { bits: 8, label: "A" }, "E", "a");
  b.tunnels("a", { d: "a_next", clk: "clk", en: "a_we", q: "acc" });
  b.add("REGISTER", 88, 28, { bits: 1, label: "carry flag" }, "E", "cf");
  b.tunnels("cf", { d: "carry", clk: "clk", en: "isADD", q: "cflag" });

  // next PC
  b.add("CONSTANT", 2, 52, { bits: 5, value: 1 }, "E", "one");
  b.tunnel("one", "out", "one");
  b.add("ADDER", 14, 50, { bits: 5 }, "E", "inc");
  b.tunnels("inc", { a: "pc", b: "one", sum: "pc_inc" });
  b.add("AND", 30, 60, {}, "E", "jc");
  b.tunnels("jc", { in0: "isJC", in1: "cflag", out: "jc_taken" });
  b.add("OR", 52, 60, {}, "E", "jump");
  b.tunnels("jump", { in0: "isJMP", in1: "jc_taken", out: "jump" });
  b.add("MUX", 68, 50, { select: 1, bits: 5 }, "E", "pcmux");
  b.tunnels("pcmux", { in0: "pc_inc", in1: "operand", sel: "jump", out: "pc_next" });
  b.add("NOT", 84, 62, {}, "E", "run");
  b.tunnels("run", { in: "isHLT", out: "run" });

  // output
  b.add("REGISTER", 88, 46, { bits: 8, label: "OUT" }, "E", "outreg");
  b.tunnels("outreg", { d: "acc", clk: "clk", en: "isOUT", q: "out" });
  b.add("PROBE", 106, 49, { bits: 8, radix: "dec", label: "output" }, "E", "display");
  b.tunnel("display", "in", "out");
  b.add("PROBE", 106, 31, { bits: 8, radix: "dec", label: "A" }, "E", "accprobe");
  b.tunnel("accprobe", "in", "acc");
  b.add("PROBE", 106, 13, { bits: 5, radix: "dec", label: "PC" }, "E", "pcprobe");
  b.tunnel("pcprobe", "in", "pc");
  b.add("LED", 106, 62, { label: "halted", color: "red" }, "E", "halt");
  b.tunnel("halt", "in", "isHLT");
  b.add("TEXT", 2, 70, {
    text: "8-bit accumulator CPU running a Fibonacci program from ROM. Step the clock to watch it.",
  });
}

export interface Example {
  id: string;
  title: string;
  description: string;
  build(): Project;
}

export const EXAMPLES: Example[] = [
  {
    id: "half-adder",
    title: "Half adder",
    description: "Two gates that add two bits.",
    build: () => {
      const p = project("half adder");
      halfAdderInto(p);
      return p;
    },
  },
  {
    id: "full-adder",
    title: "Full adder (subcircuits)",
    description: "Two half adders and an OR gate, using the half adder as a part.",
    build: () => {
      const p = project("full adder");
      fullAdderInto(p);
      return p;
    },
  },
  {
    id: "ripple-adder",
    title: "4-bit ripple-carry adder",
    description: "Four full adders chained by their carries.",
    build: () => {
      const p = project("4-bit adder");
      rippleAdderInto(p);
      return p;
    },
  },
  {
    id: "sr-latch",
    title: "SR latch",
    description: "Two cross-coupled NOR gates: one bit of memory.",
    build: () => {
      const p = project("SR latch");
      latchInto(p);
      return p;
    },
  },
  {
    id: "counter",
    title: "4-bit counter",
    description: "A clocked counter on a hex display.",
    build: () => {
      const p = project("counter");
      counterInto(p);
      return p;
    },
  },
  {
    id: "cpu",
    title: "8-bit CPU",
    description: "A working CPU with ROM, RAM, an adder and a decoder, printing Fibonacci numbers.",
    build: () => {
      const p = project("8-bit CPU");
      cpuInto(p);
      return p;
    },
  },
];
