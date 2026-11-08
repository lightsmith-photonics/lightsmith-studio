// Compare tab, for every problem kind and backend: overlay one quantity across runs (each method of a Compare
// job, and any runs ticked in Results), plot its difference from a chosen reference, and tabulate the max and
// RMS differences of every quantity the runs share. Curves come from lib/curves.ts.

import { useMemo, useRef, useState } from "react";
import { isCompare, resultKind, type ResultKind } from "../api/types";
import { compareCsv } from "../lib/csv";
import { curvesOf, difference, type Curve } from "../lib/curves";
import { exportFile } from "../lib/files";
import { useJobs } from "../state/jobs";
import { useSeries } from "./Results";
import { MockNotice } from "./MockNotice";
import { ExportButtons, Plot, type PlotHandle } from "./Plot";

const COLORS = ["#4f9dff", "#ff8a4c", "#38d39f", "#e45bd0", "#f2c94c", "#8c7bff", "#ff5d5d", "#4cd7e4"];
const pct = (x: number) => (Number.isFinite(x) ? `${(100 * x).toPrecision(3)} %` : "—");
const num = (x: number) => (Number.isFinite(x) ? x.toPrecision(3) : "—");

export interface CompareRun {
  key: string;
  label: string;
  backend: string;
  kind: ResultKind;
  curves: Curve[];
}

const KIND_NAME: Partial<Record<ResultKind, string>> = {
  cross_sections: "cross sections",
  spectrum: "R/T/A spectra",
  modes: "modes",
  sparameters: "S-parameters",
  bands: "bands",
  emission: "emission",
  optimization: "optimization",
};

export function CompareView() {
  const shown = useJobs((s) => s.shown);
  const jobs = useJobs((s) => s.jobs);
  const compareJobs = jobs.filter((j) => j.operation === "compare" && j.hasResult).map((j) => j.key);
  const keys = useMemo(() => [...new Set([...shown, ...compareJobs])], [shown, compareJobs.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps
  const { compares, raw } = useSeries(keys);
  const runs = useMemo(() => {
    const out: CompareRun[] = [];
    for (const k of keys) {
      const job = jobs.find((j) => j.key === k);
      const r = raw.get(k);
      if (!job || !r) continue;
      const entries: [string, unknown][] = isCompare(r) ? Object.entries(r.results) : [[String((r as { backend?: string }).backend ?? job.method), r]];
      for (const [m, res] of entries) {
        const kind = resultKind(res);
        const curves = curvesOf(res);
        // compare jobs: the backend and the job's subject ("1 particle", "device"), not the list of every backend
        const what = job.label.split(" · ").slice(1).join(" · ");
        if (curves.length) out.push({ key: isCompare(r) ? `${k}#${m}` : k, label: isCompare(r) ? `${m} · compare${what ? ` · ${what}` : ""}` : `${m} · ${job.label}`, backend: m, kind, curves });
      }
    }
    return out;
  }, [keys, jobs, raw]);

  const kinds = [...new Set(runs.map((r) => r.kind))];
  const [kindSel, setKind] = useState<ResultKind | null>(null);
  const kind = kindSel && kinds.includes(kindSel) ? kindSel : [...kinds].sort((a, b) => runs.filter((r) => r.kind === b).length - runs.filter((r) => r.kind === a).length)[0];
  const kr = runs.filter((r) => r.kind === kind);
  const [refKey, setRef] = useState<string | null>(null);
  const ref = kr.find((r) => r.key === refKey) ?? kr.find((r) => /mie|tmm/.test(r.backend)) ?? kr[0];
  // quantities every run of this kind has, in the reference's order
  const common = ref ? ref.curves.filter((c) => kr.every((r) => r.curves.some((d) => d.id === c.id))) : [];
  const [qSel, setQ] = useState<string | null>(null);
  const q = common.find((c) => c.id === qSel) ?? common[0];
  const [mode, setMode] = useState<"rel" | "abs">("rel");
  const oplot = useRef<PlotHandle>(null);
  const dplot = useRef<PlotHandle>(null);

  const others = kr.filter((r) => r !== ref);
  const overlay = useMemo(
    () =>
      q
        ? kr.map((r, i) => {
            const c = r.curves.find((d) => d.id === q.id)!;
            return { x: c.x, y: c.y, name: r.label, mode: "lines", line: { color: COLORS[i % COLORS.length], width: r === ref ? 3 : 2, dash: r === ref ? "solid" : "dash" } };
          })
        : [],
    [kr, q, ref],
  );
  const diffs = useMemo(
    () =>
      q && ref
        ? others.map((r) => {
            const d = difference(r.curves.find((c) => c.id === q.id)!, q);
            return { run: r, d };
          })
        : [],
    [others, q, ref],
  );
  const diffData = diffs.map(({ run, d }) => ({
    x: d.x,
    y: mode === "rel" ? d.rel.map((v) => 100 * v) : d.abs,
    name: run.label,
    mode: "lines+markers",
    marker: { size: 4 },
    line: { color: COLORS[(kr.indexOf(run) + kr.length) % COLORS.length] },
  }));
  // every common quantity: the worst relative difference per run
  const worst = (r: CompareRun) => {
    let best = { id: "", label: "", maxRel: -1, rmsRel: NaN };
    for (const c of common) {
      const d = difference(r.curves.find((x) => x.id === c.id)!, c);
      if (d.maxRel > best.maxRel) best = { id: c.id, label: c.label, maxRel: d.maxRel, rmsRel: d.rmsRel };
    }
    return best;
  };
  const csv = () => {
    const rows = [["run", "quantity", "x", "y", "reference", "difference", "relative"].join(",")];
    for (const { run, d } of diffs) d.x.forEach((x, i) => rows.push([JSON.stringify(run.label), q!.id, x, q!.y[i] + d.abs[i], q!.y[i], d.abs[i], d.rel[i]].join(",")));
    void exportFile(rows.join("\n") + "\n", "compare.csv", "text/csv");
  };

  if (kr.length < 2)
    return (
      <div className="results empty" data-testid="compare-view">
        <div>
          <h3>Nothing to compare yet</h3>
          <p className="muted">Tick two or more backends under Compare in the Run panel and press Compare, or tick two or more runs of the same problem kind in Results.</p>
        </div>
      </div>
    );

  return (
    <div className="results-main padded" data-testid="compare-view">
      <MockNotice results={[...raw.values()]} />
      <div className="row wrap">
        <h4 className="grow">Compare {KIND_NAME[kind] ?? kind}</h4>
        {kinds.length > 1 && (
          <select value={kind} onChange={(e) => setKind(e.target.value as ResultKind)} data-testid="compare-kind">
            {kinds.map((k) => (
              <option key={k} value={k}>
                {KIND_NAME[k] ?? k}
              </option>
            ))}
          </select>
        )}
        <label className="small">
          quantity{" "}
          <select value={q?.id} onChange={(e) => setQ(e.target.value)} data-testid="compare-quantity">
            {common.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
        </label>
        <label className="small">
          reference{" "}
          <select value={ref?.key} onChange={(e) => setRef(e.target.value)} data-testid="compare-ref">
            {kr.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <select value={mode} onChange={(e) => setMode(e.target.value as "rel" | "abs")} data-testid="compare-mode">
          <option value="rel">relative (%)</option>
          <option value="abs">absolute</option>
        </select>
        <button className="small" onClick={csv} disabled={!diffs.length}>
          CSV
        </button>
      </div>
      {!common.length && <div className="warn-box">These runs share no quantity (different ports, polarisations or angles).</div>}
      <div className="row wrap">
        <h4 className="grow">{q?.label}</h4>
        <ExportButtons plot={oplot} name="compare-overlay" />
      </div>
      <Plot ref={oplot} data={overlay} layout={{ xaxis: { title: { text: q?.xLabel ?? "" } }, yaxis: { title: { text: q?.yLabel ?? "" } }, hovermode: "x unified" }} height={260} testId="compare-overlay-plot" />
      <div className="row wrap">
        <h4 className="grow">Difference from {ref?.label}</h4>
        <ExportButtons plot={dplot} name="compare-difference" />
      </div>
      <Plot
        ref={dplot}
        data={diffData}
        layout={{ xaxis: { title: { text: q?.xLabel ?? "" } }, yaxis: { title: { text: mode === "rel" ? "(X − ref) / |ref|  (%)" : `X − ref (${q?.yLabel ?? ""})` }, tickformat: ".3~g" } }}
        height={240}
        testId="compare-plot"
      />
      <table className="summary-table" data-testid="compare-table">
        <thead>
          <tr>
            <th>Run</th>
            <th>max |Δ|/|ref|</th>
            <th>rms</th>
            <th>max |Δ|</th>
            <th>worst of {common.length} quantities</th>
          </tr>
        </thead>
        <tbody>
          {diffs.map(({ run, d }) => {
            const w = worst(run);
            return (
              <tr key={run.key}>
                <td>
                  {run.label}
                  {d.interpolated && <span className="muted small" title="on a different x grid: interpolated onto the reference's"> (interp.)</span>}
                </td>
                <td>{pct(d.maxRel)}</td>
                <td>{pct(d.rmsRel)}</td>
                <td>{num(d.maxAbs)}</td>
                <td>
                  {w.label}: {pct(w.maxRel)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="muted small">Relative differences divide by max(|ref|, 10⁻³ · max |ref|), as the library's compare does, so near-zero reference values do not blow up.</p>
      {compares.map(({ job, cmp }) =>
        Object.keys(cmp.relative_difference).some((m) => Object.keys(cmp.relative_difference[m]).length) ? (
          <div key={job.key} className="panel">
            <div className="row">
              <h4 className="grow">
                Library compare() · {job.label} · reference <code>{cmp.reference}</code>
              </h4>
              <button className="small" onClick={() => void exportFile(compareCsv(cmp), "compare.csv", "text/csv")}>
                CSV
              </button>
            </div>
            <table className="summary-table">
              <thead>
                <tr>
                  <th>Method</th>
                  <th>Quantity</th>
                  <th>max</th>
                  <th>rms</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(cmp.relative_difference).flatMap(([m, d]) =>
                  Object.entries(d).map(([qq, v]) => (
                    <tr key={m + qq}>
                      <td>{m}</td>
                      <td>{qq}</td>
                      <td>{pct(v.max)}</td>
                      <td>{pct(v.rms)}</td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        ) : null,
      )}
    </div>
  );
}
