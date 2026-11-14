# Contributing to Silica

Thanks for helping. Bug reports with a circuit file are the most useful thing you can send.

## Setup

```bash
git clone https://github.com/jullewz/silica.git
cd silica
npm install
npm run watch      # terminal 1: recompile on change
npm run serve      # terminal 2: http://127.0.0.1:5173
```

Before a pull request:

```bash
npm test
npm run format:check
```

## Where things live

| Change | File |
| --- | --- |
| A new component | `src/core/components.ts` (definition), `src/ui/render.ts` (drawing, if it needs a special look) |
| Signals and logic | `src/core/signal.ts` |
| Wires, nets, subcircuits | `src/core/circuit.ts` |
| Timing and events | `src/core/simulator.ts` |
| Truth tables, minimisation, synthesis | `src/core/analysis.ts` |
| Editor | `src/ui/app.ts` |
| Command line | `src/cli/silica.ts` |

## Adding a component

1. Add a `ComponentDef` to the list in `components.ts`: ports on the edge of its box, parameters with defaults and
   limits, and an `evaluate` that returns one signal per output port.
2. Treat X and Z inputs carefully: if an output depends on an unknown input, it should be X.
3. Sequential parts keep their memory in the state object from `initState` and react to `risingEdge`.
4. Add a test to `tests/core.test.ts`. The test "every definition has consistent ports" checks the geometry.
5. Describe it in `docs/components.md`.

## Rules

- `src/core` must not touch the DOM: it runs in Node for the tests and the command line.
- No runtime dependencies.
- Examples in `src/core/examples.ts` need a test that proves they work.
