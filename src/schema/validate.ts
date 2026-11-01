import Ajv2020 from "ajv/dist/2020";
import type { ValidateFunction } from "ajv";
import { SchemaDoc, isObject, type Json, type JSONSchema, type Path } from "./schema";

export interface Issue {
  path: Path;
  message: string;
  /** "schema" errors come from the JSON Schema; "semantic" ones mirror library validators the schema cannot express. */
  source: "schema" | "semantic";
}

const cache = new WeakMap<JSONSchema, ValidateFunction>();

function compile(root: JSONSchema): ValidateFunction {
  let fn = cache.get(root);
  if (!fn) {
    const ajv = new Ajv2020({ strict: false, allErrors: true, validateFormats: false });
    fn = ajv.compile(root);
    cache.set(root, fn);
  }
  return fn;
}

function pointerToPath(ptr: string): Path {
  if (!ptr) return [];
  return ptr
    .split("/")
    .slice(1)
    .map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"))
    .map((s) => (/^\d+$/.test(s) ? Number(s) : s));
}

/** Validate a problem against the live schema plus library-side checks. */
export function validateProblem(doc: SchemaDoc, value: Json): Issue[] {
  const issues: Issue[] = [];
  const fn = compile(doc.root);
  const wrapped = doc.problemNode() !== doc.root;
  if (!fn(doc.wrapProblem(withKind(doc, value)))) {
    const seen = new Set<string>();
    for (const e of fn.errors ?? []) {
      let path = pointerToPath(e.instancePath);
      if (wrapped) path = path.slice(1);
      // oneOf noise: keep the most specific message per path.
      if (e.keyword === "oneOf" || e.keyword === "anyOf" || e.keyword === "if") continue;
      if (e.keyword === "const" && e.instancePath.endsWith("/kind")) continue;
      let message = e.message ?? "invalid";
      if (e.keyword === "additionalProperties") message = `unknown field '${(e.params as { additionalProperty: string }).additionalProperty}'`;
      if (e.keyword === "required") message = `missing '${(e.params as { missingProperty: string }).missingProperty}'`;
      const key = JSON.stringify(path) + message;
      if (seen.has(key)) continue;
      seen.add(key);
      issues.push({ path, message, source: "schema" });
    }
  }
  issues.push(...semanticIssues(value));
  return issues;
}

/** Older v0.1 specs omit `kind`; the library treats that as scattering. */
export function withKind(doc: SchemaDoc, value: Json): Json {
  if (!isObject(value) || "kind" in value) return value;
  const kinds = doc.problemKinds();
  if (kinds.length > 1 || kinds[0]?.kind === "scattering") {
    const hasKindProp = doc.resolve(kinds.find((k) => k.kind === "scattering")?.node ?? {}).properties?.kind;
    if (hasKindProp) return { kind: "scattering", ...value };
  }
  return value;
}

function vec(v: Json | undefined): number[] | null {
  return Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === "number") ? (v as number[]) : null;
}

/** Checks the library's pydantic validators do that JSON Schema cannot express. */
export function semanticIssues(value: Json): Issue[] {
  const out: Issue[] = [];
  if (!isObject(value)) return out;
  const ill = value.illumination;
  if (isObject(ill)) {
    const k = vec(ill.direction);
    const e = vec(ill.polarization);
    if (k && e) {
      const nk = Math.hypot(...k);
      const ne = Math.hypot(...e);
      if (nk === 0 || ne === 0) out.push({ path: ["illumination"], message: "direction and polarization must be non-zero", source: "semantic" });
      else if (Math.abs(k[0] * e[0] + k[1] * e[1] + k[2] * e[2]) > 1e-9 * nk * ne)
        out.push({ path: ["illumination", "polarization"], message: "polarization must be orthogonal to direction", source: "semantic" });
    }
  }
  const w = value.wavelengths;
  if (Array.isArray(w) && (w.length === 0 || w.some((x) => typeof x !== "number" || x <= 0)))
    out.push({ path: ["wavelengths"], message: "wavelengths must be a non-empty list of positive values", source: "semantic" });
  return out;
}

export function pathKey(p: Path): string {
  return p.join("/");
}
