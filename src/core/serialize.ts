/**
 * Saving and loading projects as JSON, with validation, plus compact share links.
 */

import { COMPONENTS, normalizeParams } from "./components.js";
import { cleanWires, type Circuit, type ComponentInstance, type Facing, type Project } from "./circuit.js";

export class FormatError extends Error {}

const FACINGS: Facing[] = ["E", "S", "W", "N"];

export function toJSON(project: Project): string {
  return JSON.stringify(project, null, 1);
}

/** Parse and check a project. Unknown fields are dropped, missing parameters get defaults. */
export function fromJSON(text: string): Project {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (e) {
    throw new FormatError(`not valid JSON: ${(e as Error).message}`);
  }
  return validate(data);
}

export function validate(data: unknown): Project {
  const obj = data as Record<string, unknown>;
  if (!obj || typeof obj !== "object") throw new FormatError("a project must be a JSON object");
  if (obj["format"] !== "silica") throw new FormatError('this is not a Silica project (missing "format": "silica")');
  if (obj["version"] !== 1) throw new FormatError(`unsupported project version ${String(obj["version"])}`);
  if (!Array.isArray(obj["circuits"]) || obj["circuits"].length === 0)
    throw new FormatError("a project needs at least one circuit");
  const names = new Set<string>();
  const circuits: Circuit[] = obj["circuits"].map((raw: unknown, ci: number) => {
    const c = raw as Record<string, unknown>;
    const name = typeof c["name"] === "string" && c["name"].trim() ? c["name"].trim() : `circuit ${ci + 1}`;
    if (names.has(name)) throw new FormatError(`two circuits are named "${name}"`);
    names.add(name);
    const ids = new Set<string>();
    const components: ComponentInstance[] = (Array.isArray(c["components"]) ? c["components"] : []).map(
      (r: unknown, k: number) => {
        const comp = r as Record<string, unknown>;
        const kind = String(comp["kind"]);
        const def = COMPONENTS.get(kind);
        if (!def) throw new FormatError(`circuit "${name}": unknown component kind "${kind}"`);
        let id = typeof comp["id"] === "string" && comp["id"] ? comp["id"] : `c${k + 1}`;
        while (ids.has(id)) id += "_";
        ids.add(id);
        const facing = FACINGS.includes(comp["facing"] as Facing) ? (comp["facing"] as Facing) : "E";
        const x = Math.round(Number(comp["x"]));
        const y = Math.round(Number(comp["y"]));
        if (!Number.isFinite(x) || !Number.isFinite(y))
          throw new FormatError(`circuit "${name}": component ${id} has no position`);
        const params = (comp["params"] && typeof comp["params"] === "object" ? comp["params"] : {}) as Record<
          string,
          never
        >;
        return { id, kind, x, y, facing, params: normalizeParams(def, params) };
      },
    );
    const wires = cleanWires(
      (Array.isArray(c["wires"]) ? c["wires"] : [])
        .map((r: unknown) => {
          const w = r as Record<string, unknown>;
          return {
            x1: Math.round(Number(w["x1"])),
            y1: Math.round(Number(w["y1"])),
            x2: Math.round(Number(w["x2"])),
            y2: Math.round(Number(w["y2"])),
          };
        })
        .filter((w) => [w.x1, w.y1, w.x2, w.y2].every(Number.isFinite)),
    );
    return { name, components, wires };
  });
  const main = typeof obj["main"] === "string" && names.has(obj["main"]) ? obj["main"] : circuits[0]!.name;
  return { format: "silica", version: 1, main, circuits };
}

// ------------------------------------------------------------------ share links

function toBase64Url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  const s = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}

/** A compressed, URL-safe form of a project. */
export async function encodeShare(project: Project): Promise<string> {
  const raw = new TextEncoder().encode(JSON.stringify(project));
  return toBase64Url(await pipe(raw, new CompressionStream("deflate-raw")));
}

export async function decodeShare(code: string): Promise<Project> {
  try {
    const raw = await pipe(fromBase64Url(code), new DecompressionStream("deflate-raw"));
    return fromJSON(new TextDecoder().decode(raw));
  } catch (e) {
    if (e instanceof FormatError) throw e;
    throw new FormatError("the share link is damaged");
  }
}
