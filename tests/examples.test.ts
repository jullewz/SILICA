import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EXAMPLES, FIB_PROGRAM, cpuInto } from "../src/core/examples.js";
import { buildNetlist, emptyProject } from "../src/core/circuit.js";
import { Simulator } from "../src/core/simulator.js";
import { toNumber, toBits } from "../src/core/signal.js";
import {
  truthTable,
  simplify,
  synthesize,
  minimize,
  parseExpression,
  variables,
  mintermsOf,
  formatSop,
} from "../src/core/analysis.js";

const build = (id: string) => EXAMPLES.find((e) => e.id === id)!.build();

describe("examples", () => {
  it("every example builds without errors", () => {
    for (const ex of EXAMPLES) assert.deepEqual(buildNetlist(ex.build()).errors, [], ex.id);
  });

  it("half and full adders add", () => {
    assert.deepEqual(truthTable(build("half-adder")).rows, [
      [0, 0, 0, 0],
      [0, 1, 1, 0],
      [1, 0, 1, 0],
      [1, 1, 0, 1],
    ]);
    for (const [a, b, c, s, co] of truthTable(build("full-adder")).rows as number[][])
      assert.equal(a! + b! + c!, s! + 2 * co!);
  });

  it("the 4-bit ripple adder is correct for all 256 inputs", () => {
    const t = truthTable(build("ripple-adder"));
    assert.equal(t.rows.length, 256);
    for (const [a, b, sum, carry] of t.rows as number[][]) assert.equal(a! + b!, sum! + 16 * carry!);
  });

  it("the SR latch remembers", () => {
    const sim = new Simulator(buildNetlist(build("sr-latch")));
    assert.equal(toBits(sim.get("q")), "X"); // no defined state at power-up
    const s = sim.indexOf("s");
    const r = sim.indexOf("r");
    sim.press(s, true);
    sim.press(s, false);
    assert.equal(toNumber(sim.get("q")), 1);
    assert.equal(toNumber(sim.get("nq")), 0);
    sim.press(r, true);
    sim.press(r, false);
    assert.equal(toNumber(sim.get("q")), 0);
  });

  it("the counter counts, wraps and resets", () => {
    const sim = new Simulator(buildNetlist(build("counter")));
    const seen = [];
    for (let i = 0; i < 18; i++) {
      sim.cycle();
      seen.push(toNumber(sim.get("hex")));
    }
    assert.deepEqual(seen.slice(0, 17), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 0, 1]);
    sim.toggle(sim.indexOf("run"));
    sim.cycle(3);
    assert.equal(toNumber(sim.get("hex")), 2);
    const reset = sim.indexOf("reset");
    sim.press(reset, true);
    assert.equal(toNumber(sim.get("hex")), 0);
  });

  it("the CPU prints Fibonacci numbers and halts", () => {
    const sim = new Simulator(buildNetlist(build("cpu")));
    const printed: (number | null)[] = [];
    for (let i = 0; i < 200; i++) {
      const pc = toNumber(sim.get("pcprobe"));
      sim.cycle();
      if (pc !== null && FIB_PROGRAM[pc] === 192) printed.push(toNumber(sim.get("display")));
    }
    assert.deepEqual(printed, [0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144]);
    assert.equal(toNumber(sim.get("pcprobe")), 14);
    assert.equal(toNumber(sim.get("halt")), 1);
  });

  it("the CPU runs other programs", () => {
    // count down from 5 to 0, printing each value: uses a RAM cell holding 255 as -1
    const prog = [
      (3 << 5) | 31, // LDI 31
      (2 << 5) | 20, // STA 20
      (0 << 5) | 20, // LDA 20 (31)
      (1 << 5) | 20, // ADD 20 -> 62
      (1 << 5) | 20, // ADD 20 -> 93
      (6 << 5) | 0, // OUT
      (7 << 5) | 0, // HLT
    ];
    const p = emptyProject("x");
    p.circuits = [];
    p.main = "cpu";
    cpuInto(p, "cpu", prog);
    const sim = new Simulator(buildNetlist(p));
    sim.cycle(10);
    assert.equal(toNumber(sim.get("display")), 93);
  });
});

describe("analysis", () => {
  it("parses expressions in several notations", () => {
    const e = parseExpression("not a and (b or c') xor 1");
    assert.deepEqual(variables(e), ["a", "b", "c"]);
    assert.deepEqual(mintermsOf(parseExpression("a & !b | c"), ["a", "b", "c"]), [1, 3, 4, 5, 7]);
    assert.throws(() => parseExpression("a & (b"), /expected \)/);
    assert.throws(() => parseExpression("a $ b"), /unexpected token/);
  });

  it("minimizes to the classic answers", () => {
    assert.equal(simplify("a & b | a & !b").result, "a");
    assert.equal(simplify("a | !a").result, "1");
    assert.equal(simplify("a & !a").result, "0");
    // f(a,b,c,d) = sum of minterms 0,1,2,5,6,7,8,9,10,14 → b'c' + b'd' + a'bd + bcd'  (one minimal form)
    const imps = minimize(4, [0, 1, 2, 5, 6, 7, 8, 9, 10, 14]);
    const literals = imps.reduce((s, i) => s + i.care.toString(2).split("1").length - 1, 0);
    assert.ok(imps.length <= 4 && literals <= 10, formatSop(imps, ["a", "b", "c", "d"]));
    for (let m = 0; m < 16; m++) {
      const covered = imps.some((i) => (m & i.care) === i.value);
      assert.equal(covered, [0, 1, 2, 5, 6, 7, 8, 9, 10, 14].includes(m), `minterm ${m}`);
    }
  });

  it("synthesized circuits compute their expression", () => {
    for (const text of [
      "a & !b | b & c | !a & !c",
      "a ^ b ^ c",
      "a",
      "!a",
      "a | !a",
      "a & b & c & d | !a & !d",
      "x & y",
    ]) {
      const expr = parseExpression(text);
      const vars = variables(expr);
      const table = truthTable(synthesize(text));
      const want = mintermsOf(expr, vars);
      table.rows.forEach((row, m) => assert.equal(row[vars.length], want.includes(m) ? 1 : 0, `${text} at ${m}`));
      assert.deepEqual(buildNetlist(synthesize(text)).errors, []);
    }
  });
});
