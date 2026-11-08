// The mock compute server's "physics". Exact Mie for a single homogeneous
// sphere; independent quasi-static particles otherwise. It exists so the GUI
// can be built and tested without Python. Results say so in their warnings.

import backendsJson from "../../generated/backends.json";
import { C } from "../../physics/complex";
import { epsAt } from "../../physics/materials";
import { amplitudes, depolarization, mieCoefficients, spheroidPolarizability } from "../../physics/mie";
import { isObject, type Json, type JsonObject } from "../../schema/schema";
import type { BackendInfo, Estimate, FarFieldData, NearFieldData, ScatteringResult, SupportInfo } from "../types";

export const MOCK_BACKENDS = backendsJson as unknown as BackendInfo[];
export const MOCK_WARNING = "mock server: approximate in-browser physics, not a real solver backend";
export const CANNED_WARNING = "mock server: this is the library's solved EXAMPLE for this problem kind, not a solution of your spec";
export const SNAPSHOT_WARNING = "mock server: the library's FDTD solution of this exact spec, from Studio's snapshot (scripts/make_fixtures.py)";

/** As the library's AUTO_ORDER (lightsmith/api.py). */
const AUTO_ORDER: Record<string, string[]> = {
  scattering: ["mie", "tmatrix", "bem", "dda", "fdtd"],
  layer_stack: ["tmm", "rcwa", "fdtd"],
  periodic: ["rcwa", "fdfd", "fdtd"],
  mode: ["fde"],
  device: ["eme", "bpm", "fdfd", "fdtd"],
  bands: ["pwe", "fdfd"],
  circuit: ["circuit"],
  optimization: ["inverse"],
  emission: ["mie", "fdtd"],
};

type Particle = { shape: JsonObject; material: Json; position_nm: number[] };

export function problemKind(spec: Json): string {
  return isObject(spec) && typeof spec.kind === "string" ? spec.kind : "scattering";
}

export function wavelengthArray(spec: JsonObject): number[] {
  const w = spec.wavelengths;
  if (Array.isArray(w)) return w as number[];
  if (isObject(w)) {
    const a = Number(w.start_nm);
    const b = Number(w.stop_nm);
    const n = Math.max(1, Math.round(Number(w.num)));
    return n === 1 ? [a] : Array.from({ length: n }, (_, i) => a + ((b - a) * i) / (n - 1));
  }
  return [];
}

function particles(spec: JsonObject): Particle[] {
  return ((spec.particles as Json[]) ?? []).filter(isObject).map((p) => ({
    shape: p.shape as JsonObject,
    material: p.material,
    position_nm: (p.position_nm as number[]) ?? [0, 0, 0],
  }));
}

function volume(s: JsonObject): number {
  const n = (k: string) => Number(s[k]);
  switch (s.kind) {
    case "sphere":
      return (4 / 3) * Math.PI * n("radius_nm") ** 3;
    case "spheroid":
      return (4 / 3) * Math.PI * n("semi_axis_xy_nm") ** 2 * n("semi_axis_z_nm");
    case "cylinder":
      return Math.PI * n("radius_nm") ** 2 * n("length_nm");
    case "layered_sphere":
      return (4 / 3) * Math.PI * outerRadius(s) ** 3;
    default:
      return 0;
  }
}

function outerRadius(s: JsonObject): number {
  return Number(s.core_radius_nm) + ((s.shells as JsonObject[]) ?? []).reduce((a, sh) => a + Number(sh.thickness_nm), 0);
}

/** Half extent of the particle's bounding box (x, y, z). */
export function halfExtent(s: JsonObject): [number, number, number] {
  switch (s.kind) {
    case "sphere":
      return [Number(s.radius_nm), Number(s.radius_nm), Number(s.radius_nm)];
    case "spheroid":
      return [Number(s.semi_axis_xy_nm), Number(s.semi_axis_xy_nm), Number(s.semi_axis_z_nm)];
    case "cylinder":
      return [Number(s.radius_nm), Number(s.radius_nm), Number(s.length_nm) / 2];
    case "layered_sphere": {
      const r = outerRadius(s);
      return [r, r, r];
    }
    default:
      return [0, 0, 0];
  }
}

/** Volume-averaged permittivity of a layered sphere (mock only). */
function particleEps(p: Particle, wl: number): C {
  if (p.shape.kind !== "layered_sphere") return epsAt(p.material, wl);
  const radii = [Number(p.shape.core_radius_nm)];
  const mats: Json[] = [p.material];
  for (const sh of (p.shape.shells as JsonObject[]) ?? []) {
    radii.push(radii[radii.length - 1] + Number(sh.thickness_nm));
    mats.push(sh.material);
  }
  let eps = new C(0);
  let prev = 0;
  radii.forEach((r, i) => {
    eps = eps.add(epsAt(mats[i], wl).mul((r ** 3 - prev ** 3) / radii[radii.length - 1] ** 3));
    prev = r;
  });
  return eps;
}

function unit(v: number[]): number[] {
  const n = Math.hypot(...v) || 1;
  return v.map((x) => x / n);
}

export function supportsMock(spec: JsonObject, b: BackendInfo): { ok: boolean; why: string } {
  const kind = problemKind(spec);
  if (b.problem_kinds && !b.problem_kinds.includes(kind)) return { ok: false, why: `solves ${JSON.stringify(b.problem_kinds)}, not '${kind}'` };
  // Mie emission, as the library's NativeMie._supports_emission (in its order).
  if (kind === "emission" && b.method === "mie") {
    const ps = particles(spec);
    if (ps.length !== 1 || !["sphere", "layered_sphere"].includes(String(ps[0].shape?.kind))) return { ok: false, why: "Mie emission needs exactly one sphere (plain or layered); use 'fdtd'" };
    const d = isObject(spec.dipole) && Array.isArray(spec.dipole.position_nm) ? (spec.dipole.position_nm as number[]) : [0, 0, 0];
    if (Math.hypot(...d.map((x, i) => x - ps[0].position_nm[i])) <= Math.max(...halfExtent(ps[0].shape)) * (1 + 1e-9)) return { ok: false, why: "Mie emission needs the dipole outside the sphere; use 'fdtd'" };
    if (isObject(spec.radiation_pattern)) return { ok: false, why: "Mie emission does not compute radiation patterns yet; use 'fdtd'" };
    return { ok: true, why: "" };
  }
  // Other problem kinds: the mock has no per-backend rules; every backend of the kind applies.
  if (kind !== "scattering") return { ok: true, why: "" };
  const ps = particles(spec);
  const out = isObject(spec.outputs) ? spec.outputs : {};
  const near = isObject(out.near_field);
  const far = isObject(out.far_field);
  const beam = isObject(spec.illumination) && spec.illumination.kind === "gaussian_beam";
  const res = isObject(out.resonances);
  // The library's unsupported_outputs (backends/base.py), in its order.
  const missing = (opts: { near?: boolean; far?: boolean; substrate?: boolean; oa?: boolean; beam?: boolean; res?: boolean }) => {
    const m: string[] = [];
    if (near && !opts.near) m.push("near_field output");
    if (far && !opts.far) m.push("far_field output");
    if (beam && !opts.beam) m.push("gaussian_beam illumination");
    if (res && !opts.res) m.push("resonances output (time-domain solvers only)");
    if (isObject(spec.substrate) && !opts.substrate) m.push("substrate");
    if (spec.orientation_average === true && !opts.oa) m.push("orientation_average");
    return m.length ? "does not support " + m.join(", ") : "";
  };
  const fieldsWithOA = () => (spec.orientation_average === true && (near || far) ? "field outputs are not available with orientation_average" : "");
  switch (b.name === "miepython" ? "miepython" : b.method === "mie" ? "native-mie" : b.method === "tmatrix" ? "tmatrix" : b.name) {
    case "miepython": {
      if (ps.length !== 1) return { ok: false, why: "Mie handles exactly one particle; use 'tmatrix' or 'dda' for clusters" };
      if (ps[0].shape.kind !== "sphere") return { ok: false, why: `Mie handles spheres only, got '${ps[0].shape.kind}'; use 'dda' or 'tmatrix'` };
      const why = missing({ oa: true });
      return { ok: !why, why };
    }
    case "native-mie": {
      if (ps.length !== 1) return { ok: false, why: "Mie handles exactly one particle; use 'tmatrix' or 'dda' for clusters" };
      if (!["sphere", "layered_sphere"].includes(String(ps[0].shape.kind)))
        return { ok: false, why: `Mie handles spheres and layered spheres only, got '${ps[0].shape.kind}'; use 'dda' or 'tmatrix'` };
      const why = missing({ near: true, far: true, oa: true }) || fieldsWithOA();
      return { ok: !why, why };
    }
    case "tmatrix": {
      const i = ps.findIndex((p) => !["sphere", "layered_sphere"].includes(String(p.shape.kind)));
      if (i >= 0) return { ok: false, why: `the treams T-matrix backend handles spheres and layered spheres only, got '${ps[i].shape.kind}' (particle ${i}); use 'dda'` };
      const why = missing({ near: true, far: true, oa: true }) || fieldsWithOA();
      return { ok: !why, why };
    }
    default: {
      if (b.method === "fdtd") {
        const why = missing({ near: true, far: true, substrate: true, beam: true, res: true });
        return { ok: !why, why };
      }
      // as the library's quasistatic.supports and bem.supports
      if (b.method === "quasistatic") {
        if (ps.length !== 1) return { ok: false, why: "the quasistatic approximation handles exactly one particle" };
        if (!["sphere", "layered_sphere", "spheroid"].includes(String(ps[0].shape.kind))) return { ok: false, why: `quasistatic handles spheres, layered spheres and spheroids, got '${ps[0].shape.kind}'` };
        const why = missing({ far: true, oa: true }) || (spec.orientation_average === true && far ? "far_field output is not available with orientation_average" : "");
        return { ok: !why, why };
      }
      if (b.method === "bem") {
        if (isObject(spec.substrate)) return { ok: false, why: "BEM here uses the homogeneous-space Green's function and does not support a substrate; use 'fdtd'" };
        const why = missing({ near: true, far: true, oa: true }) || fieldsWithOA();
        return { ok: !why, why };
      }
      if (b.method === "dda") {
        const why = missing({ near: true, far: true, oa: true }) || fieldsWithOA();
        return { ok: !why, why };
      }
      const why = missing({ near: true, far: true, substrate: true, oa: true });
      return { ok: !why, why };
    }
  }
}

export function supportsAll(spec: JsonObject): SupportInfo[] {
  return MOCK_BACKENDS.filter((b) => !b.problem_kinds || b.problem_kinds.includes(problemKind(spec))).map((b) => {
    const s = supportsMock(spec, b);
    return {
      name: b.name,
      method: b.method,
      available: b.available,
      unavailable_reason: b.unavailable_reason,
      supported: s.ok,
      reason: s.ok ? null : s.why,
    };
  });
}

/** Resolve a method / backend name like the library's api._resolve. */
export function resolveBackend(spec: JsonObject, method: string): BackendInfo {
  const kind = problemKind(spec);
  const pool = MOCK_BACKENDS.filter((b) => !b.problem_kinds || b.problem_kinds.includes(kind));
  if (method === "auto") {
    const skipped: string[] = [];
    const order = [...(AUTO_ORDER[kind] ?? []), ...new Set(pool.map((b) => b.method))];
    for (const m of [...new Set(order)]) {
      for (const b of pool.filter((x) => x.method === m)) {
        if (!b.available) {
          skipped.push(`${b.name}: ${b.unavailable_reason}`);
          continue;
        }
        const s = supportsMock(spec, b);
        if (s.ok) return b;
        skipped.push(`${b.name}: ${s.why}`);
      }
    }
    if (!pool.length) throw new Error(`no backend is installed for problem kind '${kind}'`);
    throw new Error("no available backend supports this problem: " + skipped.join("; "));
  }
  const b = MOCK_BACKENDS.find((x) => x.name === method) ?? pool.find((x) => x.method === method && x.available) ?? pool.find((x) => x.method === method);
  if (!b) {
    const known = [...new Set(MOCK_BACKENDS.flatMap((x) => [x.method, x.name]))].sort();
    throw new Error(`unknown method or backend '${method}'; known: ${JSON.stringify(known)}`);
  }
  if (!b.available) throw new Error(`backend '${b.name}' cannot run this problem: ${b.unavailable_reason}`);
  const s = supportsMock(spec, b);
  if (!s.ok) throw new Error(`backend '${b.name}' cannot run this problem: ${s.why}`);
  return b;
}

function deviceInfo(device: string, gpu: boolean): { framework: string; device: string } {
  if (!gpu || device === "cpu") return { framework: "numpy", device: "cpu" };
  if (device === "torch-cpu") return { framework: "torch", device: "cpu" };
  return { framework: "torch", device: device === "auto" || device === "gpu" ? "cuda:0" : device };
}

export function estimateMock(spec: JsonObject, method: string, device: string): Estimate {
  const b = resolveBackend(spec, method);
  const dev = deviceInfo(device, b.gpu);
  if (problemKind(spec) !== "scattering") return { backend: b.name, method: b.method, ...dev, note: "mock server: no size estimate for this problem kind" };
  const wl = wavelengthArray(spec);
  if (b.method === "mie") return { backend: b.name, method: b.method, ...dev, cost: "negligible", memory_bytes: 0 };
  const ps = particles(spec);
  const opts = { ...((spec.options as JsonObject)?.[b.method] as JsonObject), ...((spec.options as JsonObject)?.[b.name] as JsonObject) };
  if (b.method === "dda") {
    const kmax = (2 * Math.PI * Number(spec.medium_index ?? 1)) / Math.min(...wl);
    const diam = Math.min(...ps.map((p) => 2 * Math.max(...halfExtent(p.shape))));
    const npd = Number(opts.dipoles_per_diameter) || Math.max(16, Math.ceil((diam * 4 * kmax) / 0.5));
    const d = diam / npd;
    const lo = [0, 1, 2].map((i) => Math.min(...ps.map((p) => p.position_nm[i] - halfExtent(p.shape)[i])));
    const hi = [0, 1, 2].map((i) => Math.max(...ps.map((p) => p.position_nm[i] + halfExtent(p.shape)[i])));
    const grid = lo.map((l, i) => Math.max(1, Math.ceil((hi[i] - l) / d)));
    const cells = grid[0] * grid[1] * grid[2];
    const dipoles = Math.round(ps.reduce((a, p) => a + volume(p.shape), 0) / d ** 3);
    const single = opts.precision === "single" || ((opts.precision ?? "auto") === "auto" && dev.device !== "cpu");
    const mem = (single ? 8 : 16) * (15 * 3 * 8 * cells + 10 * 3 * cells);
    const solves = wl.length * (spec.orientation_average ? 2 * Number(opts.orientations ?? 32) : 1);
    return {
      backend: b.name,
      method: b.method,
      ...dev,
      dipoles,
      grid,
      dipole_spacing_nm: d,
      dipoles_per_diameter: [npd],
      precision: single ? "single" : "double",
      memory_bytes: mem,
      solves,
      fits: dipoles <= Number(opts.max_dipoles ?? 5_000_000),
    };
  }
  return { backend: b.name, method: b.method, ...dev, memory_bytes: 1e6 * ps.length };
}

/** Solve a scattering problem in the browser (approximately; see module docs). */
export function solveMock(spec: JsonObject, method: string, device: string, onProgress?: (f: number) => void): ScatteringResult {
  const kind = problemKind(spec);
  if (kind !== "scattering") throw new Error(`the mock server has no solver for problem kind '${kind}'; connect to a compute server`);
  const b = resolveBackend(spec, method);
  // (the FDTD templates' own solutions are served by MockComputeClient, from fixtures/fdtd)
  if (b.method === "fdtd" && (isObject(spec.illumination) && spec.illumination.kind === "gaussian_beam" || isObject((spec.outputs as JsonObject)?.resonances)))
    throw new Error("the mock server cannot compute Gaussian beams or resonances; connect to a compute server (the FDTD templates as shipped do have the library's results)");
  const t0 = performance.now();
  const wl = wavelengthArray(spec);
  const nm = Number(spec.medium_index ?? 1);
  const epsM = nm * nm;
  const ps = particles(spec);
  const ill = (spec.illumination as JsonObject) ?? {};
  const ehat = unit((ill.polarization as number[]) ?? [1, 0, 0]);
  const cext: number[] = [];
  const csca: number[] = [];
  const single = ps.length === 1 && (ps[0].shape.kind === "sphere" || ps[0].shape.kind === "layered_sphere");
  wl.forEach((lam, i) => {
    const k = (2 * Math.PI * nm) / lam;
    let e = 0;
    let s = 0;
    for (const p of ps) {
      const eps = particleEps(p, lam);
      if (p.shape.kind === "sphere" || p.shape.kind === "layered_sphere") {
        const r = p.shape.kind === "sphere" ? Number(p.shape.radius_nm) : outerRadius(p.shape);
        const m = eps.sqrt().div(nm);
        const out = mieCoefficients(m, k * r);
        e += out.qext * Math.PI * r * r;
        s += out.qsca * Math.PI * r * r;
      } else {
        const [hx, , hz] = halfExtent(p.shape);
        // a finite cylinder is treated as the spheroid with the same aspect ratio and volume
        const aspect = hz / hx;
        const V = volume(p.shape);
        const a = Math.cbrt((3 * V) / (4 * Math.PI * aspect));
        const [Lxy, Lz] = depolarization(a, a * aspect);
        const er = eps.div(epsM);
        const axy = spheroidPolarizability(V, Lxy, er, k);
        const az = spheroidPolarizability(V, Lz, er, k);
        const exy = 1 - ehat[2] ** 2;
        const alpha = axy.mul(exy).add(az.mul(ehat[2] ** 2));
        e += 4 * Math.PI * k * alpha.im;
        s += ((8 * Math.PI) / 3) * k ** 4 * (axy.abs2() * exy + az.abs2() * ehat[2] ** 2);
      }
    }
    cext.push(e);
    csca.push(Math.min(s, e));
    onProgress?.((i + 1) / wl.length);
  });
  const vol = ps.reduce((a, p) => a + volume(p.shape), 0);
  const req = Math.cbrt((3 * vol) / (4 * Math.PI));
  const out = isObject(spec.outputs) ? spec.outputs : {};
  const warnings = [MOCK_WARNING];
  if (!single) warnings.push("mock: particles are treated independently (no coupling); non-spheres use a quasi-static spheroid model");
  if (isObject(spec.substrate)) warnings.push("mock: the substrate is drawn but ignored by the mock physics");
  const dev = deviceInfo(device, b.gpu);
  const result: ScatteringResult = {
    kind: "scattering",
    method: b.method,
    backend: b.name,
    wavelengths_nm: wl,
    c_ext_nm2: cext,
    c_sca_nm2: csca,
    c_abs_nm2: cext.map((x, i) => x - csca[i]),
    equivalent_radius_nm: req,
    near_field: isObject(out.near_field) ? nearField(ps, out.near_field, nm, ehat) : null,
    far_field: isObject(out.far_field) ? farField(ps, out.far_field, nm) : null,
    provenance: { ...dev, mock: true, runtime_s: (performance.now() - t0) / 1000 },
    warnings,
  };
  return result;
}

function nearField(ps: Particle[], req: JsonObject, nm: number, ehat: number[]): NearFieldData[] {
  const plane = String(req.plane ?? "xz") as "xy" | "xz" | "yz";
  const ax = { x: 0, y: 1, z: 2 };
  const a1 = ax[plane[0] as "x"];
  const a2 = ax[plane[1] as "x"];
  const normal = 3 - a1 - a2;
  const hw = Number(req.half_width_nm);
  const n = Math.max(2, Number(req.points ?? 101));
  const u = Array.from({ length: n }, (_, i) => -hw + (2 * hw * i) / (n - 1));
  const epsM = nm * nm;
  return ((req.wavelengths_nm as number[]) ?? []).map((lam) => {
    const parts = ps.map((p) => {
      const r = Math.max(...halfExtent(p.shape));
      const er = particleEps(p, lam).div(epsM);
      const f = er.sub(1).div(er.add(2)); // quasi-static sphere factor
      const fin = new C(3).div(er.add(2));
      return { p, r, f, fin };
    });
    const enh = u.map((x1) =>
      u.map((x2) => {
        const pt = [0, 0, 0];
        pt[a1] = x1;
        pt[a2] = x2;
        pt[normal] = Number(req.offset_nm ?? 0);
        let E: [C, C, C] = [new C(ehat[0]), new C(ehat[1]), new C(ehat[2])];
        for (const { p, r, f, fin } of parts) {
          const d = pt.map((v, i) => v - p.position_nm[i]);
          const dist = Math.hypot(...d);
          if (dist <= r) {
            E = [0, 1, 2].map((i) => fin.mul(ehat[i])) as [C, C, C];
            break;
          }
          const nh = d.map((v) => v / dist);
          const ndote = nh[0] * ehat[0] + nh[1] * ehat[1] + nh[2] * ehat[2];
          const s = (r / dist) ** 3;
          E = [0, 1, 2].map((i) => E[i].add(f.mul(s * (3 * nh[i] * ndote - ehat[i])))) as [C, C, C];
        }
        return E[0].abs2() + E[1].abs2() + E[2].abs2();
      }),
    );
    return { wavelength_nm: lam, plane, offset_nm: Number(req.offset_nm ?? 0), axis1_nm: u, axis2_nm: u, enhancement: enh };
  });
}

function farField(ps: Particle[], req: JsonObject, nm: number): FarFieldData[] {
  const theta = (req.theta_deg as number[]) ?? [];
  const phi = (req.phi_deg as number[]) ?? [0, 90];
  return ((req.wavelengths_nm as number[]) ?? []).map((lam) => {
    const k = (2 * Math.PI * nm) / lam;
    // Sum the Mie amplitudes of volume-equivalent spheres (incoherently; mock).
    const coeffs = ps.map((p) => {
      const r = Math.cbrt((3 * volume(p.shape)) / (4 * Math.PI));
      return mieCoefficients(particleEps(p, lam).sqrt().div(nm), k * r);
    });
    const d = theta.map((t) =>
      phi.map((ph) => {
        let v = 0;
        for (const c of coeffs) {
          const { s1, s2 } = amplitudes(c.an, c.bn, (t * Math.PI) / 180);
          const cp = Math.cos((ph * Math.PI) / 180) ** 2;
          v += (s2.abs2() * cp + s1.abs2() * (1 - cp)) / (k * k);
        }
        return v;
      }),
    );
    return { wavelength_nm: lam, theta_deg: theta, phi_deg: phi, dcsca_domega_nm2: d };
  });
}
