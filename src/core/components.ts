/**
 * The component library: every part you can place in a circuit.
 *
 * A component definition says what it looks like (size and port positions on the grid, before rotation),
 * which parameters it takes, and how it computes its outputs from its inputs. Sequential parts keep a state
 * object and react to the rising edge of their clock input.
 */

import {
  and,
  bit,
  concat,
  floating,
  known,
  mask,
  not,
  or,
  sig,
  toNumber,
  unknown,
  xor,
  type Radix,
  type Signal,
} from "./signal.js";

export type ParamValue = number | string | boolean | number[];
export type Params = Record<string, ParamValue>;

export interface ParamSpec {
  key: string;
  label: string;
  type: "int" | "select" | "text" | "bool" | "list";
  default: ParamValue;
  min?: number;
  max?: number;
  options?: readonly string[];
}

export interface PortSpec {
  name: string;
  dir: "in" | "out";
  width: number;
  x: number;
  y: number;
}

/** Lets subcircuit components ask about the circuit they stand for. */
export interface Library {
  subcircuitPins(
    name: string,
  ): { inputs: { label: string; width: number }[]; outputs: { label: string; width: number }[] } | null;
}

export const NO_LIBRARY: Library = { subcircuitPins: () => null };

export interface ComponentDef {
  kind: string;
  name: string;
  category: "Gates" | "Inputs" | "Outputs" | "Wiring" | "Plexers" | "Arithmetic" | "Memory" | "Circuits";
  description: string;
  params: ParamSpec[];
  size(p: Params, lib: Library): { w: number; h: number };
  ports(p: Params, lib: Library): PortSpec[];
  initState?(p: Params): unknown;
  /** Compute the outputs (in port order) from the inputs (in port order). */
  evaluate(inputs: Signal[], state: any, p: Params): Signal[];
  /** Drives a value the user sets (switches, buttons, input pins, clocks). */
  source?: boolean;
  /** Has a clock input and memory. */
  sequential?: boolean;
}

// ------------------------------------------------------------------ parameter helpers

const bits = (def = 1, label = "Data bits"): ParamSpec => ({
  key: "bits",
  label,
  type: "int",
  default: def,
  min: 1,
  max: 32,
});
const inputsParam: ParamSpec = { key: "inputs", label: "Inputs", type: "int", default: 2, min: 2, max: 8 };
const labelParam: ParamSpec = { key: "label", label: "Label", type: "text", default: "" };

export function num(p: Params, key: string, fallback: number): number {
  const v = p[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

export function str(p: Params, key: string, fallback: string): string {
  const v = p[key];
  return typeof v === "string" ? v : fallback;
}

function list(p: Params, key: string): number[] {
  const v = p[key];
  return Array.isArray(v) ? v : [];
}

const port = (name: string, dir: "in" | "out", width: number, x: number, y: number): PortSpec => ({
  name,
  dir,
  width,
  x,
  y,
});

function allKnown(...s: Signal[]): boolean {
  return s.every((x) => x.x === 0 && x.z === 0);
}

interface EdgeState {
  last: number | null;
}

/** True on a 0 → 1 change of a known clock signal. Updates the stored level. */
function risingEdge(state: EdgeState, clk: Signal): boolean {
  const now = toNumber(clk);
  const rise = state.last === 0 && now === 1;
  state.last = now;
  return rise;
}

// ------------------------------------------------------------------ gates

type Op = (a: Signal, b: Signal) => Signal;

function gate(kind: string, name: string, op: Op, invert: boolean, description: string): ComponentDef {
  return {
    kind,
    name,
    category: "Gates",
    description,
    params: [inputsParam, bits(1), labelParam],
    size: (p) => ({ w: 4, h: 2 * num(p, "inputs", 2) }),
    ports(p) {
      const n = num(p, "inputs", 2);
      const w = num(p, "bits", 1);
      const out: PortSpec[] = [];
      for (let i = 0; i < n; i++) out.push(port(`in${i}`, "in", w, 0, 1 + 2 * i));
      out.push(port("out", "out", w, 4, n));
      return out;
    },
    evaluate(inputs) {
      let acc = inputs[0]!;
      for (let i = 1; i < inputs.length; i++) acc = op(acc, inputs[i]!);
      return [invert ? not(acc) : acc];
    },
  };
}

const unary = (kind: string, name: string, f: (s: Signal) => Signal, description: string): ComponentDef => ({
  kind,
  name,
  category: "Gates",
  description,
  params: [bits(1), labelParam],
  size: () => ({ w: 3, h: 2 }),
  ports: (p) => [port("in", "in", num(p, "bits", 1), 0, 1), port("out", "out", num(p, "bits", 1), 3, 1)],
  evaluate: (inputs) => [f(inputs[0]!)],
});

// ------------------------------------------------------------------ the library

const defs: ComponentDef[] = [
  gate("AND", "AND gate", and, false, "Output is 1 when every input is 1."),
  gate("OR", "OR gate", or, false, "Output is 1 when any input is 1."),
  gate("NAND", "NAND gate", and, true, "AND followed by NOT. Every other gate can be built from NANDs."),
  gate("NOR", "NOR gate", or, true, "OR followed by NOT."),
  gate("XOR", "XOR gate", xor, false, "Output is 1 when an odd number of inputs are 1."),
  gate("XNOR", "XNOR gate", xor, true, "Output is 1 when an even number of inputs are 1."),
  unary("NOT", "NOT gate", not, "Inverts every bit."),
  unary("BUFFER", "Buffer", (s) => sig(s.width, s.v, s.x | s.z), "Passes its input through. Turns Z into X."),
  {
    kind: "TRISTATE",
    name: "Tri-state buffer",
    category: "Gates",
    description: "Passes its input when enabled, otherwise lets go of the wire (Z). Lets several parts share a bus.",
    params: [bits(1), labelParam],
    size: () => ({ w: 3, h: 2 }),
    ports: (p) => [
      port("in", "in", num(p, "bits", 1), 0, 1),
      port("en", "in", 1, 1, 2),
      port("out", "out", num(p, "bits", 1), 3, 1),
    ],
    evaluate([d, en]) {
      const e = toNumber(en!);
      if (e === 1) return [d!];
      if (e === 0) return [floating(d!.width)];
      return [unknown(d!.width)];
    },
  },

  // inputs
  {
    kind: "SWITCH",
    name: "Switch",
    category: "Inputs",
    description: "Click to flip between 0 and 1.",
    params: [labelParam, { key: "value", label: "Initial value", type: "int", default: 0, min: 0, max: 1 }],
    size: () => ({ w: 2, h: 2 }),
    ports: () => [port("out", "out", 1, 2, 1)],
    initState: (p) => ({ value: num(p, "value", 0) & 1 }),
    evaluate: (_i, s) => [known(1, s.value)],
    source: true,
  },
  {
    kind: "BUTTON",
    name: "Push button",
    category: "Inputs",
    description: "Outputs 1 only while you hold it down.",
    params: [labelParam],
    size: () => ({ w: 2, h: 2 }),
    ports: () => [port("out", "out", 1, 2, 1)],
    initState: () => ({ value: 0 }),
    evaluate: (_i, s) => [known(1, s.value)],
    source: true,
  },
  {
    kind: "INPUT",
    name: "Input pin",
    category: "Inputs",
    description: "A value you set, of any width. Inside a subcircuit it becomes one of its inputs.",
    params: [bits(1), labelParam, { key: "value", label: "Initial value", type: "int", default: 0, min: 0 }],
    size: () => ({ w: 3, h: 2 }),
    ports: (p) => [port("out", "out", num(p, "bits", 1), 3, 1)],
    initState: (p) => ({ value: num(p, "value", 0) >>> 0 }),
    evaluate: (_i, s, p) => [known(num(p, "bits", 1), s.value)],
    source: true,
  },
  {
    kind: "CONSTANT",
    name: "Constant",
    category: "Inputs",
    description: "A fixed value.",
    params: [bits(1), { key: "value", label: "Value", type: "int", default: 1, min: 0 }],
    size: () => ({ w: 2, h: 2 }),
    ports: (p) => [port("out", "out", num(p, "bits", 1), 2, 1)],
    evaluate: (_i, _s, p) => [known(num(p, "bits", 1), num(p, "value", 1))],
  },
  {
    kind: "CLOCK",
    name: "Clock",
    category: "Inputs",
    description: "Flips between 0 and 1 on every simulation tick. Two ticks make one clock cycle.",
    params: [labelParam],
    size: () => ({ w: 3, h: 2 }),
    ports: () => [port("out", "out", 1, 3, 1)],
    initState: () => ({ value: 0 }),
    evaluate: (_i, s) => [known(1, s.value)],
    source: true,
  },

  // outputs
  {
    kind: "OUTPUT",
    name: "Output pin",
    category: "Outputs",
    description: "Shows a value. Inside a subcircuit it becomes one of its outputs.",
    params: [
      bits(1),
      labelParam,
      { key: "radix", label: "Show as", type: "select", default: "hex", options: ["hex", "dec", "sdec", "bin"] },
    ],
    size: () => ({ w: 3, h: 2 }),
    ports: (p) => [port("in", "in", num(p, "bits", 1), 0, 1)],
    evaluate: () => [],
  },
  {
    kind: "LED",
    name: "LED",
    category: "Outputs",
    description: "Lights up on 1.",
    params: [
      labelParam,
      {
        key: "color",
        label: "Colour",
        type: "select",
        default: "violet",
        options: ["violet", "red", "green", "amber", "blue"],
      },
    ],
    size: () => ({ w: 2, h: 2 }),
    ports: () => [port("in", "in", 1, 0, 1)],
    evaluate: () => [],
  },
  {
    kind: "PROBE",
    name: "Probe",
    category: "Outputs",
    description: "Shows the value on a wire in binary, decimal or hex.",
    params: [
      bits(1),
      labelParam,
      { key: "radix", label: "Show as", type: "select", default: "dec", options: ["hex", "dec", "sdec", "bin"] },
    ],
    size: (p) => ({ w: Math.max(3, probeChars(p) + 1), h: 2 }),
    ports: (p) => [port("in", "in", num(p, "bits", 1), 0, 1)],
    evaluate: () => [],
  },
  {
    kind: "HEX",
    name: "Hex digit display",
    category: "Outputs",
    description: "Shows a 4-bit value as one hexadecimal digit on seven segments.",
    params: [labelParam],
    size: () => ({ w: 4, h: 6 }),
    ports: () => [port("in", "in", 4, 0, 3)],
    evaluate: () => [],
  },
  {
    kind: "SEVENSEG",
    name: "7-segment display",
    category: "Outputs",
    description: "Lights segments a to g (bits 0 to 6) and the decimal point (bit 7) separately.",
    params: [labelParam],
    size: () => ({ w: 4, h: 6 }),
    ports: () => [port("segments", "in", 8, 0, 3)],
    evaluate: () => [],
  },

  // wiring
  {
    kind: "TUNNEL",
    name: "Tunnel",
    category: "Wiring",
    description: "Connects to every tunnel with the same label in the same circuit, without drawing a wire.",
    params: [bits(1), { key: "label", label: "Label", type: "text", default: "net" }],
    size: (p) => ({ w: Math.max(3, str(p, "label", "net").length + 2), h: 2 }),
    ports: (p) => [port("io", "in", num(p, "bits", 1), 0, 1)],
    evaluate: () => [],
  },
  {
    kind: "SPLITTER",
    name: "Splitter",
    category: "Wiring",
    description: "Takes a bus apart into single bits, bit 0 at the top.",
    params: [bits(8, "Bus width")],
    size: (p) => ({ w: 2, h: 2 * num(p, "bits", 8) }),
    ports(p) {
      const n = num(p, "bits", 8);
      const out = [port("bus", "in", n, 0, n)];
      for (let i = 0; i < n; i++) out.push(port(`b${i}`, "out", 1, 2, 1 + 2 * i));
      return out;
    },
    evaluate: ([bus]) => Array.from({ length: bus!.width }, (_, i) => bit(bus!, i)),
  },
  {
    kind: "MERGER",
    name: "Merger",
    category: "Wiring",
    description: "Joins single bits into a bus, bit 0 at the top.",
    params: [bits(8, "Bus width")],
    size: (p) => ({ w: 2, h: 2 * num(p, "bits", 8) }),
    ports(p) {
      const n = num(p, "bits", 8);
      const out: PortSpec[] = [];
      for (let i = 0; i < n; i++) out.push(port(`b${i}`, "in", 1, 0, 1 + 2 * i));
      out.push(port("bus", "out", n, 2, n));
      return out;
    },
    evaluate: (inputs) => [concat(inputs)],
  },
  {
    kind: "EXTEND",
    name: "Bit extender",
    category: "Wiring",
    description: "Widens or narrows a value, filling new bits with zeros, ones or the sign bit.",
    params: [
      { key: "inBits", label: "Input bits", type: "int", default: 4, min: 1, max: 32 },
      { key: "outBits", label: "Output bits", type: "int", default: 8, min: 1, max: 32 },
      { key: "fill", label: "Fill with", type: "select", default: "zero", options: ["zero", "one", "sign"] },
    ],
    size: () => ({ w: 4, h: 2 }),
    ports: (p) => [port("in", "in", num(p, "inBits", 4), 0, 1), port("out", "out", num(p, "outBits", 8), 4, 1)],
    evaluate([a], _s, p) {
      const w = num(p, "outBits", 8);
      const iw = a!.width;
      if (w <= iw) return [sig(w, a!.v, a!.x, a!.z)];
      const fill = str(p, "fill", "zero");
      const high = (mask(w) & ~mask(iw)) >>> 0;
      let v = a!.v;
      let x = a!.x;
      const top = iw - 1;
      if (fill === "one") v |= high;
      else if (fill === "sign") {
        if ((a!.x | a!.z) & (1 << top)) x |= high;
        else if (a!.v & (1 << top)) v |= high;
      }
      return [sig(w, v, x | a!.z)];
    },
  },

  // plexers
  {
    kind: "MUX",
    name: "Multiplexer",
    category: "Plexers",
    description: "Passes the input chosen by the select lines.",
    params: [{ key: "select", label: "Select bits", type: "int", default: 1, min: 1, max: 4 }, bits(1)],
    size: (p) => ({ w: 3, h: 2 * 2 ** num(p, "select", 1) }),
    ports(p) {
      const s = num(p, "select", 1);
      const n = 2 ** s;
      const w = num(p, "bits", 1);
      const out: PortSpec[] = [];
      for (let i = 0; i < n; i++) out.push(port(`in${i}`, "in", w, 0, 1 + 2 * i));
      out.push(port("sel", "in", s, 1, 2 * n));
      out.push(port("out", "out", w, 3, n));
      return out;
    },
    evaluate(inputs) {
      const sel = toNumber(inputs[inputs.length - 1]!);
      const w = inputs[0]!.width;
      if (sel === null) return [unknown(w)];
      return [inputs[sel] ?? unknown(w)];
    },
  },
  {
    kind: "DEMUX",
    name: "Demultiplexer",
    category: "Plexers",
    description: "Sends its input to the output chosen by the select lines. The other outputs are 0.",
    params: [{ key: "select", label: "Select bits", type: "int", default: 1, min: 1, max: 4 }, bits(1)],
    size: (p) => ({ w: 3, h: 2 * 2 ** num(p, "select", 1) }),
    ports(p) {
      const s = num(p, "select", 1);
      const n = 2 ** s;
      const w = num(p, "bits", 1);
      const out: PortSpec[] = [port("in", "in", w, 0, n), port("sel", "in", s, 1, 2 * n)];
      for (let i = 0; i < n; i++) out.push(port(`out${i}`, "out", w, 3, 1 + 2 * i));
      return out;
    },
    evaluate([d, s], _st, p) {
      const n = 2 ** num(p, "select", 1);
      const sel = toNumber(s!);
      return Array.from({ length: n }, (_, i) =>
        sel === null ? unknown(d!.width) : i === sel ? d! : known(d!.width, 0),
      );
    },
  },
  {
    kind: "DECODER",
    name: "Decoder",
    category: "Plexers",
    description: "Sets exactly one of its outputs to 1: the one numbered by the input.",
    params: [{ key: "select", label: "Select bits", type: "int", default: 2, min: 1, max: 4 }],
    size: (p) => ({ w: 3, h: 2 * 2 ** num(p, "select", 2) }),
    ports(p) {
      const s = num(p, "select", 2);
      const n = 2 ** s;
      const out: PortSpec[] = [port("sel", "in", s, 0, n)];
      for (let i = 0; i < n; i++) out.push(port(`out${i}`, "out", 1, 3, 1 + 2 * i));
      return out;
    },
    evaluate([s], _st, p) {
      const n = 2 ** num(p, "select", 2);
      const sel = toNumber(s!);
      return Array.from({ length: n }, (_, i) => (sel === null ? unknown(1) : known(1, i === sel ? 1 : 0)));
    },
  },
  {
    kind: "ENCODER",
    name: "Priority encoder",
    category: "Plexers",
    description: "Outputs the number of the highest input that is 1, and whether any input is 1.",
    params: [{ key: "select", label: "Output bits", type: "int", default: 2, min: 1, max: 4 }],
    size: (p) => ({ w: 3, h: 2 * 2 ** num(p, "select", 2) }),
    ports(p) {
      const s = num(p, "select", 2);
      const n = 2 ** s;
      const out: PortSpec[] = [];
      for (let i = 0; i < n; i++) out.push(port(`in${i}`, "in", 1, 0, 1 + 2 * i));
      out.push(port("out", "out", s, 3, n - 1), port("any", "out", 1, 3, n + 1));
      return out;
    },
    evaluate(inputs, _st, p) {
      const s = num(p, "select", 2);
      for (let i = inputs.length - 1; i >= 0; i--) {
        const v = toNumber(inputs[i]!);
        if (v === null) return [unknown(s), unknown(1)];
        if (v === 1) return [known(s, i), known(1, 1)];
      }
      return [known(s, 0), known(1, 0)];
    },
  },

  // arithmetic
  {
    kind: "ADDER",
    name: "Adder",
    category: "Arithmetic",
    description: "Adds two numbers and a carry-in. The carry-out is the bit that did not fit.",
    params: [bits(8)],
    size: () => ({ w: 4, h: 6 }),
    ports: (p) => {
      const w = num(p, "bits", 8);
      return [
        port("a", "in", w, 0, 1),
        port("b", "in", w, 0, 3),
        port("cin", "in", 1, 0, 5),
        port("sum", "out", w, 4, 2),
        port("cout", "out", 1, 4, 4),
      ];
    },
    evaluate([a, b, c]) {
      const w = a!.width;
      const cin = c!.z === 1 ? sig(1, 0) : c!; // an unconnected carry-in counts as 0
      if (!allKnown(a!, b!, cin)) return [unknown(w), unknown(1)];
      const total = a!.v + b!.v + cin.v;
      return [known(w, total), known(1, total > mask(w) ? 1 : 0)];
    },
  },
  {
    kind: "SUBTRACTOR",
    name: "Subtractor",
    category: "Arithmetic",
    description: "Computes a minus b minus borrow-in. Borrow-out is 1 when the result went below zero.",
    params: [bits(8)],
    size: () => ({ w: 4, h: 6 }),
    ports: (p) => {
      const w = num(p, "bits", 8);
      return [
        port("a", "in", w, 0, 1),
        port("b", "in", w, 0, 3),
        port("bin", "in", 1, 0, 5),
        port("diff", "out", w, 4, 2),
        port("bout", "out", 1, 4, 4),
      ];
    },
    evaluate([a, b, c]) {
      const w = a!.width;
      const bin = c!.z === 1 ? sig(1, 0) : c!;
      if (!allKnown(a!, b!, bin)) return [unknown(w), unknown(1)];
      const d = a!.v - b!.v - bin.v;
      return [known(w, d < 0 ? d + 2 ** w : d), known(1, d < 0 ? 1 : 0)];
    },
  },
  {
    kind: "MULTIPLIER",
    name: "Multiplier",
    category: "Arithmetic",
    description: "Multiplies two unsigned numbers. The product is split into a low and a high half.",
    params: [bits(8)],
    size: () => ({ w: 4, h: 4 }),
    ports: (p) => {
      const w = num(p, "bits", 8);
      return [
        port("a", "in", w, 0, 1),
        port("b", "in", w, 0, 3),
        port("lo", "out", w, 4, 1),
        port("hi", "out", w, 4, 3),
      ];
    },
    evaluate([a, b]) {
      const w = a!.width;
      if (!allKnown(a!, b!)) return [unknown(w), unknown(w)];
      const prod = BigInt(a!.v) * BigInt(b!.v);
      const m = BigInt(mask(w));
      return [known(w, Number(prod & m)), known(w, Number((prod >> BigInt(w)) & m))];
    },
  },
  {
    kind: "COMPARATOR",
    name: "Comparator",
    category: "Arithmetic",
    description: "Compares two numbers: less than, equal, greater than.",
    params: [bits(8), { key: "signed", label: "Signed", type: "bool", default: false }],
    size: () => ({ w: 4, h: 4 }),
    ports: (p) => {
      const w = num(p, "bits", 8);
      return [
        port("a", "in", w, 0, 1),
        port("b", "in", w, 0, 3),
        port("lt", "out", 1, 4, 1),
        port("eq", "out", 1, 4, 2),
        port("gt", "out", 1, 4, 3),
      ];
    },
    evaluate([a, b], _s, p) {
      if (!allKnown(a!, b!)) return [unknown(1), unknown(1), unknown(1)];
      let x = a!.v;
      let y = b!.v;
      const w = a!.width;
      if (p["signed"] === true) {
        if (x & (1 << (w - 1))) x -= 2 ** w;
        if (y & (1 << (w - 1))) y -= 2 ** w;
      }
      return [known(1, x < y ? 1 : 0), known(1, x === y ? 1 : 0), known(1, x > y ? 1 : 0)];
    },
  },
  {
    kind: "SHIFTER",
    name: "Shifter",
    category: "Arithmetic",
    description: "Shifts or rotates bits left or right by a variable distance.",
    params: [
      bits(8),
      { key: "mode", label: "Mode", type: "select", default: "shl", options: ["shl", "shr", "sar", "rol", "ror"] },
    ],
    size: () => ({ w: 4, h: 4 }),
    ports: (p) => {
      const w = num(p, "bits", 8);
      const d = Math.max(1, Math.ceil(Math.log2(w)));
      return [port("in", "in", w, 0, 1), port("dist", "in", d, 0, 3), port("out", "out", w, 4, 2)];
    },
    evaluate([a, d], _s, p) {
      const w = a!.width;
      const dist = toNumber(d!);
      if (dist === null || !allKnown(a!)) return [unknown(w)];
      const v = a!.v;
      const n = dist % (w + 1);
      const m = mask(w);
      switch (str(p, "mode", "shl")) {
        case "shl":
          return [known(w, n >= 32 ? 0 : v << n)];
        case "shr":
          return [known(w, n >= 32 ? 0 : v >>> n)];
        case "sar": {
          const neg = (v >>> (w - 1)) & 1;
          const shifted = n >= w ? 0 : v >>> n;
          return [known(w, neg ? shifted | (m & ~(m >>> n)) : shifted)];
        }
        case "rol": {
          const k = dist % w;
          return [known(w, ((v << k) | (v >>> (w - k))) & m)];
        }
        default: {
          const k = dist % w;
          return [known(w, ((v >>> k) | (v << (w - k))) & m)];
        }
      }
    },
  },

  // memory
  {
    kind: "DFF",
    name: "D flip-flop",
    category: "Memory",
    description: "Stores D on the rising edge of the clock. Reset clears it at any time.",
    params: [labelParam],
    size: () => ({ w: 4, h: 4 }),
    ports: () => [
      port("d", "in", 1, 0, 1),
      port("clk", "in", 1, 0, 3),
      port("reset", "in", 1, 2, 4),
      port("q", "out", 1, 4, 1),
      port("nq", "out", 1, 4, 3),
    ],
    initState: () => ({ q: 0, last: null }),
    evaluate([d, clk, reset], s) {
      const edge = risingEdge(s, clk!);
      if (toNumber(reset!) === 1) s.q = 0;
      else if (edge) s.q = toNumber(d!) ?? -1;
      return s.q < 0 ? [unknown(1), unknown(1)] : [known(1, s.q), known(1, s.q ^ 1)];
    },
    sequential: true,
  },
  {
    kind: "TFF",
    name: "T flip-flop",
    category: "Memory",
    description: "Flips its state on the rising edge of the clock when T is 1.",
    params: [labelParam],
    size: () => ({ w: 4, h: 4 }),
    ports: () => [
      port("t", "in", 1, 0, 1),
      port("clk", "in", 1, 0, 3),
      port("reset", "in", 1, 2, 4),
      port("q", "out", 1, 4, 1),
      port("nq", "out", 1, 4, 3),
    ],
    initState: () => ({ q: 0, last: null }),
    evaluate([t, clk, reset], s) {
      const edge = risingEdge(s, clk!);
      if (toNumber(reset!) === 1) s.q = 0;
      else if (edge) {
        const tv = toNumber(t!);
        s.q = tv === null || s.q < 0 ? -1 : s.q ^ tv;
      }
      return s.q < 0 ? [unknown(1), unknown(1)] : [known(1, s.q), known(1, s.q ^ 1)];
    },
    sequential: true,
  },
  {
    kind: "JKFF",
    name: "JK flip-flop",
    category: "Memory",
    description: "On the rising edge: J sets, K resets, both together toggle.",
    params: [labelParam],
    size: () => ({ w: 4, h: 6 }),
    ports: () => [
      port("j", "in", 1, 0, 1),
      port("clk", "in", 1, 0, 3),
      port("k", "in", 1, 0, 5),
      port("reset", "in", 1, 2, 6),
      port("q", "out", 1, 4, 1),
      port("nq", "out", 1, 4, 5),
    ],
    initState: () => ({ q: 0, last: null }),
    evaluate([j, clk, k, reset], s) {
      const edge = risingEdge(s, clk!);
      if (toNumber(reset!) === 1) s.q = 0;
      else if (edge) {
        const jv = toNumber(j!);
        const kv = toNumber(k!);
        if (jv === null || kv === null || s.q < 0) s.q = -1;
        else if (jv && kv) s.q ^= 1;
        else if (jv) s.q = 1;
        else if (kv) s.q = 0;
      }
      return s.q < 0 ? [unknown(1), unknown(1)] : [known(1, s.q), known(1, s.q ^ 1)];
    },
    sequential: true,
  },
  {
    kind: "REGISTER",
    name: "Register",
    category: "Memory",
    description: "Stores a multi-bit value on the rising edge of the clock while enable is 1 (or unconnected).",
    params: [bits(8), labelParam],
    size: () => ({ w: 4, h: 6 }),
    ports: (p) => {
      const w = num(p, "bits", 8);
      return [
        port("d", "in", w, 0, 1),
        port("clk", "in", 1, 0, 3),
        port("en", "in", 1, 0, 5),
        port("reset", "in", 1, 2, 6),
        port("q", "out", w, 4, 3),
      ];
    },
    initState: () => ({ q: 0, qx: 0, last: null }),
    evaluate([d, clk, en, reset], s, p) {
      const w = num(p, "bits", 8);
      const edge = risingEdge(s, clk!);
      const enabled = en!.z === 1 ? 1 : toNumber(en!);
      if (toNumber(reset!) === 1) {
        s.q = 0;
        s.qx = 0;
      } else if (edge && enabled === 1) {
        s.q = d!.v;
        s.qx = d!.x | d!.z;
      } else if (edge && enabled === null) s.qx = mask(w);
      return [sig(w, s.q, s.qx)];
    },
    sequential: true,
  },
  {
    kind: "COUNTER",
    name: "Counter",
    category: "Memory",
    description:
      "Counts up by one on each rising clock edge while enabled. Carry is 1 on the last value before wrapping.",
    params: [bits(4), labelParam],
    size: () => ({ w: 4, h: 6 }),
    ports: (p) => {
      const w = num(p, "bits", 4);
      return [
        port("clk", "in", 1, 0, 1),
        port("en", "in", 1, 0, 3),
        port("reset", "in", 1, 0, 5),
        port("q", "out", w, 4, 2),
        port("carry", "out", 1, 4, 4),
      ];
    },
    initState: () => ({ q: 0, last: null }),
    evaluate([clk, en, reset], s, p) {
      const w = num(p, "bits", 4);
      const edge = risingEdge(s, clk!);
      const enabled = en!.z === 1 ? 1 : toNumber(en!);
      if (toNumber(reset!) === 1) s.q = 0;
      else if (edge && enabled === 1) s.q = (s.q + 1) & mask(w);
      return [known(w, s.q), known(1, s.q === mask(w) && enabled === 1 ? 1 : 0)];
    },
    sequential: true,
  },
  {
    kind: "RAM",
    name: "RAM",
    category: "Memory",
    description: "Read at any time from the address. Writes data on the rising clock edge while write-enable is 1.",
    params: [{ key: "addrBits", label: "Address bits", type: "int", default: 4, min: 1, max: 16 }, bits(8), labelParam],
    size: () => ({ w: 6, h: 8 }),
    ports: (p) => {
      const a = num(p, "addrBits", 4);
      const w = num(p, "bits", 8);
      return [
        port("addr", "in", a, 0, 1),
        port("din", "in", w, 0, 3),
        port("we", "in", 1, 0, 5),
        port("clk", "in", 1, 0, 7),
        port("dout", "out", w, 6, 4),
      ];
    },
    initState: (p) => ({
      mem: new Uint32Array(2 ** num(p, "addrBits", 4)),
      unk: new Uint8Array(2 ** num(p, "addrBits", 4)),
      last: null,
    }),
    evaluate([addr, din, we, clk], s, p) {
      const w = num(p, "bits", 8);
      const edge = risingEdge(s, clk!);
      const a = toNumber(addr!);
      if (edge && toNumber(we!) === 1 && a !== null) {
        s.mem[a] = din!.v;
        s.unk[a] = din!.x | din!.z ? 1 : 0;
      }
      if (a === null) return [unknown(w)];
      return [s.unk[a] ? unknown(w) : known(w, s.mem[a])];
    },
    sequential: true,
  },
  {
    kind: "ROM",
    name: "ROM",
    category: "Memory",
    description: "Read-only memory: outputs the stored word at the address. Edit its contents in the properties.",
    params: [
      { key: "addrBits", label: "Address bits", type: "int", default: 4, min: 1, max: 16 },
      bits(8),
      { key: "contents", label: "Contents (hex)", type: "list", default: [] },
      labelParam,
    ],
    size: () => ({ w: 6, h: 4 }),
    ports: (p) => [port("addr", "in", num(p, "addrBits", 4), 0, 2), port("dout", "out", num(p, "bits", 8), 6, 2)],
    evaluate([addr], _s, p) {
      const w = num(p, "bits", 8);
      const a = toNumber(addr!);
      if (a === null) return [unknown(w)];
      return [known(w, list(p, "contents")[a] ?? 0)];
    },
  },

  // hierarchy and decoration
  {
    kind: "SUBCIRCUIT",
    name: "Subcircuit",
    category: "Circuits",
    description: "Another circuit of this project, used as one part. Its input and output pins become its ports.",
    params: [{ key: "circuit", label: "Circuit", type: "text", default: "" }],
    size(p, lib) {
      const pins = lib.subcircuitPins(str(p, "circuit", ""));
      const n = pins ? Math.max(pins.inputs.length, pins.outputs.length, 1) : 1;
      return { w: 6, h: 2 * n + 2 };
    },
    ports(p, lib) {
      const pins = lib.subcircuitPins(str(p, "circuit", ""));
      if (!pins) return [];
      const out: PortSpec[] = [];
      pins.inputs.forEach((pin, i) => out.push(port(pin.label || `in${i}`, "in", pin.width, 0, 2 + 2 * i)));
      pins.outputs.forEach((pin, i) => out.push(port(pin.label || `out${i}`, "out", pin.width, 6, 2 + 2 * i)));
      return out;
    },
    evaluate: () => [],
  },
  {
    kind: "TEXT",
    name: "Text",
    category: "Circuits",
    description: "A note on the canvas.",
    params: [{ key: "text", label: "Text", type: "text", default: "note" }],
    size: (p) => ({ w: Math.max(2, Math.ceil(str(p, "text", "note").length * 0.8)), h: 2 }),
    ports: () => [],
    evaluate: () => [],
  },
];

function probeChars(p: Params): number {
  const w = num(p, "bits", 1);
  const radix = str(p, "radix", "dec") as Radix;
  if (w === 1 || radix === "bin") return w;
  if (radix === "hex") return Math.ceil(w / 4);
  return String(2 ** w - 1).length + (radix === "sdec" ? 1 : 0);
}

export const COMPONENTS: ReadonlyMap<string, ComponentDef> = new Map(defs.map((d) => [d.kind, d]));
export const CATEGORIES = [
  "Gates",
  "Inputs",
  "Outputs",
  "Wiring",
  "Plexers",
  "Arithmetic",
  "Memory",
  "Circuits",
] as const;

export function getDef(kind: string): ComponentDef {
  const d = COMPONENTS.get(kind);
  if (!d) throw new Error(`unknown component kind: ${kind}`);
  return d;
}

/** Fill in missing parameters with their defaults and clamp numbers into range. */
export function normalizeParams(def: ComponentDef, params: Params): Params {
  const out: Params = {};
  for (const spec of def.params) {
    let v = params[spec.key] ?? spec.default;
    if (spec.type === "int") {
      let n = typeof v === "number" ? Math.round(v) : Number(v);
      if (!Number.isFinite(n)) n = spec.default as number;
      if (spec.min !== undefined) n = Math.max(spec.min, n);
      if (spec.max !== undefined) n = Math.min(spec.max, n);
      v = n;
    } else if (spec.type === "select" && (typeof v !== "string" || !spec.options?.includes(v))) v = spec.default;
    else if (spec.type === "bool") v = v === true;
    out[spec.key] = v;
  }
  return out;
}
