// FDTD set-up: the templates' library snapshots (layout and solution), the mock's FDTD rules, and the spec
// helpers behind the 3D overlay. The layouts are the library's (scripts/solver_layout.py); these tests check
// that Studio reads them consistently, not the library's numbers.

import { describe, expect, it } from "vitest";
import schemaJson from "../generated/schema.json";
import { ApiError, resultKind, toFdtdLayout, type FdtdLayout } from "../api/types";
import { MockComputeClient } from "../api/compute";
import { canonical, FDTD_TEMPLATES, fdtdSnapshot, fdtdSnapshotResult } from "../api/mock/snapshots";
import { supportsAll } from "../api/mock/solver";
import { SchemaDoc, clone, type JsonObject, type JSONSchema } from "../schema/schema";
import { validateProblem } from "../schema/validate";
import { beamGeometry, dipoleGeometry, fdtdKey, meshOverrides, selectedOverride } from "../state/fdtd";
import { nodeWidths } from "../state/layout";
import { KIND_TEMPLATES } from "../state/kinds";

const doc = new SchemaDoc(schemaJson as JSONSchema);
const byId = (id: string) => FDTD_TEMPLATES.find((t) => t.id === id)!;
const fdtd = (id: string) => toFdtdLayout(byId(id).layout)!;
const OPEN = FDTD_TEMPLATES.filter((t) => t.layout.layout_kind === "yee_grid");
const inside = (a: { lo_nm: number[]; hi_nm: number[] }, b: { lo_nm: number[]; hi_nm: number[] }) => a.lo_nm.every((x, i) => x >= b.lo_nm[i] - 1e-6 && a.hi_nm[i] <= b.hi_nm[i] + 1e-6);

describe("FDTD templates", () => {
  it("are valid specs, each with the library's layout", () => {
    expect(FDTD_TEMPLATES.map((t) => t.id)).toEqual(["fdtd-override", "fdtd-graded", "fdtd-beam", "fdtd-substrate", "fdtd-device"]);
    for (const t of FDTD_TEMPLATES) {
      expect(validateProblem(doc, t.spec), t.id).toEqual([]);
      expect(t.layout.error, t.id).toBeNull();
    }
  });

  it("have consistent layouts: nested boxes, monotonic nodes, CPML on the outer cells", () => {
    for (const { id, layout } of OPEN) {
      const L = toFdtdLayout(layout)!;
      const box = (n: string) => L.boxes.find((b) => b.name === n)!;
      const inner = { lo_nm: L.pml.inner_lo_nm, hi_nm: L.pml.inner_hi_nm };
      expect(inside(box("flux_total"), box("tfsf")), id).toBe(true);
      expect(inside(box("tfsf"), box("flux_scattered")), id).toBe(true);
      expect(inside(box("flux_scattered"), inner), id).toBe(true);
      expect(inside(inner, L.domain_nm), id).toBe(true);
      L.grid.nodes_nm.forEach((nodes, a) => {
        expect(nodes.length, id).toBe(L.grid.shape[a]);
        expect(nodes.every((x, i) => i === 0 || x > nodes[i - 1]), id).toBe(true);
        expect(nodes[L.pml.cells], id).toBeCloseTo(L.pml.inner_lo_nm[a], 6);
        expect(Math.min(...nodeWidths(nodes)), id).toBeCloseTo(L.grid.spacing_min_nm[a], 6);
      });
      expect(L.grid.cells).toBe(L.grid.shape.reduce((a, b) => a * b, 1));
    }
  });

  it("reflect the options: override region, graded grids, mirror planes", () => {
    const o = fdtd("fdtd-override");
    expect(o.grid.kind).toBe("graded");
    expect(o.regions).toEqual([expect.objectContaining({ source: "mesh_override", index: 0, spacing_nm: [2, 2, 2] })]);
    expect(Math.min(...o.grid.spacing_min_nm)).toBeCloseTo(2, 6);
    expect(o.symmetry.planes_nm).toEqual({ x: 0, y: 0 });
    // two mirror planes: the run steps about a quarter of the grid (plus a ghost plane per mirror)
    expect(o.run_cells!).toBeLessThan(o.grid.cells / 3.5);
    expect(fdtd("fdtd-graded").regions[0].source).toBe("auto");
    expect(fdtd("fdtd-beam").symmetry.reduction).toBe(1);
    expect(fdtd("fdtd-substrate").symmetry.mirrors).toEqual({ y: "antisymmetric (PEC)" });
  });

  it("match only the exact spec (key order does not matter)", () => {
    const t = byId("fdtd-override");
    const reordered = Object.fromEntries(Object.entries(t.spec).reverse()) as JsonObject;
    expect(canonical(reordered)).toBe(canonical(t.spec));
    expect(fdtdSnapshot(reordered)?.id).toBe("fdtd-override");
    const edited = clone(t.spec) as JsonObject;
    (edited.medium_index as number) = 1.01;
    expect(fdtdSnapshot(edited)).toBeUndefined();
  });

  it("carry the library's solutions, with resonances for the ring-down", async () => {
    const r = await fdtdSnapshotResult(byId("fdtd-graded").spec);
    expect(r?.result.backend).toBe("lightsmith-fdtd");
    expect(resultKind(r?.result)).toBe("cross_sections");
    expect(r!.result.resonances!.length).toBeGreaterThan(0);
    expect(r!.result.resonances![0]).toEqual(expect.objectContaining({ q: expect.any(Number), wavelength_nm: expect.any(Number) }));
  });
});

describe("mock server, FDTD", () => {
  const mock = new MockComputeClient({ latencyMs: 0, stepMs: 0 });

  it("serves the templates' layouts and 404s for anything else", async () => {
    const L: FdtdLayout = toFdtdLayout(await mock.layout(byId("fdtd-beam").spec, "fdtd"))!;
    expect(L.backend).toBe("lightsmith-fdtd");
    const edited = { ...byId("fdtd-beam").spec, medium_index: 1.5 };
    await expect(mock.layout(edited, "fdtd")).rejects.toSatisfy((e: unknown) => e instanceof ApiError && e.status === 404);
  });

  it("answers the ring-down template with the library's FDTD solution", async () => {
    const job = await mock.submit({ operation: "solve", spec: byId("fdtd-graded").spec, method: "auto" });
    const res = await new Promise<JsonObject>((resolve) => mock.subscribe(job.id, (e) => e.type === "result" && resolve(e.result as JsonObject)));
    expect(res.backend).toBe("lightsmith-fdtd");
    expect((res.warnings as string[])[0]).toMatch(/exact spec/);
    expect((res.resonances as unknown[]).length).toBeGreaterThan(0);
  });

  it("names the library's reasons: beams and resonances are FDTD only", () => {
    const beam = supportsAll(byId("fdtd-beam").spec);
    expect(beam.find((s) => s.name === "lightsmith-fdtd")?.supported).toBe(true);
    for (const s of beam.filter((x) => x.method !== "fdtd")) expect(s.reason, s.name).toMatch(/gaussian_beam illumination|exactly one particle|handles spheres/);
    const ring = supportsAll(byId("fdtd-graded").spec);
    expect(ring.find((s) => s.name === "lightsmith-mie")?.reason).toMatch(/resonances output/);
  });

  it("refuses Mie emission with a radiation pattern, as the library does", () => {
    const em = KIND_TEMPLATES.emission;
    expect(supportsAll(em).find((s) => s.name === "lightsmith-mie")?.reason).toMatch(/radiation patterns/);
    const rates = { ...em, radiation_pattern: null };
    expect(supportsAll(rates).find((s) => s.name === "lightsmith-mie")?.supported).toBe(true);
    const inside = { ...rates, dipole: { position_nm: [0, 0, 10], orientation: [0, 0, 1] } };
    expect(supportsAll(inside).find((s) => s.name === "lightsmith-mie")?.reason).toMatch(/outside the sphere/);
  });
});

describe("FDTD spec helpers", () => {
  it("find mesh overrides under options.fdtd or the backend key", () => {
    const s = byId("fdtd-override").spec;
    expect(fdtdKey(s)).toBe("fdtd");
    expect(meshOverrides(s)).toEqual([{ index: 0, path: ["options", "fdtd", "mesh_override", 0], center: [0, 0, 0], size: [20, 50, 50], spacing: [2, 2, 2] }]);
    const b = { ...s, options: { "lightsmith-fdtd": { mesh_override: [{ center_nm: [1, 2, 3], size_nm: [4, 5, 6], spacing_nm: [1, 1, 0.5] }] } } };
    expect(fdtdKey(b)).toBe("lightsmith-fdtd");
    expect(meshOverrides(b)[0].spacing).toEqual([1, 1, 0.5]);
    expect(selectedOverride(["options", "fdtd", "mesh_override", 2, "center_nm"])).toBe(2);
    expect(selectedOverride(["particles", 0])).toBeNull();
  });

  it("draw the beam from its own parameters: waist at the band centre, paraxial Rayleigh range", () => {
    const g = beamGeometry(byId("fdtd-beam").spec)!;
    expect(g.waist).toBe(1000);
    expect(g.wavelength).toBe(650);
    expect(g.rayleigh).toBeCloseTo((Math.PI * 1000 ** 2) / 650, 6);
    expect(beamGeometry(byId("fdtd-override").spec)).toBeNull();
  });

  it("read the emission dipole", () => {
    const d = dipoleGeometry(KIND_TEMPLATES.emission)!;
    expect(d.position).toEqual([0, 0, 50]);
    expect(d.orientation).toEqual([0, 0, 1]);
  });

  it("classify emission results", () => {
    expect(resultKind({ kind: "emission" })).toBe("emission");
    expect(resultKind({ purcell: [1], radiative: [1] })).toBe("emission");
  });
});
