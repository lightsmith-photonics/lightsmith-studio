// Evaluate any spec material at given wavelengths: n/k previews in the
// material picker, range warnings, and the mock solver. Same formulas and
// conventions as lightsmith.materials (exp(-iωt), Im(n) >= 0 is loss).

import library from "../generated/library.json";
import { isObject, type Json, type JsonObject } from "../schema/schema";
import { C } from "./complex";

export const HC_EV_NM = 1239.841984;

export interface LibraryDataset {
  name: string;
  description: string;
  aliases: string[];
  dataset: string;
  default: boolean;
  dataset_aliases: string[];
  range_nm: [number, number];
  has_k: boolean;
  comments: string;
  reference: string;
  doi: string;
  url: string;
  license: string;
  material_json: JsonObject;
  wavelength_nm: number[];
  n: number[];
  k: number[];
}

export const LIBRARY = library as unknown as LibraryDataset[];

/** Canonical library dataset for a (possibly aliased) name/dataset, like the library's _lookup. */
export function findLibrary(name: string, dataset?: string | null): LibraryDataset | undefined {
  const lc = (s: string) => s.trim().toLowerCase();
  const rows = LIBRARY.filter((r) => lc(r.name) === lc(name) || r.aliases.some((a) => lc(a) === lc(name)));
  if (!rows.length) return undefined;
  if (!dataset) return rows.find((r) => r.default) ?? rows[0];
  return rows.find((r) => lc(r.dataset) === lc(dataset) || r.dataset_aliases.some((a) => lc(a) === lc(dataset)));
}

export class MaterialRangeError extends Error {}

function interp(x: number, xs: number[], ys: number[]): number {
  if (x <= xs[0]) return ys[0];
  if (x >= xs[xs.length - 1]) return ys[ys.length - 1];
  let lo = 0;
  let hi = xs.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (xs[mid] <= x) lo = mid;
    else hi = mid;
  }
  const t = (x - xs[lo]) / (xs[hi] - xs[lo]);
  return ys[lo] + t * (ys[hi] - ys[lo]);
}

/** Valid wavelength range of a material in nm, or null if unbounded. */
export function materialRange(m: Json): [number, number] | null {
  if (!isObject(m)) return null;
  if (m.kind === "tabulated" && Array.isArray(m.wavelength_nm) && m.wavelength_nm.length) {
    const w = m.wavelength_nm as number[];
    return [Math.min(...w), Math.max(...w)];
  }
  if (m.kind === "library") {
    const row = findLibrary(String(m.name ?? ""), m.dataset as string | null);
    return row ? row.range_nm : null;
  }
  return null;
}

/** Relative permittivity at one wavelength. Throws MaterialRangeError outside tabulated data. */
export function epsAt(m: Json, wl: number): C {
  if (!isObject(m)) throw new Error("material must be an object");
  const num = (k: string, d = 0) => (typeof m[k] === "number" ? (m[k] as number) : d);
  const w = HC_EV_NM / wl;
  switch (m.kind) {
    case "constant_index":
      return new C(num("n_real", 1), num("n_imag")).mul(new C(num("n_real", 1), num("n_imag")));
    case "constant_permittivity":
      return new C(num("eps_real", 1), num("eps_imag"));
    case "drude": {
      const wp = num("wp_ev");
      return new C(num("eps_inf", 1)).sub(new C(wp * wp).div(new C(w * w, num("gamma_ev") * w)));
    }
    case "drude_lorentz": {
      let e = new C(num("eps_inf", 1));
      const wp = num("wp_ev");
      if (wp > 0) e = e.sub(new C(wp * wp).div(new C(w * w, num("gamma_ev") * w)));
      for (const p of Array.isArray(m.poles) ? m.poles : []) {
        if (!isObject(p)) continue;
        const d = Number(p.delta_eps ?? 0);
        const w0 = Number(p.omega0_ev ?? 1);
        const g = Number(p.gamma_ev ?? 0);
        e = e.add(new C(d * w0 * w0).div(new C(w0 * w0 - w * w, -g * w)));
      }
      return e;
    }
    case "tabulated":
    case "library": {
      let xs: number[];
      let ns: number[];
      let ks: number[];
      if (m.kind === "library") {
        const row = findLibrary(String(m.name ?? ""), m.dataset as string | null);
        if (!row) throw new Error(`unknown library material ${JSON.stringify(m.name)} / ${JSON.stringify(m.dataset)}`);
        [xs, ns, ks] = [row.wavelength_nm, row.n, row.k];
      } else {
        [xs, ns, ks] = [m.wavelength_nm as number[], m.n_real as number[], m.n_imag as number[]];
        if (!Array.isArray(xs) || !xs.length) throw new Error("tabulated material has no data");
        const order = xs.map((_, i) => i).sort((a, b) => xs[a] - xs[b]);
        [xs, ns, ks] = [order.map((i) => xs[i]), order.map((i) => ns[i]), order.map((i) => ks[i])];
      }
      if (wl < xs[0] - 1e-9 || wl > xs[xs.length - 1] + 1e-9)
        throw new MaterialRangeError(`wavelength ${wl} nm outside the data range ${xs[0]}–${xs[xs.length - 1]} nm`);
      const n = new C(interp(wl, xs, ns), interp(wl, xs, ks));
      return n.mul(n);
    }
    default:
      throw new Error(`unknown material kind ${JSON.stringify(m.kind)}`);
  }
}

export function nkAt(m: Json, wl: number): { n: number; k: number } {
  const n = epsAt(m, wl).sqrt();
  return { n: n.re, k: n.im };
}

/** n, k sampled on a grid (NaN outside the material's range). */
export function nkCurve(m: Json, wls: number[]): { n: number[]; k: number[] } {
  const n: number[] = [];
  const k: number[] = [];
  for (const wl of wls) {
    try {
      const v = nkAt(m, wl);
      n.push(v.n);
      k.push(v.k);
    } catch {
      n.push(NaN);
      k.push(NaN);
    }
  }
  return { n, k };
}

/** Short display name, e.g. "Au (Johnson-Christy)" or "Drude ωp=9 eV". */
export function materialLabel(m: Json): string {
  if (!isObject(m)) return "—";
  switch (m.kind) {
    case "library":
      return `${m.name}${m.dataset ? ` (${m.dataset})` : ""}`;
    case "constant_index":
      return `n = ${m.n_real}${m.n_imag ? ` + ${m.n_imag}i` : ""}`;
    case "constant_permittivity":
      return `ε = ${m.eps_real}${m.eps_imag ? ` + ${m.eps_imag}i` : ""}`;
    case "drude":
      return `Drude ωp=${m.wp_ev} eV`;
    case "drude_lorentz":
      return `Drude–Lorentz (${Array.isArray(m.poles) ? m.poles.length : 0} poles)`;
    case "tabulated":
      return `Tabulated${m.source ? `: ${String(m.source).slice(0, 24)}` : ""}`;
    default:
      return String(m.kind ?? "material");
  }
}

/** A stable colour per material for the 3D view. */
export function materialColor(m: Json): string {
  if (isObject(m) && m.kind === "library") {
    const named: Record<string, string> = {
      Au: "#e0a526",
      Ag: "#c9ccd1",
      Al: "#a8b3bd",
      Cu: "#c8704a",
      Si: "#5b6b82",
      SiO2: "#a8d8ea",
      TiO2: "#f1f1e6",
      H2O: "#6fb7f0",
    };
    if (typeof m.name === "string" && named[m.name]) return named[m.name];
  }
  const s = JSON.stringify(m);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 55% 58%)`;
}

/** Parse a CSV/TSV of wavelength, n, k (comments with #, optional header) into a Tabulated material. */
export function parseNkCsv(text: string, unit: "nm" | "um" = "nm", source?: string): JsonObject {
  const wl: number[] = [];
  const n: number[] = [];
  const k: number[] = [];
  let detected = unit;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const parts = line.split(/[,;\t ]+/).filter(Boolean);
    const nums = parts.map(Number);
    if (nums.length < 2 || nums.slice(0, 2).some((x) => !Number.isFinite(x))) {
      if (/\bum\b|µm|micron/i.test(line)) detected = "um";
      continue; // header
    }
    wl.push(nums[0]);
    n.push(nums[1]);
    k.push(Number.isFinite(nums[2]) ? nums[2] : 0);
  }
  if (wl.length < 2) throw new Error("need at least two rows of wavelength, n[, k]");
  const scale = detected === "um" ? 1000 : 1;
  const order = wl.map((_, i) => i).sort((a, b) => wl[a] - wl[b]);
  const out: JsonObject = {
    kind: "tabulated",
    wavelength_nm: order.map((i) => wl[i] * scale),
    n_real: order.map((i) => n[i]),
    n_imag: order.map((i) => Math.max(0, k[i])),
  };
  if (source) out.source = source;
  return out;
}
