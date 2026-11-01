import { describe, expect, it, vi } from "vitest";
import fixture from "../generated/fixtures/scattering.json";
import schemaJson from "../generated/schema.json";
import { HttpComputeClient, MockComputeClient } from "../api/compute";
import { resolveBackend, solveMock, supportsAll } from "../api/mock/solver";
import type { JobEvent, ScatteringResult } from "../api/types";
import { cliCode, pythonCode, toPython } from "../lib/codegen";
import { base64UrlEncode, parseDeepLink } from "../lib/deeplink";
import { spectraCsv } from "../lib/csv";
import { epsAt, findLibrary, materialRange, nkAt, parseNkCsv } from "../physics/materials";
import { classify, defaultFor, matchVariant, SchemaDoc, type JsonObject, type JSONSchema } from "../schema/schema";
import { semanticIssues, validateProblem } from "../schema/validate";
import { applyOps } from "../state/ops";
import { useSpec } from "../state/store";
import { TEMPLATES } from "../state/templates";

const doc = new SchemaDoc(schemaJson as JSONSchema);

describe("spec ops", () => {
  it("replace / add / remove / move without mutating the input", () => {
    const a = { particles: [{ r: 1 }, { r: 2 }], x: { y: 1 } };
    const frozen = JSON.stringify(a);
    const b = applyOps(a, [
      { op: "replace", path: ["x", "y"], value: 5 },
      { op: "add", path: ["particles", 1], value: { r: 9 } },
      { op: "remove", path: ["particles", 0] },
      { op: "add", path: ["particles", "-"], value: { r: 3 } },
      { op: "move", from: ["particles", 2], path: ["particles", 0] },
    ]);
    expect(JSON.stringify(a)).toBe(frozen);
    expect(b).toEqual({ particles: [{ r: 3 }, { r: 9 }, { r: 2 }], x: { y: 5 } });
  });
});

describe("store: undo/redo, coalescing, copy/paste", () => {
  it("undoes and redoes, coalescing rapid edits of one field", () => {
    const s = useSpec.getState();
    s.setSpec(JSON.parse(JSON.stringify(TEMPLATES[0].spec)), { resetHistory: true });
    s.apply({ op: "replace", path: ["medium_index"], value: 1.4 }, { coalesceKey: "n" });
    s.apply({ op: "replace", path: ["medium_index"], value: 1.45 }, { coalesceKey: "n" });
    s.apply({ op: "replace", path: ["medium_index"], value: 1.5 }, { coalesceKey: "n" });
    expect(useSpec.getState().past).toHaveLength(1);
    useSpec.getState().undo();
    expect(useSpec.getState().spec.medium_index).toBe(1.33);
    useSpec.getState().redo();
    expect(useSpec.getState().spec.medium_index).toBe(1.5);
  });

  it("pastes a copy of the selected particle beside the scene", () => {
    const s = useSpec.getState();
    s.setSpec(JSON.parse(JSON.stringify(TEMPLATES[1].spec)), { resetHistory: true }); // dimer at x = ±42.5, r = 40
    s.select(["particles", 0]);
    expect(useSpec.getState().copySelection()).toBe(true);
    expect(useSpec.getState().paste()).toBe(true);
    const ps = useSpec.getState().spec.particles as JsonObject[];
    expect(ps).toHaveLength(3);
    expect((ps[2].position_nm as number[])[0]).toBeGreaterThanOrEqual(82.5 + 40);
    expect(useSpec.getState().selection).toEqual(["particles", 2]);
  });
});

describe("schema helpers", () => {
  it("unwraps the problem envelope and lists problem kinds", () => {
    expect(doc.problemKinds().map((k) => k.kind)).toEqual(expect.arrayContaining(["scattering", "layer_stack", "circuit"]));
  });

  it("classifies the scattering fields", () => {
    const sim = doc.defs.Simulation;
    expect(classify(doc, sim.properties.wavelengths)).toBe("union");
    expect(classify(doc, sim.properties.substrate)).toBe("optional");
    expect(classify(doc, sim.properties.options)).toBe("map");
    expect(classify(doc, doc.defs.Particle.properties.position_nm)).toBe("tuple");
    expect(classify(doc, doc.defs.Particle.properties.material)).toBe("union");
  });

  it("matches union variants by discriminator and by shape", () => {
    const w = doc.defs.Simulation.properties.wavelengths;
    expect(matchVariant(doc, w, [400, 500])).toBe(0);
    expect(matchVariant(doc, w, { start_nm: 1, stop_nm: 2, num: 3 })).toBe(1);
    const m = doc.defs.Particle.properties.material;
    const variants = doc.resolve(m).oneOf as JSONSchema[];
    expect(variants[matchVariant(doc, m, { kind: "drude", wp_ev: 9, gamma_ev: 0.1 })].$ref).toBe("#/$defs/Drude");
  });

  it("builds minimal valid defaults", () => {
    expect(defaultFor(doc, { $ref: "#/$defs/Sphere" })).toEqual({ kind: "sphere", radius_nm: 1 });
  });

  it("finds the node at a path through unions", () => {
    const spec = TEMPLATES[2].spec; // core-shell
    const n = doc.nodeAt(doc.problemNode(), spec, ["particles", 0, "shape", "shells", 0, "thickness_nm"]);
    expect(doc.resolve(n).exclusiveMinimum).toBe(0);
  });
});

describe("validation", () => {
  it("accepts every template", () => {
    for (const t of TEMPLATES) expect(validateProblem(doc, t.spec), t.id).toEqual([]);
  });
  it("reports schema errors at the right path", () => {
    const bad = JSON.parse(JSON.stringify(TEMPLATES[0].spec));
    bad.particles[0].shape.radius_nm = -1;
    bad.bogus = 1;
    const issues = validateProblem(doc, bad);
    expect(issues.some((i) => i.path.join("/") === "particles/0/shape/radius_nm")).toBe(true);
    expect(issues.some((i) => i.message.includes("bogus"))).toBe(true);
  });
  it("mirrors the library's polarization check", () => {
    expect(semanticIssues({ illumination: { direction: [0, 0, 1], polarization: [0, 0.5, 0.5] } })[0].message).toMatch(/orthogonal/);
  });
});

describe("materials", () => {
  it("evaluates Drude with the exp(-iωt) convention (Im eps > 0)", () => {
    const e = epsAt({ kind: "drude", eps_inf: 9.5, wp_ev: 9.0, gamma_ev: 0.07 }, 600);
    expect(e.re).toBeLessThan(0);
    expect(e.im).toBeGreaterThan(0);
  });
  it("resolves library aliases and ranges", () => {
    expect(findLibrary("gold", "JC")?.dataset).toBe("Johnson-Christy");
    expect(materialRange({ kind: "library", name: "Au", dataset: "McPeak" })).toEqual([300, 1700]);
    expect(nkAt({ kind: "constant_index", n_real: 1.5, n_imag: 0.1 }, 500).k).toBeCloseTo(0.1, 12);
  });
  it("parses CSV in µm with a header", () => {
    const m = parseNkCsv("wavelength (um), n, k\n0.5, 1.5, 0\n0.4, 1.6, 0.1\n");
    expect(m.wavelength_nm).toEqual([400, 500]);
    expect(m.n_imag).toEqual([0.1, 0]);
  });
});

describe("mock solver", () => {
  const f = fixture as unknown as { spec: JsonObject; result: ScatteringResult };
  it("matches the library's Mie cross sections for a gold sphere within 0.5 %", () => {
    const r = solveMock({ ...f.spec, outputs: { cross_sections: true } }, "lightsmith-mie", "cpu");
    r.c_ext_nm2.forEach((c, i) => expect(Math.abs(c - f.result.c_ext_nm2[i]) / f.result.c_ext_nm2[i]).toBeLessThan(5e-3));
    r.c_sca_nm2.forEach((c, i) => expect(Math.abs(c - f.result.c_sca_nm2[i]) / f.result.c_sca_nm2[i]).toBeLessThan(5e-3));
  });
  it("matches the library's far field for that sphere within 1 %", () => {
    const r = solveMock(f.spec, "lightsmith-mie", "cpu");
    const a = r.far_field![0].dcsca_domega_nm2.flat();
    const b = f.result.far_field![0].dcsca_domega_nm2.flat();
    a.forEach((v, i) => expect(Math.abs(v - b[i]) / b[i]).toBeLessThan(1e-2));
  });
  it("mirrors the backends' supports() reasons", () => {
    const s = supportsAll(TEMPLATES[1].spec);
    expect(s.find((x) => x.name === "miepython")!.reason).toMatch(/exactly one particle/);
    expect(s.find((x) => x.name === "lightsmith-dda")!.supported).toBe(true);
    expect(() => resolveBackend(TEMPLATES[1].spec, "mie")).toThrow(/cannot run/);
    expect(["tmatrix", "dda"]).toContain(resolveBackend(TEMPLATES[1].spec, "auto").method); // T-matrix when treams is installed
  });
});

describe("mock compute client", () => {
  it("runs a job and streams progress then the result", async () => {
    const c = new MockComputeClient({ latencyMs: 0, stepMs: 1 });
    const job = await c.submit({ operation: "solve", spec: TEMPLATES[0].spec, method: "auto", device: "cpu" });
    const events: JobEvent[] = [];
    await new Promise<void>((resolve) => c.subscribe(job.id, (e) => (events.push(e), e.type === "result" && resolve())));
    expect(events.some((e) => e.type === "progress")).toBe(true);
    expect((events.at(-1)!.result as ScatteringResult).backend).toMatch(/mie/);
  });
});

describe("HTTP compute client", () => {
  it("sends the bearer key and maps error bodies", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: "ValueError", message: "no backend" }), { status: 422 }));
    const c = new HttpComputeClient("https://example.test/", "KEY", fetchMock as unknown as typeof fetch);
    await expect(c.estimate({}, "auto", "cpu")).rejects.toMatchObject({ error: "ValueError", message: "no backend", status: 422 });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://example.test/v1/estimate");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer KEY");
    expect(JSON.parse(init.body as string)).toEqual({ simulation: {}, method: "auto", device: "cpu" });
  });

  it("falls back to per-backend estimate when /v1/supports is missing", async () => {
    const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith("/v1/supports")) return new Response("{}", { status: 404 });
      const body = JSON.parse(init.body as string);
      if (body.method === "miepython")
        return new Response(JSON.stringify({ detail: { error: "ValueError", message: "backend 'miepython' cannot run this problem: Mie handles exactly one particle" } }), { status: 422 });
      return new Response(JSON.stringify({ backend: body.method }), { status: 200 });
    });
    const c = new HttpComputeClient("http://localhost:8200", undefined, fetchMock as unknown as typeof fetch);
    const backends = [
      { name: "miepython", method: "mie", license: "MIT", gpu: false, available: true, unavailable_reason: null, citation: "" },
      { name: "lightsmith-dda", method: "dda", license: "MIT", gpu: true, available: true, unavailable_reason: null, citation: "" },
    ];
    const s = await c.supports(TEMPLATES[1].spec, backends);
    expect(s[0]).toMatchObject({ name: "miepython", supported: false, reason: "Mie handles exactly one particle" });
    expect(s[1]).toMatchObject({ supported: true });
  });
});

describe("code generation", () => {
  it("emits a Python literal and runnable calls", () => {
    expect(toPython({ a: true, b: null, c: [1, 2.5], d: 'x"y' })).toBe('{"a": True, "b": None, "c": [1, 2.5], "d": "x\\"y"}');
    const py = pythonCode(TEMPLATES[0].spec, { operation: "solve", method: "dda", device: "gpu" });
    expect(py).toContain('ls.solve(spec, method="dda", device="gpu")');
    const cmp = pythonCode(TEMPLATES[0].spec, { operation: "compare", method: "auto", device: "cpu", methods: ["mie", "dda"] });
    expect(cmp).toContain('ls.compare(spec, methods=["mie", "dda"], device="cpu")');
  });
  it("emits CLI commands for bash and PowerShell", () => {
    const sh = cliCode(TEMPLATES[0].spec, { operation: "compare", method: "auto", device: "cpu", methods: ["mie", "dda"] });
    expect(sh).toContain("cat > spec.json <<'EOF'");
    expect(sh).toContain("lightsmith compare spec.json --methods mie,dda --device cpu -o compare.json");
    expect(cliCode(TEMPLATES[0].spec, { operation: "estimate", method: "auto", device: "auto" }, "powershell")).toContain("Set-Content -Encoding utf8 spec.json");
  });
});

describe("deep links and exports", () => {
  it("decodes base64url and URI-encoded specs, desktop and web", () => {
    const spec = { medium_index: 1.5, note: "µ" };
    const b64 = base64UrlEncode(JSON.stringify(spec));
    expect(parseDeepLink(`lightsmith-studio://open?spec=${b64}`)).toEqual({ spec });
    expect(parseDeepLink(`https://studio.example/?spec=${encodeURIComponent(JSON.stringify(spec))}`)).toEqual({ spec });
    expect(parseDeepLink(`https://studio.example/#spec=${b64}`)).toEqual({ spec });
    expect(parseDeepLink("https://studio.example/?spec_url=https%3A%2F%2Fx.org%2Fa.json")).toEqual({ specUrl: "https://x.org/a.json" });
    expect(() => parseDeepLink("https://studio.example/?spec_url=javascript%3Aalert(1)")).toThrow();
    expect(parseDeepLink("https://studio.example/")).toBeNull();
    expect(parseDeepLink(`https://studio.example/?spec=${b64}&name=Dimer&project=x`)).toEqual({ spec, name: "Dimer" });
  });
  it("writes spectra CSV with Q", () => {
    const r = { method: "mie", backend: "x", wavelengths_nm: [500], c_ext_nm2: [Math.PI], c_sca_nm2: [0], c_abs_nm2: [Math.PI], equivalent_radius_nm: 1, provenance: {}, warnings: [] };
    expect(spectraCsv([{ label: "a", result: r }]).split("\n")[1]).toBe(`a,mie,x,500,${Math.PI},0,${Math.PI},1,0,1`);
  });
});
