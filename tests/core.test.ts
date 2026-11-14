import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  and,
  concat,
  format,
  mask,
  not,
  or,
  parse,
  resolve,
  sig,
  toBits,
  toNumber,
  unknown,
  floating,
  known,
  xor,
} from "../src/core/signal.js";
import { COMPONENTS, getDef, normalizeParams } from "../src/core/components.js";
import { buildNetlist, emptyProject, portsOf, projectLibrary, rotate, type Project } from "../src/core/circuit.js";
import { Simulator } from "../src/core/simulator.js";
import { fromJSON, toJSON, encodeShare, decodeShare, FormatError } from "../src/core/serialize.js";

describe("signals", () => {
  it("handles 0, 1, X and Z per bit", () => {
    const a = sig(4, 0b1100, 0b0010);
    const b = sig(4, 0b1010, 0, 0b0001);
    assert.equal(toBits(a), "11X0");
    assert.equal(toBits(b), "101Z");
    assert.equal(toBits(and(a, b)), "10X0"); // X AND 1 = X; 0 AND Z = 0
    assert.equal(toBits(or(a, b)), "111X"); // X OR 1 = 1; 0 OR Z = X
    assert.equal(toBits(xor(a, b)), "01XX");
    assert.equal(toBits(not(a)), "00X1");
    assert.equal(toBits(and(sig(1, 0), unknown(1))), "0");
    assert.equal(toBits(or(sig(1, 1), unknown(1))), "1");
  });

  it("resolves several drivers on one net", () => {
    assert.equal(toBits(resolve(2, [sig(2, 0b10, 0, 0b01), sig(2, 0b01, 0, 0b10)])), "11");
    assert.equal(toBits(resolve(2, [sig(2, 0b10), sig(2, 0b11)])), "1X"); // disagreement on bit 0
    assert.equal(toBits(resolve(2, [floating(2), floating(2)])), "ZZ");
  });

  it("formats and parses values", () => {
    assert.equal(format(known(8, 255), "hex"), "FF");
    assert.equal(format(known(8, 255), "sdec"), "-1");
    assert.equal(format(known(8, 200), "dec"), "200");
    assert.equal(format(unknown(8), "hex"), "XX");
    assert.equal(toNumber(parse("0x1f", 8)!), 31);
    assert.equal(toNumber(parse("-1", 8)!), 255);
    assert.equal(toNumber(parse("0b101", 3)!), 5);
    assert.equal(parse("seven", 8), null);
    assert.equal(toNumber(concat([known(1, 1), known(1, 0), known(2, 3)])), 0b1101);
    assert.equal(mask(32), 0xffffffff);
  });
});

function run(kind: string, params: Record<string, unknown>, inputs: number[][]): (number | null)[][] {
  const def = getDef(kind);
  const p = normalizeParams(def, params as never);
  const ports = def.ports(p, projectLibrary(emptyProject()));
  const ins = ports.filter((x) => x.dir === "in");
  const state = def.initState ? def.initState(p) : {};
  return inputs.map((row) =>
    def
      .evaluate(
        row.map((v, i) => (v < 0 ? floating(ins[i]!.width) : known(ins[i]!.width, v))),
        state,
        p,
      )
      .map(toNumber),
  );
}

describe("components", () => {
  it("every definition has consistent ports and parameters", () => {
    for (const def of COMPONENTS.values()) {
      const p = normalizeParams(def, {});
      const size = def.size(p, projectLibrary(emptyProject()));
      for (const port of def.ports(p, projectLibrary(emptyProject()))) {
        assert.ok(
          port.x >= 0 && port.x <= size.w && port.y >= 0 && port.y <= size.h,
          `${def.kind}.${port.name} is outside its box`,
        );
        assert.ok(
          port.x === 0 || port.x === size.w || port.y === 0 || port.y === size.h,
          `${def.kind}.${port.name} is not on the edge`,
        );
      }
    }
  });

  it("gates work for many inputs and wide buses", () => {
    assert.deepEqual(
      run("NAND", { inputs: 3 }, [
        [1, 1, 1],
        [1, 0, 1],
      ]),
      [[0], [1]],
    );
    assert.deepEqual(
      run("XOR", { inputs: 3 }, [
        [1, 1, 1],
        [1, 1, 0],
      ]),
      [[1], [0]],
    );
    assert.deepEqual(run("AND", { bits: 8 }, [[0xf0, 0x3c]]), [[0x30]]);
  });

  it("arithmetic parts compute sums, differences and products", () => {
    assert.deepEqual(
      run("ADDER", { bits: 8 }, [
        [200, 100, 0],
        [1, 2, -1],
      ]),
      [
        [44, 1],
        [3, 0],
      ],
    );
    assert.deepEqual(run("SUBTRACTOR", { bits: 8 }, [[5, 7, 0]]), [[254, 1]]);
    assert.deepEqual(run("MULTIPLIER", { bits: 8 }, [[200, 3]]), [[600 & 255, 2]]);
    assert.deepEqual(run("COMPARATOR", { bits: 8, signed: true }, [[255, 1]]), [[1, 0, 0]]);
    assert.deepEqual(run("SHIFTER", { bits: 8, mode: "rol" }, [[0b10000001, 1]]), [[0b00000011]]);
    assert.deepEqual(run("SHIFTER", { bits: 8, mode: "sar" }, [[0b10000000, 2]]), [[0b11100000]]);
    assert.deepEqual(run("EXTEND", { inBits: 4, outBits: 8, fill: "sign" }, [[0b1010]]), [[0b11111010]]);
  });

  it("plexers select and decode", () => {
    assert.deepEqual(run("MUX", { select: 2, bits: 4 }, [[1, 2, 3, 4, 2]]), [[3]]);
    assert.deepEqual(run("DEMUX", { select: 1 }, [[1, 1]]), [[0, 1]]);
    assert.deepEqual(run("DECODER", { select: 2 }, [[2]]), [[0, 0, 1, 0]]);
    assert.deepEqual(
      run("ENCODER", { select: 2 }, [
        [1, 0, 1, 0],
        [0, 0, 0, 0],
      ]),
      [
        [2, 1],
        [0, 0],
      ],
    );
  });

  it("flip-flops change only on the rising clock edge", () => {
    // D, clk, reset
    assert.deepEqual(
      run("DFF", {}, [
        [1, 0, 0],
        [1, 1, 0],
        [0, 1, 0],
        [0, 0, 0],
        [0, 1, 0],
        [1, 1, 1],
      ]),
      [
        [0, 1],
        [1, 0],
        [1, 0],
        [1, 0],
        [0, 1],
        [0, 1],
      ],
    );
    // J, clk, K, reset: set, then toggle twice
    assert.deepEqual(
      run("JKFF", {}, [
        [1, 0, 0, 0],
        [1, 1, 0, 0],
        [1, 0, 1, 0],
        [1, 1, 1, 0],
        [1, 0, 1, 0],
        [1, 1, 1, 0],
      ]).map((r) => r[0]),
      [0, 1, 1, 0, 0, 1],
    );
  });

  it("memory stores and reads words", () => {
    // addr, din, we, clk
    const out = run("RAM", { addrBits: 2, bits: 8 }, [
      [1, 42, 1, 0],
      [1, 42, 1, 1],
      [2, 7, 0, 0],
      [1, 0, 0, 0],
    ]);
    assert.deepEqual(
      out.map((r) => r[0]),
      [0, 42, 0, 42],
    );
    assert.deepEqual(run("ROM", { addrBits: 2, contents: [9, 8, 7] }, [[2], [3]]), [[7], [0]]);
  });
});

describe("netlists", () => {
  function tiny(): Project {
    const p = emptyProject("t");
    const c = p.circuits[0]!;
    c.components.push(
      { id: "a", kind: "SWITCH", x: 0, y: 0, facing: "E", params: {} },
      { id: "n", kind: "NOT", x: 6, y: 0, facing: "E", params: {} },
      { id: "l", kind: "LED", x: 14, y: 0, facing: "E", params: {} },
      { id: "l2", kind: "LED", x: 14, y: 6, facing: "E", params: {} },
    );
    c.wires.push(
      { x1: 2, y1: 1, x2: 6, y2: 1 },
      { x1: 9, y1: 1, x2: 14, y2: 1 },
      { x1: 4, y1: 1, x2: 4, y2: 7 },
      { x1: 4, y1: 7, x2: 14, y2: 7 },
    );
    return p;
  }

  it("connects wire ends, ports and T-junctions", () => {
    const sim = new Simulator(buildNetlist(tiny()));
    assert.equal(toNumber(sim.get("l")), 1);
    assert.equal(toNumber(sim.get("l2")), 0);
    sim.toggle(sim.indexOf("a"));
    assert.equal(toNumber(sim.get("l")), 0);
    assert.equal(toNumber(sim.get("l2")), 1);
  });

  it("does not connect wires that only cross", () => {
    const p = tiny();
    p.circuits[0]!.wires.push({ x1: 3, y1: -3, x2: 3, y2: 4 }); // crosses the first wire at 3,1 without ending there
    const nl = buildNetlist(p);
    assert.equal(nl.nets.length, buildNetlist(tiny()).nets.length + 1);
  });

  it("reports width mismatches and missing subcircuits", () => {
    const p = emptyProject("w");
    p.circuits[0]!.components.push(
      { id: "a", kind: "INPUT", x: 0, y: 0, facing: "E", params: { bits: 8 } },
      { id: "b", kind: "LED", x: 3, y: 0, facing: "E", params: {} },
      { id: "u", kind: "SUBCIRCUIT", x: 0, y: 10, facing: "E", params: { circuit: "nope" } },
    );
    const errors = buildNetlist(p).errors.map((e) => e.message);
    assert.ok(errors.some((e) => e.includes("width mismatch")));
    assert.ok(errors.some((e) => e.includes('"nope" does not exist')));
  });

  it("rotates ports with the component", () => {
    assert.deepEqual(rotate(0, 1, 3, 2, "E"), [0, 1]);
    assert.deepEqual(rotate(0, 1, 3, 2, "W"), [3, 1]);
    assert.deepEqual(rotate(3, 1, 3, 2, "S"), [1, 3]);
    const ports = portsOf(
      { id: "g", kind: "NOT", x: 10, y: 10, facing: "N", params: {} },
      projectLibrary(emptyProject()),
    );
    assert.deepEqual(
      ports.map((p) => [p.ax, p.ay]),
      [
        [11, 13],
        [11, 10],
      ],
    );
  });

  it("detects oscillation", () => {
    const p = emptyProject("ring");
    p.circuits[0]!.components.push({ id: "n", kind: "NOT", x: 2, y: 2, facing: "E", params: {} });
    p.circuits[0]!.wires.push(
      { x1: 5, y1: 3, x2: 6, y2: 3 },
      { x1: 6, y1: 3, x2: 6, y2: 6 },
      { x1: 6, y1: 6, x2: 1, y2: 6 },
      { x1: 1, y1: 6, x2: 1, y2: 3 },
      { x1: 1, y1: 3, x2: 2, y2: 3 },
    );
    const sim = new Simulator(buildNetlist(p));
    assert.equal(sim.stats.oscillating, false); // X feeds back as X: stable
    sim.values[0] = known(1, 0);
    sim.maxSteps = 100;
    (sim as unknown as { queue: Set<number> }).queue.add(0);
    assert.equal(sim.settle().oscillating, true);
  });
});

describe("saving", () => {
  it("round-trips a project and rejects bad input", async () => {
    const p = emptyProject("x");
    p.circuits[0]!.components.push({ id: "a", kind: "AND", x: 1, y: 2, facing: "S", params: { inputs: 3 } });
    p.circuits[0]!.wires.push({ x1: 5, y1: 1, x2: 1, y2: 1 });
    const back = fromJSON(toJSON(p));
    assert.equal(back.circuits[0]!.components[0]!.params["inputs"], 3);
    assert.equal(back.circuits[0]!.components[0]!.params["bits"], 1);
    assert.deepEqual(back.circuits[0]!.wires, [{ x1: 1, y1: 1, x2: 5, y2: 1 }]);
    const code = await encodeShare(p);
    assert.match(code, /^[A-Za-z0-9_-]+$/);
    assert.deepEqual(await decodeShare(code), back);
    assert.throws(() => fromJSON("{"), FormatError);
    assert.throws(() => fromJSON('{"format":"other"}'), /not a Silica project/);
    assert.throws(
      () => fromJSON('{"format":"silica","version":1,"circuits":[{"components":[{"kind":"WARP"}]}]}'),
      /unknown component kind/,
    );
    await assert.rejects(decodeShare("!!!"), FormatError);
  });
});
