# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [0.1.0] - 2026-11-15

First public release.

- Browser editor: palette, placing and rotating parts, drawing wires with T-junctions, selection, move, duplicate,
  delete, undo and redo, zoom and pan
- 41 components: gates with up to 8 inputs and 32-bit buses, tri-state buffers, switches, buttons, clocks, pins,
  LEDs, probes, hex and 7-segment displays, tunnels, splitters, mergers, bit extenders, multiplexers, decoders,
  encoders, adders, subtractors, multipliers, comparators, shifters, flip-flops, registers, counters, RAM and ROM
- Four-state signals (0, 1, X, Z) with bus conflict detection
- Event-driven unit-delay simulator with oscillation detection
- Subcircuits: any circuit of a project can be used as a part, nested to any depth
- Timing diagram, truth tables with simplified expressions, and expression-to-circuit synthesis (Quine–McCluskey)
- Examples from a half adder to an 8-bit CPU that runs a Fibonacci program
- Save and open project files, share links that carry the whole project, autosave
- `silica` command line: run, table, simplify, synth, check, examples, export

[0.1.0]: https://github.com/jullewz/silica/releases/tag/v0.1.0
