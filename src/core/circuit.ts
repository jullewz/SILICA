/**
 * Circuits on a grid, and how they become nets.
 *
 * Everything sits on integer grid points. A wire is a horizontal or vertical segment. Two things are connected
 * when they share a point: wire ends, component ports, or a wire end that lands in the middle of another wire
 * (a T-junction). Wires that only cross each other do not connect. Tunnels with the same label connect too.
 *
 * Subcircuits are flattened: every instance gets its own copy of the inner components, and the inner input and
 * output pins are merged with the nets attached to the instance's ports.
 */

import { getDef, normalizeParams, type ComponentDef, type Library, type Params, type PortSpec } from "./components.js";

export type Facing = "E" | "S" | "W" | "N";

export interface ComponentInstance {
  id: string;
  kind: string;
  x: number;
  y: number;
  facing: Facing;
  params: Params;
}

export interface Wire {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface Circuit {
  name: string;
  components: ComponentInstance[];
  wires: Wire[];
}

export interface Project {
  format: "silica";
  version: 1;
  main: string;
  circuits: Circuit[];
}

export function emptyProject(name = "main"): Project {
  return { format: "silica", version: 1, main: name, circuits: [{ name, components: [], wires: [] }] };
}

// ------------------------------------------------------------------ geometry

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PlacedPort extends PortSpec {
  index: number; // position in the component's port list
  ax: number; // absolute grid position
  ay: number;
}

/** Rotate a point inside a w×h box (drawn facing east) so the component faces `facing`. */
export function rotate(px: number, py: number, w: number, h: number, facing: Facing): [number, number] {
  switch (facing) {
    case "E":
      return [px, py];
    case "S":
      return [h - py, px];
    case "W":
      return [w - px, h - py];
    case "N":
      return [py, w - px];
  }
}

export function boxOf(c: ComponentInstance, lib: Library): Box {
  const def = getDef(c.kind);
  const { w, h } = def.size(normalizeParams(def, c.params), lib);
  return c.facing === "E" || c.facing === "W" ? { x: c.x, y: c.y, w, h } : { x: c.x, y: c.y, w: h, h: w };
}

export function portsOf(c: ComponentInstance, lib: Library): PlacedPort[] {
  const def = getDef(c.kind);
  const p = normalizeParams(def, c.params);
  const { w, h } = def.size(p, lib);
  return def.ports(p, lib).map((spec, index) => {
    const [rx, ry] = rotate(spec.x, spec.y, w, h, c.facing);
    return { ...spec, index, ax: c.x + rx, ay: c.y + ry };
  });
}

export function onSegment(px: number, py: number, w: Wire, strict: boolean): boolean {
  if (w.x1 === w.x2) {
    if (px !== w.x1) return false;
    const lo = Math.min(w.y1, w.y2);
    const hi = Math.max(w.y1, w.y2);
    return strict ? py > lo && py < hi : py >= lo && py <= hi;
  }
  if (py !== w.y1) return false;
  const lo = Math.min(w.x1, w.x2);
  const hi = Math.max(w.x1, w.x2);
  return strict ? px > lo && px < hi : px >= lo && px <= hi;
}

// ------------------------------------------------------------------ library over a project

export function pinsOf(circuit: Circuit): { inputs: ComponentInstance[]; outputs: ComponentInstance[] } {
  const order = (a: ComponentInstance, b: ComponentInstance) => a.y - b.y || a.x - b.x;
  return {
    inputs: circuit.components.filter((c) => c.kind === "INPUT").sort(order),
    outputs: circuit.components.filter((c) => c.kind === "OUTPUT").sort(order),
  };
}

export function projectLibrary(project: Project): Library {
  return {
    subcircuitPins(name) {
      const c = project.circuits.find((x) => x.name === name);
      if (!c) return null;
      const { inputs, outputs } = pinsOf(c);
      const info = (p: ComponentInstance) => {
        const params = normalizeParams(getDef(p.kind), p.params);
        return { label: String(params["label"] ?? ""), width: Number(params["bits"] ?? 1) };
      };
      return { inputs: inputs.map(info), outputs: outputs.map(info) };
    },
  };
}

// ------------------------------------------------------------------ netlist

export interface NetlistComponent {
  path: string; // "u3/u1/g7": instance path for nested parts, or the id at top level
  instance: ComponentInstance;
  def: ComponentDef;
  params: Params;
  inputNets: number[];
  outputNets: number[];
  top: boolean; // part of the circuit being simulated, not inside a subcircuit
}

export interface Net {
  width: number;
  drivers: [component: number, output: number][];
  readers: number[];
  /** Grid points of the top-level circuit on this net, for drawing. */
  points: string[];
}

export interface NetlistError {
  message: string;
  where: string; // instance path or point key
}

export interface Netlist {
  components: NetlistComponent[];
  nets: Net[];
  errors: NetlistError[];
  /** Top-level point key "x,y" → net index. */
  pointNet: Map<string, number>;
  /** Top-level component id → its ports' net indexes. */
  portNets: Map<string, number[]>;
}

class UnionFind {
  parent = new Map<string, string>();
  find(a: string): string {
    let root = a;
    for (;;) {
      const p = this.parent.get(root);
      if (p === undefined) {
        this.parent.set(root, root);
        break;
      }
      if (p === root) break;
      root = p;
    }
    // path compression
    let cur = a;
    while (cur !== root) {
      const next: string = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

interface PendingPort {
  comp: number; // index into components, or -1 for bridge pins
  port: PortSpec & { index: number };
  key: string;
}

export function buildNetlist(project: Project, circuitName = project.main): Netlist {
  const lib = projectLibrary(project);
  const uf = new UnionFind();
  const components: NetlistComponent[] = [];
  const pending: PendingPort[] = [];
  const errors: NetlistError[] = [];
  const topPoints: string[] = [];
  const topPorts = new Map<string, string[]>();

  const byName = new Map(project.circuits.map((c) => [c.name, c]));

  function visit(circuit: Circuit, prefix: string, stack: string[], bridges: Map<string, string> | null): void {
    const key = (x: number, y: number) => `${prefix}${x},${y}`;
    const top = bridges === null;
    // wires and junctions
    const points: [number, number][] = [];
    for (const w of circuit.wires) {
      uf.union(key(w.x1, w.y1), key(w.x2, w.y2));
      points.push([w.x1, w.y1], [w.x2, w.y2]);
    }
    const placed = circuit.components.map((c) => ({ c, ports: portsOf(c, lib) }));
    for (const { ports } of placed) for (const p of ports) points.push([p.ax, p.ay]);
    for (const [px, py] of points) {
      for (const w of circuit.wires) {
        if (onSegment(px, py, w, true)) uf.union(key(px, py), key(w.x1, w.y1));
      }
    }
    if (top) for (const [px, py] of points) topPoints.push(`${px},${py}`);

    for (const { c, ports } of placed) {
      const def = getDef(c.kind);
      const params = normalizeParams(def, c.params);
      const path = prefix + c.id;
      if (c.kind === "TEXT") continue;
      if (c.kind === "TUNNEL") {
        uf.union(key(ports[0]!.ax, ports[0]!.ay), `${prefix}#tunnel:${String(params["label"])}`);
        pending.push({ comp: -1, port: { ...ports[0]!, index: 0 }, key: key(ports[0]!.ax, ports[0]!.ay) });
        if (top) topPorts.set(c.id, [key(ports[0]!.ax, ports[0]!.ay)]);
        continue;
      }
      if (!top && (c.kind === "INPUT" || c.kind === "OUTPUT")) {
        // inside a subcircuit, pins are wires to the outside
        const outer = bridges!.get(c.id);
        const k = key(ports[0]!.ax, ports[0]!.ay);
        if (outer) uf.union(k, outer);
        pending.push({ comp: -1, port: { ...ports[0]!, index: 0 }, key: k });
        continue;
      }
      if (c.kind === "SUBCIRCUIT") {
        const name = String(params["circuit"]);
        const child = byName.get(name);
        if (!child) {
          errors.push({ message: `subcircuit "${name}" does not exist`, where: path });
          continue;
        }
        if (stack.includes(name)) {
          errors.push({ message: `circuit "${name}" contains itself`, where: path });
          continue;
        }
        const { inputs, outputs } = pinsOf(child);
        const inner = new Map<string, string>();
        const pinList = [...inputs, ...outputs];
        ports.forEach((p, i) => {
          const pin = pinList[i];
          const k = key(p.ax, p.ay);
          if (pin) inner.set(pin.id, k);
          pending.push({ comp: -1, port: { ...p, index: i }, key: k });
        });
        if (top)
          topPorts.set(
            c.id,
            ports.map((p) => key(p.ax, p.ay)),
          );
        visit(child, `${path}/`, [...stack, name], inner);
        continue;
      }
      const index = components.length;
      components.push({ path, instance: c, def, params, inputNets: [], outputNets: [], top });
      for (const p of ports) pending.push({ comp: index, port: p, key: key(p.ax, p.ay) });
      if (top)
        topPorts.set(
          c.id,
          ports.map((p) => key(p.ax, p.ay)),
        );
    }
  }

  const root = byName.get(circuitName);
  if (!root) throw new Error(`no circuit named "${circuitName}"`);
  visit(root, "", [circuitName], null);

  // number the nets
  const netIndex = new Map<string, number>();
  const nets: Net[] = [];
  const netOf = (k: string): number => {
    const r = uf.find(k);
    let i = netIndex.get(r);
    if (i === undefined) {
      i = nets.length;
      netIndex.set(r, i);
      nets.push({ width: 0, drivers: [], readers: [], points: [] });
    }
    return i;
  };
  const widthSeen = new Map<number, string>();
  for (const p of pending) {
    const n = netOf(p.key);
    const net = nets[n]!;
    if (net.width === 0) {
      net.width = p.port.width;
      widthSeen.set(n, p.key);
    } else if (net.width !== p.port.width) {
      errors.push({
        message: `width mismatch: a ${net.width}-bit and a ${p.port.width}-bit port share a wire`,
        where: p.key,
      });
    }
    if (p.comp < 0) continue;
    const comp = components[p.comp]!;
    if (p.port.dir === "in") {
      comp.inputNets.push(n);
      if (!net.readers.includes(p.comp)) net.readers.push(p.comp);
    } else {
      net.drivers.push([p.comp, comp.outputNets.length]);
      comp.outputNets.push(n);
    }
  }
  for (const n of nets) if (n.width === 0) n.width = 1;
  const pointNet = new Map<string, number>();
  for (const pt of topPoints) {
    const n = netOf(pt);
    pointNet.set(pt, n);
    nets[n]!.points.push(pt);
  }
  const portNets = new Map<string, number[]>();
  for (const [id, keys] of topPorts) portNets.set(id, keys.map(netOf));
  return { components, nets, errors, pointNet, portNets };
}

// ------------------------------------------------------------------ editing helpers

export function findCircuit(project: Project, name: string): Circuit {
  const c = project.circuits.find((x) => x.name === name);
  if (!c) throw new Error(`no circuit named "${name}"`);
  return c;
}

export function nextId(circuit: Circuit, prefix: string): string {
  const used = new Set(circuit.components.map((c) => c.id));
  for (let i = 1; ; i++) {
    const id = `${prefix}${i}`;
    if (!used.has(id)) return id;
  }
}

/** Merge collinear overlapping wires and drop zero-length ones. */
export function cleanWires(wires: Wire[]): Wire[] {
  const out: Wire[] = [];
  for (const w of wires) {
    if (w.x1 === w.x2 && w.y1 === w.y2) continue;
    if (w.x1 !== w.x2 && w.y1 !== w.y2) continue;
    const n: Wire =
      w.x1 === w.x2
        ? { x1: w.x1, y1: Math.min(w.y1, w.y2), x2: w.x2, y2: Math.max(w.y1, w.y2) }
        : { x1: Math.min(w.x1, w.x2), y1: w.y1, x2: Math.max(w.x1, w.x2), y2: w.y2 };
    if (!out.some((o) => o.x1 === n.x1 && o.y1 === n.y1 && o.x2 === n.x2 && o.y2 === n.y2)) out.push(n);
  }
  return out;
}
