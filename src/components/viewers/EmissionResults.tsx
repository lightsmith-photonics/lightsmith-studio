// Viewers for dipole emission (Purcell factor, radiative and non-radiative decay, efficiency, radiation
// pattern) and for the resonances (wavelength, Q, amplitude) of an FDTD ring-down. Every number is the
// library's: Studio derives only the non-radiative part, purcell − radiative, which is how the library
// defines its two rates (emitted = radiated + absorbed).

import { useMemo, useRef, useState } from "react";
import type { EmissionResult, ResonanceData } from "../../api/types";
import { exportFile } from "../../lib/files";
import { ExportButtons, Plot, type PlotHandle } from "../Plot";
import { fmtNum } from "../Properties";
import type { Run } from "./KindResults";

const COLORS = ["#4f9dff", "#ff8a4c", "#38d39f", "#e45bd0", "#f2c94c", "#8c7bff", "#ff5d5d", "#4cd7e4"];
const csvText = (header: string[], rows: (string | number)[][]) => [header, ...rows].map((r) => r.map((v) => (typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(",")).join("\n") + "\n";

type Quantity = "purcell" | "radiative" | "nonradiative" | "efficiency";
const QUANTITIES: { id: Quantity; name: string; dash: string; title: string }[] = [
  { id: "purcell", name: "total (Purcell)", dash: "solid", title: "Total decay-rate enhancement γ/γ₀: emitted power / P₀" },
  { id: "radiative", name: "radiative", dash: "dash", title: "Radiative decay enhancement γ_r/γ₀: power reaching the far field / P₀" },
  { id: "nonradiative", name: "non-radiative", dash: "dot", title: "Absorbed in the particles / P₀ = total − radiative" },
  { id: "efficiency", name: "efficiency", dash: "dashdot", title: "Quantum efficiency of the coupled emitter: radiative / total" },
];

function series(r: EmissionResult, q: Quantity): number[] {
  if (q === "nonradiative") return r.purcell.map((p, i) => p - r.radiative[i]);
  return r[q];
}

export function EmissionViewer({ runs }: { runs: Run<EmissionResult>[] }) {
  const active = runs[0].result;
  const [qs, setQs] = useState<Quantity[]>(["purcell", "radiative", "nonradiative"]);
  const [logY, setLogY] = useState(false);
  const [pi, setPi] = useState(0);
  const plot = useRef<PlotHandle>(null);
  const eplot = useRef<PlotHandle>(null);
  const pplot = useRef<PlotHandle>(null);
  const rates = qs.filter((q) => q !== "efficiency");
  const data = useMemo(
    () =>
      runs.flatMap((run, ri) =>
        rates.map((q) => {
          const Q = QUANTITIES.find((x) => x.id === q)!;
          return { x: run.result.wavelengths_nm, y: series(run.result, q), name: `${Q.name}${runs.length > 1 ? ` · ${run.label}` : ""}`, mode: "lines", line: { color: COLORS[ri % COLORS.length], dash: Q.dash, width: 2 } };
        }),
      ),
    [runs, rates],
  );
  const effData = useMemo(() => runs.map((run, ri) => ({ x: run.result.wavelengths_nm, y: run.result.efficiency, name: `efficiency${runs.length > 1 ? ` · ${run.label}` : ""}`, mode: "lines", line: { color: COLORS[ri % COLORS.length], width: 2 } })), [runs]);
  const patterns = active.radiation_pattern ?? [];
  const pat = patterns[Math.min(pi, Math.max(0, patterns.length - 1))];
  const patData = useMemo(() => {
    if (!pat) return [];
    return pat.phi_deg.flatMap((phi, j) => {
      // a polar cut: θ from +z, the φ half-plane on the right and φ + 180° (when sampled) on the left
      const opp = pat.phi_deg.findIndex((p) => Math.abs(((p - phi - 180) % 360 + 360) % 360) < 1e-6);
      if (opp >= 0 && opp < j) return [];
      const r = pat.theta_deg.map((_, i) => pat.dp_domega[i][j]);
      const th = [...pat.theta_deg];
      const rr = [...r];
      if (opp >= 0) {
        for (let i = pat.theta_deg.length - 1; i >= 0; i--) {
          th.push(360 - pat.theta_deg[i]);
          rr.push(pat.dp_domega[i][opp]);
        }
      }
      return [{ type: "scatterpolar", theta: th, r: rr, mode: "lines", name: `φ = ${phi}°${opp >= 0 ? ` / ${pat.phi_deg[opp]}°` : ""}`, line: { color: COLORS[j % COLORS.length], width: 2 } }];
    });
  }, [pat]);

  // peak of the total rate per run, for the summary line
  const peak = (r: EmissionResult) => {
    let i = 0;
    r.purcell.forEach((v, k) => v > r.purcell[i] && (i = k));
    return { wl: r.wavelengths_nm[i], f: r.purcell[i], rad: r.radiative[i], eff: r.efficiency[i] };
  };
  const pk = peak(active);
  const csv = () => {
    const rows: (string | number)[][] = [];
    for (const run of runs) run.result.wavelengths_nm.forEach((w, k) => rows.push([run.label, w, run.result.purcell[k], run.result.radiative[k], run.result.purcell[k] - run.result.radiative[k], run.result.efficiency[k]]));
    void exportFile(csvText(["series", "wavelength_nm", "purcell", "radiative", "nonradiative", "efficiency"], rows), "emission.csv", "text/csv");
  };

  return (
    <div className="panel" data-testid="emission-viewer">
      <div className="row wrap viewer-toolbar">
        <h4 className="grow" title="Relative to the same dipole in the medium alone">
          Decay rates γ/γ₀
        </h4>
        {QUANTITIES.filter((q) => q.id !== "efficiency").map((q) => (
          <label key={q.id} className="small" title={q.title}>
            <input type="checkbox" checked={qs.includes(q.id)} onChange={(e) => setQs(e.target.checked ? [...qs, q.id] : qs.filter((x) => x !== q.id))} /> {q.name}
          </label>
        ))}
        <label className="small">
          <input type="checkbox" checked={logY} onChange={(e) => setLogY(e.target.checked)} /> log
        </label>
        <ExportButtons plot={plot} name="emission" extra={<button className="small" onClick={csv}>CSV</button>} />
      </div>
      <p className="muted small" data-testid="emission-summary">
        Relative to the dipole in the medium alone. Peak Purcell factor <b>{fmtNum(pk.f)}</b> at {fmtNum(pk.wl)} nm (radiative {fmtNum(pk.rad)}, efficiency {fmtNum(100 * pk.eff)} %) · {active.backend}
      </p>
      <Plot ref={plot} data={data} layout={{ xaxis: { title: { text: "wavelength (nm)" } }, yaxis: { title: { text: "γ / γ₀" }, type: logY ? "log" : "linear" }, hovermode: "x unified" }} height={320} testId="emission-plot" />
      <div className="row wrap viewer-toolbar">
        <h4 className="grow">Efficiency (radiative / total)</h4>
        <ExportButtons plot={eplot} name="efficiency" />
      </div>
      <Plot ref={eplot} data={effData} layout={{ xaxis: { title: { text: "wavelength (nm)" } }, yaxis: { title: { text: "efficiency" }, range: [0, 1.02] } }} height={200} testId="efficiency-plot" />
      {patterns.length > 0 && pat && (
        <>
          <div className="row wrap viewer-toolbar">
            <h4 className="grow">
              Radiation pattern <span className="muted small">dP/dΩ / P₀, θ from +z</span>
            </h4>
            {patterns.length > 1 && (
              <select value={pi} onChange={(e) => setPi(Number(e.target.value))}>
                {patterns.map((p, i) => (
                  <option key={i} value={i}>
                    λ = {p.wavelength_nm} nm
                  </option>
                ))}
              </select>
            )}
            <ExportButtons plot={pplot} name="radiation-pattern" />
          </div>
          <Plot ref={pplot} data={patData} layout={{ polar: { angularaxis: { rotation: 90, direction: "clockwise" }, radialaxis: {} }, margin: { l: 30, r: 30, t: 30, b: 30 } }} height={340} testId="pattern-plot" />
        </>
      )}
    </div>
  );
}

/** Resonances of one or more runs: a sortable table, CSV, and markers for the spectra plot. */
export function ResonanceTable({ runs }: { runs: { label: string; resonances: ResonanceData[] }[] }) {
  const [sort, setSort] = useState<"amplitude" | "wavelength_nm" | "q">("amplitude");
  const rows = runs.flatMap((r) => r.resonances.map((x) => ({ ...x, label: r.label })));
  rows.sort((a, b) => (sort === "wavelength_nm" ? a.wavelength_nm - b.wavelength_nm : b[sort] - a[sort]));
  const csv = () =>
    void exportFile(csvText(["series", "wavelength_nm", "energy_ev", "Q", "linewidth_nm", "amplitude"], rows.map((r) => [r.label, r.wavelength_nm, r.energy_ev, r.q, r.wavelength_nm / r.q, r.amplitude])), "resonances.csv", "text/csv");
  if (!rows.length)
    return (
      <p className="muted small" data-testid="resonance-empty">
        No resonances in this result. Request them with <code>outputs.resonances</code> (time-domain solvers: FDTD).
      </p>
    );
  const th = (id: typeof sort, text: string) => (
    <th className={sort === id ? "sorted" : ""} onClick={() => setSort(id)} style={{ cursor: "pointer" }}>
      {text}
      {sort === id ? " ▾" : ""}
    </th>
  );
  return (
    <div data-testid="resonance-table">
      <div className="row">
        <p className="muted small grow">
          From the field's ring-down after the pulse (harmonic inversion). Q = ω/γ; the linewidth is λ/Q. Amplitudes are relative to the strongest mode; weak modes (amplitude below a few %) are the least reliable.
        </p>
        <button className="small" onClick={csv}>
          CSV
        </button>
      </div>
      <table className="summary-table">
        <thead>
          <tr>
            {runs.length > 1 && <th>run</th>}
            {th("wavelength_nm", "λ (nm)")}
            <th>E (eV)</th>
            {th("q", "Q")}
            <th>Δλ (nm)</th>
            {th("amplitude", "amplitude")}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className={r.amplitude < 0.02 ? "muted" : ""}>
              {runs.length > 1 && <td>{r.label}</td>}
              <td>{r.wavelength_nm.toFixed(2)}</td>
              <td>{r.energy_ev.toFixed(4)}</td>
              <td>
                <b>{fmtNum(r.q)}</b>
              </td>
              <td>{fmtNum(r.wavelength_nm / r.q)}</td>
              <td>
                <span className="amp-bar" style={{ width: `${Math.max(2, 60 * r.amplitude)}px` }} /> {fmtNum(r.amplitude)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
