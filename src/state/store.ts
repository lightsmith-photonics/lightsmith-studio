// The Studio state *is* the spec JSON. UI-only state (selection, panels) lives
// beside it but never inside it. Every edit goes through `apply(ops)`, which
// records undo history, so scripts, agents and the GUI share one code path.

import { create } from "zustand";
import { clone, isObject, type Json, type JsonObject, type Path } from "../schema/schema";
import { applyOps, getAt, type Op } from "./ops";
import { DEFAULT_SPEC } from "./templates";

const HISTORY_LIMIT = 200;
const COALESCE_MS = 600;
const AUTOSAVE_KEY = "studio:autosave";

export interface SpecState {
  spec: JsonObject;
  past: JsonObject[];
  future: JsonObject[];
  /** Ops that produced the latest change (for the live JSON panel and scripting log). */
  lastOps: Op[];
  lastEditKey: string | null;
  lastEditAt: number;
  selection: Path | null;
  clipboard: Json | null;
  /** Path of the file the spec was opened from / saved to (desktop), or a display name (web). */
  fileName: string | null;
  dirty: boolean;

  apply(ops: Op | Op[], opts?: { coalesceKey?: string }): void;
  setSpec(spec: JsonObject, opts?: { resetHistory?: boolean; fileName?: string | null }): void;
  undo(): void;
  redo(): void;
  select(path: Path | null): void;
  copySelection(): boolean;
  paste(): boolean;
  markSaved(fileName?: string | null): void;
}

function loadAutosave(): JsonObject | null {
  try {
    const raw = globalThis.localStorage?.getItem(AUTOSAVE_KEY);
    const v = raw ? JSON.parse(raw) : null;
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
}

let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
function autosave(spec: JsonObject) {
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    try {
      globalThis.localStorage?.setItem(AUTOSAVE_KEY, JSON.stringify(spec));
    } catch {
      /* quota or private mode: autosave is best effort */
    }
  }, 300);
}

/** Particle index of a selection path like ["particles", 2, ...]. */
export function selectedParticle(sel: Path | null): number | null {
  return sel && sel[0] === "particles" && typeof sel[1] === "number" ? sel[1] : null;
}

export const useSpec = create<SpecState>((set, get) => ({
  spec: loadAutosave() ?? clone(DEFAULT_SPEC),
  past: [],
  future: [],
  lastOps: [],
  lastEditKey: null,
  lastEditAt: 0,
  selection: ["particles", 0],
  clipboard: null,
  fileName: null,
  dirty: false,

  apply(opsIn, opts) {
    const ops = Array.isArray(opsIn) ? opsIn : [opsIn];
    if (ops.length === 0) return;
    const s = get();
    const next = applyOps(s.spec, ops);
    if (!isObject(next)) throw new Error("an edit must leave the spec a JSON object");
    const now = Date.now();
    const key = opts?.coalesceKey ?? null;
    const coalesce = key !== null && key === s.lastEditKey && now - s.lastEditAt < COALESCE_MS;
    const past = coalesce ? s.past : [...s.past, s.spec].slice(-HISTORY_LIMIT);
    let selection = s.selection;
    if (selection && getAt(next, selection) === undefined) selection = selection.slice(0, 1);
    set({ spec: next, past, future: [], lastOps: ops, lastEditKey: key, lastEditAt: now, selection, dirty: true });
    autosave(next);
  },

  setSpec(spec, opts) {
    const s = get();
    const resetHistory = opts?.resetHistory ?? false;
    set({
      spec,
      past: resetHistory ? [] : [...s.past, s.spec].slice(-HISTORY_LIMIT),
      future: [],
      lastOps: [{ op: "replace", path: [], value: spec }],
      lastEditKey: null,
      selection: Array.isArray(spec.particles) && spec.particles.length ? ["particles", 0] : [],
      fileName: opts?.fileName !== undefined ? opts.fileName : s.fileName,
      dirty: !resetHistory,
    });
    autosave(spec);
  },

  undo() {
    const s = get();
    const prev = s.past[s.past.length - 1];
    if (!prev) return;
    set({ spec: prev, past: s.past.slice(0, -1), future: [s.spec, ...s.future], lastEditKey: null, dirty: true });
    autosave(prev);
  },

  redo() {
    const s = get();
    const next = s.future[0];
    if (!next) return;
    set({ spec: next, past: [...s.past, s.spec], future: s.future.slice(1), lastEditKey: null, dirty: true });
    autosave(next);
  },

  select(path) {
    set({ selection: path });
  },

  copySelection() {
    const s = get();
    const i = selectedParticle(s.selection);
    if (i === null) return false;
    const p = getAt(s.spec, ["particles", i]);
    if (p === undefined) return false;
    set({ clipboard: clone(p) });
    try {
      void navigator.clipboard?.writeText(JSON.stringify(p, null, 2));
    } catch {
      /* system clipboard is optional */
    }
    return true;
  },

  paste() {
    const s = get();
    const p = s.clipboard;
    if (!isObject(p) || !("shape" in p)) return false;
    const copy = clone(p) as JsonObject;
    // Offset the copy so it does not sit on top of the original.
    const pos = Array.isArray(copy.position_nm) ? (copy.position_nm as number[]) : [0, 0, 0];
    const others = Array.isArray(s.spec.particles) ? (s.spec.particles as Json[]) : [];
    const right = Math.max(...others.map((q) => (isObject(q) && Array.isArray(q.position_nm) ? (q.position_nm[0] as number) : 0) + particleExtent(q)));
    copy.position_nm = [Number((right + particleExtent(copy) * 1.25).toFixed(1)), pos[1], pos[2]];
    const n = others.length;
    get().apply({ op: "add", path: ["particles", n], value: copy });
    set({ selection: ["particles", n], clipboard: copy });
    return true;
  },

  markSaved(fileName) {
    set({ dirty: false, ...(fileName !== undefined ? { fileName } : {}) });
  },
}));

/** Rough half-extent of a particle in nm (for offsets and camera framing). */
export function particleExtent(p: Json): number {
  if (!isObject(p) || !isObject(p.shape)) return 20;
  const s = p.shape as Record<string, number & Json>;
  switch (s.kind as unknown as string) {
    case "sphere":
      return s.radius_nm ?? 20;
    case "spheroid":
      return Math.max(s.semi_axis_xy_nm ?? 20, s.semi_axis_z_nm ?? 20);
    case "cylinder":
      return Math.max(s.radius_nm ?? 10, (s.length_nm ?? 40) / 2);
    case "layered_sphere": {
      const shells = (p.shape as JsonObject).shells;
      const t = Array.isArray(shells) ? shells.reduce<number>((a, sh) => a + (isObject(sh) && typeof sh.thickness_nm === "number" ? sh.thickness_nm : 0), 0) : 0;
      return (s.core_radius_nm ?? 20) + t;
    }
    default:
      return 20;
  }
}
