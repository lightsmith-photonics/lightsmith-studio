// Parameter sweeps: the set-up (Run panel) and the Sweep tab, which reduces each run's curve to one number
// (peak, its position, value at x, …) and plots it against the swept parameter, beside the overlaid curves.

import { useEffect, useMemo, useRef, useState } from "react";
import { curvesOf, METRICS, reduce, type Curve, type Metric } from "../lib/curves";
import { exportFile } from "../lib/files";
import { useConnection } from "../state/connection";
import { loadResult, useJobs, type JobRecord } from "../state/jobs";
import { useSpec } from "../state/store";
import { linspace, runSweep, sweepParams } from "../state/sweep";
import { toast } from "../state/toast";
import { useUi } from "../state/ui";
import { ExportButtons, Plot, type PlotHandle } from "./Plot";

export function SweepSetup(props: { disabled: boolean }) {
  const spec = useSpec((s) => s.spec);
  const conn = useConnection();
  const params = useMemo(() => sweepParams(spec, conn.backends, conn.method), [spec, conn.backends, conn.method]);
  const [label, setLabel] = useState<string>("");
  const p = params.find((x) => x.label === label) ?? params[0];
  const v0 = p?.value ?? 1;
  const [range, setRange] = useState<{ start: string; stop: string; num: string }>({ start: "", stop: "", num: "5" });
  // a new parameter starts at ±20 % around its value
  useEffect(() => setRange((r) => ({ ...r, start: String(Number((v0 * 0.8).toPrecision(4))), stop: String(Number((v0 * 1.2).toPrecision(4))) })), [p?.label]); // eslint-disable-line react-hooks/exhaustive-deps
  const values = p ? linspace(Number(range.start), Number(range.stop), Math.max(1, Math.min(50, Math.round(Number(range.num)) || 1)), p.integer) : [];
  const ok = values.length > 0 && values.every(Number.isFinite);
  const run = async () => {
    if (!p) return;
    try {
      const { jobs } = await runSweep({ spec, param: p, values, method: conn.method });
      toast(`Submitted a sweep of ${p.label}: ${jobs.length} solves`);
      useUi.getState().setCenterTab("sweep");
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  if (!params.length) return null;
  return (
    <details className="group" data-testid="sweep-setup">
      <summary>Parameter sweep</summary>
      <p className="muted small">One solve per value, with the method above. Any number in the spec, or a numeric option of the chosen method.</p>
      <div className="field-row">
        <label className="field-label">Parameter</label>
        <div className="field-input">
          <select value={p?.label} onChange={(e) => setLabel(e.target.value)} data-testid="sweep-param">
            <optgroup label="Spec">
              {params
                .filter((x) => x.group === "spec")
                .map((x) => (
                  <option key={x.label} value={x.label}>
                    {x.label} ({x.value})
                  </option>
                ))}
            </optgroup>
            <optgroup label="Solver options">
              {params
                .filter((x) => x.group === "options")
                .map((x) => (
                  <option key={x.label} value={x.label}>
                    {x.label}
                    {x.value !== undefined ? ` (${x.value})` : ""}
                  </option>
                ))}
            </optgroup>
          </select>
        </div>
      </div>
      <div className="field-row">
        <label className="field-label">From, to, points</label>
        <div className="field-input row">
          <input value={range.start} onChange={(e) => setRange({ ...range, start: e.target.value })} data-testid="sweep-start" size={7} />
          <input value={range.stop} onChange={(e) => setRange({ ...range, stop: e.target.value })} data-testid="sweep-stop" size={7} />
          <input value={range.num} onChange={(e) => setRange({ ...range, num: e.target.value })} data-testid="sweep-num" size={3} />
        </div>
      </div>
      <div className="muted small">{ok ? values.join(", ") : "enter numbers"}</div>
      <button onClick={() => void run()} disabled={props.disabled || !ok} data-testid="sweep-run">
        Run sweep ({values.length})
      </button>
    </details>
  );
}

const COLORS = ["#4f9dff", "#ff8a4c", "#38d39f", "#e45bd0", "#f2c94c", "#8c7bff", "#ff5d5d", "#4cd7e4"];

function blue(t: number) {
  // light to deep along the sweep
  const a = [127, 184, 255];
  const b = [255, 138, 76];
  return `rgb(${a.map((x, i) => Math.round(x + (b[i] - x) * t)).join(",")})`;
}

export function SweepView() {
  const jobs = useJobs((s) => s.jobs);
  const sweeps = useMemo(() => {
    const m = new Map<string, JobRecord[]>();
    for (const j of jobs) if (j.sweep) m.set(j.sweep.id, [...(m.get(j.sweep.id) ?? []), j]);
    return [...m.entries()].map(([id, js]) => ({ id, param: js[0].sweep!.param, jobs: [...js].sort((a, b) => a.sweep!.value - b.sweep!.value) }));
  }, [jobs]);
  const [sel, setSel] = useState<string | null>(null);
  const sw = sweeps.find((s) => s.id === sel) ?? sweeps[0];
  const [results, setResults] = useState(new Map<string, unknown>());
  const doneKeys = sw ? sw.jobs.filter((j) => j.hasResult).map((j) => j.key) : [];
  useEffect(() => {
    let live = true;
    void Promise.all(doneKeys.map(async (k) => [k, await loadResult(k)] as const)).then((pairs) => live && setResults(new Map(pairs)));
    return () => {
      live = false;
    };
  }, [doneKeys.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps
  const runs = (sw?.jobs ?? []).map((j) => ({ job: j, value: j.sweep!.value, curves: results.has(j.key) ? curvesOf(results.get(j.key)) : ([] as Curve[]) }));
  const withCurves = runs.filter((r) => r.curves.length);
  const quantities = withCurves[0]?.curves ?? [];
  const [qSel, setQ] = useState<string | null>(null);
  const q = quantities.find((c) => c.id === qSel) ?? quantities[0];
  const [metric, setMetric] = useState<Metric>("peak_y");
  const [at, setAt] = useState("");
  const mplot = useRef<PlotHandle>(null);
  const cplot = useRef<PlotHandle>(null);
  if (!sw)
    return (
      <div className="results empty" data-testid="sweep-view">
        <div>
          <h3>No sweeps yet</h3>
          <p className="muted">Open the Run panel, expand Parameter sweep, pick a field and a range, and run it.</p>
        </div>
      </div>
    );
  const pts = withCurves.map((r) => {
    const c = r.curves.find((x) => x.id === q?.id);
    return { value: r.value, y: c ? reduce(c, metric, Number(at)) : NaN };
  });
  const mlabel = METRICS.find((m) => m.id === metric)!.label + (metric === "at_x" ? ` ${at}` : "");
  const csv = () => void exportFile([["value", `${q?.id} ${metric}`].join(","), ...pts.map((p) => `${p.value},${p.y}`)].join("\n") + "\n", "sweep.csv", "text/csv");
  const failed = runs.filter((r) => r.job.status === "failed");
  return (
    <div className="results-main padded" data-testid="sweep-view">
      <div className="row wrap">
        <h4 className="grow">
          Sweep of <code>{sw.param}</code> · {withCurves.length}/{runs.length} done
          {failed.length ? <span className="warn-text"> · {failed.length} failed</span> : null}
        </h4>
        {sweeps.length > 1 && (
          <select value={sw.id} onChange={(e) => setSel(e.target.value)}>
            {sweeps.map((s) => (
              <option key={s.id} value={s.id}>
                {s.param} ({s.jobs.length})
              </option>
            ))}
          </select>
        )}
        <select value={q?.id} onChange={(e) => setQ(e.target.value)} data-testid="sweep-quantity">
          {quantities.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        <select value={metric} onChange={(e) => setMetric(e.target.value as Metric)} data-testid="sweep-metric">
          {METRICS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        {metric === "at_x" && <input value={at} onChange={(e) => setAt(e.target.value)} size={6} placeholder="x" />}
        <button className="small" onClick={csv}>
          CSV
        </button>
        <ExportButtons plot={mplot} name="sweep" />
      </div>
      <Plot
        ref={mplot}
        data={[{ x: pts.map((p) => p.value), y: pts.map((p) => p.y), mode: "lines+markers", line: { color: COLORS[0], width: 2 }, marker: { size: 7 }, name: mlabel }]}
        layout={{ xaxis: { title: { text: sw.param } }, yaxis: { title: { text: `${q?.label ?? ""}: ${mlabel}` } } }}
        height={260}
        testId="sweep-plot"
      />
      <div className="row wrap">
        <h4 className="grow">{q?.label} per run</h4>
        <ExportButtons plot={cplot} name="sweep-curves" />
      </div>
      <Plot
        ref={cplot}
        data={withCurves.map((r, i) => {
          const c = r.curves.find((x) => x.id === q?.id);
          return { x: c?.x ?? [], y: c?.y ?? [], mode: "lines", name: `${sw.param.split(".").pop()} = ${r.value}`, line: { color: blue(withCurves.length > 1 ? i / (withCurves.length - 1) : 0), width: 2 } };
        })}
        layout={{ xaxis: { title: { text: q?.xLabel ?? "" } }, yaxis: { title: { text: q?.yLabel ?? "" } } }}
        height={260}
        testId="sweep-curves-plot"
      />
      <table className="summary-table" data-testid="sweep-table">
        <thead>
          <tr>
            <th>{sw.param}</th>
            <th>status</th>
            <th>{mlabel}</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => (
            <tr key={r.job.key}>
              <td>{r.value}</td>
              <td title={r.job.error?.message ?? ""}>{r.job.status}</td>
              <td>{Number.isFinite(pts.find((p) => p.value === r.value)?.y ?? NaN) ? Number(pts.find((p) => p.value === r.value)!.y.toPrecision(5)) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
