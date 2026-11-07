// The library's own answers for Studio's FDTD templates (scripts/make_fixtures.py): the layout it builds
// (scripts/fdtd_layout.py) and, where it runs, the FDTD solution (fixtures/fdtd/<id>.json, loaded on demand).
// The mock server serves them for those exact specs only; any edit makes the spec a different problem, and the
// mock says it cannot answer.

import fdtdTemplates from "../../generated/fdtd_templates.json";
import { isObject, type Json, type JsonObject } from "../../schema/schema";
import type { FdtdLayout, ScatteringResult } from "../types";

export interface FdtdTemplate {
  id: string;
  name: string;
  description: string;
  spec: JsonObject;
  layout: FdtdLayout;
  /** Whether fixtures/fdtd/<id>.json holds the library's solution. */
  solved: boolean;
}

export const FDTD_TEMPLATES = fdtdTemplates as unknown as FdtdTemplate[];

/** JSON with sorted keys: equal for specs that are the same problem. */
export function canonical(v: Json | undefined): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (isObject(v ?? null)) {
    const o = v as JsonObject;
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(v ?? null);
}

const BY_SPEC = new Map(FDTD_TEMPLATES.map((t) => [canonical(t.spec), t]));

/** The snapshot for exactly this spec, if it is one of the FDTD templates as shipped. */
export function fdtdSnapshot(spec: Json): FdtdTemplate | undefined {
  return BY_SPEC.get(canonical(spec));
}

const RESULTS = import.meta.glob("../../generated/fixtures/fdtd/*.json", { import: "default" }) as Record<string, () => Promise<ScatteringResult>>;

/** The library's FDTD solution of this exact spec, if Studio has it. */
export async function fdtdSnapshotResult(spec: Json): Promise<{ id: string; result: ScatteringResult } | null> {
  const t = fdtdSnapshot(spec);
  const load = t?.solved ? RESULTS[`../../generated/fixtures/fdtd/${t.id}.json`] : undefined;
  return load && t ? { id: t.id, result: await load() } : null;
}
