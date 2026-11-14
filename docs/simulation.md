# How the simulation works

## Signals

Every wire carries a signal of 1 to 32 bits. Each bit is in one of four states:

| State | Meaning | Colour |
| --- | --- | --- |
| 0 | driven low | dim violet |
| 1 | driven high | bright violet, glowing |
| X | unknown: never set, or two drivers disagree | red |
| Z | floating: nothing drives it | grey-blue |

A signal is stored as three bit masks (`v` value, `x` unknown, `z` floating), so a 32-bit bus costs the same as one
bit. Gates follow three-valued logic: `0 AND X = 0`, `1 OR X = 1`, `X XOR anything = X`. A floating input counts as X,
with two exceptions: an unconnected carry-in reads as 0, and an unconnected register enable reads as 1.

## From wires to nets

Parts sit on an integer grid. A wire is a horizontal or vertical segment. Two things are connected when they share
a point:

- the ends of two wires
- a wire end and a port
- a wire end (or a port) that lands in the middle of another wire, which is a T-junction, drawn with a dot

Wires that only cross are not connected. Tunnels with the same label in the same circuit are connected without a
wire.

The netlist builder runs a union-find over all those points. It then checks that every port on a net has the same
width, and reports a mismatch at the point where it happens.

**Subcircuits are flattened.** Each instance gets its own copy of the inner parts, with a path like `u3/ha1/g2`.
Inside a subcircuit, input and output pins are not parts. They are junctions merged with whatever is connected to
the matching port outside. A circuit that contains itself, directly or through others, is reported as an error.

## Events and delay

The simulator is event-driven, with one time unit of delay per part:

1. When an input changes (you click a switch, or the clock ticks), that part is put on the queue.
2. Every part on the queue computes its outputs from its current inputs.
3. Each net whose driver changed is resolved from all of its drivers. Several drivers are fine as long as at most
   one drives each bit. Tri-state buffers let go with Z. Disagreeing drivers produce X and count as a bus conflict.
4. Every part reading a changed net goes on the queue for the next step.
5. Repeat until the queue is empty: the circuit has settled.

Because every part takes one step, feedback loops behave like real hardware. An SR latch made of two NOR gates
holds its value. A loop with an odd number of inverters never settles. After 10,000 steps without settling, the
simulator stops and reports that the circuit oscillates.

At start-up every driven net is X. A latch therefore shows X until you set or reset it, the way a real latch has no
defined value at power-up. Flip-flops, registers and counters start at 0.

## Clocks and edges

A clock flips on every **tick**, so two ticks make one **cycle**. Flip-flops, registers, counters and RAM remember the
last clock level they saw and act on a 0 → 1 change, the rising edge. All of them see the edge in the same step,
before any of their outputs change. So in a single-cycle CPU, every register loads the value its input had *before*
the clock edge, exactly as in a synchronous design.

## The 8-bit CPU example

The CPU in the examples executes one instruction per clock cycle:

```text
clock edge ─┬─ PC      ← jump ? operand : PC + 1   (unless HLT)
            ├─ A       ← mux(RAM[operand], A + RAM[operand], operand)   on LDA / ADD / LDI
            ├─ carry   ← carry-out of the adder                         on ADD
            ├─ RAM     ← A at [operand]                                 on STA
            └─ OUT     ← A                                              on OUT
```

| Opcode | Instruction | Effect |
| ---: | --- | --- |
| 0 | `LDA a` | A = RAM[a] |
| 1 | `ADD a` | A = A + RAM[a], carry flag = carry-out |
| 2 | `STA a` | RAM[a] = A |
| 3 | `LDI n` | A = n (0 to 31) |
| 4 | `JMP a` | jump to a |
| 5 | `JC a` | jump to a if the last ADD carried |
| 6 | `OUT` | show A on the output register |
| 7 | `HLT` | stop |

An instruction is one byte: the opcode in the top 3 bits, the operand in the low 5. The ROM holds this program:

```text
 0  LDI 0     4  LDA 30    8  STA 29    12  STA 31
 1  STA 30    5  OUT       9  LDA 31    13  JMP 4
 2  LDI 1     6  ADD 31   10  STA 30    14  HLT
 3  STA 31    7  JC 14    11  LDA 29
```

It prints 0, 1, 1, 2, 3, 5, 8, 13, 21, 34, 55, 89 and 144. The next sum, 233 + 144, would not fit in 8 bits, so the
carry flag stops the program. The test suite runs the CPU and checks that exact sequence. To run your own program,
select the ROM and type new bytes in hex.

## Truth tables and synthesis

**Truth tables** set every combination of the top-level input pins, switches and buttons (up to 16 input bits),
let the circuit settle, and read the output pins, probes and LEDs. When every input is a single bit, Silica also
prints the simplest sum of products for each 1-bit output.

**Simplification** uses the Quine–McCluskey method. It combines minterms into prime implicants, picks the essential
ones, then covers the rest greedily. That is exact for most textbook functions and close to minimal for the rest.

**Synthesis** turns an expression into a two-level circuit. Each input gets a vertical rail and an inverted rail,
each product term becomes an AND gate fed by horizontal wires from the rails, and an OR gate collects the products.
The layout keeps product outputs on even rows and OR inputs on odd rows, so routed wires never touch by accident.
The tests check every synthesized circuit against its expression's truth table.
