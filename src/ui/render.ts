/**
 * Drawing circuits on a canvas: grid, wires coloured by their live value, gate shapes, displays and ports.
 */

import { getDef, normalizeParams, num, str } from "../core/components.js";
import {
  boxOf,
  portsOf,
  type Circuit,
  type ComponentInstance,
  type Facing,
  type Netlist,
  type Wire,
} from "../core/circuit.js";
import { format, toNumber, type Radix, type Signal } from "../core/signal.js";
import type { Simulator } from "../core/simulator.js";
import type { Library } from "../core/components.js";

export const COLORS = {
  bg: "#0a0a0f",
  grid: "#16161f",
  gridMajor: "#1d1d29",
  body: "#15151d",
  bodyEdge: "#3b3b4f",
  text: "#d4d4dc",
  dim: "#7a7a8c",
  one: "#c084fc",
  zero: "#4b3f6b",
  unknown: "#f87171",
  floating: "#5b6b82",
  bus: "#a78bfa",
  select: "#e9d5ff",
  error: "#fb7185",
  accent: "#8b5cf6",
};

export interface View {
  x: number; // grid coordinate at the canvas origin
  y: number;
  scale: number; // pixels per grid unit
}

export interface DrawState {
  circuit: Circuit;
  lib: Library;
  netlist: Netlist | null;
  sim: Simulator | null;
  selected: Set<string>; // component ids and "w:<index>" for wires
  hoverPort: [number, number] | null;
  preview: Wire[]; // wire being drawn
  ghost: ComponentInstance | null; // component being placed
  rubber: { x1: number; y1: number; x2: number; y2: number } | null;
  errorPoints: Set<string>;
}

export function signalColor(s: Signal | undefined): string {
  if (!s) return COLORS.floating;
  if (s.z && s.z === (2 ** s.width - 1) >>> 0) return COLORS.floating;
  if (s.x || s.z) return COLORS.unknown;
  if (s.width > 1) return COLORS.bus;
  return s.v ? COLORS.one : COLORS.zero;
}

function transformFor(ctx: CanvasRenderingContext2D, view: View, c: ComponentInstance, w: number, h: number): void {
  const s = view.scale;
  const ox = (c.x - view.x) * s;
  const oy = (c.y - view.y) * s;
  const m: Record<Facing, [number, number, number, number, number, number]> = {
    E: [1, 0, 0, 1, 0, 0],
    S: [0, 1, -1, 0, h, 0],
    W: [-1, 0, 0, -1, w, h],
    N: [0, -1, 1, 0, 0, w],
  };
  const [a, b, cc, d, e, f] = m[c.facing];
  ctx.setTransform(a * s, b * s, cc * s, d * s, ox + e * s, oy + f * s);
}

export function draw(ctx: CanvasRenderingContext2D, width: number, height: number, view: View, st: DrawState): void {
  const s = view.scale;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, width, height);
  // grid dots
  const x0 = Math.floor(view.x);
  const y0 = Math.floor(view.y);
  const cols = Math.ceil(width / s) + 1;
  const rows = Math.ceil(height / s) + 1;
  if (s >= 6) {
    for (let gy = 0; gy <= rows; gy++) {
      for (let gx = 0; gx <= cols; gx++) {
        const X = x0 + gx;
        const Y = y0 + gy;
        ctx.fillStyle = X % 10 === 0 && Y % 10 === 0 ? "#2a2a3a" : COLORS.grid;
        const r = X % 10 === 0 && Y % 10 === 0 ? 1.6 : 1;
        ctx.fillRect((X - view.x) * s - r / 2, (Y - view.y) * s - r / 2, r, r);
      }
    }
  }
  const px = (gx: number) => (gx - view.x) * s;
  const py = (gy: number) => (gy - view.y) * s;
  const valueAt = (key: string): Signal | undefined => {
    if (!st.netlist || !st.sim) return undefined;
    const n = st.netlist.pointNet.get(key);
    return n === undefined ? undefined : st.sim.values[n];
  };
  // wires
  ctx.lineCap = "round";
  const endCount = new Map<string, number>();
  st.circuit.wires.forEach((w, i) => {
    const v = valueAt(`${w.x1},${w.y1}`);
    const wide = v ? v.width > 1 : false;
    const selected = st.selected.has(`w:${i}`);
    ctx.strokeStyle = selected ? COLORS.select : signalColor(v);
    ctx.lineWidth = Math.max(1.5, s * (wide ? 0.32 : 0.18));
    if (v && v.width === 1 && v.v && !v.x && !v.z) {
      ctx.shadowColor = COLORS.one;
      ctx.shadowBlur = s * 0.6;
    }
    ctx.beginPath();
    ctx.moveTo(px(w.x1), py(w.y1));
    ctx.lineTo(px(w.x2), py(w.y2));
    ctx.stroke();
    ctx.shadowBlur = 0;
    for (const k of [`${w.x1},${w.y1}`, `${w.x2},${w.y2}`]) endCount.set(k, (endCount.get(k) ?? 0) + 1);
  });
  // junction dots where three or more things meet, or where a wire ends on another wire
  for (const [k, count] of endCount) {
    const [gx, gy] = k.split(",").map(Number) as [number, number];
    const onMiddle = st.circuit.wires.some((w) => onInterior(gx, gy, w));
    if (count >= 3 || onMiddle) {
      ctx.fillStyle = signalColor(valueAt(k));
      ctx.beginPath();
      ctx.arc(px(gx), py(gy), Math.max(2.5, s * 0.28), 0, Math.PI * 2);
      ctx.fill();
    }
  }
  // bus values on wide wires
  if (st.sim && st.netlist && s >= 8) {
    ctx.font = `${Math.max(9, s * 0.75)}px "JetBrains Mono", ui-monospace, monospace`;
    ctx.textBaseline = "bottom";
    const labelled = new Set<number>();
    st.circuit.wires.forEach((w) => {
      const n = st.netlist!.pointNet.get(`${w.x1},${w.y1}`);
      if (n === undefined || labelled.has(n)) return;
      const v = st.sim!.values[n]!;
      if (v.width === 1 || Math.abs(w.x2 - w.x1) < 3) return;
      labelled.add(n);
      ctx.fillStyle = COLORS.dim;
      ctx.fillText(format(v, "hex"), px(Math.min(w.x1, w.x2)) + s * 0.6, py(w.y1) - s * 0.2);
    });
  }
  // components
  for (const c of st.circuit.components) drawComponent(ctx, view, c, st, false);
  if (st.ghost) drawComponent(ctx, view, st.ghost, st, true);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // wire preview
  if (st.preview.length) {
    ctx.strokeStyle = COLORS.select;
    ctx.setLineDash([s * 0.4, s * 0.3]);
    ctx.lineWidth = Math.max(1.5, s * 0.18);
    ctx.beginPath();
    for (const w of st.preview) {
      ctx.moveTo(px(w.x1), py(w.y1));
      ctx.lineTo(px(w.x2), py(w.y2));
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }
  if (st.hoverPort) {
    ctx.strokeStyle = COLORS.select;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(px(st.hoverPort[0]), py(st.hoverPort[1]), Math.max(4, s * 0.45), 0, Math.PI * 2);
    ctx.stroke();
  }
  for (const k of st.errorPoints) {
    const [gx, gy] = k.split(",").map(Number) as [number, number];
    ctx.strokeStyle = COLORS.error;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(px(gx), py(gy), Math.max(6, s * 0.7), 0, Math.PI * 2);
    ctx.stroke();
  }
  if (st.rubber) {
    const r = st.rubber;
    ctx.fillStyle = "rgba(139, 92, 246, 0.08)";
    ctx.strokeStyle = "rgba(167, 139, 250, 0.6)";
    ctx.lineWidth = 1;
    const rx = px(Math.min(r.x1, r.x2));
    const ry = py(Math.min(r.y1, r.y2));
    ctx.fillRect(rx, ry, Math.abs(r.x2 - r.x1) * s, Math.abs(r.y2 - r.y1) * s);
    ctx.strokeRect(rx, ry, Math.abs(r.x2 - r.x1) * s, Math.abs(r.y2 - r.y1) * s);
  }
}

function onInterior(x: number, y: number, w: Wire): boolean {
  if (w.x1 === w.x2) return x === w.x1 && y > Math.min(w.y1, w.y2) && y < Math.max(w.y1, w.y2);
  return y === w.y1 && x > Math.min(w.x1, w.x2) && x < Math.max(w.x1, w.x2);
}

function componentIndex(st: DrawState, id: string): number {
  if (!st.netlist) return -1;
  return st.netlist.components.findIndex((c) => c.top && c.instance.id === id);
}

function drawComponent(
  ctx: CanvasRenderingContext2D,
  view: View,
  c: ComponentInstance,
  st: DrawState,
  ghost: boolean,
): void {
  const def = getDef(c.kind);
  const p = normalizeParams(def, c.params);
  const { w, h } = def.size(p, st.lib);
  const s = view.scale;
  const selected = st.selected.has(c.id);
  const idx = ghost ? -1 : componentIndex(st, c.id);
  const sim = st.sim;
  const portNets = st.netlist?.portNets.get(c.id);
  const portValue = (i: number): Signal | undefined =>
    sim && portNets && portNets[i] !== undefined ? sim.values[portNets[i]!] : undefined;
  ctx.globalAlpha = ghost ? 0.55 : 1;
  transformFor(ctx, view, c, w, h);
  const line = 1 / s;
  ctx.lineWidth = 1.6 * line;
  ctx.strokeStyle = selected ? COLORS.select : COLORS.bodyEdge;
  ctx.fillStyle = COLORS.body;
  const kind = c.kind;
  const gateBody = () => {
    ctx.fill();
    ctx.stroke();
  };
  if (["AND", "NAND", "OR", "NOR", "XOR", "XNOR"].includes(kind)) {
    const n = num(p, "inputs", 2);
    const H = 2 * n;
    const bubble = kind === "NAND" || kind === "NOR" || kind === "XNOR";
    const bw = bubble ? 3.3 : 4;
    ctx.beginPath();
    if (kind.endsWith("AND")) {
      const ry = (H - 0.4) / 2;
      const rx = Math.min(ry, bw - 1.2);
      const xs = bw - rx;
      ctx.moveTo(0.4, 0.2);
      ctx.lineTo(xs, 0.2);
      ctx.ellipse(xs, H / 2, rx, ry, 0, -Math.PI / 2, Math.PI / 2);
      ctx.lineTo(0.4, H - 0.2);
      ctx.closePath();
    } else {
      ctx.moveTo(0.3, 0.2);
      ctx.quadraticCurveTo(bw * 0.65, 0.2, bw, H / 2);
      ctx.quadraticCurveTo(bw * 0.65, H - 0.2, 0.3, H - 0.2);
      ctx.quadraticCurveTo(1.3, H / 2, 0.3, 0.2);
      ctx.closePath();
    }
    gateBody();
    if (kind.startsWith("X")) {
      ctx.beginPath();
      ctx.moveTo(-0.15, 0.2);
      ctx.quadraticCurveTo(0.85, H / 2, -0.15, H - 0.2);
      ctx.stroke();
    }
    if (bubble) {
      ctx.beginPath();
      ctx.arc(bw + 0.33, H / 2, 0.33, 0, Math.PI * 2);
      gateBody();
    }
    // input stubs
    ctx.beginPath();
    for (let i = 0; i < n; i++) {
      ctx.moveTo(0, 1 + 2 * i);
      ctx.lineTo(kind.endsWith("AND") ? 0.4 : 0.6, 1 + 2 * i);
    }
    ctx.stroke();
  } else if (kind === "NOT" || kind === "BUFFER" || kind === "TRISTATE") {
    ctx.beginPath();
    ctx.moveTo(0.3, 0.15);
    ctx.lineTo(kind === "NOT" ? 2.2 : 2.7, 1);
    ctx.lineTo(0.3, 1.85);
    ctx.closePath();
    gateBody();
    if (kind === "NOT") {
      ctx.beginPath();
      ctx.arc(2.5, 1, 0.3, 0, Math.PI * 2);
      gateBody();
    }
  } else if (kind === "TUNNEL") {
    ctx.beginPath();
    ctx.moveTo(0, 1);
    ctx.lineTo(0.8, 0.2);
    ctx.lineTo(w, 0.2);
    ctx.lineTo(w, 1.8);
    ctx.lineTo(0.8, 1.8);
    ctx.closePath();
    ctx.fillStyle = "#1a1626";
    ctx.strokeStyle = selected ? COLORS.select : signalColor(portValue(0));
    gateBody();
  } else if (kind === "SPLITTER" || kind === "MERGER") {
    ctx.strokeStyle = selected ? COLORS.select : COLORS.bus;
    ctx.lineWidth = 3 * line;
    ctx.beginPath();
    ctx.moveTo(1, 0.6);
    ctx.lineTo(1, h - 0.6);
    ctx.stroke();
    ctx.lineWidth = 1.2 * line;
    ctx.beginPath();
    const n = num(p, "bits", 8);
    for (let i = 0; i < n; i++) {
      const x = kind === "SPLITTER" ? 2 : 0;
      ctx.moveTo(1, 1 + 2 * i);
      ctx.lineTo(x, 1 + 2 * i);
    }
    const busX = kind === "SPLITTER" ? 0 : 2;
    ctx.moveTo(1, n);
    ctx.lineTo(busX, n);
    ctx.stroke();
  } else if (kind === "TEXT") {
    // drawn upright below
  } else if (kind === "LED" || kind === "SWITCH" || kind === "BUTTON") {
    // drawn upright below
  } else {
    roundRect(ctx, 0.15, 0.15, w - 0.3, h - 0.3, 0.35);
    gateBody();
    if (kind === "MUX" || kind === "DEMUX") {
      ctx.fillStyle = COLORS.dim;
    }
  }
  // ports
  if (!ghost) {
    const ports = def.ports(p, st.lib);
    ports.forEach((port, i) => {
      if (kind === "TEXT") return;
      ctx.fillStyle = signalColor(portValue(i));
      ctx.beginPath();
      ctx.arc(port.x, port.y, port.width > 1 ? 0.24 : 0.18, 0, Math.PI * 2);
      ctx.fill();
    });
  }
  // upright text and live displays
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const box = boxOf(c, st.lib);
  const bx = (box.x - view.x) * s;
  const by = (box.y - view.y) * s;
  const bw = box.w * s;
  const bh = box.h * s;
  const cx = bx + bw / 2;
  const cy = by + bh / 2;
  const font = (size: number, weight = 500) =>
    `${weight} ${Math.max(7, size * s)}px "JetBrains Mono", ui-monospace, monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  const label = str(p, "label", "");
  const state = idx >= 0 && sim ? (sim.states[idx] as Record<string, number>) : null;
  const inValue = portValue(0);
  switch (kind) {
    case "SWITCH": {
      const on = state ? state["value"] === 1 : num(p, "value", 0) === 1;
      ctx.fillStyle = on ? COLORS.accent : "#26263a";
      roundRectPx(ctx, bx + 0.25 * s, by + 0.45 * s, bw - 0.5 * s, bh - 0.9 * s, 0.55 * s);
      ctx.fill();
      ctx.strokeStyle = selected ? COLORS.select : COLORS.bodyEdge;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.fillStyle = "#f4f0ff";
      ctx.beginPath();
      ctx.arc(on ? bx + bw - 0.75 * s : bx + 0.75 * s, cy, 0.38 * s, 0, Math.PI * 2);
      ctx.fill();
      break;
    }
    case "BUTTON": {
      const on = state?.["value"] === 1;
      ctx.fillStyle = on ? COLORS.accent : "#26263a";
      ctx.strokeStyle = selected ? COLORS.select : COLORS.bodyEdge;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(cx, cy, 0.8 * s, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      break;
    }
    case "LED": {
      const v = inValue ? toNumber(inValue) : null;
      const colors: Record<string, string> = {
        violet: "#c084fc",
        red: "#f87171",
        green: "#4ade80",
        amber: "#fbbf24",
        blue: "#60a5fa",
      };
      const color = colors[str(p, "color", "violet")] ?? "#c084fc";
      ctx.beginPath();
      ctx.arc(cx, cy, 0.8 * s, 0, Math.PI * 2);
      if (v === 1) {
        ctx.shadowColor = color;
        ctx.shadowBlur = 1.4 * s;
        ctx.fillStyle = color;
      } else ctx.fillStyle = v === null && inValue && inValue.x ? "#3a1c22" : "#1d1a26";
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.strokeStyle = selected ? COLORS.select : COLORS.bodyEdge;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      break;
    }
    case "INPUT":
    case "OUTPUT":
    case "PROBE":
    case "CONSTANT": {
      let text: string;
      if (kind === "INPUT")
        text = format(
          { width: num(p, "bits", 1), v: state ? (state["value"] ?? 0) >>> 0 : num(p, "value", 0), x: 0, z: 0 },
          "hex",
        );
      else if (kind === "CONSTANT")
        text = format({ width: num(p, "bits", 1), v: num(p, "value", 1), x: 0, z: 0 }, "hex");
      else text = inValue ? format(inValue, str(p, "radix", kind === "PROBE" ? "dec" : "hex") as Radix) : "?";
      if (text.length > 6 && bw < text.length * 0.62 * s) text = text.slice(0, 5) + "…";
      ctx.fillStyle = kind === "INPUT" ? COLORS.one : kind === "CONSTANT" ? COLORS.dim : COLORS.text;
      ctx.font = font(0.95, 600);
      ctx.fillText(text, cx, cy);
      break;
    }
    case "CLOCK": {
      const on = state?.["value"] === 1;
      ctx.strokeStyle = on ? COLORS.one : COLORS.dim;
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      const l = bx + 0.6 * s;
      const r = bx + bw - 0.6 * s;
      const t = by + 0.6 * s;
      const b = by + bh - 0.6 * s;
      const q = (r - l) / 4;
      ctx.moveTo(l, b);
      ctx.lineTo(l + q, b);
      ctx.lineTo(l + q, t);
      ctx.lineTo(l + 2 * q, t);
      ctx.lineTo(l + 2 * q, b);
      ctx.lineTo(l + 3 * q, b);
      ctx.lineTo(l + 3 * q, t);
      ctx.lineTo(r, t);
      ctx.stroke();
      break;
    }
    case "HEX":
    case "SEVENSEG": {
      let segs = 0;
      const v = inValue ? toNumber(inValue) : null;
      if (v !== null) segs = kind === "HEX" ? HEX_SEGMENTS[v & 15]! : v;
      drawSegments(ctx, bx + 0.7 * s, by + 0.6 * s, bw - 1.4 * s, bh - 1.2 * s, segs, v === null);
      break;
    }
    case "TUNNEL": {
      ctx.fillStyle = COLORS.text;
      ctx.font = font(0.85, 500);
      const tx = c.facing === "W" ? bx + bw / 2 - 0.3 * s : c.facing === "E" ? bx + bw / 2 + 0.3 * s : cx;
      if (c.facing === "N" || c.facing === "S") {
        ctx.save();
        ctx.translate(cx, cy);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText(label, 0, 0);
        ctx.restore();
      } else ctx.fillText(label, tx, cy);
      break;
    }
    case "TEXT": {
      ctx.fillStyle = COLORS.dim;
      ctx.textAlign = "left";
      ctx.font = `${Math.max(8, 0.95 * s)}px Inter, system-ui, sans-serif`;
      ctx.fillText(str(p, "text", ""), bx, cy);
      if (selected) {
        ctx.strokeStyle = COLORS.select;
        ctx.strokeRect(bx - 2, by, bw + 4, bh);
      }
      break;
    }
    case "SPLITTER":
    case "MERGER":
      break;
    default: {
      if (["AND", "OR", "NAND", "NOR", "XOR", "XNOR", "NOT", "BUFFER", "TRISTATE"].includes(kind)) break;
      const title = SHORT[kind] ?? def.name;
      ctx.fillStyle = COLORS.text;
      ctx.font = font(0.8, 600);
      ctx.fillText(title, cx, by + Math.min(bh / 2, 1.2 * s));
      if (kind === "SUBCIRCUIT") {
        ctx.fillStyle = COLORS.dim;
        ctx.font = font(0.65);
        ctx.fillText(str(p, "circuit", ""), cx, by + 2.1 * s);
      }
      if (state && "q" in state && typeof state["q"] === "number" && s >= 8 && kind !== "RAM") {
        const width = num(p, "bits", 1);
        ctx.fillStyle = COLORS.one;
        ctx.font = font(0.85, 600);
        ctx.fillText(
          state["q"] < 0 ? "X" : format({ width, v: state["q"] >>> 0, x: 0, z: 0 }, width > 1 ? "hex" : "bin"),
          cx,
          cy + 0.6 * s,
        );
      }
      // port names on larger parts
      if (s >= 11 && box.w >= 5 && box.h >= 4 && !["MUX", "DEMUX", "DECODER", "ENCODER"].includes(kind)) {
        ctx.font = font(0.55);
        ctx.fillStyle = COLORS.dim;
        for (const port of portsOf(c, st.lib)) {
          const lx = (port.ax - view.x) * s;
          const ly = (port.ay - view.y) * s;
          const inside = port.ax === box.x ? 0.9 : port.ax === box.x + box.w ? -0.9 : 0;
          const vy = port.ay === box.y + box.h ? -0.7 : port.ay === box.y ? 0.7 : 0;
          if (inside === 0 && vy === 0) continue;
          ctx.textAlign = inside > 0 ? "left" : inside < 0 ? "right" : "center";
          ctx.fillText(port.name, lx + inside * s * 0.45, ly + vy * s);
        }
        ctx.textAlign = "center";
      }
    }
  }
  if (label && !["TUNNEL", "TEXT"].includes(kind)) {
    ctx.fillStyle = COLORS.dim;
    ctx.font = font(0.7, 500);
    ctx.textBaseline = "bottom";
    ctx.fillText(label, cx, by - 0.1 * s);
  }
  if (selected && !["TEXT"].includes(kind)) {
    ctx.strokeStyle = "rgba(233, 213, 255, 0.35)";
    ctx.setLineDash([4, 3]);
    ctx.lineWidth = 1;
    ctx.strokeRect(bx - 3, by - 3, bw + 6, bh + 6);
    ctx.setLineDash([]);
  }
  ctx.globalAlpha = 1;
}

const SHORT: Record<string, string> = {
  ADDER: "+",
  SUBTRACTOR: "−",
  MULTIPLIER: "×",
  COMPARATOR: "cmp",
  SHIFTER: "shift",
  MUX: "MUX",
  DEMUX: "DMX",
  DECODER: "DEC",
  ENCODER: "PRI",
  REGISTER: "REG",
  COUNTER: "CTR",
  RAM: "RAM",
  ROM: "ROM",
  DFF: "D",
  TFF: "T",
  JKFF: "JK",
  EXTEND: "ext",
  SUBCIRCUIT: "▣",
};

export const HEX_SEGMENTS = [
  0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07, 0x7f, 0x6f, 0x77, 0x7c, 0x39, 0x5e, 0x79, 0x71,
];

function drawSegments(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  segs: number,
  unknownValue: boolean,
): void {
  const t = Math.max(2, w * 0.14);
  const half = h / 2;
  const seg = (i: number, x1: number, y1: number, x2: number, y2: number) => {
    const on = (segs >> i) & 1;
    ctx.strokeStyle = unknownValue ? "#3a1c22" : on ? COLORS.one : "#221d30";
    ctx.shadowColor = COLORS.one;
    ctx.shadowBlur = on && !unknownValue ? t * 1.5 : 0;
    ctx.lineWidth = t;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();
  };
  const g = t * 0.9;
  seg(0, x + g, y, x + w - g, y);
  seg(1, x + w, y + g, x + w, y + half - g);
  seg(2, x + w, y + half + g, x + w, y + h - g);
  seg(3, x + g, y + h, x + w - g, y + h);
  seg(4, x, y + half + g, x, y + h - g);
  seg(5, x, y + g, x, y + half - g);
  seg(6, x + g, y + half, x + w - g, y + half);
  ctx.shadowBlur = 0;
  const dp = (segs >> 7) & 1;
  ctx.fillStyle = dp ? COLORS.one : "#221d30";
  ctx.beginPath();
  ctx.arc(x + w + t * 1.2, y + h, t * 0.5, 0, Math.PI * 2);
  ctx.fill();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function roundRectPx(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  roundRect(ctx, x, y, w, h, Math.min(r, h / 2));
}

/** Draw a timing diagram: one row per signal, newest sample on the right. */
export function drawTiming(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  rows: { label: string; samples: Signal[] }[],
  capacity: number,
  dpr = 1,
): void {
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  width /= dpr;
  height /= dpr;
  ctx.fillStyle = "#0c0c12";
  ctx.fillRect(0, 0, width, height);
  if (!rows.length) {
    ctx.fillStyle = COLORS.dim;
    ctx.font = "13px Inter, system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(
      "Label input pins, output pins, probes or LEDs to see them here. Run or step the clock.",
      width / 2,
      height / 2,
    );
    return;
  }
  const labelW = 110;
  const rowH = Math.min(34, Math.max(20, (height - 8) / rows.length));
  const step = (width - labelW - 10) / capacity;
  ctx.font = `12px "JetBrains Mono", ui-monospace, monospace`;
  rows.forEach((row, r) => {
    const top = 4 + r * rowH;
    const lo = top + rowH - 6;
    const hi = top + 6;
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText(row.label.slice(0, 13), 8, top + rowH / 2);
    ctx.strokeStyle = "#1c1c28";
    ctx.beginPath();
    ctx.moveTo(labelW, top + rowH - 1);
    ctx.lineTo(width, top + rowH - 1);
    ctx.stroke();
    const n = row.samples.length;
    const start = labelW + (capacity - n) * step;
    ctx.lineWidth = 1.6;
    for (let i = 0; i < n; i++) {
      const v = row.samples[i]!;
      const x1 = start + i * step;
      const x2 = x1 + step;
      const prev = row.samples[i - 1];
      if (v.width === 1) {
        const known1 = toNumber(v);
        ctx.strokeStyle = signalColor(v);
        ctx.beginPath();
        const y = known1 === 1 ? hi : known1 === 0 ? lo : (hi + lo) / 2;
        if (prev && toNumber(prev) !== known1) {
          const py = toNumber(prev) === 1 ? hi : toNumber(prev) === 0 ? lo : (hi + lo) / 2;
          ctx.moveTo(x1, py);
          ctx.lineTo(x1, y);
        } else ctx.moveTo(x1, y);
        ctx.lineTo(x2, y);
        ctx.stroke();
      } else {
        const changed = !prev || prev.v !== v.v || prev.x !== v.x || prev.z !== v.z;
        ctx.strokeStyle = signalColor(v);
        ctx.beginPath();
        if (changed) {
          ctx.moveTo(x1, (hi + lo) / 2);
          ctx.lineTo(x1 + 3, hi);
          ctx.moveTo(x1, (hi + lo) / 2);
          ctx.lineTo(x1 + 3, lo);
          ctx.moveTo(x1 + 3, hi);
        } else ctx.moveTo(x1, hi);
        ctx.lineTo(x2, hi);
        ctx.moveTo(changed ? x1 + 3 : x1, lo);
        ctx.lineTo(x2, lo);
        ctx.stroke();
        if (changed) {
          let run = 1;
          while (i + run < n && sameSignal(row.samples[i + run]!, v)) run++;
          if (run * step > 22) {
            ctx.fillStyle = COLORS.text;
            ctx.textAlign = "left";
            ctx.fillText(format(v, "hex"), x1 + 6, (hi + lo) / 2);
          }
        }
      }
    }
  });
}

function sameSignal(a: Signal, b: Signal): boolean {
  return a.v === b.v && a.x === b.x && a.z === b.z;
}
