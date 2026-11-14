/**
 * Event-driven, unit-delay simulation.
 *
 * Every component takes one time step to react. When a net changes, every component reading it is scheduled
 * for the next step. A circuit settles when no events remain. Feedback loops (latches, ring oscillators)
 * work naturally; a circuit that never settles is stopped after a limit and reported as oscillating.
 *
 * All nets start as X (unknown) and unconnected inputs read as Z, so a latch shows X until something sets it,
 * just as a real one has no defined state at power-up.
 */

import { type Netlist } from "./circuit.js";
import { equal, floating, known, resolve, type Signal } from "./signal.js";

export interface SimStats {
  steps: number; // unit-delay steps processed in the last settle
  events: number; // component evaluations in the last settle
  oscillating: boolean;
}

export class Simulator {
  readonly netlist: Netlist;
  readonly values: Signal[];
  readonly conflicts: boolean[];
  readonly outputs: Signal[][];
  readonly states: unknown[];
  time = 0; // total unit-delay steps since reset
  ticks = 0; // clock ticks since reset
  stats: SimStats = { steps: 0, events: 0, oscillating: false };
  maxSteps = 10_000;
  private queue = new Set<number>();
  private readonly byPath = new Map<string, number>();

  constructor(netlist: Netlist) {
    this.netlist = netlist;
    this.values = netlist.nets.map((n) =>
      n.drivers.length ? { width: n.width, v: 0, x: (2 ** n.width - 1) >>> 0, z: 0 } : floating(n.width),
    );
    this.conflicts = netlist.nets.map(() => false);
    this.outputs = netlist.components.map((c) => c.outputNets.map((n) => this.values[n]!));
    this.states = netlist.components.map((c) => (c.def.initState ? c.def.initState(c.params) : {}));
    netlist.components.forEach((c, i) => this.byPath.set(c.path, i));
    this.reset();
  }

  /** Put every part back in its starting state and settle. */
  reset(): SimStats {
    this.netlist.components.forEach((c, i) => {
      this.states[i] = c.def.initState ? c.def.initState(c.params) : {};
    });
    this.netlist.nets.forEach((n, i) => {
      this.values[i] = n.drivers.length
        ? { width: n.width, v: 0, x: (2 ** n.width - 1) >>> 0, z: 0 }
        : floating(n.width);
      this.conflicts[i] = false;
    });
    this.netlist.components.forEach((c, i) => {
      this.outputs[i] = c.outputNets.map((n) => this.values[n]!);
    });
    this.time = 0;
    this.ticks = 0;
    this.netlist.components.forEach((_c, i) => this.queue.add(i));
    return this.settle();
  }

  /** Process events until the circuit is stable (or the step limit is reached). */
  settle(): SimStats {
    let steps = 0;
    let events = 0;
    const comps = this.netlist.components;
    const nets = this.netlist.nets;
    while (this.queue.size) {
      if (steps >= this.maxSteps) {
        this.queue.clear();
        this.stats = { steps, events, oscillating: true };
        return this.stats;
      }
      steps++;
      this.time++;
      const batch = [...this.queue];
      this.queue.clear();
      const touched = new Set<number>();
      for (const i of batch) {
        const c = comps[i]!;
        events++;
        const inputs = c.inputNets.map((n) => this.values[n]!);
        const outs = c.def.evaluate(inputs, this.states[i], c.params);
        const prev = this.outputs[i]!;
        for (let k = 0; k < c.outputNets.length; k++) {
          const v = outs[k];
          if (v && !equal(v, prev[k]!)) {
            prev[k] = v;
            touched.add(c.outputNets[k]!);
          }
        }
      }
      for (const n of touched) {
        const net = nets[n]!;
        const drivers = net.drivers.map(([ci, k]) => this.outputs[ci]![k]!);
        const value = drivers.length === 1 ? drivers[0]! : resolve(net.width, drivers);
        this.conflicts[n] = drivers.length > 1 && hasConflict(drivers);
        if (!equal(value, this.values[n]!)) {
          this.values[n] = value;
          for (const r of net.readers) this.queue.add(r);
        }
      }
    }
    this.stats = { steps, events, oscillating: false };
    return this.stats;
  }

  /** Flip every clock and settle. Two ticks make one full clock cycle. */
  tick(): SimStats {
    this.ticks++;
    this.netlist.components.forEach((c, i) => {
      if (c.instance.kind === "CLOCK") {
        const s = this.states[i] as { value: number };
        s.value ^= 1;
        this.queue.add(i);
      }
    });
    return this.settle();
  }

  /** Run whole clock cycles: rising edge then falling edge. */
  cycle(n = 1): SimStats {
    let stats = this.stats;
    for (let i = 0; i < n; i++) {
      stats = this.tick();
      if (stats.oscillating) return stats;
      stats = this.tick();
      if (stats.oscillating) return stats;
    }
    return stats;
  }

  // ------------------------------------------------------------------ inputs and outputs

  indexOf(pathOrLabel: string): number {
    const direct = this.byPath.get(pathOrLabel);
    if (direct !== undefined) return direct;
    // several parts can share a label (a register and the probe showing it): prefer what displays a value
    const DISPLAYS = ["OUTPUT", "PROBE", "LED", "HEX", "SEVENSEG"];
    let found = -1;
    this.netlist.components.forEach((c, i) => {
      if (!c.top || c.params["label"] !== pathOrLabel) return;
      if (
        found < 0 ||
        (DISPLAYS.includes(c.instance.kind) && !DISPLAYS.includes(this.netlist.components[found]!.instance.kind))
      )
        found = i;
    });
    if (found < 0) throw new Error(`no component with id or label "${pathOrLabel}"`);
    return found;
  }

  /** Set a switch, button, input pin or clock by id or label, and settle. */
  set(pathOrLabel: string, value: number, settle = true): SimStats {
    const i = this.indexOf(pathOrLabel);
    const c = this.netlist.components[i]!;
    if (!c.def.source) throw new Error(`${pathOrLabel} is a ${c.def.name}, which you cannot set`);
    (this.states[i] as { value: number }).value = value >>> 0;
    this.queue.add(i);
    return settle ? this.settle() : this.stats;
  }

  /** The value at a component's first port (outputs read their input; inputs report what they drive). */
  get(pathOrLabel: string): Signal {
    const i = this.indexOf(pathOrLabel);
    const c = this.netlist.components[i]!;
    const n = c.inputNets[0] ?? c.outputNets[0];
    return n === undefined ? known(1, 0) : this.values[n]!;
  }

  /** The value of an output port of a component, by port name. */
  output(pathOrLabel: string, portIndex = 0): Signal {
    const i = this.indexOf(pathOrLabel);
    return this.outputs[i]![portIndex]!;
  }

  state(pathOrLabel: string): unknown {
    return this.states[this.indexOf(pathOrLabel)];
  }

  /** User actions on a component, like clicking a switch. Returns true if something changed. */
  toggle(index: number): boolean {
    const c = this.netlist.components[index]!;
    const s = this.states[index] as { value: number };
    if (c.instance.kind === "SWITCH" || c.instance.kind === "CLOCK") s.value ^= 1;
    else if (c.instance.kind === "INPUT") {
      const w = Number(c.params["bits"] ?? 1);
      s.value = w === 1 ? s.value ^ 1 : (s.value + 1) % 2 ** w;
    } else return false;
    this.queue.add(index);
    this.settle();
    return true;
  }

  press(index: number, down: boolean): void {
    const s = this.states[index] as { value: number };
    s.value = down ? 1 : 0;
    this.queue.add(index);
    this.settle();
  }
}

function hasConflict(drivers: Signal[]): boolean {
  let driven = 0;
  let v = 0;
  for (const d of drivers) {
    const bits = ~d.z;
    if (driven & bits & (v ^ d.v)) return true;
    v |= d.v & bits;
    driven |= bits;
  }
  return false;
}
