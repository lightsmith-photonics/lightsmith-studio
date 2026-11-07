// Run panel: method choice with each backend's support verdict (the library's
// own `supports` reasons), device choice, Estimate, Solve, Compare, and the
// job manager (live progress, cancel, history, re-run).

import { SweepSetup } from "./Sweep";
import { useEffect, useMemo, useState } from "react";
import type { Estimate, SupportInfo } from "../api/types";
import { useConnection } from "../state/connection";
import { useJobs, type JobRecord } from "../state/jobs";
import { useSpec } from "../state/store";
import { loadSpec, runOperation } from "../state/actions";
import { toast } from "../state/toast";
import { fmtNum } from "./Properties";
import { useIssues } from "./SpecForm";
import { useUi } from "../state/ui";

export function fmtBytes(b: number | undefined): string {
  if (b === undefined || !Number.isFinite(b)) return "—";
  if (b === 0) return "≈ 0";
  const u = ["B", "kB", "MB", "GB", "TB"];
  const i = Math.min(u.length - 1, Math.floor(Math.log10(Math.abs(b)) / 3));
  return `${(b / 10 ** (3 * i)).toPrecision(3)} ${u[i]}`;
}

function fmtTime(s: number): string {
  if (s < 1) return "< 1 s";
  if (s < 90) return `${s.toFixed(0)} s`;
  if (s < 5400) return `${(s / 60).toFixed(0)} min`;
  return `${(s / 3600).toFixed(1)} h`;
}

/** Runtime when the server gives one; otherwise a labelled order-of-magnitude guess. */
export function runtimeOf(e: Estimate): { text: string; heuristic: boolean } {
  if (typeof e.estimated_runtime_s === "number") return { text: fmtTime(e.estimated_runtime_s), heuristic: false };
  if (typeof e.seconds_estimate === "number") return { text: fmtTime(e.seconds_estimate), heuristic: false };
  if (e.method === "mie") return { text: "< 1 s", heuristic: true };
  if (typeof e.dipoles === "number") {
    const solves = typeof e.solves === "number" ? e.solves : 1;
    const gpu = typeof e.device === "string" && e.device !== "cpu";
    // ~100 iterations of an FFT matvec on the padded grid per solve
    const grid = Array.isArray(e.grid) ? (e.grid as number[]).reduce((a, b) => a * b, 1) : e.dipoles;
    const perSolve = (8 * grid * Math.log2(Math.max(2, 8 * grid)) * 100 * 9) / (gpu ? 2e11 : 5e9);
    const t = fmtTime(perSolve * solves);
    return { text: t.startsWith("<") ? t : `~${t}`, heuristic: true };
  }
  return { text: "—", heuristic: true };
}

export function useSupport(): { list: SupportInfo[] | null; error: string | null } {
  const spec = useSpec((s) => s.spec);
  const client = useConnection((s) => s.client);
  const backends = useConnection((s) => s.backends);
  const status = useConnection((s) => s.status);
  const [list, setList] = useState<SupportInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (status !== "connected") return;
    let live = true;
    const t = setTimeout(() => {
      client
        .supports(spec, backends)
        .then((x) => live && (setList(x), setError(null)))
        .catch((e) => live && setError((e as Error).message));
    }, 400);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [spec, client, backends, status]);
  return { list, error };
}

export function RunPanel() {
  const conn = useConnection();
  const spec = useSpec((s) => s.spec);
  const issues = useIssues();
  const { list: support, error: supportErr } = useSupport();
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [estErr, setEstErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const openCode = useUi((s) => s.openCode);
  const kind = typeof spec.kind === "string" ? spec.kind : "scattering";
  const relevant = conn.backends.filter((b) => !b.problem_kinds || b.problem_kinds.includes(kind));
  const methods = [...new Set(relevant.map((b) => b.method))];
  const gpus = (conn.doctor?.cuda_gpus as string[] | undefined) ?? [];
  const runnable = (support ?? []).filter((s) => s.available && s.supported).map((s) => s.name);
  const compareSel = conn.compareMethods.length ? conn.compareMethods.filter((m) => runnable.includes(m)) : runnable;

  useEffect(() => {
    setEstimate(null);
    setEstErr(null);
  }, [spec, conn.method, conn.device]);

  const methodOk = useMemo(() => {
    if (!support) return null;
    if (conn.method === "auto") return support.some((s) => s.available && s.supported) ? null : "no available backend supports this problem";
    const cands = support.filter((s) => s.name === conn.method || s.method === conn.method);
    if (!cands.length) return `unknown method or backend '${conn.method}'`;
    const ok = cands.find((s) => s.available && s.supported);
    return ok ? null : (cands[0].reason ?? cands[0].unavailable_reason ?? "not supported");
  }, [support, conn.method]);

  const doEstimate = async () => {
    setBusy(true);
    setEstErr(null);
    try {
      setEstimate(await conn.client.estimate(spec, conn.method, conn.device));
    } catch (e) {
      setEstErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const run = async (op: "solve" | "compare") => {
    try {
      await runOperation(op, op === "compare" ? { methods: compareSel } : {});
    } catch (e) {
      if ((e as Error).message !== "spec is invalid") toast((e as Error).message, "error");
    }
  };

  return (
    <div className="run-panel" data-testid="run-panel">
      <section className="prop-section">
        <h3>Method</h3>
        <div className="field-row">
          <label className="field-label">Method / backend</label>
          <div className="field-input">
            <select value={conn.method} onChange={(e) => conn.setMethod(e.target.value)} data-testid="method-select">
              <option value="auto">auto (most accurate applicable)</option>
              <optgroup label="Methods">
                {methods.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Backends">
                {relevant.map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.name} ({b.method})
                  </option>
                ))}
              </optgroup>
            </select>
          </div>
        </div>
        {methodOk && (
          <div className="warn-box" data-testid="method-warning">
            {methodOk}
          </div>
        )}
        <table className="support-table" data-testid="support-table">
          <thead>
            <tr>
              <th>Backend</th>
              <th>Method</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {relevant.map((b) => {
              const s = support?.find((x) => x.name === b.name);
              const ok = s ? s.available && s.supported : null;
              return (
                <tr key={b.name} className={ok ? "ok" : ok === false ? "no" : ""} title={`${b.license}${b.gpu ? " · GPU" : ""}${b.citation ? ` · ${b.citation}` : ""}`}>
                  <td>
                    {b.name}
                    {b.gpu && <span className="badge">GPU</span>}
                  </td>
                  <td>{b.method}</td>
                  <td data-testid={`support-${b.name}`}>
                    {ok === null ? <span className="muted">…</span> : ok ? "✓ supported" : <span className="reason">✗ {s?.available === false ? (s.unavailable_reason ?? "not installed") : s?.reason}</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {supportErr && <div className="field-error">{supportErr}</div>}
      </section>

      <section className="prop-section">
        <h3>Device</h3>
        <div className="field-row">
          <label className="field-label">Device</label>
          <div className="field-input">
            <select value={conn.device} onChange={(e) => conn.setDevice(e.target.value)} data-testid="device-select">
              <option value="auto">auto{conn.doctor?.auto_device ? ` (${conn.doctor.auto_device.device}${conn.doctor.auto_device.gpu_name ? `, ${conn.doctor.auto_device.gpu_name}` : ""})` : ""}</option>
              <option value="cpu">cpu (NumPy)</option>
              <option value="gpu">gpu</option>
              {gpus.map((g, i) => (
                <option key={i} value={`cuda:${i}`}>
                  cuda:{i} — {g}
                </option>
              ))}
              <option value="torch-cpu">torch-cpu</option>
            </select>
          </div>
        </div>
        {!gpus.length && <div className="muted small">The server reports no CUDA GPU; "gpu" will fail and "auto" uses the CPU.</div>}
      </section>

      <section className="prop-section">
        <h3>Run</h3>
        {issues.length > 0 && (
          <div className="warn-box" data-testid="spec-issues">
            {issues.length} problem{issues.length > 1 ? "s" : ""} in the spec: {issues[0].path.join(".") || "(root)"} — {issues[0].message}
          </div>
        )}
        <div className="row wrap">
          <button onClick={() => void doEstimate()} disabled={busy} data-testid="estimate-btn">
            Estimate
          </button>
          <button className="primary" onClick={() => void run("solve")} disabled={issues.length > 0} data-testid="solve-btn" title="Ctrl+Enter">
            ▶ Solve
          </button>
          <button onClick={() => void run("compare")} disabled={issues.length > 0 || compareSel.length < 1} data-testid="compare-btn">
            Compare ({compareSel.length})
          </button>
          <span className="spacer" />
          <button className="small" onClick={() => openCode("python")}>
            Python
          </button>
          <button className="small" onClick={() => openCode("cli")}>
            CLI
          </button>
        </div>
        {runnable.length > 1 && (
          <div className="compare-select">
            <span className="muted small">Compare:</span>
            {runnable.map((m) => (
              <label key={m} className="small">
                <input
                  type="checkbox"
                  checked={compareSel.includes(m)}
                  onChange={(e) => conn.setCompareMethods(e.target.checked ? [...new Set([...compareSel, m])] : compareSel.filter((x) => x !== m))}
                />{" "}
                {m}
              </label>
            ))}
          </div>
        )}
        <SweepSetup disabled={issues.length > 0} />
        {estErr && <div className="field-error" data-testid="estimate-error">{estErr}</div>}
        {estimate && <EstimateCard e={estimate} />}
      </section>

      <JobList />
    </div>
  );
}

function EstimateCard({ e }: { e: Estimate }) {
  const rt = runtimeOf(e);
  const known = new Set(["backend", "method", "framework", "device", "gpu_name", "memory_bytes", "dipoles", "grid", "estimated_runtime_s"]);
  return (
    <div className="estimate" data-testid="estimate-card">
      <div className="kv">
        <span>Backend</span>
        <b>
          {e.backend} ({e.method})
        </b>
        <span>Device</span>
        <b>
          {String(e.device ?? "?")} · {String(e.framework ?? "")}
          {e.gpu_name ? ` · ${String(e.gpu_name)}` : ""}
        </b>
        {typeof e.dipoles === "number" && (
          <>
            <span>Dipoles</span>
            <b data-testid="estimate-dipoles">{e.dipoles.toLocaleString()}</b>
          </>
        )}
        {Array.isArray(e.grid) && (
          <>
            <span>Grid</span>
            <b>{(e.grid as number[]).join(" × ")}</b>
          </>
        )}
        <span>Memory</span>
        <b data-testid="estimate-memory">{fmtBytes(e.memory_bytes)}</b>
        <span>Time</span>
        <b>
          {rt.text} {rt.heuristic && <span className="muted small">(Studio heuristic)</span>}
        </b>
        {Object.entries(e)
          .filter(([k]) => !known.has(k))
          .map(([k, v]) => (
            <Frag key={k} k={k} v={v} />
          ))}
      </div>
      {e.fits === false && <div className="warn-box">The problem exceeds the backend's size limit (max_dipoles); it will be refused.</div>}
    </div>
  );
}

function Frag({ k, v }: { k: string; v: unknown }) {
  return (
    <>
      <span>{k}</span>
      <b>{typeof v === "number" ? fmtNum(v) : Array.isArray(v) ? v.map((x) => (typeof x === "number" ? fmtNum(x) : String(x))).join(", ") : typeof v === "object" ? JSON.stringify(v) : String(v)}</b>
    </>
  );
}

const STATUS_ICON: Record<string, string> = { queued: "◷", running: "⟳", succeeded: "✓", failed: "✗", cancelled: "⊘" };

export function JobList() {
  const jobs = useJobs((s) => s.jobs);
  const shown = useJobs((s) => s.shown);
  const j = useJobs.getState();
  const setTab = useUi((s) => s.setCenterTab);
  return (
    <section className="prop-section">
      <h3>
        Jobs <span className="muted">({jobs.length})</span>
        <span className="spacer" />
        {jobs.length > 0 && (
          <button className="link" onClick={() => j.clear()}>
            clear finished
          </button>
        )}
      </h3>
      {jobs.length === 0 && <div className="muted small">No runs yet. Solve or Compare to start one.</div>}
      <ul className="jobs" data-testid="job-list">
        {jobs.map((r: JobRecord) => (
          <li key={r.key} className={`job ${r.status}`} data-testid="job" data-status={r.status}>
            <div className="job-head">
              <span className={`status ${r.status}`} title={r.status}>
                {STATUS_ICON[r.status]}
              </span>
              <span className="job-label" title={r.id}>
                {r.label}
              </span>
              <span className="muted small">{new Date(r.createdAt).toLocaleTimeString()}</span>
            </div>
            {(r.status === "running" || r.status === "queued") && (
              <div className="progress">
                <div style={{ width: `${Math.round((r.progress ?? 0) * 100)}%` }} />
              </div>
            )}
            {r.message && r.status === "running" && <div className="muted small">{r.message}</div>}
            {r.error && <div className="field-error small">{r.error.error}: {r.error.message}</div>}
            <div className="job-actions">
              {(r.status === "running" || r.status === "queued") && (
                <button className="small" onClick={() => void j.cancel(r.key).catch((e) => toast((e as Error).message, "error"))} data-testid="job-cancel">
                  Cancel
                </button>
              )}
              {r.hasResult && (
                <>
                  <label className="small">
                    <input type="checkbox" checked={shown.includes(r.key)} onChange={(e) => j.toggleShown(r.key, e.target.checked)} /> overlay
                  </label>
                  <button
                    className="small"
                    onClick={() => {
                      if (r.sweep) return setTab("sweep"); // sweeps have their own tab
                      j.setActive(r.key);
                      j.toggleShown(r.key, true);
                      setTab("results");
                    }}
                    data-testid="job-show"
                  >
                    Results
                  </button>
                </>
              )}
              <button className="small" onClick={() => void j.rerun(r.key).catch((e) => toast((e as Error).message, "error"))} title="Submit the same spec and settings again">
                Re-run
              </button>
              <button className="small" onClick={() => loadSpec(r.spec)} title="Load this job's spec into the editor">
                Load spec
              </button>
              <button className="icon danger" onClick={() => j.remove(r.key)} title="Remove from history">
                ✕
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
