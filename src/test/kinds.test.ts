import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import schemaJson from "../generated/schema.json";
import { MockComputeClient } from "../api/compute";
import { CANNED_WARNING } from "../api/mock/solver";
import { resultKind, type BandResult, type JobEvent } from "../api/types";
import { bandGaps, svgPathToPoints } from "../components/viewers/KindResults";
import { cellPolygon, footprint, moveProfile, profileBounds } from "../components/kinds/geometry2d";
import { buildConfig } from "../config/runtime";
import { completeSignIn, getSession, jwtPayload, pkceChallenge, signOut } from "../lib/auth";
import { SchemaDoc, type JsonObject, type JSONSchema } from "../schema/schema";
import { validateProblem } from "../schema/validate";
import { KIND_META, KIND_TEMPLATES } from "../state/kinds";

const doc = new SchemaDoc(schemaJson as JSONSchema);
const fixtures = import.meta.glob("../generated/fixtures/*.json", { eager: true, import: "default" }) as Record<string, { spec: JsonObject; result: JsonObject | null }>;
const fixture = (k: string) => fixtures[`../generated/fixtures/${k}.json`];

describe("problem kinds", () => {
  it("has a template for every kind in the schema, each valid against it", () => {
    for (const { kind } of doc.problemKinds()) {
      const t = KIND_TEMPLATES[kind];
      expect(t, `template for ${kind}`).toBeDefined();
      expect(validateProblem(doc, t), kind).toEqual([]);
    }
  });

  it("names every kind and its result kind matches the solved fixture", () => {
    for (const { kind } of doc.problemKinds()) {
      expect(KIND_META[kind], kind).toBeDefined();
      const fx = fixture(kind);
      if (fx?.result) expect(resultKind(fx.result), kind).toBe(KIND_META[kind].result);
    }
  });

  it("finds the TM gap of the square rod lattice (about 31 %)", () => {
    const gaps = bandGaps((fixture("bands").result as unknown as BandResult).frequencies);
    const tm = gaps.find((g) => g.pol === "tm" && g.bands[0] === 1);
    expect(tm).toBeDefined();
    expect(tm!.ratio).toBeGreaterThan(0.28);
    expect(tm!.ratio).toBeLessThan(0.36);
    expect(bandGaps({ te: [[0.1, 0.2], [0.3, 0.4]] })).toEqual([]);
  });

  it("answers non-scattering jobs with the labelled example result", async () => {
    const c = new MockComputeClient({ latencyMs: 0, stepMs: 1 });
    for (const kind of ["layer_stack", "mode", "bands", "circuit"]) {
      const job = await c.submit({ operation: "solve", spec: KIND_TEMPLATES[kind], method: "auto", device: "cpu" });
      const ev = await new Promise<JobEvent>((resolve) => c.subscribe(job.id, (e) => (e.type === "result" || e.type === "error") && resolve(e)));
      expect(ev.type, kind).toBe("result");
      expect(resultKind(ev.result)).toBe(KIND_META[kind].result);
      expect((ev.result as { warnings: string[] }).warnings[0]).toBe(CANNED_WARNING);
    }
  });
});

describe("2D geometry", () => {
  it("bounds and moves profiles", () => {
    expect(profileBounds({ kind: "rectangle", center_nm: [10, 0], size_nm: [4, 2] })).toEqual([8, -1, 12, 1]);
    expect(moveProfile({ kind: "polygon", vertices_nm: [[0, 0], [1, 0], [0, 1]] }, 2, 3).vertices_nm).toEqual([[2, 3], [3, 3], [2, 4]]);
    const f = footprint({ kind: "box", center_nm: [1, 2, 3], size_nm: [10, 20, 30] })!;
    expect(f.profile).toEqual({ kind: "rectangle", center_nm: [1, 2], size_nm: [10, 20] });
    expect(f.move(1, 1)).toEqual({ kind: "box", center_nm: [2, 3, 3], size_nm: [10, 20, 30] });
    expect(cellPolygon([2, 0], [0, 2])).toEqual([[-1, -1], [1, -1], [1, 1], [-1, 1]]);
    expect(svgPathToPoints("M0,0h2v1h-2z")).toHaveLength(5);
  });
});

describe("runtime config", () => {
  it("defaults to the local server without config", () => {
    const c = buildConfig({});
    expect(c.defaultServer).toBe("local");
    expect(c.auth.mode).toBe("none");
  });
  it("uses hosted when a compute URL is configured and ignores empty values", () => {
    const c = buildConfig({ computeUrl: "https://c.example", materialsUrl: "", defaultServer: undefined, auth: { mode: "community", communityUrl: "https://web.example" } });
    expect(c.defaultServer).toBe("hosted");
    expect(c.computeUrl).toBe("https://c.example");
    expect(c.materialsUrl).toBe("");
    expect(c.auth).toMatchObject({ mode: "community", communityUrl: "https://web.example" });
  });
});

describe("sign-in", () => {
  it("computes the S256 PKCE challenge", async () => {
    const v = "verifier-0123456789-abcdefghijklmnopqrstuvwxyz";
    expect(await pkceChallenge(v)).toBe(createHash("sha256").update(v).digest("base64url"));
  });

  it("completes the Community handoff and cleans the URL", async () => {
    const payload = Buffer.from(JSON.stringify({ sub: "u1", name: "Ada", exp: Math.floor(Date.now() / 1000) + 300 })).toString("base64url");
    const token = `h.${payload}.s`;
    expect(jwtPayload(token)?.name).toBe("Ada");
    sessionStorage.setItem("studio:auth-pending", JSON.stringify({ kind: "community", state: "S1", returnTo: "http://localhost:3000/" }));
    history.replaceState(null, "", `/#access_token=${token}&token_type=Bearer&expires_in=300&state=S1`);
    expect(await completeSignIn({ mode: "community", communityUrl: "https://web.example" })).toBe(true);
    expect(getSession()).toMatchObject({ accessToken: token, name: "Ada", source: "community" });
    expect(location.hash).toBe("");
    signOut();
    expect(getSession()).toBeNull();
  });

  it("rejects a state mismatch", async () => {
    sessionStorage.setItem("studio:auth-pending", JSON.stringify({ kind: "community", state: "good", returnTo: "http://localhost:3000/" }));
    history.replaceState(null, "", "/#access_token=x&state=evil");
    await expect(completeSignIn({ mode: "community", communityUrl: "https://web.example" })).rejects.toThrow(/state mismatch/);
    expect(getSession()).toBeNull();
  });
});
