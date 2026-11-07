// FDTD objects that live in the spec itself: mesh-override boxes (options.fdtd.mesh_override) and the Gaussian
// beam's focus and waist. Everything the library derives from them (the grid, the source and monitor boxes,
// CPML, mirror planes) comes from the library's layout (state/layout.ts), never from here.

import { wavelengthArray } from "../api/mock/solver";
import { isObject, type Json, type JsonObject, type Path } from "../schema/schema";
import { useSpec } from "./store";

/** `options[...]` key holding the FDTD options: the backend's own key wins, as in the library (options_for). */
export function fdtdKey(spec: JsonObject): "fdtd" | "lightsmith-fdtd" {
  const o = isObject(spec.options) ? spec.options : {};
  return isObject(o["lightsmith-fdtd"]) && Array.isArray((o["lightsmith-fdtd"] as JsonObject).mesh_override) ? "lightsmith-fdtd" : "fdtd";
}

export function fdtdOptions(spec: JsonObject): JsonObject {
  const o = isObject(spec.options) ? spec.options : {};
  return { ...(isObject(o.fdtd) ? o.fdtd : {}), ...(isObject(o["lightsmith-fdtd"]) ? o["lightsmith-fdtd"] : {}) };
}

export interface MeshOverrideBox {
  index: number;
  path: Path;
  center: [number, number, number];
  size: [number, number, number];
  spacing: [number, number, number];
}

const vec3 = (v: Json | undefined, d: number): [number, number, number] =>
  Array.isArray(v) && v.length === 3 ? [Number(v[0]), Number(v[1]), Number(v[2])] : typeof v === "number" ? [v, v, v] : [d, d, d];

export function meshOverrides(spec: JsonObject): MeshOverrideBox[] {
  const key = fdtdKey(spec);
  const opts = isObject(spec.options) && isObject(spec.options[key]) ? (spec.options[key] as JsonObject) : {};
  const list = Array.isArray(opts.mesh_override) ? opts.mesh_override : [];
  return list.flatMap((o, index) =>
    isObject(o) ? [{ index, path: ["options", key, "mesh_override", index], center: vec3(o.center_nm, 0), size: vec3(o.size_nm, 10), spacing: vec3(o.spacing_nm, 1) }] : [],
  );
}

/** Selection path of a mesh-override box: ["options", key, "mesh_override", i]. */
export function selectedOverride(sel: Path | null): number | null {
  return sel && sel[0] === "options" && sel[2] === "mesh_override" && typeof sel[3] === "number" ? sel[3] : null;
}

/** Add a refinement box around the selected particle (or the scene centre) at a quarter of the current base cell. */
export function addMeshOverride() {
  const s = useSpec.getState();
  const spec = s.spec;
  const key = fdtdKey(spec);
  const options = isObject(spec.options) ? spec.options : {};
  const opts = isObject(options[key]) ? (options[key] as JsonObject) : {};
  const list = Array.isArray(opts.mesh_override) ? opts.mesh_override : [];
  const sel = s.selection;
  const p = sel && sel[0] === "particles" && typeof sel[1] === "number" && Array.isArray(spec.particles) ? spec.particles[sel[1]] : null;
  const center = isObject(p) && Array.isArray(p.position_nm) ? (p.position_nm as number[]) : [0, 0, 0];
  const base = typeof opts.spacing_nm === "number" ? opts.spacing_nm : 8;
  const box = { center_nm: center.map(Number), size_nm: [40, 40, 40], spacing_nm: Math.max(0.5, Number((base / 4).toPrecision(3))) };
  const ops = [];
  if (!isObject(spec.options)) ops.push({ op: "replace" as const, path: ["options"], value: {} });
  if (!isObject(options[key])) ops.push({ op: "replace" as const, path: ["options", key], value: {} });
  ops.push({ op: "replace" as const, path: ["options", key, "mesh_override"], value: [...list, box] });
  s.apply(ops);
  s.select(["options", key, "mesh_override", list.length]);
}

export interface BeamGeometry {
  focus: [number, number, number];
  dir: [number, number, number];
  pol: [number, number, number];
  waist: number;
  /** Vacuum wavelength at which the waist is `waist`: waist_wavelength_nm, else the middle of the band. */
  wavelength: number;
  /** Rayleigh range π w0² n / λ in the host (paraxial; the drawn envelope only). */
  rayleigh: number;
}

function unit(v: number[]): [number, number, number] {
  const n = Math.hypot(...v) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}

/** The spec's Gaussian beam, for drawing: focus, axis, waist and its paraxial envelope. */
export function beamGeometry(spec: JsonObject): BeamGeometry | null {
  const ill = isObject(spec.illumination) ? spec.illumination : null;
  if (!ill || ill.kind !== "gaussian_beam") return null;
  const wl = wavelengthArray(spec);
  const mid = wl.length ? (Math.min(...wl) + Math.max(...wl)) / 2 : 600;
  const wavelength = typeof ill.waist_wavelength_nm === "number" ? ill.waist_wavelength_nm : mid;
  const waist = Number(ill.waist_nm) || 1000;
  const n = Number(spec.medium_index ?? 1) || 1;
  return {
    focus: vec3(ill.focus_nm, 0),
    dir: unit(vec3(ill.direction, 0).every((x) => x === 0) ? [0, 0, 1] : vec3(ill.direction, 0)),
    pol: unit(vec3(ill.polarization, 0).every((x) => x === 0) ? [1, 0, 0] : vec3(ill.polarization, 0)),
    waist,
    wavelength,
    rayleigh: (Math.PI * waist * waist * n) / wavelength,
  };
}

export interface DipoleGeometry {
  position: [number, number, number];
  orientation: [number, number, number];
}

export function dipoleGeometry(spec: JsonObject): DipoleGeometry | null {
  if (spec.kind !== "emission") return null;
  const d = isObject(spec.dipole) ? spec.dipole : {};
  const o = vec3(d.orientation, 0);
  return { position: vec3(d.position_nm, 0), orientation: unit(o.every((x) => x === 0) ? [0, 0, 1] : o) };
}
