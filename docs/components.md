# Components

This page is generated from `src/core/components.ts` by `node scripts/components-doc.mjs`. Do not edit it by hand.

Ports are listed in order: inputs first, then outputs. Widths in parentheses use the default parameters.

## Gates

**AND gate** (`AND`). Output is 1 when every input is 1.

- inputs: in0 (1), in1 (1)
- outputs: out (1)
- parameters: `inputs` 2–8, `bits` 1–32, `label`

**OR gate** (`OR`). Output is 1 when any input is 1.

- inputs: in0 (1), in1 (1)
- outputs: out (1)
- parameters: `inputs` 2–8, `bits` 1–32, `label`

**NAND gate** (`NAND`). AND followed by NOT. Every other gate can be built from NANDs.

- inputs: in0 (1), in1 (1)
- outputs: out (1)
- parameters: `inputs` 2–8, `bits` 1–32, `label`

**NOR gate** (`NOR`). OR followed by NOT.

- inputs: in0 (1), in1 (1)
- outputs: out (1)
- parameters: `inputs` 2–8, `bits` 1–32, `label`

**XOR gate** (`XOR`). Output is 1 when an odd number of inputs are 1.

- inputs: in0 (1), in1 (1)
- outputs: out (1)
- parameters: `inputs` 2–8, `bits` 1–32, `label`

**XNOR gate** (`XNOR`). Output is 1 when an even number of inputs are 1.

- inputs: in0 (1), in1 (1)
- outputs: out (1)
- parameters: `inputs` 2–8, `bits` 1–32, `label`

**NOT gate** (`NOT`). Inverts every bit.

- inputs: in (1)
- outputs: out (1)
- parameters: `bits` 1–32, `label`

**Buffer** (`BUFFER`). Passes its input through. Turns Z into X.

- inputs: in (1)
- outputs: out (1)
- parameters: `bits` 1–32, `label`

**Tri-state buffer** (`TRISTATE`). Passes its input when enabled, otherwise lets go of the wire (Z). Lets several parts share a bus.

- inputs: in (1), en (1)
- outputs: out (1)
- parameters: `bits` 1–32, `label`

## Inputs

**Switch** (`SWITCH`). Click to flip between 0 and 1.

- inputs: none
- outputs: out (1)
- parameters: `label`, `value` 0–1

**Push button** (`BUTTON`). Outputs 1 only while you hold it down.

- inputs: none
- outputs: out (1)
- parameters: `label`

**Input pin** (`INPUT`). A value you set, of any width. Inside a subcircuit it becomes one of its inputs.

- inputs: none
- outputs: out (1)
- parameters: `bits` 1–32, `label`, `value` 0–∞

**Constant** (`CONSTANT`). A fixed value.

- inputs: none
- outputs: out (1)
- parameters: `bits` 1–32, `value` 0–∞

**Clock** (`CLOCK`). Flips between 0 and 1 on every simulation tick. Two ticks make one clock cycle.

- inputs: none
- outputs: out (1)
- parameters: `label`

## Outputs

**Output pin** (`OUTPUT`). Shows a value. Inside a subcircuit it becomes one of its outputs.

- inputs: in (1)
- outputs: none
- parameters: `bits` 1–32, `label`, `radix`: hex, dec, sdec, bin

**LED** (`LED`). Lights up on 1.

- inputs: in (1)
- outputs: none
- parameters: `label`, `color`: violet, red, green, amber, blue

**Probe** (`PROBE`). Shows the value on a wire in binary, decimal or hex.

- inputs: in (1)
- outputs: none
- parameters: `bits` 1–32, `label`, `radix`: hex, dec, sdec, bin

**Hex digit display** (`HEX`). Shows a 4-bit value as one hexadecimal digit on seven segments.

- inputs: in (4)
- outputs: none
- parameters: `label`

**7-segment display** (`SEVENSEG`). Lights segments a to g (bits 0 to 6) and the decimal point (bit 7) separately.

- inputs: segments (8)
- outputs: none
- parameters: `label`

## Wiring

**Tunnel** (`TUNNEL`). Connects to every tunnel with the same label in the same circuit, without drawing a wire.

- inputs: io (1)
- outputs: none
- parameters: `bits` 1–32, `label`

**Splitter** (`SPLITTER`). Takes a bus apart into single bits, bit 0 at the top.

- inputs: bus (8)
- outputs: b0 (1), b1 (1), b2 (1), b3 (1), b4 (1), b5 (1), b6 (1), b7 (1)
- parameters: `bits` 1–32

**Merger** (`MERGER`). Joins single bits into a bus, bit 0 at the top.

- inputs: b0 (1), b1 (1), b2 (1), b3 (1), b4 (1), b5 (1), b6 (1), b7 (1)
- outputs: bus (8)
- parameters: `bits` 1–32

**Bit extender** (`EXTEND`). Widens or narrows a value, filling new bits with zeros, ones or the sign bit.

- inputs: in (4)
- outputs: out (8)
- parameters: `inBits` 1–32, `outBits` 1–32, `fill`: zero, one, sign

## Plexers

**Multiplexer** (`MUX`). Passes the input chosen by the select lines.

- inputs: in0 (1), in1 (1), sel (1)
- outputs: out (1)
- parameters: `select` 1–4, `bits` 1–32

**Demultiplexer** (`DEMUX`). Sends its input to the output chosen by the select lines. The other outputs are 0.

- inputs: in (1), sel (1)
- outputs: out0 (1), out1 (1)
- parameters: `select` 1–4, `bits` 1–32

**Decoder** (`DECODER`). Sets exactly one of its outputs to 1: the one numbered by the input.

- inputs: sel (2)
- outputs: out0 (1), out1 (1), out2 (1), out3 (1)
- parameters: `select` 1–4

**Priority encoder** (`ENCODER`). Outputs the number of the highest input that is 1, and whether any input is 1.

- inputs: in0 (1), in1 (1), in2 (1), in3 (1)
- outputs: out (2), any (1)
- parameters: `select` 1–4

## Arithmetic

**Adder** (`ADDER`). Adds two numbers and a carry-in. The carry-out is the bit that did not fit.

- inputs: a (8), b (8), cin (1)
- outputs: sum (8), cout (1)
- parameters: `bits` 1–32

**Subtractor** (`SUBTRACTOR`). Computes a minus b minus borrow-in. Borrow-out is 1 when the result went below zero.

- inputs: a (8), b (8), bin (1)
- outputs: diff (8), bout (1)
- parameters: `bits` 1–32

**Multiplier** (`MULTIPLIER`). Multiplies two unsigned numbers. The product is split into a low and a high half.

- inputs: a (8), b (8)
- outputs: lo (8), hi (8)
- parameters: `bits` 1–32

**Comparator** (`COMPARATOR`). Compares two numbers: less than, equal, greater than.

- inputs: a (8), b (8)
- outputs: lt (1), eq (1), gt (1)
- parameters: `bits` 1–32, `signed`

**Shifter** (`SHIFTER`). Shifts or rotates bits left or right by a variable distance.

- inputs: in (8), dist (3)
- outputs: out (8)
- parameters: `bits` 1–32, `mode`: shl, shr, sar, rol, ror

## Memory

**D flip-flop** (`DFF`). Stores D on the rising edge of the clock. Reset clears it at any time.

- inputs: d (1), clk (1), reset (1)
- outputs: q (1), nq (1)
- parameters: `label`

**T flip-flop** (`TFF`). Flips its state on the rising edge of the clock when T is 1.

- inputs: t (1), clk (1), reset (1)
- outputs: q (1), nq (1)
- parameters: `label`

**JK flip-flop** (`JKFF`). On the rising edge: J sets, K resets, both together toggle.

- inputs: j (1), clk (1), k (1), reset (1)
- outputs: q (1), nq (1)
- parameters: `label`

**Register** (`REGISTER`). Stores a multi-bit value on the rising edge of the clock while enable is 1 (or unconnected).

- inputs: d (8), clk (1), en (1), reset (1)
- outputs: q (8)
- parameters: `bits` 1–32, `label`

**Counter** (`COUNTER`). Counts up by one on each rising clock edge while enabled. Carry is 1 on the last value before wrapping.

- inputs: clk (1), en (1), reset (1)
- outputs: q (4), carry (1)
- parameters: `bits` 1–32, `label`

**RAM** (`RAM`). Read at any time from the address. Writes data on the rising clock edge while write-enable is 1.

- inputs: addr (4), din (8), we (1), clk (1)
- outputs: dout (8)
- parameters: `addrBits` 1–16, `bits` 1–32, `label`

**ROM** (`ROM`). Read-only memory: outputs the stored word at the address. Edit its contents in the properties.

- inputs: addr (4)
- outputs: dout (8)
- parameters: `addrBits` 1–16, `bits` 1–32, `contents`, `label`

## Circuits

**Subcircuit** (`SUBCIRCUIT`). Another circuit of this project, used as one part. Its input and output pins become its ports.

- inputs: none
- outputs: none
- parameters: `circuit`

**Text** (`TEXT`). A note on the canvas.

- inputs: none
- outputs: none
- parameters: `text`

