// Every solver: the library's layout snapshots of the examples (scripts/solver_layout.py), the curve layer behind
// Compare and Sweep (lib/curves.ts), and sweep set-up (state/sweep.ts).

import { describe, expect, it } from "vitest";
import backendsJson from "../generated/backends.json";
import layoutsJson from "../generated/layouts.json";
import { MockComputeClient } from "../api/compute";
import { canonical } from "../api/mock/snapshots";
import { ApiError, isSweep, type BackendInfo, type SolverLayout, type SweepResult } from "../api/types";
import { curvesOf, difference, interpolate, reduce, type Curve } from "../lib/curves";
import type { JsonObject } from "../schema/schema";
import { KIND_TEMPLATES } from "../state/kinds";
import { linspace, runSweep, sweepParams, withValue } from "../state/sweep";
import { useConnection } from "../state/connection";
import { DEFAULT_SPEC } from "../state/templates";

const fixtures = import.meta.glob("../generated/fixtures/*.json", { eager: true, import: "default" }) as Record<string, { spec: JsonObject; result: JsonObject | null }>;
const LAYOUTS = layoutsJson as unknown as { spec: JsonObject; layouts: Record<string, SolverLayout> }[];
const BACKENDS = backendsJson as unknown as BackendInfo[];
const forSpec = (spec: JsonObject) => LAYOUTS.find((e) => canonical(e.spec) === canonical(spec))!.layouts;

describe("solver layouts (library snapshots)", () => {
  it("cover every kind's example, with the envelope", () => {
    for (const [kind, spec] of Object.entries(KIND_TEMPLATES)) {
      const ls = forSpec(spec);
      expect(Object.keys(ls).length, kind).toBeGreaterThan(0);
      for (const [name, l] of Object.entries(ls)) {
        expect(l.backend, name).toBe(name);
        expect(l.problem_kind, name).toBe(kind);
        expect(typeof l.layout_kind).toBe("string");
        expect(Object.keys(l.summary).length, name).toBeGreaterThan(0);
        expect(l.error, `${kind} ${name}`).toBeNull();
      }
    }
  });

  it("give each solver its own discretisation", () => {
    const kinds = (kind: string) => Object.fromEntries(Object.entries(forSpec(KIND_TEMPLATES[kind])).map(([n, l]) => [n, l.layout_kind]));
    expect(kinds("scattering")).toMatchObject({ "lightsmith-dda": "dipole_lattice", "lightsmith-bem": "surface_mesh", "lightsmith-mie": "multipoles", treams: "multipoles", "lightsmith-fdtd": "yee_grid" });
    expect(kinds("device")).toMatchObject({ "lightsmith-eme": "cells", "lightsmith-bpm": "cells", "lightsmith-fdfd": "device_grid", "lightsmith-fdtd": "device_grid" });
    expect(kinds("mode")).toEqual({ "lightsmith-fde": "cross_section_grid" });
    expect(kinds("periodic")["lightsmith-rcwa"]).toBe("harmonics");
    expect(kinds("bands")).toEqual({ "lightsmith-pwe": "plane_waves" });
    expect(kinds("optimization")).toEqual({ "lightsmith-inverse": "device_grid" });
    expect(kinds("layer_stack")["lightsmith-tmm"]).toBe("none");
  });

  it("carry payloads Studio can draw", () => {
    const sc = forSpec(KIND_TEMPLATES.scattering);
    const dda = sc["lightsmith-dda"].payload as { points_nm: number[][]; n_dipoles: number; stride: number };
    expect(dda.points_nm.length).toBe(Math.ceil(dda.n_dipoles / dda.stride));
    const bem = sc["lightsmith-bem"].payload as { verts_nm: number[][]; tris: number[][] };
    expect(Math.max(...bem.tris.flat())).toBeLessThan(bem.verts_nm.length);
    const rcwa = forSpec(KIND_TEMPLATES.periodic)["lightsmith-rcwa"].payload as { harmonics: number[][]; orders_max: number[] };
    expect(rcwa.harmonics.length).toBe(2 * rcwa.orders_max[0] + 1);
    const eme = forSpec(KIND_TEMPLATES.device)["lightsmith-eme"].payload as { cells: { start_nm: number; stop_nm: number }[]; lo_nm: number; hi_nm: number };
    expect(eme.cells[0].start_nm).toBeCloseTo(eme.lo_nm, 6);
    expect(eme.cells[eme.cells.length - 1].stop_nm).toBeCloseTo(eme.hi_nm, 6);
    const pwe = forSpec(KIND_TEMPLATES.bands)["lightsmith-pwe"].payload as { k_reduced: number[][]; k_labels: Record<string, string> };
    expect(Object.values(pwe.k_labels)).toEqual(["Γ", "X", "M", "Γ"]);
  });

  it("are served by the mock for the exact spec and backend only", async () => {
    const mock = new MockComputeClient({ latencyMs: 0 });
    const l = await mock.layout(KIND_TEMPLATES.bands, "pwe");
    expect(l.backend).toBe("lightsmith-pwe");
    await expect(mock.layout({ ...KIND_TEMPLATES.bands, num_bands: 9 }, "pwe")).rejects.toThrow(/shipped examples/);
    // the mock's estimate of an example is the library's own, recorded with the layout
    const e = await mock.estimate(KIND_TEMPLATES.mode, "fde", "cpu");
    expect(e.grid).toEqual((forSpec(KIND_TEMPLATES.mode)["lightsmith-fde"].estimate as { grid: number[] }).grid);
  });
});

describe("curves (Compare, Sweep)", () => {
  it("turn every solved example into named curves", () => {
    for (const [path, fx] of Object.entries(fixtures)) {
      if (!fx.result) continue;
      const cs = curvesOf(fx.result);
      expect(cs.length, path).toBeGreaterThan(0);
      for (const c of cs) expect(c.x.length, `${path} ${c.id}`).toBe(c.y.length);
    }
  });

  it("difference a run from a reference, interpolating onto its x", () => {
    const ref: Curve = { id: "q", label: "q", x: [0, 1, 2, 3], y: [1, 2, 3, 4], xLabel: "", yLabel: "" };
    const same = difference({ ...ref, y: [1.1, 2, 3, 4] }, ref);
    expect(same.interpolated).toBe(false);
    expect(same.maxAbs).toBeCloseTo(0.1, 12);
    expect(same.maxRel).toBeCloseTo(0.1, 12);
    const other = difference({ ...ref, x: [0, 3], y: [1, 4] }, ref);
    expect(other.interpolated).toBe(true);
    expect(other.maxAbs).toBeCloseTo(0, 12);
    expect(interpolate({ x: [0, 2], y: [0, 4] }, [1, 3])).toEqual([2, NaN]);
  });

  it("reduce a curve for sweeps", () => {
    const c: Curve = { id: "q", label: "q", x: [400, 500, 600], y: [1, 3, 2], xLabel: "", yLabel: "" };
    expect(reduce(c, "peak_y")).toBe(3);
    expect(reduce(c, "peak_x")).toBe(500);
    expect(reduce(c, "min_x")).toBe(400);
    expect(reduce(c, "mean_y")).toBe(2);
    expect(reduce(c, "at_x", 550)).toBe(2.5);
  });
});

describe("sweeps", () => {
  const spec = KIND_TEMPLATES.scattering;

  it("offer every number of the spec and the numeric options of the chosen method", () => {
    const ps = sweepParams(spec, BACKENDS, "dda");
    const labels = ps.map((p) => p.label);
    expect(labels).toContain("particles.0.shape.radius_nm");
    expect(labels).toContain("medium_index");
    expect(labels).toContain("options.dda.dipoles_per_diameter");
    expect(labels.some((l) => l.startsWith("options.fdtd"))).toBe(false);
    expect(ps.find((p) => p.label === "options.dda.dipoles_per_diameter")?.integer).toBe(true);
    expect(sweepParams(spec, BACKENDS, "auto").some((p) => p.label.startsWith("options.fdtd"))).toBe(true);
  });

  it("set the value in a copy, creating options[method] when needed", () => {
    const s = withValue(spec, ["options", "dda", "dipoles_per_diameter"], 20);
    expect((s.options as JsonObject).dda).toEqual({ dipoles_per_diameter: 20 });
    expect(spec.options).toEqual(KIND_TEMPLATES.scattering.options);
    expect((withValue(spec, ["particles", 0, "shape", "radius_nm"], 30).particles as JsonObject[])[0]).toMatchObject({ shape: { radius_nm: 30 } });
    expect(linspace(16, 24, 3, true)).toEqual([16, 20, 24]);
    expect(linspace(1, 2, 3)).toEqual([1, 1.5, 2]);
  });
});

describe("sweeps through the server", () => {
  it("the default scene has every scattering backend's layout, miepython's own rule included", () => {
    const ls = forSpec(DEFAULT_SPEC);
    expect(Object.keys(ls)).toEqual(expect.arrayContaining(["lightsmith-mie", "miepython", "lightsmith-quasistatic", "lightsmith-dda", "lightsmith-bem", "treams", "lightsmith-fdtd"]));
    expect(ls.miepython.summary.rule).toBe("miepython's wiscombe_terms");
    expect(ls["lightsmith-quasistatic"].layout_kind).toBe("none");
    expect(forSpec(KIND_TEMPLATES.layer_stack)["lightsmith-fdtd"].layout_kind).toBe("unit_cell");
  });

  it("the mock runs sweep jobs as the compute server does: one result per value", async () => {
    const mock = new MockComputeClient({ latencyMs: 0, stepMs: 0 });
    const path = ["particles", 0, "shape", "radius_nm"];
    await expect(mock.submit({ operation: "sweep", spec: DEFAULT_SPEC, method: "lightsmith-mie", sweep: { path, values: [20, -1] } })).rejects.toThrow(/sweep value -1/);
    const job = await mock.submit({ operation: "sweep", spec: DEFAULT_SPEC, method: "lightsmith-mie", sweep: { path, values: [20, 40] } });
    const res = await new Promise<JsonObject>((resolve) => mock.subscribe(job.id, (e) => e.type === "result" && resolve(e.result as JsonObject)));
    expect(isSweep(res)).toBe(true);
    const r = res as unknown as SweepResult;
    expect(r.values).toEqual([20, 40]);
    expect(r.errors).toEqual({});
    const peak = (i: number) => Math.max(...(r.results[i] as { c_ext_nm2: number[] }).c_ext_nm2);
    expect(peak(1)).toBeGreaterThan(peak(0));
  });

  it("falls back to one solve job per value on servers without sweep jobs", async () => {
    const submitted: string[] = [];
    const fake = {
      kind: "http" as const,
      baseUrl: "http://old.example",
      async submit(r: { operation: string }) {
        if (r.operation === "sweep") throw new ApiError("ValidationError", "kind: Input should be 'solve', 'compare', 'estimate' or 'optimize'", 422);
        submitted.push(r.operation);
        return { id: `j${submitted.length}`, status: "queued" as const };
      },
      subscribe: () => () => {},
    };
    const prev = useConnection.getState().client;
    useConnection.setState({ client: fake as never });
    try {
      const param = sweepParams(DEFAULT_SPEC, BACKENDS, "mie").find((p) => p.label === "particles.0.shape.radius_nm")!;
      const out = await runSweep({ spec: DEFAULT_SPEC, param, values: [30, 40, -5], method: "mie" });
      expect(out.serverSweep).toBe(false);
      expect(out.skipped).toEqual([-5]); // the schema rejects a negative radius before anything is sent
      expect(submitted).toEqual(["solve", "solve"]);
      expect(out.jobs.map((j) => j.sweep?.value)).toEqual([30, 40]);
    } finally {
      useConnection.setState({ client: prev });
    }
  });
});
