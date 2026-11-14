/**
 * The Silica editor: palette, canvas, properties, simulation controls and analysis panels.
 */

import { synthesize, simplify, truthTable, minimize, formatSop } from "../core/analysis.js";
import {
  boxOf,
  buildNetlist,
  cleanWires,
  emptyProject,
  findCircuit,
  nextId,
  portsOf,
  projectLibrary,
  type Circuit,
  type ComponentInstance,
  type Facing,
  type Netlist,
  type Project,
  type Wire,
} from "../core/circuit.js";
import {
  CATEGORIES,
  COMPONENTS,
  getDef,
  normalizeParams,
  type ParamSpec,
  type ParamValue,
} from "../core/components.js";
import { EXAMPLES } from "../core/examples.js";
import { decodeShare, encodeShare, fromJSON, toJSON } from "../core/serialize.js";
import { format, type Signal } from "../core/signal.js";
import { Simulator } from "../core/simulator.js";
import { draw, drawTiming, type DrawState, type View } from "./render.js";

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el as T;
};

const canvas = $<HTMLCanvasElement>("canvas");
const ctx = canvas.getContext("2d")!;
const timingCanvas = $<HTMLCanvasElement>("timing");
const tctx = timingCanvas.getContext("2d")!;
const SPEEDS = [1, 2, 4, 8, 16, 32, 64, 256];
const TIMING_CAPACITY = 120;
const FACINGS: Facing[] = ["E", "S", "W", "N"];

// ------------------------------------------------------------------ state

let project: Project = emptyProject();
let current = project.main;
const views = new Map<string, View>();
let netlist: Netlist | null = null;
let sim: Simulator | null = null;
let selected = new Set<string>();
let placing: ComponentInstance | null = null;
let running = false;
let speed = 3;
let tickDebt = 0;
let lastFrame = performance.now();
const undoStack: string[] = [];
const redoStack: string[] = [];
const timing = new Map<string, Signal[]>();
let bottomPanel = "timing";
let hint = "";

type Drag =
  | { kind: "none" }
  | { kind: "pan"; sx: number; sy: number; vx: number; vy: number }
  | { kind: "wire"; sx: number; sy: number; ex: number; ey: number; vertical: boolean | null }
  | {
      kind: "move";
      gx: number;
      gy: number;
      dx: number;
      dy: number;
      moved: boolean;
      clicked: string | null;
      before: string;
    }
  | { kind: "rubber"; x1: number; y1: number; x2: number; y2: number }
  | { kind: "press"; index: number };
let drag: Drag = { kind: "none" };
let hoverPort: [number, number] | null = null;

const circuit = (): Circuit => findCircuit(project, current);
const lib = () => projectLibrary(project);
const view = (): View => {
  let v = views.get(current);
  if (!v) {
    v = fitView(circuit());
    views.set(current, v);
  }
  return v;
};

// ------------------------------------------------------------------ project lifecycle

function fitView(c: Circuit): View {
  const rect = canvas.getBoundingClientRect();
  if (!c.components.length) return { x: -4, y: -4, scale: 18 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const comp of c.components) {
    const b = boxOf(comp, lib());
    minX = Math.min(minX, b.x);
    minY = Math.min(minY, b.y);
    maxX = Math.max(maxX, b.x + b.w);
    maxY = Math.max(maxY, b.y + b.h);
  }
  for (const w of c.wires) {
    minX = Math.min(minX, w.x1, w.x2);
    maxX = Math.max(maxX, w.x1, w.x2);
    minY = Math.min(minY, w.y1, w.y2);
    maxY = Math.max(maxY, w.y1, w.y2);
  }
  const pad = 4;
  const scale = Math.max(
    6,
    Math.min(
      26,
      Math.min((rect.width || 900) / (maxX - minX + 2 * pad), (rect.height || 500) / (maxY - minY + 2 * pad)),
    ),
  );
  const x = (minX + maxX) / 2 - (rect.width || 900) / scale / 2;
  const y = (minY + maxY) / 2 - (rect.height || 500) / scale / 2;
  return { x, y, scale };
}

function loadProject(p: Project, fit = true): void {
  project = p;
  current = p.main;
  if (fit) views.clear();
  selected.clear();
  placing = null;
  timing.clear();
  rebuild(false);
  renderTabs();
  renderPalette();
  renderProps();
}

/** Rebuild the netlist and simulator after an edit, keeping switch and memory states where parts survived. */
function rebuild(keepState = true): void {
  const old = sim;
  try {
    netlist = buildNetlist(project, current);
  } catch (e) {
    netlist = null;
    sim = null;
    status(`error: ${(e as Error).message}`, true);
    return;
  }
  sim = new Simulator(netlist);
  if (keepState && old) {
    const before = new Map(old.netlist.components.map((c, i) => [`${c.path}:${c.instance.kind}`, i]));
    let changed = false;
    netlist.components.forEach((c, i) => {
      const j = before.get(`${c.path}:${c.instance.kind}`);
      if (j !== undefined && c.def.initState) {
        sim!.states[i] = old.states[j];
        changed = true;
      }
    });
    if (changed) {
      sim.netlist.components.forEach((_c, i) => (sim as unknown as { queue: Set<number> }).queue.add(i));
      sim.settle();
    }
  }
  updateStatus();
}

function snapshot(): string {
  return JSON.stringify(project);
}

function commit(before: string): void {
  if (before === snapshot()) return;
  undoStack.push(before);
  if (undoStack.length > 200) undoStack.shift();
  redoStack.length = 0;
  for (const c of project.circuits) c.wires = cleanWires(c.wires);
  rebuild();
  save();
  renderProps();
}

function edit(fn: () => void): void {
  const before = snapshot();
  fn();
  commit(before);
}

function undo(): void {
  const prev = undoStack.pop();
  if (!prev) return;
  redoStack.push(snapshot());
  restore(prev);
}

function redo(): void {
  const next = redoStack.pop();
  if (!next) return;
  undoStack.push(snapshot());
  restore(next);
}

function restore(json: string): void {
  const name = current;
  project = JSON.parse(json) as Project;
  current = project.circuits.some((c) => c.name === name) ? name : project.main;
  selected.clear();
  rebuild();
  renderTabs();
  renderPalette();
  renderProps();
  save();
}

function save(): void {
  try {
    localStorage.setItem("silica.project", toJSON(project));
  } catch {
    // storage full or disabled: the project still lives in the page
  }
}

// ------------------------------------------------------------------ geometry helpers

function toGrid(ev: { clientX: number; clientY: number }): { fx: number; fy: number; gx: number; gy: number } {
  const r = canvas.getBoundingClientRect();
  const v = view();
  const fx = v.x + (ev.clientX - r.left) / v.scale;
  const fy = v.y + (ev.clientY - r.top) / v.scale;
  return { fx, fy, gx: Math.round(fx), gy: Math.round(fy) };
}

function componentAt(fx: number, fy: number): ComponentInstance | null {
  const list = circuit().components;
  for (let i = list.length - 1; i >= 0; i--) {
    const c = list[i]!;
    const b = boxOf(c, lib());
    if (fx >= b.x && fx <= b.x + b.w && fy >= b.y && fy <= b.y + b.h) return c;
  }
  return null;
}

function portNear(fx: number, fy: number): [number, number] | null {
  let best: [number, number] | null = null;
  let bestD = 0.45;
  for (const c of circuit().components) {
    for (const p of portsOf(c, lib())) {
      const d = Math.hypot(p.ax - fx, p.ay - fy);
      if (d < bestD) {
        bestD = d;
        best = [p.ax, p.ay];
      }
    }
  }
  for (const w of circuit().wires) {
    for (const [x, y] of [
      [w.x1, w.y1],
      [w.x2, w.y2],
    ] as [number, number][]) {
      const d = Math.hypot(x - fx, y - fy);
      if (d < bestD) {
        bestD = d;
        best = [x, y];
      }
    }
  }
  return best;
}

function wireAt(fx: number, fy: number): number {
  const ws = circuit().wires;
  for (let i = ws.length - 1; i >= 0; i--) {
    const w = ws[i]!;
    const d =
      w.x1 === w.x2
        ? fy >= Math.min(w.y1, w.y2) - 0.3 && fy <= Math.max(w.y1, w.y2) + 0.3
          ? Math.abs(fx - w.x1)
          : 9
        : fx >= Math.min(w.x1, w.x2) - 0.3 && fx <= Math.max(w.x1, w.x2) + 0.3
          ? Math.abs(fy - w.y1)
          : 9;
    if (d < 0.35) return i;
  }
  return -1;
}

function wirePath(sx: number, sy: number, ex: number, ey: number, vertical: boolean): Wire[] {
  const out: Wire[] = [];
  if (vertical) {
    if (sy !== ey) out.push({ x1: sx, y1: sy, x2: sx, y2: ey });
    if (sx !== ex) out.push({ x1: sx, y1: ey, x2: ex, y2: ey });
  } else {
    if (sx !== ex) out.push({ x1: sx, y1: sy, x2: ex, y2: sy });
    if (sy !== ey) out.push({ x1: ex, y1: sy, x2: ex, y2: ey });
  }
  return out;
}

function topIndex(id: string): number {
  if (!netlist) return -1;
  return netlist.components.findIndex((c) => c.top && c.instance.id === id);
}

// ------------------------------------------------------------------ canvas events

canvas.addEventListener("contextmenu", (e) => e.preventDefault());

canvas.addEventListener("mousedown", (ev) => {
  canvas.focus();
  const { fx, fy, gx, gy } = toGrid(ev);
  if (ev.button === 1 || ev.button === 2) {
    const v = view();
    drag = { kind: "pan", sx: ev.clientX, sy: ev.clientY, vx: v.x, vy: v.y };
    canvas.style.cursor = "grabbing";
    return;
  }
  if (placing) {
    const before = snapshot();
    const c = circuit();
    const id = nextId(c, placing.kind === "SUBCIRCUIT" ? "u" : placing.kind.slice(0, 1).toLowerCase());
    c.components.push({ ...placing, id, params: { ...placing.params } });
    selected = new Set([id]);
    if (!ev.shiftKey) {
      placing = null;
      renderPalette();
    }
    commit(before);
    return;
  }
  const port = portNear(fx, fy);
  const comp = componentAt(fx, fy);
  const interactive = comp && ["SWITCH", "BUTTON", "INPUT", "CLOCK"].includes(comp.kind);
  if (port && !(interactive && !ev.altKey && Math.hypot(port[0] - fx, port[1] - fy) > 0.3)) {
    drag = { kind: "wire", sx: port[0], sy: port[1], ex: port[0], ey: port[1], vertical: null };
    return;
  }
  if (comp) {
    if (comp.kind === "BUTTON" && !ev.shiftKey) {
      const i = topIndex(comp.id);
      if (i >= 0 && sim) {
        sim.press(i, true);
        drag = { kind: "press", index: i };
        return;
      }
    }
    if (ev.shiftKey) {
      if (selected.has(comp.id)) selected.delete(comp.id);
      else selected.add(comp.id);
    } else if (!selected.has(comp.id)) selected = new Set([comp.id]);
    drag = {
      kind: "move",
      gx,
      gy,
      dx: 0,
      dy: 0,
      moved: false,
      clicked: interactive ? comp.id : null,
      before: snapshot(),
    };
    renderProps();
    return;
  }
  const wi = wireAt(fx, fy);
  if (wi >= 0) {
    if (ev.shiftKey) selected.add(`w:${wi}`);
    else selected = new Set([`w:${wi}`]);
    drag = { kind: "wire", sx: gx, sy: gy, ex: gx, ey: gy, vertical: null };
    renderProps();
    return;
  }
  if (!ev.shiftKey) selected.clear();
  drag = { kind: "rubber", x1: fx, y1: fy, x2: fx, y2: fy };
  renderProps();
});

window.addEventListener("mousemove", (ev) => {
  const { fx, fy, gx, gy } = toGrid(ev);
  if (placing) {
    const b = boxOf({ ...placing, x: 0, y: 0 }, lib());
    placing.x = gx - Math.round(b.w / 2);
    placing.y = gy - Math.round(b.h / 2);
  }
  switch (drag.kind) {
    case "pan": {
      const v = view();
      v.x = drag.vx - (ev.clientX - drag.sx) / v.scale;
      v.y = drag.vy - (ev.clientY - drag.sy) / v.scale;
      break;
    }
    case "wire":
      drag.ex = gx;
      drag.ey = gy;
      if (drag.vertical === null && (gx !== drag.sx || gy !== drag.sy))
        drag.vertical = Math.abs(gy - drag.sy) > Math.abs(gx - drag.sx);
      break;
    case "move": {
      const dx = gx - drag.gx;
      const dy = gy - drag.gy;
      if (dx !== drag.dx || dy !== drag.dy) {
        moveSelection(dx - drag.dx, dy - drag.dy);
        drag.dx = dx;
        drag.dy = dy;
        drag.moved = true;
      }
      break;
    }
    case "rubber":
      drag.x2 = fx;
      drag.y2 = fy;
      break;
    default:
      break;
  }
  if (ev.target === canvas) hoverPort = drag.kind === "none" || drag.kind === "wire" ? portNear(fx, fy) : null;
});

window.addEventListener("mouseup", () => {
  const d = drag;
  drag = { kind: "none" };
  canvas.style.cursor = "";
  switch (d.kind) {
    case "wire": {
      if (d.vertical === null) return;
      const segs = wirePath(d.sx, d.sy, d.ex, d.ey, d.vertical);
      if (segs.length) edit(() => circuit().wires.push(...segs));
      break;
    }
    case "move":
      if (d.moved) commit(d.before);
      else if (d.clicked && sim) {
        const i = topIndex(d.clicked);
        if (i >= 0) sim.toggle(i);
      }
      break;
    case "rubber": {
      const x1 = Math.min(d.x1, d.x2);
      const x2 = Math.max(d.x1, d.x2);
      const y1 = Math.min(d.y1, d.y2);
      const y2 = Math.max(d.y1, d.y2);
      if (x2 - x1 < 0.5 && y2 - y1 < 0.5) break;
      for (const c of circuit().components) {
        const b = boxOf(c, lib());
        if (b.x >= x1 && b.x + b.w <= x2 && b.y >= y1 && b.y + b.h <= y2) selected.add(c.id);
      }
      circuit().wires.forEach((w, i) => {
        if (
          Math.min(w.x1, w.x2) >= x1 &&
          Math.max(w.x1, w.x2) <= x2 &&
          Math.min(w.y1, w.y2) >= y1 &&
          Math.max(w.y1, w.y2) <= y2
        )
          selected.add(`w:${i}`);
      });
      renderProps();
      break;
    }
    case "press":
      sim?.press(d.index, false);
      break;
    default:
      break;
  }
});

canvas.addEventListener(
  "wheel",
  (ev) => {
    ev.preventDefault();
    const v = view();
    const { fx, fy } = toGrid(ev);
    const factor = Math.exp(-ev.deltaY * 0.0015);
    v.scale = Math.max(4, Math.min(48, v.scale * factor));
    const r = canvas.getBoundingClientRect();
    v.x = fx - (ev.clientX - r.left) / v.scale;
    v.y = fy - (ev.clientY - r.top) / v.scale;
  },
  { passive: false },
);

canvas.addEventListener("dblclick", (ev) => {
  const { fx, fy } = toGrid(ev);
  const comp = componentAt(fx, fy);
  if (comp?.kind === "SUBCIRCUIT") {
    const name = String(comp.params["circuit"]);
    if (project.circuits.some((c) => c.name === name)) switchCircuit(name);
  }
});

function moveSelection(dx: number, dy: number): void {
  const c = circuit();
  for (const comp of c.components) {
    if (selected.has(comp.id)) {
      comp.x += dx;
      comp.y += dy;
    }
  }
  c.wires.forEach((w, i) => {
    if (selected.has(`w:${i}`)) {
      w.x1 += dx;
      w.x2 += dx;
      w.y1 += dy;
      w.y2 += dy;
    }
  });
  rebuild();
}

function deleteSelection(): void {
  if (!selected.size) return;
  edit(() => {
    const c = circuit();
    c.components = c.components.filter((x) => !selected.has(x.id));
    c.wires = c.wires.filter((_w, i) => !selected.has(`w:${i}`));
  });
  selected.clear();
  renderProps();
}

function rotateSelection(): void {
  edit(() => {
    for (const comp of circuit().components) {
      if (selected.has(comp.id)) comp.facing = FACINGS[(FACINGS.indexOf(comp.facing) + 1) % 4]!;
    }
  });
}

function duplicateSelection(): void {
  const c = circuit();
  const fresh = new Set<string>();
  edit(() => {
    for (const comp of c.components.filter((x) => selected.has(x.id))) {
      const id = nextId(c, comp.kind.slice(0, 1).toLowerCase());
      c.components.push({ ...comp, id, x: comp.x + 2, y: comp.y + 2, params: structuredClone(comp.params) });
      fresh.add(id);
    }
    c.wires.forEach((w, i) => {
      if (selected.has(`w:${i}`)) {
        c.wires.push({ x1: w.x1 + 2, y1: w.y1 + 2, x2: w.x2 + 2, y2: w.y2 + 2 });
        fresh.add(`w:${c.wires.length - 1}`);
      }
    });
  });
  selected = fresh;
}

window.addEventListener("keydown", (ev) => {
  const target = ev.target as HTMLElement;
  if (target.matches("input, textarea, select")) return;
  const mod = ev.ctrlKey || ev.metaKey;
  if (mod && ev.key.toLowerCase() === "z") {
    ev.preventDefault();
    if (ev.shiftKey) redo();
    else undo();
  } else if (mod && ev.key.toLowerCase() === "y") {
    ev.preventDefault();
    redo();
  } else if (mod && ev.key.toLowerCase() === "d") {
    ev.preventDefault();
    duplicateSelection();
  } else if (mod && ev.key.toLowerCase() === "a") {
    ev.preventDefault();
    selected = new Set([...circuit().components.map((c) => c.id), ...circuit().wires.map((_w, i) => `w:${i}`)]);
  } else if (ev.key === "Delete" || ev.key === "Backspace") {
    deleteSelection();
  } else if (ev.key.toLowerCase() === "r" && !mod) {
    if (placing) placing.facing = FACINGS[(FACINGS.indexOf(placing.facing) + 1) % 4]!;
    else rotateSelection();
  } else if (ev.key === "Escape") {
    placing = null;
    selected.clear();
    drag = { kind: "none" };
    renderPalette();
    renderProps();
  } else if (ev.key === " ") {
    ev.preventDefault();
    toggleRun();
  } else if (ev.key === ".") {
    doTick();
  } else if (ev.key === ",") {
    doTick();
    doTick();
  } else if (ev.key === "f") {
    views.set(current, fitView(circuit()));
  }
});

// ------------------------------------------------------------------ simulation controls

function doTick(): void {
  if (!sim) return;
  const stats = sim.tick();
  sample();
  if (stats.oscillating) {
    running = false;
    updateRunButton();
  }
  updateStatus();
}

function sample(): void {
  if (!sim || !netlist) return;
  const seen = new Set<string>();
  netlist.components.forEach((c) => {
    if (!c.top) return;
    const k = c.instance.kind;
    if (!["INPUT", "OUTPUT", "PROBE", "LED", "CLOCK", "SWITCH", "BUTTON", "HEX"].includes(k)) return;
    const label = String(c.params["label"] ?? "") || (k === "CLOCK" ? "clk" : "");
    if (!label || seen.has(label)) return;
    seen.add(label);
    const v = sim!.get(c.path);
    const list = timing.get(label) ?? [];
    list.push(v);
    if (list.length > TIMING_CAPACITY) list.shift();
    timing.set(label, list);
  });
  for (const k of [...timing.keys()]) if (!seen.has(k)) timing.delete(k);
}

function toggleRun(): void {
  running = !running;
  tickDebt = 0;
  updateRunButton();
}

function updateRunButton(): void {
  const b = $<HTMLButtonElement>("run");
  b.textContent = running ? "❚❚ Pause" : "▶ Run";
  b.classList.toggle("primary", !running);
  b.classList.toggle("active", running);
}

$("run").addEventListener("click", toggleRun);
$("tick").addEventListener("click", doTick);
$("cycle").addEventListener("click", () => {
  doTick();
  doTick();
});
$("reset").addEventListener("click", () => {
  sim?.reset();
  timing.clear();
  updateStatus();
});
const speedInput = $<HTMLInputElement>("speed");
speedInput.addEventListener("input", () => {
  speed = Number(speedInput.value);
  $("speed-label").textContent = `${SPEEDS[speed]} Hz`;
});

function status(text: string, error = false): void {
  const el = $("status");
  el.innerHTML = "";
  const span = document.createElement("span");
  if (error) span.className = "err";
  span.textContent = text;
  el.appendChild(span);
}

function updateStatus(): void {
  if (!netlist || !sim) return;
  const parts = [`${circuit().components.length} parts`, `${netlist.nets.length} nets`, `tick ${sim.ticks}`];
  if (netlist.errors.length) {
    status(
      `${netlist.errors[0]!.message}${netlist.errors.length > 1 ? ` (+${netlist.errors.length - 1} more)` : ""}`,
      true,
    );
    return;
  }
  if (sim.stats.oscillating) {
    status("the circuit oscillates: it never settles. Look for a loop with an odd number of inverters.", true);
    return;
  }
  const conflicts = sim.conflicts.filter(Boolean).length;
  if (conflicts) parts.push(`${conflicts} bus conflict${conflicts > 1 ? "s" : ""}`);
  status(parts.join("  ·  "), conflicts > 0);
}

// ------------------------------------------------------------------ palette, tabs and properties

function renderPalette(): void {
  const el = $("palette");
  el.innerHTML = "";
  for (const cat of CATEGORIES) {
    const items = [...COMPONENTS.values()].filter((d) => d.category === cat && d.kind !== "SUBCIRCUIT");
    const subs = cat === "Circuits" ? project.circuits.filter((c) => c.name !== current) : [];
    if (!items.length && !subs.length) continue;
    const h = document.createElement("h3");
    h.textContent = cat;
    el.appendChild(h);
    const grid = document.createElement("div");
    grid.className = "items";
    const add = (label: string, title: string, make: () => ComponentInstance, active: boolean) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.title = title;
      if (active) b.classList.add("active");
      b.addEventListener("click", () => {
        placing = active ? null : make();
        selected.clear();
        renderPalette();
        renderProps();
        canvas.focus();
      });
      grid.appendChild(b);
    };
    for (const d of items) {
      add(
        d.name.replace(" gate", "").replace("Hex digit display", "Hex digit"),
        d.description,
        () => ({ id: "ghost", kind: d.kind, x: 0, y: 0, facing: "E", params: normalizeParams(d, {}) }),
        placing?.kind === d.kind,
      );
    }
    for (const s of subs) {
      add(
        `▣ ${s.name}`,
        `Use "${s.name}" as a part`,
        () => ({ id: "ghost", kind: "SUBCIRCUIT", x: 0, y: 0, facing: "E", params: { circuit: s.name } }),
        placing?.kind === "SUBCIRCUIT" && placing.params["circuit"] === s.name,
      );
    }
    el.appendChild(grid);
  }
}

function renderTabs(): void {
  const el = $("tabs");
  el.innerHTML = "";
  for (const c of project.circuits) {
    const b = document.createElement("button");
    b.textContent = c.name;
    b.title = "Click to open, double-click to rename";
    if (c.name === current) b.classList.add("current");
    if (c.name === project.main) b.classList.add("main");
    b.addEventListener("click", () => switchCircuit(c.name));
    b.addEventListener("dblclick", () => renameCircuit(c.name));
    el.appendChild(b);
  }
  const add = document.createElement("button");
  add.textContent = "+";
  add.title = "New circuit";
  add.addEventListener("click", () => {
    const name = prompt("Name of the new circuit:", `circuit ${project.circuits.length + 1}`)?.trim();
    if (!name) return;
    if (project.circuits.some((c) => c.name === name)) return toast("A circuit with that name already exists");
    edit(() => project.circuits.push({ name, components: [], wires: [] }));
    switchCircuit(name);
  });
  el.appendChild(add);
}

function renameCircuit(old: string): void {
  const name = prompt("Rename circuit:", old)?.trim();
  if (!name || name === old) return;
  if (project.circuits.some((c) => c.name === name)) return toast("A circuit with that name already exists");
  edit(() => {
    findCircuit(project, old).name = name;
    if (project.main === old) project.main = name;
    for (const c of project.circuits)
      for (const comp of c.components)
        if (comp.kind === "SUBCIRCUIT" && comp.params["circuit"] === old) comp.params["circuit"] = name;
  });
  if (current === old) current = name;
  const v = views.get(old);
  if (v) views.set(name, v);
  renderTabs();
  renderPalette();
}

function switchCircuit(name: string): void {
  current = name;
  selected.clear();
  placing = null;
  timing.clear();
  rebuild(false);
  renderTabs();
  renderPalette();
  renderProps();
}

function field(spec: ParamSpec, value: ParamValue, onChange: (v: ParamValue) => void): HTMLElement {
  const label = document.createElement("label");
  label.textContent = spec.label;
  let input: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;
  if (spec.type === "select") {
    input = document.createElement("select");
    for (const o of spec.options ?? []) {
      const opt = document.createElement("option");
      opt.value = o;
      opt.textContent = o;
      input.appendChild(opt);
    }
    input.value = String(value);
    input.addEventListener("change", () => onChange(input.value));
  } else if (spec.type === "bool") {
    label.className = "check";
    input = document.createElement("input");
    input.type = "checkbox";
    input.checked = value === true;
    input.addEventListener("change", () => onChange((input as HTMLInputElement).checked));
    label.prepend(input);
    return label;
  } else if (spec.type === "list") {
    input = document.createElement("textarea");
    input.value = (Array.isArray(value) ? value : [])
      .map((n) => n.toString(16).toUpperCase().padStart(2, "0"))
      .join(" ");
    input.placeholder = "hex words separated by spaces";
    input.addEventListener("change", () => {
      const words = input.value
        .split(/[\s,]+/)
        .filter(Boolean)
        .map((t) => parseInt(t, 16));
      onChange(words.map((n) => (Number.isFinite(n) ? n : 0)));
    });
  } else {
    input = document.createElement("input");
    input.type = spec.type === "int" ? "number" : "text";
    if (spec.min !== undefined) input.min = String(spec.min);
    if (spec.max !== undefined) input.max = String(spec.max);
    input.value = String(value);
    input.addEventListener("change", () => onChange(spec.type === "int" ? Number(input.value) : input.value));
  }
  label.appendChild(input);
  return label;
}

function renderProps(): void {
  const el = $("props");
  el.innerHTML = "";
  const h = (text: string) => {
    const e = document.createElement("h3");
    e.textContent = text;
    el.appendChild(e);
  };
  const comps = circuit().components.filter((c) => selected.has(c.id));
  if (comps.length === 1) {
    const comp = comps[0]!;
    const def = getDef(comp.kind);
    h("Selected");
    const k = document.createElement("div");
    k.className = "kind";
    k.textContent = def.name;
    el.appendChild(k);
    const d = document.createElement("div");
    d.className = "desc";
    d.textContent = def.description;
    el.appendChild(d);
    const params = normalizeParams(def, comp.params);
    for (const spec of def.params) {
      if (comp.kind === "SUBCIRCUIT") continue;
      el.appendChild(
        field(spec, params[spec.key]!, (v) =>
          edit(() => (comp.params = normalizeParams(def, { ...comp.params, [spec.key]: v }))),
        ),
      );
    }
    if (comp.kind === "INPUT" && sim) {
      const i = topIndex(comp.id);
      const label = document.createElement("label");
      label.textContent = "Value now";
      const input = document.createElement("input");
      input.type = "text";
      const st = sim.states[i] as { value: number } | undefined;
      input.value = st ? format({ width: Number(params["bits"]), v: st.value, x: 0, z: 0 }, "dec") : "0";
      input.addEventListener("change", () => {
        const n = input.value.trim().startsWith("0x") ? parseInt(input.value, 16) : Number(input.value);
        if (Number.isFinite(n) && sim) sim.set(comp.id, n);
      });
      label.appendChild(input);
      el.appendChild(label);
    }
    const buttons = document.createElement("div");
    buttons.className = "buttons";
    const btn = (text: string, fn: () => void) => {
      const b = document.createElement("button");
      b.textContent = text;
      b.addEventListener("click", fn);
      buttons.appendChild(b);
    };
    btn("Rotate (R)", rotateSelection);
    btn("Duplicate", duplicateSelection);
    btn("Delete", deleteSelection);
    if (comp.kind === "SUBCIRCUIT") btn("Open circuit", () => switchCircuit(String(comp.params["circuit"])));
    el.appendChild(buttons);
  } else if (selected.size) {
    h("Selection");
    const p = document.createElement("div");
    p.className = "desc";
    p.textContent = `${comps.length} parts and ${selected.size - comps.length} wire segments selected.`;
    el.appendChild(p);
    const buttons = document.createElement("div");
    buttons.className = "buttons";
    for (const [text, fn] of [
      ["Rotate", rotateSelection],
      ["Duplicate", duplicateSelection],
      ["Delete", deleteSelection],
    ] as [string, () => void][]) {
      const b = document.createElement("button");
      b.textContent = text;
      b.addEventListener("click", fn);
      buttons.appendChild(b);
    }
    el.appendChild(buttons);
  } else {
    h("Circuit");
    const k = document.createElement("div");
    k.className = "kind";
    k.textContent = current;
    el.appendChild(k);
    const buttons = document.createElement("div");
    buttons.className = "buttons";
    const mk = (text: string, fn: () => void, disabled = false) => {
      const b = document.createElement("button");
      b.textContent = text;
      b.disabled = disabled;
      b.addEventListener("click", fn);
      buttons.appendChild(b);
    };
    mk("Rename", () => renameCircuit(current));
    mk("Make main", () => edit(() => (project.main = current)), project.main === current);
    mk(
      "Delete",
      () => {
        if (!confirm(`Delete circuit "${current}"?`)) return;
        edit(() => {
          project.circuits = project.circuits.filter((c) => c.name !== current);
          if (project.main === current) project.main = project.circuits[0]!.name;
        });
        switchCircuit(project.main);
      },
      project.circuits.length < 2,
    );
    el.appendChild(buttons);
    h("How to");
    const ul = document.createElement("ul");
    for (const tip of [
      "Pick a part on the left, then click to place it. Hold Shift to place several.",
      "Drag from a port or a wire end to draw a wire. Wires bend once.",
      "Click switches to flip them; hold buttons down.",
      "Drag parts to move them; drag on empty space to select an area.",
      "Right-drag to pan, scroll to zoom, F to fit.",
      "Double-click a subcircuit to open it.",
    ]) {
      const li = document.createElement("li");
      li.textContent = tip;
      ul.appendChild(li);
    }
    el.appendChild(ul);
    h("Keys");
    const keys = document.createElement("ul");
    for (const [k, t] of [
      ["R", "rotate"],
      ["Del", "delete"],
      ["Ctrl+D", "duplicate"],
      ["Ctrl+Z", "undo"],
      ["Space", "run or pause"],
      [".", "one tick"],
      [",", "one cycle"],
      ["Esc", "cancel"],
    ]) {
      const li = document.createElement("li");
      li.innerHTML = `<kbd>${k}</kbd> ${t}`;
      keys.appendChild(li);
    }
    el.appendChild(keys);
    const credit = document.createElement("p");
    credit.className = "credit";
    credit.textContent = "Silica is open source. Designed, developed and maintained by jullewz.";
    el.appendChild(credit);
  }
}

// ------------------------------------------------------------------ bottom panels

for (const tab of document.querySelectorAll<HTMLButtonElement>(".btabs [role=tab]")) {
  tab.addEventListener("click", () => {
    bottomPanel = tab.dataset["panel"] ?? "timing";
    for (const t of document.querySelectorAll<HTMLButtonElement>(".btabs [role=tab]")) {
      const on = t === tab;
      t.setAttribute("aria-selected", String(on));
      $(`panel-${t.dataset["panel"]}`).hidden = !on;
    }
  });
}

$("build-table").addEventListener("click", () => {
  const out = $("table-out");
  out.innerHTML = "";
  try {
    const t = truthTable(project, current);
    const table = document.createElement("table");
    table.className = "tt";
    const head = document.createElement("tr");
    t.inputs.forEach((c) => head.insertAdjacentHTML("beforeend", `<th>${escapeHtml(c.label)}</th>`));
    t.outputs.forEach((c, i) =>
      head.insertAdjacentHTML("beforeend", `<th class="${i === 0 ? "sep" : ""}">${escapeHtml(c.label)}</th>`),
    );
    table.appendChild(head);
    for (const row of t.rows.slice(0, 1024)) {
      const tr = document.createElement("tr");
      row.forEach((v, i) => {
        const td = document.createElement("td");
        td.textContent = v === null ? "X" : String(v);
        if (v === 1) td.className = "one";
        if (v === 0) td.className = "zero";
        if (i === t.inputs.length) td.classList.add("sep");
        tr.appendChild(td);
      });
      table.appendChild(tr);
    }
    const note = $("table-note");
    const allBits = t.inputs.every((c) => c.width === 1);
    const exprs: string[] = [];
    if (allBits && t.inputs.length <= 10) {
      t.outputs.forEach((o, k) => {
        if (o.width !== 1) return;
        const ones = t.rows.map((r, m) => (r[t.inputs.length + k] === 1 ? m : -1)).filter((m) => m >= 0);
        exprs.push(
          `${o.label} = ${formatSop(
            minimize(t.inputs.length, ones),
            t.inputs.map((c) => c.label),
          )}`,
        );
      });
    }
    note.textContent = `${t.rows.length} rows${t.sequential ? " · the circuit has memory, so this shows its response from the current state" : ""}${exprs.length ? " · " + exprs.join("   ") : ""}`;
    out.appendChild(table);
  } catch (e) {
    out.textContent = (e as Error).message;
  }
});

function updateExpr(): void {
  const out = $("expr-out");
  try {
    const r = simplify(($("expr") as HTMLInputElement).value);
    out.innerHTML = `variables: <b>${escapeHtml(r.vars.join(", ") || "none")}</b> · true for minterms ${escapeHtml(r.minterms.join(", ") || "none")}<br/>simplest sum of products: <b>${escapeHtml(r.result)}</b>`;
  } catch (e) {
    out.textContent = (e as Error).message;
  }
}
$("expr").addEventListener("input", updateExpr);
$("build-expr").addEventListener("click", () => {
  try {
    const text = ($("expr") as HTMLInputElement).value;
    let name = "expression";
    for (let i = 2; project.circuits.some((c) => c.name === name); i++) name = `expression ${i}`;
    const built = synthesize(text, name).circuits[0]!;
    edit(() => project.circuits.push(built));
    switchCircuit(name);
    views.set(name, fitView(circuit()));
    toast(`Built "${name}": a two-level circuit for ${simplify(text).result}`);
  } catch (e) {
    toast((e as Error).message);
  }
});

// ------------------------------------------------------------------ files and examples

const examples = $<HTMLSelectElement>("examples");
for (const ex of EXAMPLES) {
  const o = document.createElement("option");
  o.value = ex.id;
  o.textContent = ex.title;
  o.title = ex.description;
  examples.appendChild(o);
}
examples.addEventListener("change", () => {
  const ex = EXAMPLES.find((e) => e.id === examples.value);
  examples.value = "";
  if (!ex) return;
  const before = snapshot();
  loadProject(ex.build());
  undoStack.push(before);
  save();
});
$("new").addEventListener("click", () => {
  if (!confirm("Start a new, empty project? Your current one stays in the undo history.")) return;
  const before = snapshot();
  loadProject(emptyProject());
  undoStack.push(before);
  save();
});
$("save").addEventListener("click", () => {
  const blob = new Blob([toJSON(project)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${project.main.replace(/[^\w.-]+/g, "_") || "circuit"}.silica.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});
const fileInput = $<HTMLInputElement>("file");
$("open").addEventListener("click", () => fileInput.click());
fileInput.addEventListener("change", async () => {
  const f = fileInput.files?.[0];
  fileInput.value = "";
  if (!f) return;
  try {
    const p = fromJSON(await f.text());
    const before = snapshot();
    loadProject(p);
    undoStack.push(before);
    save();
    toast(`Opened ${f.name}`);
  } catch (e) {
    toast((e as Error).message);
  }
});
$("share").addEventListener("click", async () => {
  const code = await encodeShare(project);
  const url = `${location.origin}${location.pathname}#p=${code}`;
  history.replaceState(null, "", url);
  try {
    await navigator.clipboard.writeText(url);
    toast("Link copied: it contains the whole project");
  } catch {
    toast("The link is in the address bar");
  }
});
$("undo").addEventListener("click", undo);
$("redo").addEventListener("click", redo);

function toast(text: string): void {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  window.setTimeout(() => (t.hidden = true), 2600);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
}

// ------------------------------------------------------------------ frame loop

function resize(): void {
  const dpr = window.devicePixelRatio || 1;
  for (const c of [canvas, timingCanvas]) {
    const r = c.getBoundingClientRect();
    c.width = Math.max(1, Math.round(r.width * dpr));
    c.height = Math.max(1, Math.round(r.height * dpr));
  }
}
window.addEventListener("resize", resize);

function frame(now: number): void {
  const dt = Math.min(0.25, (now - lastFrame) / 1000);
  lastFrame = now;
  if (running && sim) {
    tickDebt += dt * SPEEDS[speed]! * 2;
    let n = 0;
    while (tickDebt >= 1 && n < 512) {
      doTick();
      tickDebt -= 1;
      n++;
      if (!running) break;
    }
  }
  const dpr = window.devicePixelRatio || 1;
  const v = view();
  const scaled: View = { x: v.x, y: v.y, scale: v.scale * dpr };
  let preview: Wire[] = [];
  if (drag.kind === "wire" && drag.vertical !== null)
    preview = wirePath(drag.sx, drag.sy, drag.ex, drag.ey, drag.vertical);
  const errorPoints = new Set<string>();
  for (const e of netlist?.errors ?? []) if (/^-?\d+,-?\d+$/.test(e.where)) errorPoints.add(e.where);
  const st: DrawState = {
    circuit: circuit(),
    lib: lib(),
    netlist,
    sim,
    selected,
    hoverPort,
    preview,
    ghost: placing,
    rubber: drag.kind === "rubber" ? drag : null,
    errorPoints,
  };
  draw(ctx, canvas.width, canvas.height, scaled, st);
  if (bottomPanel === "timing") {
    drawTiming(
      tctx,
      timingCanvas.width,
      timingCanvas.height,
      [...timing.entries()].map(([label, samples]) => ({ label, samples })),
      TIMING_CAPACITY,
      dpr,
    );
  }
  const newHint = placing
    ? "Click to place · R rotates · Shift keeps placing · Esc cancels"
    : drag.kind === "wire"
      ? "Release to finish the wire"
      : "";
  if (newHint !== hint) {
    hint = newHint;
    $("hint").textContent = hint;
  }
  document.body.dataset["ready"] = "1";
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ start

async function start(): Promise<void> {
  resize();
  let loaded: Project | null = null;
  const m = /#p=([A-Za-z0-9_-]+)/.exec(location.hash);
  if (m?.[1]) {
    try {
      loaded = await decodeShare(m[1]);
    } catch (e) {
      toast((e as Error).message);
    }
  }
  const ex = /#example=([\w-]+)/.exec(location.hash);
  if (!loaded && ex?.[1]) loaded = EXAMPLES.find((e) => e.id === ex[1])?.build() ?? null;
  if (!loaded) {
    try {
      const saved = localStorage.getItem("silica.project");
      if (saved) loaded = fromJSON(saved);
    } catch {
      loaded = null;
    }
  }
  loadProject(loaded ?? EXAMPLES.find((e) => e.id === "cpu")!.build());
  updateExpr();
  updateRunButton();
  requestAnimationFrame(frame);
}

void start();
