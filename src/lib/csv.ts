// CSV exports of results (spectra, compare, near field, far field).

import type { CompareResult, FarFieldData, NearFieldData, ScatteringResult } from "../api/types";

const fmt = (x: number) => (Number.isFinite(x) ? String(x) : "");

function table(header: string[], rows: (string | number)[][]): string {
  const esc = (v: string | number) => {
    const s = typeof v === "number" ? fmt(v) : v;
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...rows].map((r) => r.map(esc).join(",")).join("\n") + "\n";
}

export function spectraCsv(results: { label: string; result: ScatteringResult }[]): string {
  const header = ["series", "method", "backend", "wavelength_nm", "c_ext_nm2", "c_sca_nm2", "c_abs_nm2", "q_ext", "q_sca", "q_abs"];
  const rows: (string | number)[][] = [];
  for (const { label, result: r } of results) {
    const g = Math.PI * r.equivalent_radius_nm ** 2;
    r.wavelengths_nm.forEach((w, i) =>
      rows.push([label, r.method, r.backend, w, r.c_ext_nm2[i], r.c_sca_nm2[i], r.c_abs_nm2[i], r.c_ext_nm2[i] / g, r.c_sca_nm2[i] / g, r.c_abs_nm2[i] / g]),
    );
  }
  return table(header, rows);
}

export function compareCsv(c: CompareResult): string {
  const rows: (string | number)[][] = [];
  for (const [m, d] of Object.entries(c.relative_difference))
    for (const [q, v] of Object.entries(d)) rows.push([m, c.reference, q, v.max, v.rms]);
  return table(["method", "reference", "quantity", "max_rel_diff", "rms_rel_diff"], rows);
}

export function nearFieldCsv(nf: NearFieldData): string {
  const [a, b] = [nf.plane[0], nf.plane[1]];
  const rows: number[][] = [];
  nf.axis1_nm.forEach((u, i) => nf.axis2_nm.forEach((v, j) => rows.push([u, v, nf.enhancement[i][j]])));
  return `# near field |E|^2/|E0|^2, plane ${nf.plane} at offset ${nf.offset_nm} nm, wavelength ${nf.wavelength_nm} nm\n` + table([`${a}_nm`, `${b}_nm`, "enhancement"], rows);
}

export function farFieldCsv(ff: FarFieldData): string {
  const rows: number[][] = [];
  ff.theta_deg.forEach((t, i) => ff.phi_deg.forEach((p, j) => rows.push([t, p, ff.dcsca_domega_nm2[i][j]])));
  return `# dC_sca/dOmega (nm^2/sr), wavelength ${ff.wavelength_nm} nm\n` + table(["theta_deg", "phi_deg", "dcsca_domega_nm2"], rows);
}
