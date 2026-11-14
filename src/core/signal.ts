/**
 * Signals on wires and buses.
 *
 * A signal is up to 32 bits wide. Each bit is in one of four states:
 *
 *   0, 1  a driven logic level
 *   X     unknown: uninitialised, or two drivers disagree
 *   Z     floating: nothing drives it (a tri-state output that is off, or an unconnected wire)
 *
 * The state is packed into three bit masks so whole buses are handled with a few bitwise operations.
 * Invariant: a bit set in `x` or `z` is 0 in `v`, and no bit is set in both `x` and `z`.
 */

export interface Signal {
  readonly width: number;
  readonly v: number; // value bits
  readonly x: number; // unknown bits
  readonly z: number; // floating bits
}

export function mask(width: number): number {
  return width >= 32 ? 0xffffffff : ((1 << width) - 1) >>> 0;
}

export function sig(width: number, v: number, x = 0, z = 0): Signal {
  const m = mask(width);
  x = (x & m & ~z) >>> 0;
  z = (z & m) >>> 0;
  return { width, v: (v & m & ~x & ~z) >>> 0, x, z };
}

export const known = (width: number, value: number): Signal => sig(width, value);
export const unknown = (width: number): Signal => sig(width, 0, mask(width));
export const floating = (width: number): Signal => sig(width, 0, 0, mask(width));

export function isKnown(s: Signal): boolean {
  return s.x === 0 && s.z === 0;
}

export function equal(a: Signal, b: Signal): boolean {
  return a.width === b.width && a.v === b.v && a.x === b.x && a.z === b.z;
}

/** Bits a gate cannot rely on: unknown or floating. */
function unsure(s: Signal): number {
  return (s.x | s.z) >>> 0;
}

export function and(a: Signal, b: Signal): Signal {
  const m = mask(a.width);
  const ua = unsure(a);
  const ub = unsure(b);
  const one = a.v & b.v & ~ua & ~ub;
  const zero = (~a.v & ~ua) | (~b.v & ~ub);
  return sig(a.width, one, ~(one | zero) & m);
}

export function or(a: Signal, b: Signal): Signal {
  const m = mask(a.width);
  const ua = unsure(a);
  const ub = unsure(b);
  const one = (a.v & ~ua) | (b.v & ~ub);
  const zero = ~a.v & ~ua & ~b.v & ~ub;
  return sig(a.width, one, ~(one | zero) & m);
}

export function xor(a: Signal, b: Signal): Signal {
  const x = unsure(a) | unsure(b);
  return sig(a.width, a.v ^ b.v, x);
}

export function not(a: Signal): Signal {
  return sig(a.width, ~a.v, unsure(a));
}

/** Combine every driver of a net. Floating drivers yield; disagreeing drivers produce X. */
export function resolve(width: number, drivers: readonly Signal[]): Signal {
  const m = mask(width);
  let driven = 0;
  let v = 0;
  let x = 0;
  for (const d of drivers) {
    const bits = ~d.z & m;
    const clash = driven & bits & ((v ^ d.v) | x | d.x);
    x |= clash;
    const fresh = bits & ~driven;
    v |= d.v & fresh;
    x |= d.x & fresh;
    driven |= bits;
  }
  return sig(width, v, x, ~driven & m);
}

/** One bit of a signal as a 1-bit signal. */
export function bit(s: Signal, i: number): Signal {
  return sig(1, s.v >>> i, s.x >>> i, s.z >>> i);
}

/** Join 1-bit (or narrower) signals, least significant first. */
export function concat(parts: readonly Signal[]): Signal {
  let v = 0;
  let x = 0;
  let z = 0;
  let shift = 0;
  for (const p of parts) {
    v |= p.v << shift;
    x |= p.x << shift;
    z |= p.z << shift;
    shift += p.width;
  }
  return sig(shift, v, x, z);
}

/** The signal as a number, or null when any bit is X or Z. */
export function toNumber(s: Signal): number | null {
  return isKnown(s) ? s.v >>> 0 : null;
}

export function toSigned(s: Signal): number | null {
  const n = toNumber(s);
  if (n === null) return null;
  if (s.width < 32 && n & (1 << (s.width - 1))) return n - 2 ** s.width;
  return s.width === 32 ? n | 0 : n;
}

/** Text form, most significant bit first: "1010", "1X0Z". */
export function toBits(s: Signal): string {
  let out = "";
  for (let i = s.width - 1; i >= 0; i--) {
    out += (s.z >>> i) & 1 ? "Z" : (s.x >>> i) & 1 ? "X" : (s.v >>> i) & 1 ? "1" : "0";
  }
  return out;
}

export type Radix = "bin" | "dec" | "sdec" | "hex";

export function format(s: Signal, radix: Radix = "hex"): string {
  if (s.width === 1 || radix === "bin") return toBits(s);
  const n = radix === "sdec" ? toSigned(s) : toNumber(s);
  if (n === null) {
    if (s.z === mask(s.width)) return "Z";
    return radix === "hex" ? "X".repeat(Math.ceil(s.width / 4)) : "X";
  }
  if (radix === "hex")
    return n
      .toString(16)
      .toUpperCase()
      .padStart(Math.ceil(s.width / 4), "0");
  return String(n);
}

/** Parse "1010", "0b1010", "0x1F", "-3" or "42" into a signal of the given width. */
export function parse(text: string, width: number): Signal | null {
  const t = text.trim().replace(/_/g, "");
  let n: number;
  if (/^0x[0-9a-f]+$/i.test(t)) n = parseInt(t.slice(2), 16);
  else if (/^0b[01]+$/i.test(t)) n = parseInt(t.slice(2), 2);
  else if (/^-?\d+$/.test(t)) n = parseInt(t, 10);
  else return null;
  if (!Number.isFinite(n)) return null;
  return known(width, n < 0 ? (n + 2 ** Math.min(width, 32)) >>> 0 : n);
}
