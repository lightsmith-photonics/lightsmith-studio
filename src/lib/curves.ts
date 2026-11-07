// Every result kind as named curves y(x), so runs of any problem kind, from any backend, can be overlaid,
// differenced (Compare) and reduced to numbers (Sweep). Only the library's numbers are used; the one derived
// quantity is |S|² from the S-parameters' real and imaginary parts.

import type {
  BandResult,
  EmissionResult,
  ModeResult,
  OptimizationResult,
  ScatteringResult,
  SParameterResult,
  SpectrumResult,
} from "../api/types";
import { resultKind } from "../api/types";

export interface Curve {
  /** Stable id across runs of the same problem kind, e.g. "c_ext_nm2", "R/s/0", "S21". */
  id: string;
  label: string;
  x: number[];
  y: number[];
  xLabel: string;
  yLabel: string;
}

const WL = "vacuum wavelength (nm)";

function sCurves(r: SParameterResult, prefix = ""): Curve[] {
  const out: Curve[] = [];
  const n = r.ports.length;
  for (let o = 0; o < n; o++)
    for (let i = 0; i < n; i++) {
      const y = r.wavelengths_nm.map((_, w) => (r.s_real[w]?.[o]?.[i] ?? NaN) ** 2 + (r.s_imag[w]?.[o]?.[i] ?? NaN) ** 2);
      out.push({ id: `${prefix}|S|²(${r.ports[o]},${r.ports[i]})`, label: `${prefix}|S ${r.ports[o]}←${r.ports[i]}|²`, x: r.wavelengths_nm, y, xLabel: WL, yLabel: "|S|²" });
    }
  return out;
}

/** The curves of one result; [] for a shape Studio does not know. */
export function curvesOf(result: unknown): Curve[] {
  switch (resultKind(result)) {
    case "cross_sections": {
      const r = result as ScatteringResult;
      return (["c_ext_nm2", "c_sca_nm2", "c_abs_nm2"] as const).map((k) => ({ id: k, label: `C_${k.slice(2, 5)}`, x: r.wavelengths_nm, y: r[k], xLabel: WL, yLabel: "cross section (nm²)" }));
    }
    case "spectrum": {
      const r = result as SpectrumResult;
      const out: Curve[] = [];
      for (const q of ["r", "t", "a"] as const)
        for (const p of r.polarizations)
          r.angles_deg.forEach((ang, j) => {
            const y = r[q]?.[p]?.[j];
            if (y) out.push({ id: `${q.toUpperCase()}/${p}/${ang}`, label: `${q.toUpperCase()}_${p} θ=${ang}°`, x: r.wavelengths_nm, y, xLabel: WL, yLabel: "power fraction" });
          });
      return out;
    }
    case "modes": {
      const r = result as ModeResult;
      const nModes = Math.max(0, ...r.modes.map((m) => m.length));
      const out: Curve[] = [];
      for (let m = 0; m < nModes; m++) {
        out.push({ id: `neff/${m}`, label: `n_eff mode ${m}`, x: r.wavelengths_nm, y: r.modes.map((w) => w[m]?.neff_real ?? NaN), xLabel: WL, yLabel: "n_eff" });
        if (r.modes.some((w) => typeof w[m]?.ng === "number")) out.push({ id: `ng/${m}`, label: `n_g mode ${m}`, x: r.wavelengths_nm, y: r.modes.map((w) => w[m]?.ng ?? NaN), xLabel: WL, yLabel: "n_g" });
      }
      return out;
    }
    case "sparameters":
      return sCurves(result as SParameterResult);
    case "bands": {
      const r = result as BandResult;
      const out: Curve[] = [];
      for (const [pol, f] of Object.entries(r.frequencies)) {
        const nb = Math.max(0, ...f.map((k) => k.length));
        for (let b = 0; b < nb; b++) out.push({ id: `band/${pol}/${b}`, label: `${pol} band ${b + 1}`, x: r.k_distance, y: f.map((k) => k[b] ?? NaN), xLabel: "k-path distance", yLabel: "a/λ" });
      }
      return out;
    }
    case "emission": {
      const r = result as EmissionResult;
      return [
        { id: "purcell", label: "Purcell (total)", x: r.wavelengths_nm, y: r.purcell, xLabel: WL, yLabel: "γ/γ₀" },
        { id: "radiative", label: "radiative", x: r.wavelengths_nm, y: r.radiative, xLabel: WL, yLabel: "γ/γ₀" },
        { id: "efficiency", label: "efficiency", x: r.wavelengths_nm, y: r.efficiency, xLabel: WL, yLabel: "efficiency" },
      ];
    }
    case "optimization": {
      const r = result as OptimizationResult;
      const hist = r.history ?? [];
      const out: Curve[] = [{ id: "objective", label: "objective", x: hist.map((h) => h.iteration), y: hist.map((h) => h.objective), xLabel: "iteration", yLabel: "objective" }];
      if (r.sparameters) out.push(...sCurves(r.sparameters, "final "));
      return out;
    }
    default:
      return [];
  }
}

/** y of `c` at the points `x` by linear interpolation (NaN outside its range). */
export function interpolate(c: { x: number[]; y: number[] }, x: number[]): number[] {
  const order = c.x.map((_, i) => i).sort((a, b) => c.x[a] - c.x[b]);
  const xs = order.map((i) => c.x[i]);
  const ys = order.map((i) => c.y[i]);
  return x.map((v) => {
    if (!xs.length || v < xs[0] - 1e-9 || v > xs[xs.length - 1] + 1e-9) return NaN;
    let j = xs.findIndex((t) => t >= v - 1e-9);
    if (j <= 0) return ys[0];
    if (Math.abs(xs[j] - v) < 1e-9) return ys[j];
    const t = (v - xs[j - 1]) / (xs[j] - xs[j - 1]);
    return ys[j - 1] + t * (ys[j] - ys[j - 1]);
  });
}

export function sameX(a: number[], b: number[]): boolean {
  return a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) <= 1e-6 * Math.max(1, Math.abs(v)));
}

export interface Difference {
  x: number[];
  abs: number[];
  /** (y − ref) / max(|ref|, floor · max|ref|): the floor keeps near-zero reference values from blowing up. */
  rel: number[];
  maxAbs: number;
  rmsAbs: number;
  maxRel: number;
  rmsRel: number;
  /** The run was interpolated onto the reference's x. */
  interpolated: boolean;
}

const stats = (v: number[]) => {
  const f = v.filter(Number.isFinite).map(Math.abs);
  return { max: f.length ? Math.max(...f) : NaN, rms: f.length ? Math.sqrt(f.reduce((s, x) => s + x * x, 0) / f.length) : NaN };
};

/** `run − ref` on the reference's x (relative floor: 1e-3 of the reference's largest |y|, as the library's compare). */
export function difference(run: Curve, ref: Curve, floor = 1e-3): Difference {
  const interpolated = !sameX(run.x, ref.x);
  const y = interpolated ? interpolate(run, ref.x) : run.y;
  const scale = Math.max(...ref.y.filter(Number.isFinite).map(Math.abs), 0);
  const abs = y.map((v, i) => v - ref.y[i]);
  const rel = abs.map((d, i) => d / Math.max(Math.abs(ref.y[i]), floor * scale, 1e-300));
  const a = stats(abs);
  const r = stats(rel);
  return { x: ref.x, abs, rel, maxAbs: a.max, rmsAbs: a.rms, maxRel: r.max, rmsRel: r.rms, interpolated };
}

/** Scalar reductions of a curve, for sweeps. */
export type Metric = "peak_y" | "peak_x" | "min_y" | "min_x" | "mean_y" | "at_x";
export const METRICS: { id: Metric; label: string }[] = [
  { id: "peak_y", label: "peak value" },
  { id: "peak_x", label: "position of the peak" },
  { id: "min_y", label: "minimum value" },
  { id: "min_x", label: "position of the minimum" },
  { id: "mean_y", label: "mean value" },
  { id: "at_x", label: "value at x =" },
];

export function reduce(c: Curve, m: Metric, at?: number): number {
  const ok = c.y.map((v, i) => [c.x[i], v] as const).filter(([, v]) => Number.isFinite(v));
  if (!ok.length) return NaN;
  switch (m) {
    case "peak_y":
      return Math.max(...ok.map(([, v]) => v));
    case "min_y":
      return Math.min(...ok.map(([, v]) => v));
    case "peak_x":
      return ok.reduce((b, p) => (p[1] > b[1] ? p : b))[0];
    case "min_x":
      return ok.reduce((b, p) => (p[1] < b[1] ? p : b))[0];
    case "mean_y":
      return ok.reduce((s, [, v]) => s + v, 0) / ok.length;
    case "at_x":
      return at === undefined ? NaN : interpolate(c, [at])[0];
  }
}
