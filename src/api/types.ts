// Wire types. They mirror the library's Python objects; fields the GUI does not
// interpret are kept as-is (`[k: string]: unknown`) so nothing is lost.

import type { Json, JsonObject, JSONSchema } from "../schema/schema";

export interface BackendInfo {
  name: string;
  method: string;
  problem_kinds?: string[];
  license: string;
  gpu: boolean;
  differentiable?: boolean;
  available: boolean;
  unavailable_reason: string | null;
  citation: string;
  /** JSON Schema of the backend's options model (Studio extension; may be absent). */
  options_schema?: JSONSchema | null;
}

export interface SupportInfo {
  name: string;
  method: string;
  available: boolean;
  unavailable_reason?: string | null;
  supported: boolean;
  reason: string | null;
}

export type Doctor = { auto_device?: { framework: string; device: string; gpu_name?: string }; cuda_gpus?: string[]; [k: string]: unknown };

export type Estimate = {
  backend: string;
  method: string;
  framework?: string;
  device?: string;
  memory_bytes?: number;
  dipoles?: number;
  grid?: number[];
  estimated_runtime_s?: number;
  [k: string]: unknown;
};

export interface NearFieldData {
  wavelength_nm: number;
  plane: "xy" | "xz" | "yz";
  offset_nm: number;
  axis1_nm: number[];
  axis2_nm: number[];
  enhancement: number[][];
  e_real?: number[][][] | null;
  e_imag?: number[][][] | null;
}

export interface FarFieldData {
  wavelength_nm: number;
  theta_deg: number[];
  phi_deg: number[];
  dcsca_domega_nm2: number[][];
}

/** One resonance of an FDTD ring-down (harmonic inversion): complex frequency with Q = ω / γ. */
export interface ResonanceData {
  wavelength_nm: number;
  energy_ev: number;
  q: number;
  /** Relative to the strongest resonance. */
  amplitude: number;
}

export interface ScatteringResult {
  kind?: string;
  method: string;
  backend: string;
  wavelengths_nm: number[];
  c_ext_nm2: number[];
  c_sca_nm2: number[];
  c_abs_nm2: number[];
  equivalent_radius_nm: number;
  near_field?: NearFieldData[] | null;
  far_field?: FarFieldData[] | null;
  resonances?: ResonanceData[] | null;
  provenance: Record<string, unknown>;
  warnings: string[];
  [k: string]: unknown;
}

/** Results of non-scattering problem kinds are rendered generically. */
export type AnyResult = ScatteringResult | (JsonObject & { method?: string; backend?: string; provenance?: Record<string, unknown>; warnings?: string[] });

export interface CompareResult {
  reference: string;
  results: Record<string, AnyResult>;
  relative_difference: Record<string, Record<string, { max: number; rms: number }>>;
}

export type Operation = "solve" | "compare" | "estimate" | "sweep";
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface JobRequest {
  operation: Operation;
  spec: Json;
  method?: string;
  methods?: string[] | null;
  device?: string;
  reference?: string | null;
  label?: string | null;
  /** sweep: the swept field (JSON path) and its values (compute API `kind: "sweep"`). */
  sweep?: { path: (string | number)[]; values: number[] } | null;
}

/** The result of a sweep job: one result per value (null where that solve failed). */
export interface SweepResult {
  kind: "sweep";
  path: (string | number)[];
  values: number[];
  method: string;
  results: (AnyResult | null)[];
  errors: Record<string, { error: string; message: string }>;
}

export function isSweep(r: unknown): r is SweepResult {
  return !!r && typeof r === "object" && (r as SweepResult).kind === "sweep" && Array.isArray((r as SweepResult).results);
}

export interface JobState {
  id: string;
  status: JobStatus;
  progress?: number | null;
  message?: string | null;
  operation?: Operation;
  created_at?: string;
  started_at?: string | null;
  finished_at?: string | null;
  result?: AnyResult | CompareResult | Estimate | null;
  error?: { error: string; message: string } | null;
}

export interface JobEvent {
  type: "status" | "progress" | "log" | "result" | "error";
  status?: JobStatus;
  progress?: number;
  message?: string;
  result?: JobState["result"];
  error?: JobState["error"];
}

export class ApiError extends Error {
  constructor(
    readonly error: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export function isScattering(r: unknown): r is ScatteringResult {
  return !!r && typeof r === "object" && Array.isArray((r as ScatteringResult).c_ext_nm2);
}

export function isCompare(r: unknown): r is CompareResult {
  return !!r && typeof r === "object" && "relative_difference" in (r as object) && "results" in (r as object);
}

// --- result kinds of the other problem kinds (lightsmith/results.py) -------------------------

interface ResultBase {
  kind: string;
  method: string;
  backend: string;
  provenance: Record<string, unknown>;
  warnings: string[];
}

/** Per polarization ("s", "p", ...): [angle][wavelength]. */
export type PerPol = Record<string, number[][]>;

export interface SpectrumResult extends ResultBase {
  kind: "spectrum";
  wavelengths_nm: number[];
  angles_deg: number[];
  polarizations: string[];
  r: PerPol;
  t: PerPol;
  a: PerPol;
  orders?: { order: [number, number]; r: PerPol; t: PerPol }[] | null;
  /** Complex zeroth-order amplitudes (re, im) per polarization, [angle][wavelength], when the backend gives them. */
  r_amplitude?: Record<string, [number, number][][]> | null;
  t_amplitude?: Record<string, [number, number][][]> | null;
}

export interface ModeData {
  neff_real: number;
  neff_imag: number;
  ng?: number | null;
  te_fraction?: number | null;
  loss_db_per_cm?: number | null;
  effective_area_um2?: number | null;
  field?: { x_nm: number[]; y_nm: number[]; components: Record<string, [number[][], number[][]]> } | null;
}

export interface ModeResult extends ResultBase {
  kind: "modes";
  wavelengths_nm: number[];
  /** [wavelength][mode] */
  modes: ModeData[][];
}

export interface SParameterResult extends ResultBase {
  kind: "sparameters";
  wavelengths_nm: number[];
  ports: string[];
  /** [wavelength][out][in] */
  s_real: number[][][];
  s_imag: number[][][];
}

export interface BandResult extends ResultBase {
  kind: "bands";
  k_reduced: number[][];
  k_distance: number[];
  k_labels: Record<string, string>;
  /** polarization -> [k][band], normalised frequency a/λ */
  frequencies: Record<string, number[][]>;
}

export interface OptimizationResult extends ResultBase {
  kind: "optimization";
  history: { iteration: number; objective: number; terms?: Record<string, number>; beta?: number; binarization?: number }[];
  objective_initial: number;
  objective_final: number;
  objective_binary: number;
  /**
   * Per design region: projected density at the final beta and the raw variables, [x][y] ("2d" and 3D "extruded"
   * regions), or [x][y][z] on the nodes z_nm ("volumetric" 3D regions).
   */
  designs?: DesignOutput[];
  /** The exported binary design as Structures (prism polygons). */
  structures?: { name?: string | null; geometry: Record<string, unknown>; material: unknown }[];
  /** The input device plus the exported structures. */
  final_device?: Record<string, unknown>;
  sparameters?: SParameterResult | null;
}

/** One design region of an optimization result (lightsmith.inverse.topopt.DesignOutput). */
export interface DesignOutput {
  name: string;
  x_nm: number[];
  y_nm: number[];
  /** 3D volumetric regions: the z nodes. */
  z_nm?: number[] | null;
  parametrization?: "2d" | "extruded" | "volumetric" | string;
  density: number[][] | number[][][];
  raw: number[][] | number[][][];
}

/** The [x][y] map of a design at z node `zi` (volumetric regions), or the map itself (2D and extruded regions). */
export function designSlice(m: number[][] | number[][][], zi: number): number[][] {
  return (m as (number | number[])[][]).map((col) => col.map((v) => (Array.isArray(v) ? (v[Math.min(Math.max(0, zi), v.length - 1)] ?? NaN) : v)));
}

export interface RadiationPatternData {
  wavelength_nm: number;
  theta_deg: number[];
  phi_deg: number[];
  /** Radiated power per steradian over P0, [theta][phi]; integrates to `radiative`. */
  dp_domega: number[][];
}

/** Dipole emission near particles, relative to the same dipole in the medium alone (lightsmith EmissionResult). */
export interface EmissionResult extends ResultBase {
  kind: "emission";
  wavelengths_nm: number[];
  /** Total decay-rate enhancement: emitted power / P0. */
  purcell: number[];
  /** Power reaching the far field / P0. */
  radiative: number[];
  /** radiative / purcell. */
  efficiency: number[];
  radiation_pattern?: RadiationPatternData[] | null;
}

export type ResultKind = "cross_sections" | "spectrum" | "modes" | "sparameters" | "bands" | "optimization" | "emission" | "unknown";

/** Which viewer a result needs: its `kind`, or its shape for results from older servers. */
export function resultKind(r: unknown): ResultKind {
  if (!r || typeof r !== "object") return "unknown";
  const o = r as Record<string, unknown>;
  const k = o.kind;
  if (k === "cross_sections" || k === "spectrum" || k === "modes" || k === "sparameters" || k === "bands" || k === "optimization" || k === "emission") return k;
  if (Array.isArray(o.c_ext_nm2)) return "cross_sections";
  if (o.r && o.t && o.a && Array.isArray(o.angles_deg)) return "spectrum";
  if (Array.isArray(o.modes)) return "modes";
  if (Array.isArray(o.s_real)) return "sparameters";
  if (o.frequencies && Array.isArray(o.k_distance)) return "bands";
  if (Array.isArray(o.history)) return "optimization";
  if (Array.isArray(o.purcell)) return "emission";
  return "unknown";
}

// --- solver layouts (lightsmith.discretization; API_ASSUMPTIONS.md "Solver layouts") ----------

export type LayoutKind = "yee_grid" | "unit_cell" | "device_grid" | "dipole_lattice" | "surface_mesh" | "multipoles" | "harmonics" | "cross_section_grid" | "cells" | "plane_waves" | "none";

/** What a backend will discretise for a spec, before any solve: a common envelope and a per-solver payload. */
export interface SolverLayout {
  backend: string;
  method: string;
  problem_kind: string;
  layout_kind: LayoutKind | string;
  /** Key figures, in display order. */
  summary: Record<string, string | number | boolean | null | number[]>;
  payload: Record<string, unknown>;
  /** The library's estimate for the same backend, when it gave one. */
  estimate?: Record<string, unknown> | null;
  warnings: string[];
  /** The library's refusal; the layout is still returned when it can be computed. */
  error: string | null;
}

/** An FDTD scattering or emission layout (layout_kind "yee_grid"), flattened for the 3D overlay. */
export function toFdtdLayout(l: SolverLayout | null | undefined): FdtdLayout | null {
  if (!l || l.layout_kind !== "yee_grid") return null;
  const p = l.payload as Record<string, unknown>;
  return {
    backend: l.backend,
    method: l.method,
    problem_kind: l.problem_kind,
    grid: p.grid as FdtdLayout["grid"],
    domain_nm: p.domain_nm as FdtdLayout["domain_nm"],
    pml: p.pml as FdtdLayout["pml"],
    boxes: (p.boxes as LayoutBox[]) ?? [],
    regions: (p.regions as LayoutRegion[]) ?? [],
    symmetry: p.symmetry as SymmetryInfo,
    run_cells: typeof l.estimate?.cells === "number" ? (l.estimate.cells as number) : null,
    warnings: l.warnings,
    error: l.error,
  };
}

// --- FDTD layout (the yee_grid payload) ----------

export interface LayoutBox {
  /** "tfsf", "flux_total", "flux_scattered" (scattering) or "flux_radiated" (emission). */
  name: string;
  label: string;
  lo_nm: number[];
  hi_nm: number[];
}

export interface LayoutRegion {
  source: "auto" | "mesh_override";
  /** Particle index ("auto") or mesh_override index. */
  particle?: number;
  index?: number;
  lo_nm: number[];
  hi_nm: number[];
  spacing_nm: number[];
}

export interface SymmetryInfo {
  mirrors: Record<string, string>;
  reduction: number;
  planes_nm?: Record<string, number>;
  skipped?: string;
}

/** The FDTD simulation layout the library builds for a spec: the whole grid (before any mirror halving). */
export interface FdtdLayout {
  backend: string;
  method: string;
  problem_kind: string;
  grid: {
    kind: "uniform" | "graded";
    base_spacing_nm: number;
    shape: number[];
    cells: number;
    /** Node planes per axis, nm. */
    nodes_nm: [number[], number[], number[]];
    spacing_min_nm: number[];
    spacing_max_nm: number[];
    max_ratio?: number;
  };
  domain_nm: { lo_nm: number[]; hi_nm: number[] };
  /** CPML thickness in cells and the inner faces of the absorbing layers. */
  pml: { cells: number; inner_lo_nm: number[]; inner_hi_nm: number[] };
  boxes: LayoutBox[];
  regions: LayoutRegion[];
  symmetry: SymmetryInfo;
  /** Cells the run steps (after mirror halving). */
  run_cells?: number | null;
  warnings: string[];
  /** The library's refusal (e.g. a graded grid with a Gaussian beam); the geometry is still drawn. */
  error: string | null;
}
