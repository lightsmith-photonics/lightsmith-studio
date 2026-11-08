// The library's own answers for Studio's examples (scripts/make_fixtures.py):
// - the FDTD templates: the layout the library builds for each and its FDTD solution (fixtures/fdtd/<id>.json);
// - layouts.json: for every example (per kind, and the FDTD templates), what each backend that can run it will
//   discretise (scripts/solver_layout.py), loaded on demand.
// The mock server serves them for those exact specs only; any edit makes the spec a different problem, and the
// mock says it cannot answer.

import fdtdTemplates from "../../generated/fdtd_templates.json";
import { isObject, type Json, type JsonObject } from "../../schema/schema";
import type { ScatteringResult, SolverLayout } from "../types";

export interface FdtdTemplate {
  id: string;
  name: string;
  description: string;
  spec: JsonObject;
  /** The library's FDTD layout of the spec (the solver-layout envelope). */
  layout: SolverLayout;
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

/** The FDTD template that is exactly this spec, if any. */
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

type LayoutEntry = { spec: JsonObject; layouts: Record<string, SolverLayout> };
let layouts: Promise<Map<string, Record<string, SolverLayout>>> | null = null;

function layoutIndex() {
  layouts ??= import("../../generated/layouts.json").then((m) => {
    const list = (m.default ?? m) as unknown as LayoutEntry[];
    return new Map(list.map((e) => [canonical(e.spec), e.layouts]));
  });
  return layouts;
}

/** The library's layout of exactly this spec for `backend` (a backend name), if Studio has it. */
export async function layoutSnapshot(spec: Json, backend: string): Promise<SolverLayout | undefined> {
  const t = fdtdSnapshot(spec);
  if (t && t.layout.backend === backend) return t.layout;
  return (await layoutIndex()).get(canonical(spec))?.[backend];
}

/** Every backend with a layout snapshot of exactly this spec. */
export async function layoutSnapshotBackends(spec: Json): Promise<string[]> {
  return Object.keys((await layoutIndex()).get(canonical(spec)) ?? {});
}
