// High-level actions shared by the GUI, keyboard shortcuts, deep links and the
// scripting API (window.studio). Each one ends in spec ops or a job.

import { clone, defaultFor, isObject, SchemaDoc, type Json, type JsonObject, type Path } from "../schema/schema";
import { validateProblem, withKind } from "../schema/validate";
import { addRecent, forgetCurrentFile, openRecent, openSpecFile, parseSpecText, saveSpecFile, setCurrentFile, type RecentFile } from "../lib/files";
import type { Operation } from "../api/types";
import { useConnection } from "./connection";
import { useJobs } from "./jobs";
import { getAt } from "./ops";
import { selectedParticle, useSpec } from "./store";
import { PARTICLE_PRESETS, TEMPLATES } from "./templates";
import { KIND_TEMPLATES } from "./kinds";
import { toast } from "./toast";

/** Make a spec match the connected library's schema (add `kind` for v0.1 specs, drop it for old servers). */
export function normalizeSpec(doc: SchemaDoc, spec: JsonObject): JsonObject {
  const s = withKind(doc, spec) as JsonObject;
  const node = doc.resolve(doc.problemNode());
  const isUnion = !!(node.oneOf || node.anyOf);
  if (!isUnion && !node.properties?.kind && "kind" in s) {
    const { kind: _k, ...rest } = s;
    return rest;
  }
  return s;
}

export function loadSpec(spec: Json, opts: { fileName?: string | null; resetHistory?: boolean } = {}) {
  if (!isObject(spec)) throw new Error("a spec must be a JSON object");
  const doc = useConnection.getState().schema;
  useSpec.getState().setSpec(normalizeSpec(doc, clone(spec)), { resetHistory: opts.resetHistory ?? false, fileName: opts.fileName });
}

export function newFromTemplate(id: string) {
  const t = TEMPLATES.find((x) => x.id === id);
  if (!t) throw new Error(`unknown template ${id}; available: ${TEMPLATES.map((x) => x.id).join(", ")}`);
  forgetCurrentFile();
  loadSpec(t.spec, { fileName: null });
}

/** Start a problem of any kind: its solved example, or schema defaults ("blank"). */
export function newProblemOfKind(kind: string, start: "example" | "blank" = "example") {
  const doc = useConnection.getState().schema;
  const k = doc.problemKinds().find((x) => x.kind === kind);
  if (!k) throw new Error(`unknown problem kind ${kind}`);
  forgetCurrentFile();
  const example = KIND_TEMPLATES[kind];
  if (start === "example" && example) loadSpec(example, { fileName: null });
  else loadSpec(defaultFor(doc, k.node) as JsonObject, { fileName: null });
  const s = useSpec.getState();
  s.select(Array.isArray(s.spec.particles) ? ["particles", 0] : []);
}

export async function openFileAction() {
  const f = await openSpecFile();
  if (!f) return;
  loadSpec(parseSpecText(f.text), { fileName: f.path ?? f.name, resetHistory: true });
  setCurrentFile(f);
  await addRecent(f.name, f.path ?? null, useSpec.getState().spec);
  toast(`Opened ${f.name}`);
}

export async function openRecentAction(r: RecentFile) {
  const f = await openRecent(r);
  loadSpec(parseSpecText(f.text), { fileName: f.path ?? f.name, resetHistory: true });
  setCurrentFile(f);
}

export async function saveFileAction(saveAs = false) {
  const s = useSpec.getState();
  const suggested = (s.fileName?.split(/[\\/]/).pop() ?? "simulation.json").replace(/(\.json)?$/, ".json");
  const res = await saveSpecFile(s.spec, suggested, saveAs);
  if (!res) return;
  s.markSaved(res.path ?? res.name);
  await addRecent(res.name, res.path ?? null, s.spec);
  toast(`Saved ${res.name}`);
}

export function addParticle(presetId = "sphere") {
  const preset = PARTICLE_PRESETS.find((p) => p.id === presetId) ?? PARTICLE_PRESETS[0];
  const s = useSpec.getState();
  const n = Array.isArray(s.spec.particles) ? s.spec.particles.length : 0;
  const p = clone(preset.particle);
  if (n > 0) {
    // place it to the right of the scene
    const xs = (s.spec.particles as JsonObject[]).map((q) => ((q.position_nm as number[]) ?? [0, 0, 0])[0]);
    p.position_nm = [Math.max(...xs) + 90, 0, 0];
  }
  s.apply({ op: "add", path: ["particles", n], value: p });
  s.select(["particles", n]);
}

export function deleteSelection() {
  const s = useSpec.getState();
  const i = selectedParticle(s.selection);
  if (i !== null) {
    const n = (s.spec.particles as Json[]).length;
    if (n <= 1) {
      toast("A simulation needs at least one particle", "warn");
      return;
    }
    s.apply({ op: "remove", path: ["particles", i] });
    s.select(["particles", Math.max(0, i - 1)]);
    return;
  }
  const sel = s.selection;
  if (!sel || sel.length === 0) return;
  // Optional sections (substrate, near/far field) are switched off rather than deleted.
  const v = getAt(s.spec, sel);
  if (v !== undefined && v !== null && ["substrate", "outputs"].includes(String(sel[0]))) s.apply({ op: "replace", path: sel, value: null });
}

export function duplicateSelection() {
  const s = useSpec.getState();
  if (s.copySelection()) s.paste();
}

export function setAtPath(path: Path, value: Json, coalesceKey?: string) {
  useSpec.getState().apply({ op: "replace", path, value }, coalesceKey ? { coalesceKey } : undefined);
}

export function currentIssues() {
  return validateProblem(useConnection.getState().schema, useSpec.getState().spec);
}

export async function runOperation(operation: Operation, opts: { methods?: string[] | null; method?: string; device?: string } = {}) {
  const issues = currentIssues();
  if (issues.length) {
    toast(`Fix ${issues.length} problem${issues.length > 1 ? "s" : ""} in the spec first: ${issues[0].path.join(".")} ${issues[0].message}`, "error");
    throw new Error("spec is invalid");
  }
  const rec = await useJobs.getState().submit(operation, useSpec.getState().spec, opts);
  toast(`Submitted ${rec.label}`);
  return rec;
}
