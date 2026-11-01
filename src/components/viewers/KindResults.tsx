// Result viewers for the non-scattering result kinds: spectrum (R/T/A + diffraction orders),
// modes (n_eff tables, field profiles), sparameters (|S|, phase, matrix), bands (diagram with
// gap shading) and optimization (history). Each takes the runs to overlay; runs[0] is active.

import { useMemo, useRef, useState } from "react";
import type { BandResult, ModeResult, OptimizationResult, SParameterResult, SpectrumResult } from "../../api/types";
import { exportFile } from "../../lib/files";
import { isObject, type JsonObject } from "../../schema/schema";
import { profilePath } from "../kinds/geometry2d";
import { ExportButtons, Plot, type PlotHandle } from "../Plot";
import { fmtNum } from "../Properties";

export interface Run<R> {
  key: string;
  label: string;
  result: R;
  spec: JsonObject;
}

const COLORS = ["#4f9dff", "#ff8a4c", "#38d39f", "#e45bd0", "#f2c94c", "#8c7bff", "#ff5d5d", "#4cd7e4"];
const csvRows = (header: string[], rows: (string | number)[][]) => [header, ...rows].map((r) => r.map((v) => (typeof v === "number" ? (Number.isFinite(v) ? String(v) : "") : /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(",")).join("\n") + "\n";

function Toolbar(props: { children: React.ReactNode }) {
  return <div className="row wrap viewer-toolbar">{props.children}</div>;
}

function Checks<T extends string>(props: { options: T[]; value: T[]; onChange: (v: T[]) => void; label?: (t: T) => string }) {
  return (
    <>
      {props.options.map((o) => (
        <label key={o} className="small">
          <input type="checkbox" checked={props.value.includes(o)} onChange={(e) => props.onChange(e.target.checked ? [...props.value, o] : props.value.filter((x) => x !== o))} /> {props.label ? props.label(o) : o}
        </label>
      ))}
    </>
  );
}

// --- spectrum ---------------------------------------------------------------------------

type RTA = "r" | "t" | "a";
const RTA_NAME: Record<RTA, string> = { r: "R", t: "T", a: "A" };
const RTA_DASH: Record<RTA, string> = { r: "solid", t: "dash", a: "dot" };

export function SpectrumViewer({ runs }: { runs: Run<SpectrumResult>[] }) {
  const active = runs[0].result;
  const pols = [...new Set(runs.flatMap((r) => r.result.polarizations))];
  const [qs, setQs] = useState<RTA[]>(["r", "t", "a"]);
  const [ps, setPs] = useState<string[]>(pols);
  const [ai, setAi] = useState(0);
  const [mapMode, setMapMode] = useState(false);
  const [orderQ, setOrderQ] = useState<"r" | "t">("t");
  const plot = useRef<PlotHandle>(null);
  const oplot = useRef<PlotHandle>(null);
  const angle = active.angles_deg[Math.min(ai, active.angles_deg.length - 1)];

  const data = useMemo(() => {
    if (mapMode) {
      const q = qs[0] ?? "r";
      const p = ps[0] ?? pols[0];
      return [{ type: "heatmap", x: active.wavelengths_nm, y: active.angles_deg, z: active[q][p] ?? [], colorscale: "Viridis", zmin: 0, zmax: 1, colorbar: { title: { text: `${RTA_NAME[q]}_${p}` } } }];
    }
    return runs.flatMap((run, ri) =>
      ps.flatMap((p, pi) =>
        qs.flatMap((q) => {
          const r = run.result;
          const j = r.angles_deg.findIndex((x) => Math.abs(x - angle) < 1e-9);
          const y = j >= 0 ? r[q]?.[p]?.[j] : undefined;
          if (!y) return [];
          return [{ x: r.wavelengths_nm, y, name: `${RTA_NAME[q]}_${p}${runs.length > 1 ? ` · ${run.label}` : ""}`, mode: "lines", line: { color: COLORS[(ri * 2 + pi) % COLORS.length], dash: RTA_DASH[q], width: 2 } }];
        }),
      ),
    );
  }, [runs, ps, qs, angle, mapMode, active, pols]);

  const orderData = useMemo(() => {
    const p = ps[0] ?? pols[0];
    return (active.orders ?? []).map((o, i) => ({ x: active.wavelengths_nm, y: o[orderQ]?.[p]?.[ai] ?? [], name: `(${o.order.join(",")})`, mode: "lines", line: { color: COLORS[i % COLORS.length] } }));
  }, [active, orderQ, ps, pols, ai]);

  const csv = () => {
    const rows: (string | number)[][] = [];
    for (const run of runs)
      for (const p of run.result.polarizations)
        run.result.angles_deg.forEach((ang, j) => run.result.wavelengths_nm.forEach((w, k) => rows.push([run.label, p, ang, w, run.result.r[p]?.[j]?.[k], run.result.t[p]?.[j]?.[k], run.result.a[p]?.[j]?.[k]])));
    void exportFile(csvRows(["series", "polarization", "angle_deg", "wavelength_nm", "R", "T", "A"], rows), "spectrum.csv", "text/csv");
  };

  return (
    <div className="panel" data-testid="spectrum-viewer">
      <Toolbar>
        <h4 className="grow">Reflection / transmission / absorption</h4>
        <Checks options={["r", "t", "a"] as RTA[]} value={qs} onChange={setQs} label={(q) => RTA_NAME[q]} />
        <Checks options={pols} value={ps} onChange={setPs} label={(p) => `${p}-pol`} />
        {active.angles_deg.length > 1 && (
          <>
            <select value={ai} onChange={(e) => setAi(Number(e.target.value))} disabled={mapMode} data-testid="spectrum-angle">
              {active.angles_deg.map((a, i) => (
                <option key={i} value={i}>
                  θ = {a}°
                </option>
              ))}
            </select>
            <label className="small">
              <input type="checkbox" checked={mapMode} onChange={(e) => setMapMode(e.target.checked)} /> map vs angle
            </label>
          </>
        )}
        <ExportButtons plot={plot} name="spectrum" extra={<button className="small" onClick={csv}>CSV</button>} />
      </Toolbar>
      <Plot
        ref={plot}
        data={data}
        layout={mapMode ? { xaxis: { title: { text: "wavelength (nm)" } }, yaxis: { title: { text: "angle of incidence (°)" } } } : { xaxis: { title: { text: "wavelength (nm)" } }, yaxis: { title: { text: "power fraction" }, range: [-0.02, 1.02] }, hovermode: "x unified" }}
        height={340}
        testId="spectrum-plot"
      />
      {(active.orders?.length ?? 0) > 0 && (
        <>
          <Toolbar>
            <h4 className="grow">
              Diffraction orders <span className="muted small">({ps[0] ?? pols[0]}-pol, θ = {angle}°)</span>
            </h4>
            <select value={orderQ} onChange={(e) => setOrderQ(e.target.value as "r" | "t")}>
              <option value="t">transmitted</option>
              <option value="r">reflected</option>
            </select>
            <ExportButtons plot={oplot} name="orders" />
          </Toolbar>
          <Plot ref={oplot} data={orderData} layout={{ xaxis: { title: { text: "wavelength (nm)" } }, yaxis: { title: { text: "efficiency" } } }} height={260} testId="orders-plot" />
        </>
      )}
    </div>
  );
}

// --- modes ----------------------------------------------------------------------------

const COMPONENTS = ["|E|²", "|H|²", "Ex", "Ey", "Ez", "Hx", "Hy", "Hz"];

export function ModesViewer({ runs }: { runs: Run<ModeResult>[] }) {
  const active = runs[0].result;
  const [wi, setWi] = useState(Math.floor(active.wavelengths_nm.length / 2));
  const [mi, setMi] = useState(0);
  const [comp, setComp] = useState("|E|²");
  const nplot = useRef<PlotHandle>(null);
  const fplot = useRef<PlotHandle>(null);
  const modes = active.modes[wi] ?? [];
  const mode = modes[Math.min(mi, modes.length - 1)];
  const field = mode?.field;
  const nModes = Math.max(...active.modes.map((m) => m.length), 0);

  const neffData = useMemo(
    () =>
      runs.flatMap((run, ri) =>
        Array.from({ length: Math.max(...run.result.modes.map((m) => m.length), 0) }, (_, m) => ({
          x: run.result.wavelengths_nm,
          y: run.result.modes.map((ms) => ms[m]?.neff_real ?? null),
          name: `mode ${m}${runs.length > 1 ? ` · ${run.label}` : ""}`,
          mode: "lines+markers",
          line: { color: COLORS[(ri * nModes + m) % COLORS.length] },
        })),
      ),
    [runs, nModes],
  );

  const fieldData = useMemo(() => {
    if (!field) return [];
    const mag2 = (c: string) => {
      const v = field.components[c];
      return v ? v[0].map((row, i) => row.map((re, j) => re * re + v[1][i][j] * v[1][i][j])) : null;
    };
    let zxy: number[][] | null;
    if (comp === "|E|²" || comp === "|H|²") {
      const parts = (comp === "|E|²" ? ["Ex", "Ey", "Ez"] : ["Hx", "Hy", "Hz"]).map(mag2).filter(Boolean) as number[][][];
      zxy = parts.length ? parts[0].map((row, i) => row.map((_, j) => parts.reduce((a, p) => a + p[i][j], 0))) : null;
    } else {
      const m = mag2(comp);
      zxy = m ? m.map((row) => row.map(Math.sqrt)) : null;
    }
    if (!zxy) return [];
    const z = field.y_nm.map((_, j) => field.x_nm.map((_, i) => zxy![i][j]));
    const outlines = ((runs[0].spec.structures as JsonObject[]) ?? []).filter(isObject).map((s) => s.profile);
    return [
      { type: "heatmap", x: field.x_nm, y: field.y_nm, z, colorscale: "Hot", colorbar: { title: { text: comp.startsWith("|") ? comp : `|${comp}|` } } },
      ...outlines.map((p) => {
        const pts = svgPathToPoints(profilePath(p));
        return { x: pts.map((q) => q[0]), y: pts.map((q) => q[1]), mode: "lines", line: { color: "#7fd3ff", width: 1.5 }, hoverinfo: "skip", showlegend: false };
      }),
    ];
  }, [field, comp, runs]);

  const csv = () =>
    void exportFile(
      csvRows(
        ["wavelength_nm", "mode", "neff_real", "neff_imag", "ng", "loss_db_per_cm", "te_fraction", "effective_area_um2"],
        active.modes.flatMap((ms, w) => ms.map((m, k) => [active.wavelengths_nm[w], k, m.neff_real, m.neff_imag, m.ng ?? "", m.loss_db_per_cm ?? "", m.te_fraction ?? "", m.effective_area_um2 ?? ""])),
      ),
      "modes.csv",
      "text/csv",
    );

  return (
    <div className="panel" data-testid="modes-viewer">
      <Toolbar>
        <h4 className="grow">Modes</h4>
        <select value={wi} onChange={(e) => setWi(Number(e.target.value))} data-testid="modes-wavelength">
          {active.wavelengths_nm.map((w, i) => (
            <option key={i} value={i}>
              λ = {w} nm
            </option>
          ))}
        </select>
        <button className="small" onClick={csv}>
          CSV
        </button>
      </Toolbar>
      <table className="summary-table" data-testid="modes-table">
        <thead>
          <tr>
            <th>#</th>
            <th>n_eff</th>
            <th>n_g</th>
            <th>loss (dB/cm)</th>
            <th>TE fraction</th>
            <th>A_eff (µm²)</th>
          </tr>
        </thead>
        <tbody>
          {modes.map((m, k) => (
            <tr key={k} className={k === mi ? "selected" : ""} onClick={() => setMi(k)} style={{ cursor: "pointer" }}>
              <td>{k}</td>
              <td>
                {m.neff_real.toFixed(5)}
                {Math.abs(m.neff_imag) > 1e-9 ? ` + ${m.neff_imag.toExponential(2)}i` : ""}
              </td>
              <td>{m.ng != null ? m.ng.toFixed(4) : "—"}</td>
              <td>{m.loss_db_per_cm != null ? fmtNum(m.loss_db_per_cm) : "—"}</td>
              <td>{m.te_fraction != null ? m.te_fraction.toFixed(3) : "—"}</td>
              <td>{m.effective_area_um2 != null ? fmtNum(m.effective_area_um2) : "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="viewer-grid">
        <div>
          <Toolbar>
            <h4 className="grow">n_eff vs wavelength</h4>
            <ExportButtons plot={nplot} name="neff" />
          </Toolbar>
          <Plot ref={nplot} data={neffData} layout={{ xaxis: { title: { text: "wavelength (nm)" } }, yaxis: { title: { text: "n_eff" } } }} height={300} testId="neff-plot" />
        </div>
        <div>
          <Toolbar>
            <h4 className="grow">Mode {mi} profile</h4>
            <select value={comp} onChange={(e) => setComp(e.target.value)} disabled={!field}>
              {COMPONENTS.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            <ExportButtons plot={fplot} name={`mode${mi}-${active.wavelengths_nm[wi]}nm`} />
          </Toolbar>
          {field ? (
            <Plot ref={fplot} data={fieldData} layout={{ xaxis: { title: { text: "x (nm)" }, constrain: "domain" }, yaxis: { title: { text: "y (nm)" }, scaleanchor: "x" } }} height={300} testId="mode-field-plot" />
          ) : (
            <div className="muted pad">No field data. Set include_fields: true and solve again.</div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Points of an M/L/h/v/a path from profilePath (arcs approximated by their endpoints' circle). */
export function svgPathToPoints(d: string): [number, number][] {
  const circle = /^M([-\d.e]+),([-\d.e]+)a([-\d.e]+),/.exec(d);
  if (circle) {
    const r = Number(circle[3]);
    const cx = Number(circle[1]) + r;
    const cy = Number(circle[2]);
    return Array.from({ length: 73 }, (_, i) => [cx + r * Math.cos((i / 72) * 2 * Math.PI), cy + r * Math.sin((i / 72) * 2 * Math.PI)]);
  }
  const rect = /^M([-\d.e]+),([-\d.e]+)h([-\d.e]+)v([-\d.e]+)/.exec(d);
  if (rect) {
    const [x, y, w, h] = rect.slice(1).map(Number);
    return [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
      [x, y],
    ];
  }
  const pts = d
    .replace(/^M/, "")
    .replace(/z$/, "")
    .split("L")
    .map((s) => s.split(",").map(Number) as [number, number]);
  return pts.length ? [...pts, pts[0]] : [];
}

// --- S-parameters ---------------------------------------------------------------------------

function unwrapDeg(ph: number[]): number[] {
  const out = [...ph];
  for (let i = 1; i < out.length; i++) {
    let d = out[i] - out[i - 1];
    while (d > 180) (out[i] -= 360), (d -= 360);
    while (d < -180) (out[i] += 360), (d += 360);
  }
  return out;
}

export function SParamViewer({ runs, title = "S-parameters" }: { runs: Run<SParameterResult>[]; title?: string }) {
  const active = runs[0].result;
  const P = active.ports;
  const [inp, setInp] = useState(0);
  const [outs, setOuts] = useState<string[]>(P);
  const [db, setDb] = useState(true);
  const [phase, setPhase] = useState(false);
  const [wi, setWi] = useState(Math.floor(active.wavelengths_nm.length / 2));
  const plot = useRef<PlotHandle>(null);
  const mplot = useRef<PlotHandle>(null);

  const s = (r: SParameterResult, w: number, o: number, i: number) => [r.s_real[w]?.[o]?.[i] ?? NaN, r.s_imag[w]?.[o]?.[i] ?? NaN];
  const data = useMemo(
    () =>
      runs.flatMap((run, ri) => {
        const r = run.result;
        const i = r.ports.indexOf(P[inp]);
        if (i < 0) return [];
        return outs.flatMap((name, oi) => {
          const o = r.ports.indexOf(name);
          if (o < 0) return [];
          const vals = r.wavelengths_nm.map((_, w) => s(r, w, o, i));
          const y = phase ? unwrapDeg(vals.map(([re, im]) => (Math.atan2(im, re) * 180) / Math.PI)) : vals.map(([re, im]) => (db ? 10 * Math.log10(Math.max(re * re + im * im, 1e-12)) : re * re + im * im));
          return [{ x: r.wavelengths_nm, y, name: `S[${name}, ${P[inp]}]${runs.length > 1 ? ` · ${run.label}` : ""}`, mode: "lines", line: { color: COLORS[(ri * P.length + oi) % COLORS.length] } }];
        });
      }),
    [runs, inp, outs, db, phase, P],
  );

  const matrix = useMemo(() => {
    const z = P.map((_, o) => P.map((_, i) => Math.hypot(...s(active, wi, o, i))));
    return [
      {
        type: "heatmap",
        x: P.map((p) => `in ${p}`),
        y: P.map((p) => `out ${p}`),
        z,
        zmin: 0,
        zmax: 1,
        colorscale: "Viridis",
        text: z.map((row) => row.map((v) => v.toFixed(3))),
        texttemplate: "%{text}",
        hovertemplate: "%{y} ← %{x}: |S| = %{z:.4f}<extra></extra>",
        colorbar: { title: { text: "|S|" } },
      },
    ];
  }, [active, wi, P]);

  const csv = () => {
    const rows: (string | number)[][] = [];
    active.wavelengths_nm.forEach((w, k) => P.forEach((po, o) => P.forEach((pi, i) => rows.push([w, po, pi, active.s_real[k][o][i], active.s_imag[k][o][i]]))));
    void exportFile(csvRows(["wavelength_nm", "out", "in", "re", "im"], rows), "sparameters.csv", "text/csv");
  };
  const power = active.wavelengths_nm.map((_, w) => P.reduce((a, _p, o) => a + Math.hypot(...s(active, w, o, inp)) ** 2, 0));

  return (
    <div className="panel" data-testid="sparam-viewer">
      <Toolbar>
        <h4 className="grow">{title}</h4>
        <label className="small">
          input{" "}
          <select value={inp} onChange={(e) => setInp(Number(e.target.value))} data-testid="sparam-input">
            {P.map((p, i) => (
              <option key={p} value={i}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <Checks options={P} value={outs} onChange={setOuts} />
        <div className="seg">
          <button className={!phase && db ? "active" : ""} onClick={() => (setPhase(false), setDb(true))}>
            dB
          </button>
          <button className={!phase && !db ? "active" : ""} onClick={() => (setPhase(false), setDb(false))}>
            |S|²
          </button>
          <button className={phase ? "active" : ""} onClick={() => setPhase(true)}>
            phase
          </button>
        </div>
        <ExportButtons plot={plot} name="sparameters" extra={<button className="small" onClick={csv}>CSV</button>} />
      </Toolbar>
      <Plot
        ref={plot}
        data={data}
        layout={{ xaxis: { title: { text: "wavelength (nm)" } }, yaxis: { title: { text: phase ? "phase (°, unwrapped)" : db ? "|S|² (dB)" : "|S|²" } }, hovermode: "x unified" }}
        height={320}
        testId="sparam-plot"
      />
      <div className="muted small">
        Σ|S_out,{P[inp]}|² from {Math.min(...power).toFixed(3)} to {Math.max(...power).toFixed(3)} (1 = lossless)
      </div>
      <Toolbar>
        <h4 className="grow">Matrix |S|</h4>
        <input type="range" min={0} max={active.wavelengths_nm.length - 1} value={wi} onChange={(e) => setWi(Number(e.target.value))} data-testid="sparam-wl" />
        <span className="small">λ = {active.wavelengths_nm[wi]} nm</span>
        <ExportButtons plot={mplot} name="smatrix" />
      </Toolbar>
      <Plot ref={mplot} data={matrix} layout={{ yaxis: { autorange: "reversed" }, margin: { l: 80, r: 10, t: 10, b: 50 } }} height={Math.min(420, 120 + 50 * P.length)} testId="smatrix-plot" />
    </div>
  );
}

// --- bands ------------------------------------------------------------------------------

export interface Gap {
  pol: string;
  lower: number;
  upper: number;
  bands: [number, number];
  ratio: number;
}

/** Gaps between consecutive bands that hold over the whole k-path (per polarization), plus complete gaps. */
export function bandGaps(freqs: Record<string, number[][]>): Gap[] {
  const out: Gap[] = [];
  for (const [pol, fk] of Object.entries(freqs)) {
    const nb = Math.min(...fk.map((r) => r.length));
    for (let n = 0; n + 1 < nb; n++) {
      const lo = Math.max(...fk.map((r) => r[n]));
      const hi = Math.min(...fk.map((r) => r[n + 1]));
      if (hi > lo + 1e-9) out.push({ pol, lower: lo, upper: hi, bands: [n + 1, n + 2], ratio: (2 * (hi - lo)) / (hi + lo) });
    }
  }
  if (freqs.te && freqs.tm) {
    for (const a of out.filter((g) => g.pol === "te"))
      for (const b of out.filter((g) => g.pol === "tm")) {
        const lo = Math.max(a.lower, b.lower);
        const hi = Math.min(a.upper, b.upper);
        if (hi > lo + 1e-9) out.push({ pol: "complete", lower: lo, upper: hi, bands: a.bands, ratio: (2 * (hi - lo)) / (hi + lo) });
      }
  }
  return out;
}

const POL_COLOR: Record<string, string> = { te: "#4f9dff", tm: "#ff8a4c", all: "#dfe3ea", complete: "#38d39f" };

export function BandsViewer({ runs }: { runs: Run<BandResult>[] }) {
  const active = runs[0].result;
  const plot = useRef<PlotHandle>(null);
  const [showGaps, setShowGaps] = useState(true);
  const gaps = useMemo(() => bandGaps(active.frequencies), [active]);
  const a = useMemo(() => {
    const lv = runs[0].spec.lattice_vectors_nm as number[][] | undefined;
    return lv?.[0] ? Math.hypot(...lv[0]) : null;
  }, [runs]);
  const data = useMemo(
    () =>
      runs.flatMap((run, ri) =>
        Object.entries(run.result.frequencies).flatMap(([pol, fk]) =>
          Array.from({ length: Math.min(...fk.map((r) => r.length)) }, (_, b) => ({
            x: run.result.k_distance,
            y: fk.map((r) => r[b]),
            name: `${pol.toUpperCase()}${runs.length > 1 ? ` · ${run.label}` : ""}`,
            legendgroup: `${ri}${pol}`,
            showlegend: b === 0,
            mode: "lines",
            line: { color: ri === 0 ? (POL_COLOR[pol] ?? COLORS[b % COLORS.length]) : COLORS[(ri + 3) % COLORS.length], width: 2, dash: ri === 0 ? "solid" : "dash" },
          })),
        ),
      ),
    [runs],
  );
  const ticks = Object.entries(active.k_labels).map(([i, l]) => ({ x: active.k_distance[Number(i)], l }));
  const layout = useMemo(
    () => ({
      xaxis: { title: { text: "wave vector" }, tickvals: ticks.map((t) => t.x), ticktext: ticks.map((t) => t.l), showgrid: true, range: [Math.min(...active.k_distance), Math.max(...active.k_distance)] },
      yaxis: { title: { text: "frequency ωa/2πc = a/λ" }, rangemode: "tozero" },
      shapes: showGaps
        ? gaps.map((g) => ({ type: "rect", xref: "paper", x0: 0, x1: 1, y0: g.lower, y1: g.upper, fillcolor: g.pol === "complete" ? "rgba(56,211,159,0.25)" : g.pol === "tm" ? "rgba(255,138,76,0.15)" : "rgba(79,157,255,0.15)", line: { width: 0 }, layer: "below" }))
        : [],
    }),
    [ticks, gaps, showGaps, active],
  );
  return (
    <div className="panel" data-testid="bands-viewer">
      <Toolbar>
        <h4 className="grow">Band diagram</h4>
        <label className="small">
          <input type="checkbox" checked={showGaps} onChange={(e) => setShowGaps(e.target.checked)} /> shade gaps
        </label>
        <ExportButtons
          plot={plot}
          name="bands"
          extra={
            <button
              className="small"
              onClick={() =>
                void exportFile(
                  csvRows(
                    ["polarization", "k_index", "k_distance", "band", "a_over_lambda"],
                    Object.entries(active.frequencies).flatMap(([p, fk]) => fk.flatMap((r, k) => r.map((f, b) => [p, k, active.k_distance[k], b + 1, f]))),
                  ),
                  "bands.csv",
                  "text/csv",
                )
              }
            >
              CSV
            </button>
          }
        />
      </Toolbar>
      <Plot ref={plot} data={data} layout={layout} height={400} testId="bands-plot" />
      <table className="summary-table" data-testid="gap-table">
        <thead>
          <tr>
            <th>Gap</th>
            <th>between bands</th>
            <th>a/λ</th>
            <th>gap/midgap</th>
            {a && <th>λ (nm), a = {fmtNum(a)} nm</th>}
          </tr>
        </thead>
        <tbody>
          {gaps.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                No band gap along this k-path.
              </td>
            </tr>
          )}
          {gaps.map((g, i) => (
            <tr key={i}>
              <td style={{ color: POL_COLOR[g.pol] }}>{g.pol === "complete" ? "complete (TE+TM)" : g.pol.toUpperCase()}</td>
              <td>
                {g.bands[0]}–{g.bands[1]}
              </td>
              <td>
                {g.lower.toFixed(4)}–{g.upper.toFixed(4)}
              </td>
              <td>{(100 * g.ratio).toFixed(1)} %</td>
              {a && (
                <td>
                  {(a / g.upper).toFixed(0)}–{(a / g.lower).toFixed(0)}
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --- inverse design ----------------------------------------------------------------------------

export function OptimizationViewer({ runs }: { runs: Run<OptimizationResult>[] }) {
  const r = runs[0].result;
  const plot = useRef<PlotHandle>(null);
  const data = useMemo(
    () => [
      { x: r.history.map((h) => h.iteration), y: r.history.map((h) => h.objective), name: "objective", mode: "lines+markers", line: { color: COLORS[0] } },
      { x: r.history.map((h) => h.iteration), y: r.history.map((h) => h.binarization ?? null), name: "binarization", yaxis: "y2", mode: "lines", line: { color: COLORS[1], dash: "dot" } },
      { x: r.history.map((h) => h.iteration), y: r.history.map((h) => (typeof h.beta === "number" ? Math.log2(Math.max(h.beta, 1e-9)) / 8 : null)), name: "log₂β / 8", yaxis: "y2", mode: "lines", line: { color: COLORS[3], dash: "dash", width: 1 } },
    ],
    [r],
  );
  return (
    <>
      <div className="panel" data-testid="optimization-viewer">
        <Toolbar>
          <h4 className="grow">Optimisation history</h4>
          <span className="small">
            objective {fmtNum(r.objective_initial)} → {fmtNum(r.objective_final)} (binary design {fmtNum(r.objective_binary)}) · {r.structures?.length ?? 0} exported structures
          </span>
          <ExportButtons plot={plot} name="optimization" />
        </Toolbar>
        <Plot ref={plot} data={data} layout={{ xaxis: { title: { text: "iteration" } }, yaxis: { title: { text: "objective" } }, yaxis2: { title: { text: "binarization" }, overlaying: "y", side: "right", range: [0, 1] } }} height={300} testId="optimization-plot" />
      </div>
      {(r.designs?.length ?? 0) > 0 && <DesignView run={runs[0]} />}
      {r.sparameters && <SParamViewer runs={[{ ...runs[0], result: r.sparameters }]} title="S-parameters of the final (binary) design" />}
    </>
  );
}

/** Polygon outlines (nm) of structures' xy footprints: prism profiles, boxes and balls. */
function structureOutlines(list: unknown): { pts: [number, number][]; name: string }[] {
  if (!Array.isArray(list)) return [];
  return list.flatMap((s) => {
    if (!isObject(s) || !isObject(s.geometry)) return [];
    const g = s.geometry as JsonObject;
    let profile: JsonObject | null = null;
    if (g.kind === "prism" && isObject(g.profile)) profile = g.profile as JsonObject;
    else if (g.kind === "box") {
      const c = (g.center_nm as number[]) ?? [0, 0, 0];
      const z = (g.size_nm as number[]) ?? [0, 0, 0];
      profile = { kind: "rectangle", center_nm: [c[0], c[1]], size_nm: [z[0], z[1]] };
    } else if (g.kind === "ball") {
      const c = (g.center_nm as number[]) ?? [0, 0, 0];
      profile = { kind: "circle", center_nm: [c[0], c[1]], radius_nm: Number(g.radius_nm) || 1 };
    }
    return profile ? [{ pts: svgPathToPoints(profilePath(profile)), name: String(s.name ?? "") }] : [];
  });
}

/** Final design: density (or raw variables) of each design region, with the exported binary polygons. */
function DesignView({ run }: { run: Run<OptimizationResult> }) {
  const r = run.result;
  const designs = r.designs ?? [];
  const [di, setDi] = useState(0);
  const [which, setWhich] = useState<"density" | "raw">("density");
  const [outlines, setOutlines] = useState(true);
  const plot = useRef<PlotHandle>(null);
  const d = designs[Math.min(di, designs.length - 1)];
  const data = useMemo(() => {
    if (!d) return [];
    const m = d[which];
    const z = d.y_nm.map((_, j) => d.x_nm.map((_, i) => m[i]?.[j] ?? null));
    const traces: object[] = [
      { type: "heatmap", x: d.x_nm, y: d.y_nm, z, zmin: 0, zmax: 1, colorscale: "Greys", colorbar: { title: { text: which === "density" ? "density" : "raw ρ" } }, hovertemplate: "x=%{x:.0f} nm<br>y=%{y:.0f} nm<br>%{z:.3f}<extra></extra>" },
    ];
    if (outlines) {
      // Fixed parts of the device (waveguides), then the exported binary design (the region box is skipped).
      const device = isObject(run.spec.device) ? (run.spec.device as JsonObject) : null;
      for (const o of structureOutlines(device?.structures))
        traces.push({ x: o.pts.map((p) => p[0]), y: o.pts.map((p) => p[1]), mode: "lines", line: { color: "#8b93a1", width: 1, dash: "dot" }, hoverinfo: "skip", showlegend: false });
      for (const o of structureOutlines(r.structures).filter((o) => !o.name.endsWith(":region")))
        traces.push({ x: o.pts.map((p) => p[0]), y: o.pts.map((p) => p[1]), mode: "lines", line: { color: "#4cd7e4", width: 1.5 }, hoverinfo: "skip", showlegend: false });
    }
    return traces;
  }, [d, which, outlines, r.structures, run.spec]);
  if (!d) return null;
  const pad = 0.15 * Math.max(d.x_nm[d.x_nm.length - 1] - d.x_nm[0], d.y_nm[d.y_nm.length - 1] - d.y_nm[0]);
  const binary = d.density.flat();
  const solid = binary.filter((v) => v > 0.5).length / Math.max(1, binary.length);
  return (
    <div className="panel" data-testid="design-view">
      <Toolbar>
        <h4 className="grow">
          Final design <span className="muted small">{Math.round(100 * solid)} % solid · binary objective {fmtNum(r.objective_binary)}</span>
        </h4>
        {designs.length > 1 && (
          <select value={di} onChange={(e) => setDi(Number(e.target.value))}>
            {designs.map((x, i) => (
              <option key={i} value={i}>
                {x.name}
              </option>
            ))}
          </select>
        )}
        <div className="seg">
          <button className={which === "density" ? "active" : ""} onClick={() => setWhich("density")}>
            density
          </button>
          <button className={which === "raw" ? "active" : ""} onClick={() => setWhich("raw")}>
            raw
          </button>
        </div>
        <label className="small">
          <input type="checkbox" checked={outlines} onChange={(e) => setOutlines(e.target.checked)} /> exported polygons
        </label>
        <ExportButtons
          plot={plot}
          name={`design-${d.name}`}
          extra={
            <button
              className="small"
              onClick={() =>
                void exportFile(csvRows(["x_nm", "y_nm", "density", "raw"], d.x_nm.flatMap((x, i) => d.y_nm.map((y, j) => [x, y, d.density[i][j], d.raw[i][j]]))), `design-${d.name}.csv`, "text/csv")
              }
            >
              CSV
            </button>
          }
        />
      </Toolbar>
      <Plot
        ref={plot}
        data={data}
        layout={{
          xaxis: { title: { text: "x (nm)" }, range: [d.x_nm[0] - pad, d.x_nm[d.x_nm.length - 1] + pad], constrain: "domain" },
          yaxis: { title: { text: "y (nm)" }, range: [d.y_nm[0] - pad, d.y_nm[d.y_nm.length - 1] + pad], scaleanchor: "x" },
        }}
        height={420}
        testId="design-plot"
      />
      <div className="muted small">Grey: density (white = high-index material); cyan: exported binary polygons; dotted: fixed waveguides.</div>
    </div>
  );
}
