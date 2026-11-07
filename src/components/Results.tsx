// Results: spectra overlaid across runs and methods, a compare view with
// relative differences, near-field heatmaps (log scale, particle outlines),
// far-field polar and 3D plots, provenance / warnings, and exports.

import { useEffect, useMemo, useRef, useState } from "react";
import { isCompare, isScattering, resultKind, type ResultKind, type AnyResult, type CompareResult, type FarFieldData, type NearFieldData, type ScatteringResult } from "../api/types";
import { halfExtent } from "../api/mock/solver";
import { compareCsv, farFieldCsv, nearFieldCsv, spectraCsv } from "../lib/csv";
import { exportFile } from "../lib/files";
import { isObject, type JsonObject } from "../schema/schema";
import { loadResult, useJobs, type JobRecord } from "../state/jobs";
import { ExportButtons, Plot, type PlotHandle } from "./Plot";
import { Tabs } from "./Modal";
import { fmtNum } from "./Properties";
import { BandsViewer, ModesViewer, OptimizationViewer, SParamViewer, SpectrumViewer, type Run } from "./viewers/KindResults";
import { EmissionViewer, ResonanceTable } from "./viewers/EmissionResults";

const COLORS = ["#4f9dff", "#ff8a4c", "#38d39f", "#e45bd0", "#f2c94c", "#8c7bff", "#ff5d5d", "#4cd7e4"];
const DASH: Record<string, string> = { c_ext_nm2: "solid", c_sca_nm2: "dash", c_abs_nm2: "dot" };
const QNAME: Record<string, string> = { c_ext_nm2: "ext", c_sca_nm2: "sca", c_abs_nm2: "abs" };
type Q = "c_ext_nm2" | "c_sca_nm2" | "c_abs_nm2";

export interface Series {
  key: string;
  label: string;
  job: JobRecord;
  result: ScatteringResult;
}

/** Load results of the given jobs (compare jobs expand into one series per method). */
export function useSeries(keys: string[]): { series: Series[]; compares: { job: JobRecord; cmp: CompareResult }[]; raw: Map<string, AnyResult | CompareResult> } {
  const jobs = useJobs((s) => s.jobs);
  const [raw, setRaw] = useState(new Map<string, AnyResult | CompareResult>());
  useEffect(() => {
    let live = true;
    void Promise.all(keys.map(async (k) => [k, await loadResult(k)] as const)).then((pairs) => {
      if (!live) return;
      const m = new Map<string, AnyResult | CompareResult>();
      for (const [k, v] of pairs) if (v) m.set(k, v as AnyResult);
      setRaw(m);
    });
    return () => {
      live = false;
    };
  }, [keys.join("|"), jobs]); // eslint-disable-line react-hooks/exhaustive-deps
  return useMemo(() => {
    const series: Series[] = [];
    const compares: { job: JobRecord; cmp: CompareResult }[] = [];
    for (const k of keys) {
      const job = jobs.find((j) => j.key === k);
      const r = raw.get(k);
      if (!job || !r) continue;
      if (isCompare(r)) {
        compares.push({ job, cmp: r });
        for (const [m, res] of Object.entries(r.results)) if (isScattering(res)) series.push({ key: `${k}#${m}`, label: `${m} · ${job.label}`, job, result: res });
      } else if (isScattering(r)) series.push({ key: k, label: `${r.backend} · ${job.label}`, job, result: r });
    }
    return { series, compares, raw };
  }, [keys, jobs, raw]);
}

export function ResultsView() {
  const jobs = useJobs((s) => s.jobs);
  const shown = useJobs((s) => s.shown);
  const active = useJobs((s) => s.active);
  const setActive = useJobs((s) => s.setActive);
  const toggle = useJobs((s) => s.toggleShown);
  const withResults = jobs.filter((j) => j.hasResult);
  const { series, raw } = useSeries(shown);
  const activeKey = active && withResults.some((j) => j.key === active) ? active : (shown[0] ?? withResults[0]?.key ?? null);
  const { series: activeSeries, raw: activeRaw } = useSeries(activeKey ? [activeKey] : []);
  const [detail, setDetail] = useState<"near" | "far" | "res" | "prov" | "json">("near");
  const activeJob = withResults.find((j) => j.key === activeKey);
  const activeRes = activeKey ? activeRaw.get(activeKey) : undefined;
  const activeKind = activeRes ? resultKind(isCompare(activeRes) ? Object.values(activeRes.results)[0] : activeRes) : "unknown";
  const otherKind = activeKind !== "cross_sections" && activeKind !== "unknown";
  const resonanceCount = activeSeries.reduce((n, s) => n + (s.result.resonances?.length ?? 0), 0);
  // Runs of the active result kind: the active job first, then other ticked jobs (compare jobs expand per method).
  const kindRuns = useMemo(() => {
    if (!otherKind || !activeJob || !activeRes) return [];
    const expand = (key: string, res: AnyResult | CompareResult): Run<never>[] => {
      const job = jobs.find((j) => j.key === key)!;
      const entries: [string, unknown][] = isCompare(res) ? Object.entries(res.results) : [[String((res as AnyResult).backend ?? job.method), res]];
      return entries.filter(([, r]) => resultKind(r) === activeKind).map(([m, r]) => ({ key: `${key}#${m}`, label: isCompare(res) ? `${m} · ${job.label}` : job.label, result: r as never, spec: job.spec }));
    };
    const others = [...raw.entries()].filter(([k]) => k !== activeKey).flatMap(([k, r]) => expand(k, r));
    return [...expand(activeKey!, activeRes), ...others];
  }, [otherKind, activeJob, activeRes, activeKind, raw, jobs, activeKey]);

  if (!withResults.length)
    return (
      <div className="results empty" data-testid="results">
        <div>
          <h3>No results yet</h3>
          <p className="muted">Open the Run panel and press Solve (Ctrl+Enter). Finished runs appear here; tick several to overlay them.</p>
        </div>
      </div>
    );

  return (
    <div className="results" data-testid="results">
      <div className="results-side">
        <h4>Runs</h4>
        {withResults.map((j) => (
          <div key={j.key} className={`run-item${j.key === activeKey ? " active" : ""}`}>
            <input type="checkbox" checked={shown.includes(j.key)} onChange={(e) => toggle(j.key, e.target.checked)} title="overlay in the spectra plot" />
            <button className="link" onClick={() => setActive(j.key)} title={j.id}>
              {j.label}
            </button>
          </div>
        ))}
      </div>
      <div className="results-main">
        {otherKind && kindRuns.length > 0 ? (
          <KindViewer kind={activeKind} runs={kindRuns} />
        ) : series.length > 0 ? (
          <SpectraPanel series={series} />
        ) : activeRes && activeKind === "unknown" ? null : (
          <div className="muted">Tick a run on the left to plot it.</div>
        )}
        {activeKind === "unknown" && activeRes && <GenericResults results={[[activeKey!, activeRes]]} />}
        {activeJob && activeRes && (
          <div className="detail">
            <div className="row">
              <h4 className="grow">Details · {activeJob.label}</h4>
              <button
                className="small"
                onClick={() => void exportFile(JSON.stringify(activeRes, null, 2), `${activeJob.id}.json`, "application/json")}
                data-testid="export-json"
              >
                Result JSON
              </button>
            </div>
            <Tabs
              value={otherKind && (detail === "near" || detail === "far" || detail === "res") ? "prov" : detail}
              onChange={setDetail}
              tabs={[
                ...(otherKind
                  ? []
                  : [
                      { id: "near" as const, label: "Near field" },
                      { id: "far" as const, label: "Far field" },
                      { id: "res" as const, label: <>Resonances{resonanceCount ? <span className="badge">{resonanceCount}</span> : null}</> },
                    ]),
                { id: "prov", label: "Provenance & warnings" },
                { id: "json", label: "Raw" },
              ]}
            />
            {!otherKind && detail === "near" && <NearFieldPanel series={activeSeries} spec={activeJob.spec} />}
            {!otherKind && detail === "far" && <FarFieldPanel series={activeSeries} />}
            {!otherKind && detail === "res" && <ResonanceTable runs={activeSeries.map((s) => ({ label: s.label, resonances: s.result.resonances ?? [] }))} />}
            {otherKind && (detail === "near" || detail === "far") && <ProvenancePanel res={activeRes} job={activeJob} />}
            {detail === "prov" && <ProvenancePanel res={activeRes} job={activeJob} />}
            {detail === "json" && <pre className="raw-json">{JSON.stringify(activeRes, (_k, v) => (Array.isArray(v) && v.length > 40 ? `[${v.length} items]` : v), 2)}</pre>}
          </div>
        )}
      </div>
    </div>
  );
}

function KindViewer({ kind, runs }: { kind: ResultKind; runs: Run<never>[] }) {
  switch (kind) {
    case "spectrum":
      return <SpectrumViewer runs={runs} />;
    case "modes":
      return <ModesViewer runs={runs} />;
    case "sparameters":
      return <SParamViewer runs={runs} />;
    case "bands":
      return <BandsViewer runs={runs} />;
    case "optimization":
      return <OptimizationViewer runs={runs} />;
    case "emission":
      return <EmissionViewer runs={runs} />;
    default:
      return null;
  }
}

function SpectraPanel({ series }: { series: Series[] }) {
  const [norm, setNorm] = useState<"C" | "Q">("C");
  const [qs, setQs] = useState<Q[]>(["c_ext_nm2", "c_sca_nm2", "c_abs_nm2"]);
  const [logY, setLogY] = useState(false);
  const plot = useRef<PlotHandle>(null);
  const data = useMemo(
    () =>
      series.flatMap((s, i) =>
        qs.map((q) => {
          const g = norm === "Q" ? Math.PI * s.result.equivalent_radius_nm ** 2 : 1;
          return {
            x: s.result.wavelengths_nm,
            y: s.result[q].map((v) => v / g),
            name: `${norm}${QNAME[q]} · ${s.label}`,
            mode: s.result.wavelengths_nm.length > 60 ? "lines" : "lines+markers",
            marker: { size: 4 },
            line: { color: COLORS[i % COLORS.length], dash: DASH[q], width: 2 },
          };
        }),
      ),
    [series, qs, norm],
  );
  const layout = useMemo(
    () => ({
      xaxis: { title: { text: "vacuum wavelength (nm)" } },
      yaxis: { title: { text: norm === "C" ? "cross section (nm²)" : "efficiency Q = C / π r_eq²" }, type: logY ? "log" : "linear" },
      hovermode: "x unified",
    }),
    [norm, logY],
  );
  return (
    <div className="panel" data-testid="spectra">
      <div className="row wrap">
        <h4 className="grow">Spectra</h4>
        <div className="seg">
          {(["C", "Q"] as const).map((n) => (
            <button key={n} className={norm === n ? "active" : ""} onClick={() => setNorm(n)} data-testid={`norm-${n}`}>
              {n}
            </button>
          ))}
        </div>
        {(Object.keys(QNAME) as Q[]).map((q) => (
          <label key={q} className="small">
            <input type="checkbox" checked={qs.includes(q)} onChange={(e) => setQs(e.target.checked ? [...qs, q] : qs.filter((x) => x !== q))} /> {QNAME[q]}
          </label>
        ))}
        <label className="small">
          <input type="checkbox" checked={logY} onChange={(e) => setLogY(e.target.checked)} /> log y
        </label>
        <ExportButtons
          plot={plot}
          name="spectra"
          extra={
            <button className="small" onClick={() => void exportFile(spectraCsv(series.map((s) => ({ label: s.label, result: s.result }))), "spectra.csv", "text/csv")} data-testid="export-csv">
              CSV
            </button>
          }
        />
      </div>
      <Plot ref={plot} data={data} layout={layout} height={340} testId="spectra-plot" />
      <div className="summary-table">
        <table>
          <thead>
            <tr>
              <th>Series</th>
              <th>peak λ (ext)</th>
              <th>peak Q_ext</th>
              <th>r_eq (nm)</th>
              <th>runtime</th>
            </tr>
          </thead>
          <tbody>
            {series.map((s) => {
              const r = s.result;
              const i = r.c_ext_nm2.indexOf(Math.max(...r.c_ext_nm2));
              return (
                <tr key={s.key}>
                  <td>{s.label}</td>
                  <td>{fmtNum(r.wavelengths_nm[i])} nm</td>
                  <td>{fmtNum(r.c_ext_nm2[i] / (Math.PI * r.equivalent_radius_nm ** 2))}</td>
                  <td>{fmtNum(r.equivalent_radius_nm)}</td>
                  <td>{typeof r.provenance?.runtime_s === "number" ? `${fmtNum(r.provenance.runtime_s as number)} s` : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Compare tab: relative differences of any results on the same wavelength grid. */
export function CompareView() {
  const shown = useJobs((s) => s.shown);
  const jobs = useJobs((s) => s.jobs);
  const compareJobs = jobs.filter((j) => j.operation === "compare" && j.hasResult).map((j) => j.key);
  const keys = useMemo(() => [...new Set([...shown, ...compareJobs])], [shown, compareJobs.join("|")]); // eslint-disable-line react-hooks/exhaustive-deps
  const { series, compares } = useSeries(keys);
  const [ref, setRef] = useState<string | null>(null);
  const [q, setQ] = useState<Q>("c_ext_nm2");
  const plot = useRef<PlotHandle>(null);
  const refSeries = series.find((s) => s.key === ref) ?? series.find((s) => s.result.method === "mie") ?? series[0];
  const others = series.filter((s) => s !== refSeries && refSeries && sameGrid(s.result, refSeries.result));
  const data = useMemo(
    () =>
      others.map((s, i) => ({
        x: s.result.wavelengths_nm,
        y: s.result[q].map((v, j) => (100 * (v - refSeries!.result[q][j])) / Math.max(Math.abs(refSeries!.result[q][j]), 1e-300)),
        name: s.label,
        mode: "lines+markers",
        marker: { size: 4 },
        line: { color: COLORS[(i + 1) % COLORS.length] },
      })),
    [others, refSeries, q],
  );
  if (series.length < 2)
    return (
      <div className="results empty" data-testid="compare-view">
        <div>
          <h3>Nothing to compare yet</h3>
          <p className="muted">Run Compare in the Run panel, or overlay two or more runs with the same wavelengths.</p>
        </div>
      </div>
    );
  return (
    <div className="results-main padded" data-testid="compare-view">
      <div className="row wrap">
        <h4 className="grow">Relative difference vs reference</h4>
        <label className="small">
          reference{" "}
          <select value={refSeries?.key} onChange={(e) => setRef(e.target.value)} data-testid="compare-ref">
            {series.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
        <select value={q} onChange={(e) => setQ(e.target.value as Q)}>
          <option value="c_ext_nm2">C_ext</option>
          <option value="c_sca_nm2">C_sca</option>
          <option value="c_abs_nm2">C_abs</option>
        </select>
        <ExportButtons plot={plot} name="relative-difference" />
      </div>
      <Plot ref={plot} data={data} layout={{ xaxis: { title: { text: "vacuum wavelength (nm)" } }, yaxis: { title: { text: "(X − ref) / |ref|  (%)" }, tickformat: ".3~g" } }} height={320} testId="compare-plot" />
      <table className="summary-table" data-testid="compare-table">
        <thead>
          <tr>
            <th>Series</th>
            <th>max |Δ|/|ref| ext</th>
            <th>rms ext</th>
            <th>max sca</th>
            <th>max abs</th>
          </tr>
        </thead>
        <tbody>
          {others.map((s) => {
            const d = (qq: Q) => rel(s.result[qq], refSeries!.result[qq]);
            return (
              <tr key={s.key}>
                <td>{s.label}</td>
                <td>{pct(d("c_ext_nm2").max)}</td>
                <td>{pct(d("c_ext_nm2").rms)}</td>
                <td>{pct(d("c_sca_nm2").max)}</td>
                <td>{pct(d("c_abs_nm2").max)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {series.some((s) => refSeries && !sameGrid(s.result, refSeries.result)) && <div className="muted small">Runs on a different wavelength grid than the reference are not compared.</div>}
      {compares.map(({ job, cmp }) => (
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
      ))}
    </div>
  );
}

function sameGrid(a: ScatteringResult, b: ScatteringResult) {
  return a.wavelengths_nm.length === b.wavelengths_nm.length && a.wavelengths_nm.every((w, i) => Math.abs(w - b.wavelengths_nm[i]) < 1e-6 * Math.max(1, w));
}

function rel(x: number[], y: number[]) {
  const r = x.map((v, i) => Math.abs(v - y[i]) / Math.max(Math.abs(y[i]), 1e-300));
  return { max: Math.max(...r), rms: Math.sqrt(r.reduce((s, v) => s + v * v, 0) / r.length) };
}

const pct = (x: number) => `${(100 * x).toPrecision(3)} %`;

// --- near field ---------------------------------------------------------------

/** Outlines (in plane coordinates) of every particle cut by the plane. */
export function particleOutlines(spec: JsonObject, nf: NearFieldData): { x: number[]; y: number[] }[] {
  const ax: Record<string, number> = { x: 0, y: 1, z: 2 };
  const a1 = ax[nf.plane[0]];
  const a2 = ax[nf.plane[1]];
  const nAx = 3 - a1 - a2;
  const out: { x: number[]; y: number[] }[] = [];
  const ts = Array.from({ length: 97 }, (_, i) => (i / 96) * 2 * Math.PI);
  for (const p of ((spec.particles as JsonObject[]) ?? []).filter(isObject)) {
    const pos = (p.position_nm as number[]) ?? [0, 0, 0];
    const s = p.shape as JsonObject;
    const d = nf.offset_nm - pos[nAx];
    const h = halfExtent(s);
    const radii: number[][] = [];
    if (s.kind === "cylinder") {
      // rectangle when the plane contains the axis (z), circle when it cuts across it
      if (nAx === 2) {
        if (Math.abs(d) <= h[2]) radii.push([h[0], h[1]]);
      } else if (Math.abs(d) <= h[0]) {
        const half = Math.sqrt(h[0] ** 2 - d * d);
        const hw = [0, 0, 0];
        hw[a1] = a1 === 2 ? h[2] : half;
        hw[a2] = a2 === 2 ? h[2] : half;
        const [w1, w2] = [hw[a1], hw[a2]];
        out.push({ x: [pos[a1] - w1, pos[a1] + w1, pos[a1] + w1, pos[a1] - w1, pos[a1] - w1], y: [pos[a2] - w2, pos[a2] - w2, pos[a2] + w2, pos[a2] + w2, pos[a2] - w2] });
      }
    } else {
      const shells: number[] = [];
      if (s.kind === "layered_sphere") {
        let r = Number(s.core_radius_nm);
        shells.push(r);
        for (const sh of (s.shells as JsonObject[]) ?? []) shells.push((r += Number(sh.thickness_nm)));
      } else shells.push(1);
      for (const scale of shells) {
        const e = s.kind === "layered_sphere" ? [scale, scale, scale] : h;
        const f = 1 - (d / e[nAx]) ** 2;
        if (f > 0) radii.push([e[a1] * Math.sqrt(f), e[a2] * Math.sqrt(f)]);
      }
    }
    for (const [r1, r2] of radii) out.push({ x: ts.map((t) => pos[a1] + r1 * Math.cos(t)), y: ts.map((t) => pos[a2] + r2 * Math.sin(t)) });
  }
  return out;
}

function NearFieldPanel({ series, spec }: { series: Series[]; spec: JsonObject }) {
  const nfs = series.flatMap((s) => (s.result.near_field ?? []).map((nf) => ({ s, nf })));
  const [i, setI] = useState(0);
  const [log, setLog] = useState(true);
  const plot = useRef<PlotHandle>(null);
  const cur = nfs[Math.min(i, nfs.length - 1)];
  const data = useMemo(() => {
    if (!cur) return [];
    const { nf } = cur;
    // enhancement is indexed [axis1][axis2]; Plotly wants z[y][x]
    const z = nf.axis2_nm.map((_, j) => nf.axis1_nm.map((_, k) => {
      const v = nf.enhancement[k][j];
      return v === null || !Number.isFinite(v) ? null : log ? Math.log10(Math.max(v, 1e-12)) : v;
    }));
    return [
      { type: "heatmap", x: nf.axis1_nm, y: nf.axis2_nm, z, colorscale: "Hot", colorbar: { title: { text: log ? "log₁₀ |E|²/|E₀|²" : "|E|²/|E₀|²", side: "right" } }, hovertemplate: `${nf.plane[0]}=%{x:.1f} nm<br>${nf.plane[1]}=%{y:.1f} nm<br>${log ? "log₁₀ " : ""}enh=%{z:.3g}<extra></extra>` },
      ...particleOutlines(spec, nf).map((o) => ({ x: o.x, y: o.y, mode: "lines", line: { color: "#7fd3ff", width: 1.5 }, hoverinfo: "skip", showlegend: false })),
    ];
  }, [cur, log, spec]);
  if (!cur) return <div className="muted pad">This run has no near-field data. Enable Outputs → Near field and run again (Mie, T-matrix and DDA backends support it).</div>;
  const nf = cur.nf;
  const max = Math.max(...nf.enhancement.flat().filter((v) => Number.isFinite(v)));
  return (
    <div data-testid="near-field">
      <div className="row wrap">
        <select value={i} onChange={(e) => setI(Number(e.target.value))}>
          {nfs.map((x, k) => (
            <option key={k} value={k}>
              {x.s.result.backend} · {x.nf.plane} @ {x.nf.offset_nm} nm · λ = {x.nf.wavelength_nm} nm
            </option>
          ))}
        </select>
        <label className="small">
          <input type="checkbox" checked={log} onChange={(e) => setLog(e.target.checked)} /> log scale
        </label>
        <span className="muted small grow">max enhancement {fmtNum(max)}</span>
        <ExportButtons plot={plot} name={`near-field-${nf.wavelength_nm}nm`} extra={<button className="small" onClick={() => void exportFile(nearFieldCsv(nf), `near-field-${nf.wavelength_nm}nm.csv`, "text/csv")}>CSV</button>} />
      </div>
      <Plot
        ref={plot}
        data={data}
        layout={{ xaxis: { title: { text: `${nf.plane[0]} (nm)` }, constrain: "domain" }, yaxis: { title: { text: `${nf.plane[1]} (nm)` }, scaleanchor: "x" }, margin: { l: 60, r: 10, t: 10, b: 45 } }}
        height={420}
        testId="near-field-plot"
      />
    </div>
  );
}

// --- far field ------------------------------------------------------------------

function FarFieldPanel({ series }: { series: Series[] }) {
  const ffs = series.flatMap((s) => (s.result.far_field ?? []).map((ff) => ({ s, ff })));
  const [i, setI] = useState(0);
  const [mode, setMode] = useState<"polar" | "3d">("polar");
  const [logR, setLogR] = useState(false);
  const plot = useRef<PlotHandle>(null);
  const cur = ffs[Math.min(i, ffs.length - 1)];
  const data = useMemo(() => (cur ? (mode === "polar" ? polarTraces(cur.ff, logR) : surfaceTraces(cur.ff)) : []), [cur, mode, logR]);
  if (!cur) return <div className="muted pad">This run has no far-field data. Enable Outputs → Far field and run again.</div>;
  const ff = cur.ff;
  return (
    <div data-testid="far-field">
      <div className="row wrap">
        <select value={i} onChange={(e) => setI(Number(e.target.value))}>
          {ffs.map((x, k) => (
            <option key={k} value={k}>
              {x.s.result.backend} · λ = {x.ff.wavelength_nm} nm
            </option>
          ))}
        </select>
        <div className="seg">
          <button className={mode === "polar" ? "active" : ""} onClick={() => setMode("polar")}>
            Polar
          </button>
          <button className={mode === "3d" ? "active" : ""} onClick={() => setMode("3d")} data-testid="far-3d">
            3D
          </button>
        </div>
        {mode === "polar" && (
          <label className="small">
            <input type="checkbox" checked={logR} onChange={(e) => setLogR(e.target.checked)} /> log r
          </label>
        )}
        <span className="grow" />
        <ExportButtons plot={plot} name={`far-field-${ff.wavelength_nm}nm`} extra={<button className="small" onClick={() => void exportFile(farFieldCsv(ff), `far-field-${ff.wavelength_nm}nm.csv`, "text/csv")}>CSV</button>} />
      </div>
      {mode === "3d" && ff.phi_deg.length < 3 && <div className="muted small">Only {ff.phi_deg.length} φ values: the 3D pattern is interpolated around the axis. Use Outputs → Far field → "Full sphere" for a true 3D pattern.</div>}
      <Plot
        ref={plot}
        data={data}
        layout={
          mode === "polar"
            ? { polar: { angularaxis: { direction: "counterclockwise", rotation: 90 }, radialaxis: { type: logR ? "log" : "linear", title: { text: "dC/dΩ (nm²/sr)" } } }, margin: { l: 40, r: 40, t: 30, b: 30 } }
            : { scene: { aspectmode: "data", xaxis: { title: { text: "x" } }, yaxis: { title: { text: "y" } }, zaxis: { title: { text: "z (k)" } } }, margin: { l: 0, r: 0, t: 0, b: 0 } }
        }
        height={420}
        testId="far-field-plot"
      />
    </div>
  );
}

function polarTraces(ff: FarFieldData, logR: boolean) {
  // Mirror each φ cut with its φ+180° partner so the pattern covers the full plane.
  return ff.phi_deg.map((phi, j) => {
    const partner = ff.phi_deg.findIndex((p) => Math.abs(((p - phi + 360) % 360) - 180) < 1e-6);
    const th = [...ff.theta_deg];
    const r = ff.theta_deg.map((_, t) => ff.dcsca_domega_nm2[t][j]);
    const back = partner >= 0 ? ff.theta_deg.map((_, t) => ff.dcsca_domega_nm2[t][partner]) : r;
    return {
      type: "scatterpolar",
      theta: [...th, ...th.map((t) => 360 - t).reverse()],
      r: [...r, ...back.slice().reverse()].map((v) => (logR ? Math.max(v, 1e-12) : v)),
      name: `φ = ${phi}°${phi === 0 ? " (E-plane)" : phi === 90 ? " (H-plane)" : ""}`,
      mode: "lines",
      line: { color: COLORS[j % COLORS.length] },
    };
  });
}

function surfaceTraces(ff: FarFieldData) {
  // Interpolate dC/dΩ(θ, φ) on a regular φ grid (periodic) and draw r = dC/dΩ.
  const phis = ff.phi_deg.map((p) => ((p % 360) + 360) % 360);
  const order = phis.map((p, j) => [p, j] as const).sort((a, b) => a[0] - b[0]);
  const nPhi = 73;
  const grid = Array.from({ length: nPhi }, (_, k) => (k * 360) / (nPhi - 1));
  const valueAt = (t: number, p: number): number => {
    if (order.length === 1) return ff.dcsca_domega_nm2[t][order[0][1]];
    // with only E- and H-plane cuts, assume the dipole-like cos²φ / sin²φ mixing
    if (order.length === 2) {
      const e = ff.dcsca_domega_nm2[t][order[0][1]];
      const h = ff.dcsca_domega_nm2[t][order[1][1]];
      const c = Math.cos(((p - order[0][0]) * Math.PI) / 180) ** 2;
      return e * c + h * (1 - c);
    }
    let lo = order[order.length - 1];
    let hi = order[0];
    for (let k = 0; k < order.length; k++) {
      if (order[k][0] <= p) lo = order[k];
      if (order[k][0] >= p) {
        hi = order[k];
        break;
      }
    }
    const span = (hi[0] - lo[0] + 360) % 360 || 360;
    const f = ((p - lo[0] + 360) % 360) / span;
    return ff.dcsca_domega_nm2[t][lo[1]] * (1 - f) + ff.dcsca_domega_nm2[t][hi[1]] * f;
  };
  const X: number[][] = [];
  const Y: number[][] = [];
  const Z: number[][] = [];
  const C: number[][] = [];
  ff.theta_deg.forEach((th, t) => {
    const T = (th * Math.PI) / 180;
    X.push([]);
    Y.push([]);
    Z.push([]);
    C.push([]);
    for (const p of grid) {
      const v = valueAt(t, p);
      const P = (p * Math.PI) / 180;
      // frame: k along +z, E (φ = 0) along +x
      X[t].push(v * Math.sin(T) * Math.cos(P));
      Y[t].push(v * Math.sin(T) * Math.sin(P));
      Z[t].push(v * Math.cos(T));
      C[t].push(v);
    }
  });
  return [{ type: "surface", x: X, y: Y, z: Z, surfacecolor: C, colorscale: "Viridis", colorbar: { title: { text: "nm²/sr" } } }];
}

// --- provenance / generic ---------------------------------------------------------

function ProvenancePanel({ res, job }: { res: AnyResult | CompareResult; job: JobRecord }) {
  const items: [string, AnyResult][] = isCompare(res) ? Object.entries(res.results) : [[job.method, res as AnyResult]];
  return (
    <div className="provenance" data-testid="provenance">
      <div className="kv">
        <span>Job</span>
        <b>{job.id}</b>
        <span>Server</span>
        <b>{job.server}</b>
        <span>Operation</span>
        <b>
          {job.operation} · method {job.method} · device {job.device}
        </b>
        <span>Submitted</span>
        <b>{new Date(job.createdAt).toLocaleString()}</b>
      </div>
      {items.map(([name, r]) => (
        <div key={name} className="panel">
          <h4>
            {String(r.backend ?? name)} <span className="muted">({String(r.method ?? "")})</span>
          </h4>
          {(r.warnings ?? []).length > 0 ? (
            <ul className="warnings" data-testid="warnings">
              {(r.warnings ?? []).map((w, i) => (
                <li key={i}>⚠ {w}</li>
              ))}
            </ul>
          ) : (
            <div className="muted small">No warnings.</div>
          )}
          <div className="kv">
            {Object.entries(r.provenance ?? {}).map(([k, v]) => (
              <Fragment2 key={k} k={k} v={v} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

function Fragment2({ k, v }: { k: string; v: unknown }) {
  return (
    <>
      <span>{k}</span>
      <b>{typeof v === "number" ? fmtNum(v) : typeof v === "object" ? JSON.stringify(v) : String(v)}</b>
    </>
  );
}

/** Results of other problem kinds: plot every numeric array against the wavelength axis. */
function GenericResults({ results }: { results: [string, AnyResult | CompareResult][] }) {
  const data = useMemo(() => {
    const out: object[] = [];
    results.forEach(([, r], i) => {
      const obj = r as Record<string, unknown>;
      const xKey = Object.keys(obj).find((k) => /wavelength/.test(k) && Array.isArray(obj[k]));
      if (!xKey) return;
      const x = obj[xKey] as number[];
      Object.entries(obj).forEach(([k, v], j) => {
        if (k !== xKey && Array.isArray(v) && v.length === x.length && v.every((n) => typeof n === "number"))
          out.push({ x, y: v, name: k, mode: "lines", line: { color: COLORS[(i + j) % COLORS.length] } });
      });
    });
    return out;
  }, [results]);
  const plot = useRef<PlotHandle>(null);
  return (
    <div className="panel">
      <div className="row">
        <h4 className="grow">Results</h4>
        <ExportButtons plot={plot} name="results" />
      </div>
      {data.length ? <Plot ref={plot} data={data as never[]} layout={{ xaxis: { title: { text: "wavelength (nm)" } } }} height={320} /> : <div className="muted">No wavelength-indexed arrays to plot; see Raw.</div>}
    </div>
  );
}
