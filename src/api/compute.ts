// Compute API clients. `HttpComputeClient` talks to Lightsmith Cloud (lightsmith-cloud; local
// or hosted); `MockComputeClient` implements the same contract in the browser.
// Every endpoint used here is listed in API_ASSUMPTIONS.md.

import doctorJson from "../generated/doctor.json";
import schemaJson from "../generated/schema.json";
import { clone, isObject, type Json, type JsonObject, type JSONSchema } from "../schema/schema";
import { fdtdSnapshot, fdtdSnapshotResult } from "./mock/snapshots";
import { CANNED_WARNING, estimateMock, MOCK_BACKENDS, problemKind, resolveBackend, SNAPSHOT_WARNING, solveMock, supportsAll } from "./mock/solver";
import {
  ApiError,
  type BackendInfo,
  type CompareResult,
  type Doctor,
  type Estimate,
  type FdtdLayout,
  type JobEvent,
  type JobRequest,
  type JobState,
  type ScatteringResult,
  type SupportInfo,
} from "./types";

export interface ComputeClient {
  readonly kind: "mock" | "http";
  readonly baseUrl: string;
  schema(): Promise<JSONSchema>;
  backends(): Promise<BackendInfo[]>;
  doctor(): Promise<Doctor>;
  estimate(spec: Json, method: string, device: string): Promise<Estimate>;
  /** Per-backend availability and support for this spec, with the library's reasons. */
  supports(spec: Json, backends: BackendInfo[]): Promise<SupportInfo[]>;
  /**
   * The FDTD layout (grid, source and monitor boxes, CPML, mirror planes) the library builds for this spec.
   * Proposed endpoint `POST /v1/layout`; throws ApiError with status 404 where the server lacks it.
   */
  layout(spec: Json, method?: string): Promise<FdtdLayout>;
  submit(req: JobRequest): Promise<JobState>;
  job(id: string): Promise<JobState>;
  cancel(id: string): Promise<void>;
  /** Live job events (WebSocket, falling back to polling). Returns an unsubscribe function. */
  subscribe(id: string, onEvent: (e: JobEvent) => void): () => void;
}

export const TERMINAL = new Set(["succeeded", "failed", "cancelled"]);
/** Compute API contract (lightsmith-cloud API.md): WebSocket auth subprotocol. */
const WS_AUTH_SUBPROTOCOL = "lightsmith.bearer";

/** Turn any error body (ours, FastAPI's `detail`, plain text) into an ApiError. */
export async function toApiError(res: Response): Promise<ApiError> {
  let body: unknown = null;
  const text = await res.text().catch(() => "");
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  const pick = (b: unknown): { error: string; message: string } | null => {
    if (!b) return null;
    if (typeof b === "string") return { error: `HTTP ${res.status}`, message: b };
    if (isObject(b as Json)) {
      const o = b as Record<string, unknown>;
      if (typeof o.message === "string") return { error: String(o.error ?? `HTTP ${res.status}`), message: o.message };
      if ("detail" in o) {
        const d = o.detail;
        if (typeof d === "string") return { error: `HTTP ${res.status}`, message: d };
        if (Array.isArray(d))
          return {
            error: "ValidationError",
            message: d.map((x) => (isObject(x as Json) ? `${((x as JsonObject).loc as Json[] | undefined)?.join(".") ?? ""}: ${(x as JsonObject).msg}` : String(x))).join("; "),
          };
        return pick(d);
      }
    }
    return { error: `HTTP ${res.status}`, message: JSON.stringify(b) };
  };
  const e = pick(body) ?? { error: `HTTP ${res.status}`, message: res.statusText || "request failed" };
  return new ApiError(e.error, e.message, res.status);
}

const stripCannotRun = (msg: string) => msg.replace(/^backend '[^']+' cannot run this (simulation|problem): /, "");

export class HttpComputeClient implements ComputeClient {
  readonly kind = "http" as const;
  constructor(
    readonly baseUrl: string,
    /** Bearer token (API key or sign-in token), or a getter so a refreshed sign-in needs no new client. */
    private readonly auth?: string | (() => string | undefined),
    private readonly fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private get apiKey(): string | undefined {
    return typeof this.auth === "function" ? this.auth() : this.auth;
  }

  private headers(json = false): HeadersInit {
    const h: Record<string, string> = { Accept: "application/json" };
    if (json) h["Content-Type"] = "application/json";
    if (this.apiKey) h.Authorization = `Bearer ${this.apiKey}`;
    return h;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: this.headers(body !== undefined),
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      throw new ApiError("ConnectionError", `cannot reach ${this.baseUrl} (${(e as Error).message}). Is the compute server running?`);
    }
    if (!res.ok) throw await toApiError(res);
    if (res.status === 204) return undefined as T;
    return (await res.json()) as T;
  }

  /** `?all=1` asks for every problem kind; servers that ignore it return the scattering schema. */
  schema() {
    return this.req<JSONSchema>("GET", "/v1/schema?all=1");
  }
  async backends() {
    const list = await this.req<BackendInfo[]>("GET", "/v1/backends");
    // Servers may not publish options schemas yet: borrow the bundled snapshot's for the same backend,
    // matched by name, or by method and name tail (backend names carry the brand prefix).
    const tail = (n: string) => n.split("-").slice(1).join("-") || n;
    const fromSnapshot = (b: BackendInfo) =>
      (MOCK_BACKENDS.find((m) => m.name === b.name) ?? MOCK_BACKENDS.find((m) => m.method === b.method && tail(m.name) === tail(b.name)))?.options_schema ?? null;
    return list.map((b) => ({ ...b, options_schema: b.options_schema ?? fromSnapshot(b) }));
  }
  doctor() {
    return this.req<Doctor>("GET", "/v1/doctor");
  }
  estimate(spec: Json, method: string, device: string) {
    return this.req<Estimate>("POST", "/v1/estimate", { simulation: spec, method, device });
  }
  layout(spec: Json, method = "fdtd") {
    return this.req<FdtdLayout>("POST", "/v1/layout", { simulation: spec, method });
  }

  private noSupportsEndpoint = false;
  private supportsCache = new Map<string, SupportInfo>();

  async supports(spec: Json, backends: BackendInfo[]): Promise<SupportInfo[]> {
    if (!this.noSupportsEndpoint) {
      try {
        return await this.req<SupportInfo[]>("POST", "/v1/supports", { simulation: spec });
      } catch (e) {
        if (!(e instanceof ApiError) || (e.status !== 404 && e.status !== 405)) throw e;
        this.noSupportsEndpoint = true;
      }
    }
    // Fallback: ask /v1/estimate once per backend; its error message is the library's reason.
    const kind = isObject(spec) && typeof spec.kind === "string" ? spec.kind : "scattering";
    const pool = backends.filter((b) => !b.problem_kinds || b.problem_kinds.includes(kind));
    return Promise.all(
      pool.map(async (b): Promise<SupportInfo> => {
        const base = { name: b.name, method: b.method, available: b.available, unavailable_reason: b.unavailable_reason };
        if (!b.available) return { ...base, supported: false, reason: b.unavailable_reason ?? "not available" };
        const key = `${b.name}|${JSON.stringify(spec)}`;
        const hit = this.supportsCache.get(key);
        if (hit) return hit;
        let out: SupportInfo;
        try {
          await this.estimate(spec, b.name, "cpu");
          out = { ...base, supported: true, reason: null };
        } catch (e) {
          // Rate limits and outages say nothing about support; do not cache them.
          if (e instanceof ApiError && (e.status === 429 || e.status === undefined || e.status >= 500)) return { ...base, supported: false, reason: e.message };
          out = { ...base, supported: false, reason: stripCannotRun((e as Error).message) };
        }
        if (this.supportsCache.size > 500) this.supportsCache.clear();
        this.supportsCache.set(key, out);
        return out;
      }),
    );
  }

  async submit(r: JobRequest): Promise<JobState> {
    if (r.operation === "estimate") throw new ApiError("UnsupportedOperation", "estimate is synchronous: use POST /v1/estimate");
    const body = {
      simulation: r.spec,
      kind: r.operation,
      method: r.method ?? "auto",
      methods: r.methods ?? null,
      reference: r.reference ?? null,
      device: r.device ?? "auto",
      label: r.label ?? null,
    };
    return normalizeJob(await this.req<RawJob>("POST", "/v1/jobs", body));
  }

  async job(id: string): Promise<JobState> {
    const j = normalizeJob(await this.req<RawJob>("GET", `/v1/jobs/${encodeURIComponent(id)}`));
    // Results above the inline limit are only available from result_url.
    if (j.status === "succeeded" && !j.result && j.result_url) j.result = await this.req<JobState["result"]>("GET", j.result_url.replace(/^https?:\/\/[^/]+/, ""));
    return j;
  }
  async cancel(id: string) {
    try {
      await this.req<unknown>("DELETE", `/v1/jobs/${encodeURIComponent(id)}`);
    } catch (e) {
      if (e instanceof ApiError && (e.status === 404 || e.status === 405)) await this.req<unknown>("POST", `/v1/jobs/${encodeURIComponent(id)}/cancel`);
      else throw e;
    }
  }

  subscribe(id: string, onEvent: (e: JobEvent) => void): () => void {
    let closed = false;
    let ws: WebSocket | null = null;
    let poll: ReturnType<typeof setInterval> | undefined;
    let lastStatus = "";
    let finished = false;

    const finish = async () => {
      if (finished) return;
      finished = true;
      try {
        const j = await this.job(id);
        if (j.status === "succeeded") onEvent({ type: "result", status: j.status, result: j.result, progress: 1 });
        else onEvent({ type: j.status === "failed" ? "error" : "status", status: j.status, error: j.error, message: j.message ?? undefined });
      } catch (e) {
        onEvent({ type: "error", status: "failed", error: { error: "ConnectionError", message: (e as Error).message } });
      }
      stop();
    };

    const startPolling = () => {
      if (poll || closed) return;
      poll = setInterval(async () => {
        try {
          const j = await this.job(id);
          if (j.status !== lastStatus || j.progress != null) {
            lastStatus = j.status;
            onEvent({ type: "progress", status: j.status, progress: j.progress ?? undefined, message: j.message ?? undefined });
          }
          if (TERMINAL.has(j.status)) void finish();
        } catch {
          /* transient; keep polling */
        }
      }, 1000);
    };

    const stop = () => {
      closed = true;
      if (poll) clearInterval(poll);
      if (ws && ws.readyState <= 1) ws.close();
    };

    try {
      const url = new URL(`${this.baseUrl}/v1/jobs/${encodeURIComponent(id)}/events`);
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      // Browsers cannot set Authorization on a WebSocket; the server accepts the token as a subprotocol.
      const key = this.apiKey;
      ws = key ? new WebSocket(url.toString(), [WS_AUTH_SUBPROTOCOL, key]) : new WebSocket(url.toString());
      ws.onmessage = (m) => {
        let raw: Record<string, unknown>;
        try {
          raw = JSON.parse(String(m.data));
        } catch {
          return;
        }
        const e = normalizeEvent(raw);
        if (e.status) lastStatus = e.status;
        if (raw.type === "end" || e.type === "result" || e.type === "error" || (e.status && TERMINAL.has(e.status))) {
          if (e.type === "result" && e.result) {
            finished = true;
            onEvent(e);
            stop();
          } else void finish();
          return;
        }
        onEvent(e);
      };
      ws.onerror = () => startPolling();
      ws.onclose = () => {
        if (!closed && !finished) startPolling();
      };
    } catch {
      startPolling();
    }
    return stop;
  }
}

// The server's wire shapes (lightsmith-cloud API.md) -> Studio's.
type RawJob = JobState & { job_id?: string; kind?: string; stage?: string; warnings?: string[]; result_url?: string };

function normalizeJob(j: RawJob): JobState & { result_url?: string } {
  const id = j.id ?? j.job_id!;
  const stage = j.stage && j.stage !== "done" ? j.stage.replace(/_/g, " ") : null;
  return { ...j, id, operation: (j.operation ?? j.kind) as JobState["operation"], message: j.message ?? stage };
}

function normalizeEvent(raw: Record<string, unknown>): JobEvent {
  const type = raw.type === "end" ? "status" : (raw.type as JobEvent["type"]);
  const parts = [raw.stage, raw.method].filter(Boolean).map(String);
  const message = (raw.message as string) ?? (raw.line as string) ?? (parts.length ? parts.join(" ").replace(/_/g, " ") : undefined);
  return {
    type,
    status: raw.status as JobEvent["status"],
    progress: typeof raw.progress === "number" ? raw.progress : undefined,
    message,
    error: (raw.error as JobEvent["error"]) ?? undefined,
    result: raw.result as JobEvent["result"],
  };
}

// --- mock -------------------------------------------------------------------

interface MockJob extends JobState {
  request: JobRequest;
  listeners: Set<(e: JobEvent) => void>;
  timer?: ReturnType<typeof setTimeout>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The compute API, implemented in-browser. Latency and progress are simulated. */
export class MockComputeClient implements ComputeClient {
  readonly kind = "mock" as const;
  readonly baseUrl = "mock://compute";
  private jobs = new Map<string, MockJob>();
  private seq = 0;
  constructor(
    private readonly opts: { latencyMs?: number; stepMs?: number; schema?: JSONSchema } = {},
  ) {}

  private async delay() {
    await sleep(this.opts.latencyMs ?? 60);
  }

  async schema() {
    await this.delay();
    return clone(this.opts.schema ?? (schemaJson as JSONSchema));
  }
  async backends() {
    await this.delay();
    return clone(MOCK_BACKENDS);
  }
  async doctor() {
    await this.delay();
    return clone(doctorJson as Doctor);
  }
  async estimate(spec: Json, method: string, device: string) {
    await this.delay();
    return wrap(() => estimateMock(asSpec(spec), method, device));
  }
  async supports(spec: Json) {
    await this.delay();
    return supportsAll(asSpec(spec));
  }
  /** Only the shipped FDTD templates: their layouts are the library's (scripts/fdtd_layout.py). */
  async layout(spec: Json) {
    await this.delay();
    const snap = fdtdSnapshot(spec);
    if (!snap) throw new ApiError("NotFound", "the mock server has the library's layout of the FDTD templates only, as shipped", 404);
    return clone(snap.layout as unknown as Json) as unknown as FdtdLayout;
  }

  async submit(request: JobRequest): Promise<JobState> {
    await this.delay();
    const id = `mock-${Date.now().toString(36)}-${(++this.seq).toString(36)}`;
    const job: MockJob = { id, status: "queued", progress: 0, operation: request.operation, created_at: new Date().toISOString(), request, listeners: new Set() };
    this.jobs.set(id, job);
    job.timer = setTimeout(() => void this.run(job), 50);
    return this.snapshot(job);
  }

  private emit(job: MockJob, e: JobEvent) {
    job.listeners.forEach((l) => l(e));
  }

  private async run(job: MockJob) {
    if (job.status === "cancelled") return;
    job.status = "running";
    job.started_at = new Date().toISOString();
    this.emit(job, { type: "status", status: "running", progress: 0 });
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      await sleep(this.opts.stepMs ?? 120);
      if ((job.status as string) === "cancelled") return;
      job.progress = (i / steps) * 0.95;
      this.emit(job, { type: "progress", status: "running", progress: job.progress, message: `step ${i}/${steps}` });
    }
    try {
      const r = job.request;
      const spec = asSpec(r.spec);
      let result: JobState["result"];
      let snap: Awaited<ReturnType<typeof fdtdSnapshotResult>> = null;
      if (r.operation === "estimate") result = estimateMock(spec, r.method ?? "auto", r.device ?? "auto");
      else if (problemKind(spec) !== "scattering") result = await cannedResult(spec, r);
      else if (r.operation === "solve" && resolveBackend(spec, r.method ?? "auto").method === "fdtd" && (snap = await fdtdSnapshotResult(spec))) {
        const res = clone(snap.result as unknown as Json) as unknown as ScatteringResult;
        result = { ...res, provenance: { ...res.provenance, mock: true, snapshot: snap.id }, warnings: [SNAPSHOT_WARNING, ...(res.warnings ?? [])] };
      }
      else if (r.operation === "compare") result = compareMock(spec, r.methods ?? null, r.device ?? "auto", r.reference ?? null);
      else result = solveMock(spec, r.method ?? "auto", r.device ?? "auto");
      if ((job.status as string) === "cancelled") return;
      Object.assign(job, { status: "succeeded", progress: 1, result, finished_at: new Date().toISOString() });
      this.emit(job, { type: "result", status: "succeeded", progress: 1, result });
    } catch (e) {
      const err = { error: (e as Error).name === "Error" ? "ValueError" : (e as Error).name, message: (e as Error).message };
      Object.assign(job, { status: "failed", error: err, finished_at: new Date().toISOString() });
      this.emit(job, { type: "error", status: "failed", error: err });
    }
  }

  private snapshot(j: MockJob): JobState {
    const { request: _r, listeners: _l, timer: _t, ...rest } = j;
    return clone(rest) as JobState;
  }

  async job(id: string) {
    await this.delay();
    const j = this.jobs.get(id);
    if (!j) throw new ApiError("NotFound", `no job ${id}`, 404);
    return this.snapshot(j);
  }

  async cancel(id: string) {
    const j = this.jobs.get(id);
    if (!j) throw new ApiError("NotFound", `no job ${id}`, 404);
    if (TERMINAL.has(j.status)) return;
    clearTimeout(j.timer);
    j.status = "cancelled";
    j.finished_at = new Date().toISOString();
    this.emit(j, { type: "status", status: "cancelled" });
  }

  subscribe(id: string, onEvent: (e: JobEvent) => void) {
    const j = this.jobs.get(id);
    if (!j) {
      onEvent({ type: "error", status: "failed", error: { error: "NotFound", message: `no job ${id}` } });
      return () => {};
    }
    j.listeners.add(onEvent);
    if (TERMINAL.has(j.status)) {
      onEvent(j.status === "succeeded" ? { type: "result", status: j.status, result: j.result } : { type: "status", status: j.status, error: j.error });
    }
    return () => j.listeners.delete(onEvent);
  }
}

// Solved examples per problem kind (scripts/make_fixtures.py), loaded only when needed.
const FIXTURES = import.meta.glob("../generated/fixtures/*.json", { import: "default" }) as Record<string, () => Promise<{ spec: JsonObject; result: JsonObject | null }>>;

/** The mock's answer for non-scattering kinds: the library's own solved example, clearly labelled. */
async function cannedResult(spec: JsonObject, r: JobRequest): Promise<JobState["result"]> {
  const kind = problemKind(spec);
  const load = FIXTURES[`../generated/fixtures/${kind}.json`];
  const fx = load ? await load() : null;
  if (!fx?.result) throw new Error(`the mock server has no example result for problem kind '${kind}'; connect to a compute server`);
  const one = (method: string) => {
    const b = resolveBackend(spec, method);
    const res = clone(fx.result!) as JsonObject;
    return { ...res, warnings: [CANNED_WARNING, ...((res.warnings as string[]) ?? [])], provenance: { ...(res.provenance as JsonObject), mock: true, requested_backend: b.name } };
  };
  if (r.operation !== "compare") return one(r.method ?? "auto") as JobState["result"];
  const names = r.methods?.length ? r.methods : supportsAll(spec).filter((s) => s.available && s.supported).map((s) => s.name);
  const results = Object.fromEntries(names.map((m) => [m, one(m)]));
  return { reference: names[0], results, relative_difference: Object.fromEntries(names.slice(1).map((m) => [m, {}])) } as unknown as JobState["result"];
}

function asSpec(spec: Json): JsonObject {
  if (!isObject(spec)) throw new ApiError("ValidationError", "spec must be a JSON object", 422);
  return spec;
}

function wrap<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw new ApiError("ValueError", (e as Error).message, 422);
  }
}

function relDiff(a: number[], b: number[]) {
  const rel = a.map((x, i) => Math.abs(x - b[i]) / Math.max(Math.abs(b[i]), 1e-300));
  return { max: Math.max(...rel), rms: Math.sqrt(rel.reduce((s, x) => s + x * x, 0) / rel.length) };
}

export function compareMock(spec: JsonObject, methods: string[] | null, device: string, reference: string | null): CompareResult {
  const list = methods ?? supportsAll(spec).filter((s) => s.available && s.supported).map((s) => s.name);
  if (!list.length) throw new Error("no available backend supports this problem");
  const results: Record<string, ScatteringResult> = {};
  for (const m of list) {
    const r = solveMock(spec, m, device);
    // Give each mock backend a small, method-dependent deviation so the compare view has something to show.
    const amp = r.method === "dda" ? 0.03 : r.method === "tmatrix" ? 0.002 : 0;
    const f = r.wavelengths_nm.map((w) => 1 + amp * (0.5 + 0.5 * Math.cos(w / 40)));
    const scale = (a: number[]) => a.map((x, i) => x * f[i]);
    results[m] = { ...r, c_ext_nm2: scale(r.c_ext_nm2), c_sca_nm2: scale(r.c_sca_nm2), c_abs_nm2: scale(r.c_abs_nm2) };
  }
  const ref = reference ?? Object.keys(results).find((k) => results[k].method === "mie") ?? list[0];
  const relative_difference: CompareResult["relative_difference"] = {};
  for (const [m, r] of Object.entries(results)) {
    if (m === ref) continue;
    relative_difference[m] = Object.fromEntries(
      (["c_ext_nm2", "c_sca_nm2", "c_abs_nm2"] as const).map((q) => [q, relDiff(r[q], results[ref][q])]),
    );
  }
  return { reference: ref, results, relative_difference };
}
