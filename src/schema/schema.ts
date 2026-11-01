// Generic JSON Schema helpers for the subset pydantic emits (draft 2020-12):
// $ref/$defs, oneOf/anyOf (+discriminator), const, enum, prefixItems tuples,
// additionalProperties maps and plain scalars. Everything the GUI knows about
// the spec's structure comes from here, so new library fields show up
// without code changes.

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonObject = { [k: string]: Json };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type JSONSchema = { [k: string]: any };
export type Path = (string | number)[];

export type EditorKind =
  | "object"
  | "union"
  | "optional"
  | "array"
  | "tuple"
  | "map"
  | "json"
  | "enum"
  | "const"
  | "number"
  | "integer"
  | "string"
  | "boolean"
  | "null"
  | "unknown";

export function isObject(v: unknown): v is JsonObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function clone<T>(v: T): T {
  return v === undefined ? v : (JSON.parse(JSON.stringify(v)) as T);
}

/** Name of the $def a node refers to (or undefined for inline nodes). */
export function refName(node: JSONSchema | undefined): string | undefined {
  const ref: string | undefined = node?.$ref;
  return ref?.startsWith("#/$defs/") ? ref.slice("#/$defs/".length) : undefined;
}

export class SchemaDoc {
  constructor(readonly root: JSONSchema) {}

  get defs(): Record<string, JSONSchema> {
    return this.root.$defs ?? this.root.definitions ?? {};
  }

  /** Follow $ref chains. Sibling keywords next to $ref (description, default) are kept. */
  resolve(node: JSONSchema | undefined): JSONSchema {
    let n: JSONSchema = node ?? {};
    for (let i = 0; i < 32 && n.$ref; i++) {
      const name = refName(n);
      const target = name ? this.defs[name] : undefined;
      if (!target) return { ...n, $unresolved: n.$ref };
      const { $ref: _ref, ...rest } = n;
      n = { ...target, ...rest };
    }
    return n;
  }

  /** The title for a node: its def name, title, or the const of its discriminator. */
  label(node: JSONSchema): string {
    const r = this.resolve(node);
    return refName(node) ?? r.title ?? constKind(this, node) ?? kindOf(this, node);
  }

  /** The schema of "one problem": unwraps {problem: ...} envelopes. */
  problemNode(): JSONSchema {
    const r = this.root;
    const props = r.properties ?? {};
    if (r.type === "object" && Object.keys(props).length === 1 && props.problem) return props.problem;
    return r;
  }

  /** Wrap a problem value the way the root schema expects (for whole-document validation). */
  wrapProblem(value: Json): Json {
    return this.problemNode() === this.root ? value : { problem: value };
  }

  /** Problem kinds available in this schema, e.g. ["scattering", "layer_stack", ...]. */
  problemKinds(): { kind: string; title: string; node: JSONSchema }[] {
    const node = this.problemNode();
    const variants = unionVariants(this, node);
    if (!variants) {
      const k = constKind(this, node) ?? "scattering";
      return [{ kind: k, title: this.resolve(node).title ?? k, node }];
    }
    return variants.map((v) => ({ kind: constKind(this, v) ?? this.label(v), title: this.resolve(v).title ?? "", node: v }));
  }

  /** Schema node for a value path inside a problem of the given value. */
  nodeAt(root: JSONSchema, value: Json, path: Path): JSONSchema | undefined {
    let node: JSONSchema | undefined = root;
    let v: Json | undefined = value;
    for (const key of path) {
      if (!node) return undefined;
      node = this.descend(node, v ?? null, key);
      v = v != null && typeof v === "object" ? (v as never)[key] : undefined;
    }
    return node;
  }

  /** The child schema for `key` given the current value (selects union variants). */
  descend(node: JSONSchema, value: Json, key: string | number): JSONSchema | undefined {
    const kind = classify(this, node);
    const r = this.resolve(node);
    switch (kind) {
      case "optional":
        return this.descend(optionalInner(this, node)!, value, key);
      case "union": {
        const vs = unionVariants(this, node)!;
        return this.descend(vs[matchVariant(this, node, value)], value, key);
      }
      case "object":
        return r.properties?.[key] ?? (typeof r.additionalProperties === "object" ? r.additionalProperties : undefined);
      case "map":
        return r.additionalProperties;
      case "array":
        return r.items;
      case "tuple":
        return r.prefixItems?.[key as number];
      default:
        return undefined;
    }
  }
}

function kindOf(doc: SchemaDoc, node: JSONSchema): string {
  const r = doc.resolve(node);
  return Array.isArray(r.type) ? r.type.join("|") : (r.type ?? "value");
}

/** If a node is an object with a const `kind`-like discriminator, return that const. */
export function constKind(doc: SchemaDoc, node: JSONSchema, prop = "kind"): string | undefined {
  const r = doc.resolve(node);
  const p = r.properties?.[prop];
  return p && "const" in p ? String(p.const) : undefined;
}

function nonNull(doc: SchemaDoc, variants: JSONSchema[]): JSONSchema[] {
  return variants.filter((v) => doc.resolve(v).type !== "null");
}

/** The non-null branch of an `X | None` node. */
export function optionalInner(doc: SchemaDoc, node: JSONSchema): JSONSchema | undefined {
  const r = doc.resolve(node);
  const vs: JSONSchema[] | undefined = r.anyOf ?? r.oneOf;
  if (!vs) return undefined;
  const nn = nonNull(doc, vs);
  if (nn.length !== vs.length && nn.length === 1) return { ...nn[0], ...pick(r, ["description", "title"]) };
  return undefined;
}

function pick(o: JSONSchema, keys: string[]): JSONSchema {
  const out: JSONSchema = {};
  for (const k of keys) if (k in o && !(k in out)) out[k] = o[k];
  return out;
}

/** Variants of a union node, excluding null (null is handled by "optional" or a None choice). */
export function unionVariants(doc: SchemaDoc, node: JSONSchema): JSONSchema[] | undefined {
  const r = doc.resolve(node);
  const vs: JSONSchema[] | undefined = r.oneOf ?? r.anyOf;
  return vs ? nonNull(doc, vs) : undefined;
}

export function unionHasNull(doc: SchemaDoc, node: JSONSchema): boolean {
  const r = doc.resolve(node);
  const vs: JSONSchema[] = r.oneOf ?? r.anyOf ?? [];
  return vs.some((v) => doc.resolve(v).type === "null");
}

export function discriminatorProp(doc: SchemaDoc, node: JSONSchema): string | undefined {
  const r = doc.resolve(node);
  if (r.discriminator?.propertyName) return r.discriminator.propertyName;
  const vs = unionVariants(doc, node) ?? [];
  if (vs.length > 1 && vs.every((v) => constKind(doc, v) !== undefined)) return "kind";
  return undefined;
}

const UNSUPPORTED = ["allOf", "not", "if", "then", "patternProperties", "$dynamicRef", "dependentSchemas", "contains"];

export function classify(doc: SchemaDoc, node: JSONSchema | undefined): EditorKind {
  if (!node) return "unknown";
  if ((node as unknown) === true || (isObject(node) && Object.keys(node).length === 0)) return "json";
  const r = doc.resolve(node);
  if (r.$unresolved) return "unknown";
  // Keywords this form generator does not understand: flag them so the parity test fails loudly.
  if (UNSUPPORTED.some((k) => k in r)) return "unknown";
  if (r.oneOf || r.anyOf) {
    if (optionalInner(doc, node)) return "optional";
    const vs = unionVariants(doc, node)!;
    if (vs.length === 0) return "null";
    if (vs.length === 1 && !unionHasNull(doc, node)) return classify(doc, vs[0]);
    return "union";
  }
  if ("const" in r) return "const";
  if (Array.isArray(r.enum)) return "enum";
  const t = Array.isArray(r.type) ? r.type.find((x: string) => x !== "null") : r.type;
  switch (t) {
    case "object":
      if (r.properties) return "object";
      if (isObject(r.additionalProperties) && Object.keys(r.additionalProperties).length > 0) {
        return classify(doc, r.additionalProperties) === "json" ? "map" : "map";
      }
      return "json";
    case "array":
      if (Array.isArray(r.prefixItems)) return "tuple";
      return "array";
    case "number":
    case "integer":
    case "string":
    case "boolean":
    case "null":
      return t;
    case undefined:
      return "json";
    default:
      return "unknown";
  }
}

/** Index of the union variant that best matches `value`. */
export function matchVariant(doc: SchemaDoc, node: JSONSchema, value: Json): number {
  const vs = unionVariants(doc, node) ?? [];
  const prop = discriminatorProp(doc, node);
  if (prop && isObject(value) && typeof value[prop] === "string") {
    const i = vs.findIndex((v) => constKind(doc, v, prop) === value[prop]);
    if (i >= 0) return i;
  }
  const scores = vs.map((v) => matchScore(doc, v, value));
  let best = 0;
  scores.forEach((s, i) => {
    if (s > scores[best]) best = i;
  });
  return best;
}

function matchScore(doc: SchemaDoc, node: JSONSchema, value: Json): number {
  const kind = classify(doc, node);
  const r = doc.resolve(node);
  if (value === null || value === undefined) return kind === "null" ? 2 : 0;
  if (Array.isArray(value)) return kind === "array" || kind === "tuple" ? 2 : 0;
  if (isObject(value)) {
    if (kind !== "object" && kind !== "map" && kind !== "json") return 0;
    if (kind !== "object") return 1;
    const props = r.properties ?? {};
    const required: string[] = r.required ?? [];
    const keys = Object.keys(value);
    let s = 2;
    if (required.every((k) => k in value)) s += 2;
    if (r.additionalProperties === false && keys.some((k) => !(k in props))) s -= 3;
    s += keys.filter((k) => k in props).length * 0.1;
    return s;
  }
  if (typeof value === "number") return kind === "number" || kind === "integer" ? 2 : 0;
  if (typeof value === "string") return kind === "string" || kind === "enum" || kind === "const" ? 2 : 0;
  if (typeof value === "boolean") return kind === "boolean" ? 2 : 0;
  return 0;
}

/** A sensible starting value: schema defaults first, then minimal valid values. */
export function defaultFor(doc: SchemaDoc, node: JSONSchema | undefined, depth = 0): Json {
  if (!node || depth > 24) return null;
  const r = doc.resolve(node);
  if ("default" in r && !(r.default === null && classify(doc, node) === "optional")) return clone(r.default);
  const kind = classify(doc, node);
  switch (kind) {
    case "const":
      return clone(r.const);
    case "enum":
      return clone(r.enum[0]);
    case "optional":
      return null;
    case "union":
      return defaultFor(doc, unionVariants(doc, node)![0], depth + 1);
    case "object": {
      const out: JsonObject = {};
      const req: string[] = r.required ?? [];
      for (const [k, p] of Object.entries<JSONSchema>(r.properties)) {
        const pr = doc.resolve(p);
        if (req.includes(k) || "const" in pr) out[k] = defaultFor(doc, p, depth + 1);
      }
      return out;
    }
    case "map":
    case "json":
      return {};
    case "array": {
      const n = r.minItems ?? 0;
      return Array.from({ length: n }, () => defaultFor(doc, r.items, depth + 1));
    }
    case "tuple":
      return r.prefixItems.map((p: JSONSchema) => defaultFor(doc, p, depth + 1));
    case "number":
    case "integer": {
      if (typeof r.minimum === "number") return r.minimum;
      if (typeof r.exclusiveMinimum === "number") return r.exclusiveMinimum + 1;
      return 0;
    }
    case "string":
      return "";
    case "boolean":
      return false;
    default:
      return null;
  }
}

/**
 * Like defaultFor, but every optional field is switched on and every optional
 * property is filled. Used by the parity test (every field must get an editor)
 * and handy as an "everything" example.
 */
export function maximalValue(doc: SchemaDoc, node: JSONSchema | undefined, depth = 0): Json {
  if (!node || depth > 12) return null;
  const r = doc.resolve(node);
  const kind = classify(doc, node);
  switch (kind) {
    case "optional":
      return maximalValue(doc, optionalInner(doc, node), depth + 1);
    case "union":
      return maximalValue(doc, unionVariants(doc, node)![0], depth + 1);
    case "object": {
      const out: JsonObject = {};
      for (const [k, p] of Object.entries<JSONSchema>(r.properties)) out[k] = maximalValue(doc, p, depth + 1);
      return out;
    }
    case "map": {
      return { example: maximalValue(doc, r.additionalProperties, depth + 1) };
    }
    case "array": {
      const n = Math.max(1, r.minItems ?? 1);
      return Array.from({ length: n }, () => maximalValue(doc, r.items, depth + 1));
    }
    default: {
      const d = defaultFor(doc, node, depth);
      if (kind === "json" && (d === null || (isObject(d) && Object.keys(d).length === 0))) return { key: 1 };
      return d;
    }
  }
}

export interface SchemaField {
  /** "Def.prop" for properties of named defs, or a JSON path for inline objects. */
  id: string;
  def: string;
  prop: string;
  kind: EditorKind;
}

/** Every (object, property) pair reachable from `start`, with its editor kind. */
export function allFields(doc: SchemaDoc, start: JSONSchema = doc.root): SchemaField[] {
  const out = new Map<string, SchemaField>();
  const seen = new Set<string>();
  const visit = (node: JSONSchema | undefined, where: string) => {
    if (!node || typeof node !== "object") return;
    const name = refName(node);
    if (name) {
      if (seen.has(name)) return;
      seen.add(name);
    }
    const r = doc.resolve(node);
    const owner = name ?? where;
    for (const [k, p] of Object.entries<JSONSchema>(r.properties ?? {})) {
      const id = `${owner}.${k}`;
      out.set(id, { id, def: owner, prop: k, kind: classify(doc, p) });
      visit(p, id);
    }
    for (const key of ["oneOf", "anyOf", "prefixItems"]) (r[key] ?? []).forEach((v: JSONSchema, i: number) => visit(v, `${owner}[${i}]`));
    if (r.items) visit(r.items, `${owner}[]`);
    if (isObject(r.additionalProperties)) visit(r.additionalProperties, `${owner}{}`);
  };
  visit(start, refName(start) ?? doc.resolve(start).title ?? "root");
  return [...out.values()];
}

/** Human label for a property key, e.g. "radius_nm" -> "Radius (nm)". */
export function prettyKey(key: string, node?: JSONSchema): string {
  const units: [RegExp, string][] = [
    [/_nm2$/, " (nm²)"],
    [/_nm$/, " (nm)"],
    [/_ev$/, " (eV)"],
    [/_deg$/, " (°)"],
    [/_um$/, " (µm)"],
    [/_s$/, " (s)"],
  ];
  let unit = "";
  let base = key;
  for (const [re, u] of units) {
    if (re.test(base)) {
      base = base.replace(re, "");
      unit = u;
      break;
    }
  }
  const words = base.split("_").filter(Boolean);
  const special: Record<string, string> = { eps: "ε", inf: "∞", wp: "ωp", omega0: "ω₀", nm: "nm", xy: "xy", xz: "xz", yz: "yz", n: "n", k: "k" };
  const txt = words.map((w, i) => special[w] ?? (i === 0 ? w[0].toUpperCase() + w.slice(1) : w)).join(" ");
  return (txt || node?.title || key) + unit;
}
