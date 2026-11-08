// Job manager: submit / watch / cancel / re-run, with a persistent history.
// The history index lives in localStorage; result payloads (which can be
// large: near-field maps) live in IndexedDB.

import { del, get as idbGet, set as idbSet } from "idb-keyval";
import { create } from "zustand";
import { TERMINAL } from "../api/compute";
import type { JobRequest, JobState, JobStatus, Operation } from "../api/types";
import { clone, type JsonObject } from "../schema/schema";
import { useConnection } from "./connection";

export interface JobRecord {
  /** Local id (unique across servers). */
  key: string;
  id: string;
  server: string;
  serverKind: "mock" | "http";
  operation: Operation;
  method: string;
  methods: string[] | null;
  device: string;
  spec: JsonObject;
  label: string;
  status: JobStatus;
  progress: number | null;
  message: string | null;
  error: { error: string; message: string } | null;
  createdAt: string;
  finishedAt: string | null;
  hasResult: boolean;
  /** Set on the jobs of a parameter sweep (state/sweep.ts). */
  sweep?: SweepTag;
}

export interface SweepTag {
  id: string;
  /** The swept field, as a dotted path. */
  param: string;
  path: (string | number)[];
  /** One job per value: this job's value. */
  value?: number;
  /** One server sweep job: every value. */
  values?: number[];
}

const INDEX_KEY = "studio:jobs";
const memory = new Map<string, unknown>();

async function saveResult(key: string, v: unknown) {
  memory.set(key, v);
  try {
    await idbSet(`result:${key}`, v);
  } catch {
    /* no IndexedDB (tests, private mode): memory only */
  }
}

export async function loadResult(key: string): Promise<JobState["result"] | undefined> {
  if (memory.has(key)) return memory.get(key) as JobState["result"];
  try {
    const v = await idbGet(`result:${key}`);
    if (v !== undefined) memory.set(key, v);
    return v as JobState["result"];
  } catch {
    return undefined;
  }
}

function loadIndex(): JobRecord[] {
  try {
    const raw = globalThis.localStorage?.getItem(INDEX_KEY);
    const list: JobRecord[] = raw ? JSON.parse(raw) : [];
    // Jobs that were running when the app closed: http jobs are re-attached by `resume`, mock jobs are gone.
    return list.map((j) =>
      !TERMINAL.has(j.status) && j.serverKind === "mock" ? { ...j, status: "failed", error: { error: "Lost", message: "the mock server does not survive a reload" } } : j,
    );
  } catch {
    return [];
  }
}

function persist(list: JobRecord[]) {
  try {
    globalThis.localStorage?.setItem(INDEX_KEY, JSON.stringify(list.slice(0, 200)));
  } catch {
    /* ignore */
  }
}

export interface JobsState {
  jobs: JobRecord[];
  /** Jobs whose results are overlaid in the Results view. */
  shown: string[];
  /** Job whose details (near field, far field, provenance) are shown. */
  active: string | null;
  submit(operation: Operation, spec: JsonObject, opts?: { label?: string; method?: string; methods?: string[] | null; device?: string; sweep?: SweepTag }): Promise<JobRecord>;
  cancel(key: string): Promise<void>;
  rerun(key: string): Promise<JobRecord>;
  remove(key: string): void;
  clear(): void;
  toggleShown(key: string, on?: boolean): void;
  setActive(key: string | null): void;
  resume(): void;
}

const unsubscribers = new Map<string, () => void>();

export const useJobs = create<JobsState>((set, get) => {
  const patch = (key: string, p: Partial<JobRecord>) => {
    const jobs = get().jobs.map((j) => (j.key === key ? { ...j, ...p } : j));
    set({ jobs });
    persist(jobs);
  };

  const watch = (rec: JobRecord) => {
    const conn = useConnection.getState();
    const client = conn.client;
    if (client.baseUrl !== rec.server) return;
    unsubscribers.get(rec.key)?.();
    const stop = client.subscribe(rec.id, (e) => {
      if (e.type === "result") {
        void saveResult(rec.key, e.result).then(() => {
          patch(rec.key, { status: "succeeded", progress: 1, hasResult: true, finishedAt: new Date().toISOString() });
          const s = get();
          // sweep jobs go to the Sweep tab, not into the overlay of every run
          if (!rec.sweep) set({ shown: [...new Set([...s.shown, rec.key])], active: rec.key });
        });
        return;
      }
      const p: Partial<JobRecord> = {};
      if (e.status) p.status = e.status;
      if (typeof e.progress === "number") p.progress = e.progress;
      if (e.message) p.message = e.message;
      if (e.error) p.error = e.error;
      if (e.status && TERMINAL.has(e.status)) p.finishedAt = new Date().toISOString();
      patch(rec.key, p);
    });
    unsubscribers.set(rec.key, stop);
  };

  return {
    jobs: loadIndex(),
    shown: [],
    active: null,

    async submit(operation, spec, opts = {}) {
      const conn = useConnection.getState();
      const client = conn.client;
      const method = opts.method ?? conn.method;
      const device = opts.device ?? conn.device;
      const methods = operation === "compare" ? (opts.methods ?? (conn.compareMethods.length ? conn.compareMethods : null)) : null;
      const label = opts.label ?? defaultLabel(operation, method, methods, spec);
      const req: JobRequest = { operation, spec, method, device, label, ...(operation === "compare" ? { methods } : {}), ...(operation === "sweep" && opts.sweep ? { sweep: { path: opts.sweep.path, values: opts.sweep.values ?? [] } } : {}) };
      const state = await client.submit(req);
      const rec: JobRecord = {
        key: `${client.kind}:${state.id}`,
        id: state.id,
        server: client.baseUrl,
        serverKind: client.kind,
        operation,
        method,
        methods,
        device,
        spec: clone(spec),
        label,
        status: state.status,
        progress: state.progress ?? null,
        message: state.message ?? null,
        error: state.error ?? null,
        createdAt: state.created_at ?? new Date().toISOString(),
        finishedAt: null,
        hasResult: false,
        ...(opts.sweep ? { sweep: opts.sweep } : {}),
      };
      const jobs = [rec, ...get().jobs];
      set({ jobs });
      persist(jobs);
      if (TERMINAL.has(state.status) && state.result) {
        await saveResult(rec.key, state.result);
        patch(rec.key, { hasResult: true });
      } else watch(rec);
      return rec;
    },

    async cancel(key) {
      const rec = get().jobs.find((j) => j.key === key);
      if (!rec || TERMINAL.has(rec.status)) return;
      await useConnection.getState().client.cancel(rec.id);
      patch(key, { status: "cancelled", finishedAt: new Date().toISOString() });
      unsubscribers.get(key)?.();
    },

    async rerun(key) {
      const rec = get().jobs.find((j) => j.key === key);
      if (!rec) throw new Error("unknown job");
      // A server sweep job is re-run as a new sweep with the same field and values; one value of a per-value sweep
      // (servers without sweep jobs) stays in its sweep.
      const sweep = rec.sweep && (rec.operation === "sweep" ? { ...rec.sweep, id: `sweep-${Date.now().toString(36)}` } : rec.sweep);
      return get().submit(rec.operation, rec.spec, { method: rec.method, methods: rec.methods, device: rec.device, label: rec.label, ...(sweep ? { sweep } : {}) });
    },

    remove(key) {
      unsubscribers.get(key)?.();
      memory.delete(key);
      void del(`result:${key}`).catch(() => {});
      const jobs = get().jobs.filter((j) => j.key !== key);
      set({ jobs, shown: get().shown.filter((k) => k !== key), active: get().active === key ? null : get().active });
      persist(jobs);
    },

    clear() {
      for (const j of get().jobs) if (TERMINAL.has(j.status)) get().remove(j.key);
    },

    toggleShown(key, on) {
      const s = get().shown;
      const want = on ?? !s.includes(key);
      set({ shown: want ? [...new Set([...s, key])] : s.filter((k) => k !== key) });
    },

    setActive(active) {
      set({ active });
    },

    resume() {
      for (const j of get().jobs) if (!TERMINAL.has(j.status)) watch(j);
    },
  };
});

function defaultLabel(op: Operation, method: string, methods: string[] | null, spec: JsonObject): string {
  const n = Array.isArray(spec.particles) ? spec.particles.length : 0;
  const what = typeof spec.kind === "string" && spec.kind !== "scattering" ? spec.kind : `${n} particle${n === 1 ? "" : "s"}`;
  if (op === "compare") return `compare ${methods?.join(", ") ?? "all"} · ${what}`;
  return `${op} ${method} · ${what}`;
}
