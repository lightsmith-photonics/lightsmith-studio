// Parameter sweeps: one numeric field of the spec (geometry, materials, wavelengths…) or one numeric backend
// option, over a range. The library has no sweep call, so a sweep is N ordinary solve jobs, each a complete spec
// the library validates and solves; Studio only groups them (JobRecord.sweep) and reduces their curves.

import type { BackendInfo } from "../api/types";
import { clone, isObject, SchemaDoc, type Json, type JsonObject, type JSONSchema, type Path } from "../schema/schema";
import { validateProblem } from "../schema/validate";
import { useConnection } from "./connection";
import { useJobs, type JobRecord } from "./jobs";
import { toast } from "./toast";

export interface SweepParam {
  path: Path;
  label: string;
  /** Current value in the spec (undefined: an option left at its default). */
  value: number | undefined;
  integer: boolean;
  group: "spec" | "options";
}

const SKIP = new Set(["kind", "schema_version"]);

/** Every number in the spec, by path (array elements included), except under `options`. */
function specNumbers(v: Json | undefined, path: Path, out: SweepParam[]) {
  if (typeof v === "number") out.push({ path, label: path.join("."), value: v, integer: Number.isInteger(v) && /num|points|count|modes|bands|iter|order|n_/.test(String(path[path.length - 1])), group: "spec" });
  else if (Array.isArray(v)) v.forEach((x, i) => specNumbers(x, [...path, i], out));
  else if (isObject(v ?? null)) for (const [k, x] of Object.entries(v as JsonObject)) if (!SKIP.has(k) && !(path.length === 0 && k === "options")) specNumbers(x, [...path, k], out);
}

function numericType(doc: SchemaDoc, node: JSONSchema): "number" | "integer" | null {
  const r = doc.resolve(node);
  if (r.type === "integer") return "integer";
  if (r.type === "number") return "number";
  for (const v of [...(r.anyOf ?? []), ...(r.oneOf ?? [])]) {
    const t = numericType(doc, v);
    if (t) return t;
  }
  return null;
}

/** Numeric options of the backends of `method` (their options schemas), under options[method]. */
function optionNumbers(spec: JsonObject, backends: BackendInfo[], method: string): SweepParam[] {
  const kind = typeof spec.kind === "string" ? spec.kind : "scattering";
  const pool = backends.filter((b) => (!b.problem_kinds || b.problem_kinds.includes(kind)) && (method === "auto" || b.method === method || b.name === method) && b.options_schema);
  const out: SweepParam[] = [];
  const seen = new Set<string>();
  for (const b of pool) {
    const os = b.options_schema!;
    const doc = new SchemaDoc(os);
    for (const [k, node] of Object.entries(doc.resolve(os).properties ?? {})) {
      const t = numericType(doc, node as JSONSchema);
      const key = `${b.method}.${k}`;
      if (!t || seen.has(key)) continue;
      seen.add(key);
      const opts = isObject(spec.options) && isObject(spec.options[b.method]) ? (spec.options[b.method] as JsonObject) : {};
      const cur = opts[k];
      const def = doc.resolve(node as JSONSchema).default;
      out.push({ path: ["options", b.method, k], label: `options.${b.method}.${k}`, value: typeof cur === "number" ? cur : typeof def === "number" ? def : undefined, integer: t === "integer", group: "options" });
    }
  }
  return out;
}

export function sweepParams(spec: JsonObject, backends: BackendInfo[], method: string): SweepParam[] {
  const out: SweepParam[] = [];
  specNumbers(spec, [], out);
  return [...out, ...optionNumbers(spec, backends, method)];
}

/** A copy of `spec` with `value` at `path`, creating missing objects (options[method] for a new option). */
export function withValue(spec: JsonObject, path: Path, value: number): JsonObject {
  const s = clone(spec) as JsonObject;
  let o: JsonObject | Json[] = s;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i] as never;
    const next = (o as Record<string, Json>)[k];
    if (!isObject(next ?? null) && !Array.isArray(next)) (o as Record<string, Json>)[k] = typeof path[i + 1] === "number" ? [] : {};
    o = (o as Record<string, Json>)[k] as JsonObject;
  }
  (o as Record<string, Json>)[path[path.length - 1] as never] = value;
  return s;
}

export function linspace(a: number, b: number, n: number, integer = false): number[] {
  const v = n <= 1 ? [a] : Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));
  const out = v.map((x) => (integer ? Math.round(x) : Number(x.toPrecision(10))));
  return [...new Set(out)];
}

export interface SweepRequest {
  spec: JsonObject;
  param: SweepParam;
  values: number[];
  method: string;
}

/** Submit one solve per value. Specs the schema rejects are skipped and reported. Returns the sweep id. */
export async function runSweep(req: SweepRequest): Promise<{ id: string; jobs: JobRecord[]; skipped: number[] }> {
  const id = `sweep-${Date.now().toString(36)}`;
  const doc = useConnection.getState().schema;
  const jobs: JobRecord[] = [];
  const skipped: number[] = [];
  const name = String(req.param.path[req.param.path.length - 1]);
  for (const v of req.values) {
    const spec = withValue(req.spec, req.param.path, v);
    if (validateProblem(doc, spec).length) {
      skipped.push(v);
      continue;
    }
    jobs.push(
      await useJobs.getState().submit("solve", spec, {
        method: req.method,
        label: `${name} = ${v}`,
        sweep: { id, param: req.param.label, path: req.param.path, value: v },
      }),
    );
  }
  if (skipped.length) toast(`Skipped ${skipped.length} value${skipped.length > 1 ? "s" : ""} the schema rejects: ${skipped.join(", ")}`, "warn");
  return { id, jobs, skipped };
}
