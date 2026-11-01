// Materials API client (services/materials-db) and an in-browser mock backed by
// the library snapshot. Endpoints are listed in API_ASSUMPTIONS.md.

import { LIBRARY } from "../physics/materials";
import { isObject, type Json, type JsonObject } from "../schema/schema";
import { toApiError } from "./compute";
import { ApiError } from "./types";

export interface DbDataset {
  id: string;
  name: string;
  range_nm?: [number, number] | null;
  reference?: string | null;
  doi?: string | null;
}

export interface DbMaterial {
  id: string;
  name: string;
  description?: string | null;
  datasets: DbDataset[];
}

export interface NkData {
  wavelength_nm: number[];
  n: number[];
  k: number[];
}

export interface MaterialsClient {
  readonly kind: "mock" | "http";
  list(q?: string): Promise<DbMaterial[]>;
  data(datasetId: string): Promise<NkData>;
  /** Material JSON ready to drop into a spec. */
  material(datasetId: string): Promise<JsonObject>;
}

/** Accept the shapes materials-db may reasonably return for a list. */
function normalizeList(body: unknown): DbMaterial[] {
  const arr = Array.isArray(body) ? body : isObject(body as Json) ? ((body as JsonObject).materials ?? (body as JsonObject).items ?? []) : [];
  return (arr as JsonObject[]).map((m) => ({
    id: String(m.id ?? m.name),
    name: String(m.name ?? m.id),
    description: (m.description as string) ?? null,
    datasets: ((m.datasets as JsonObject[]) ?? []).map((d) => ({
      id: String(d.id ?? d.name),
      name: String(d.name ?? d.dataset ?? d.id),
      range_nm: (d.range_nm as [number, number]) ?? null,
      reference: (d.reference as string) ?? null,
      doi: (d.doi as string) ?? null,
    })),
  }));
}

/** Dataset ids may contain slashes (materials-db routes them as paths): encode per segment. */
const encId = (id: string) => id.split("/").map(encodeURIComponent).join("/");
const nums = (a: unknown): number[] => (Array.isArray(a) ? a.map((x) => (typeof x === "number" ? x : NaN)) : []);

export class HttpMaterialsClient implements MaterialsClient {
  readonly kind = "http" as const;
  constructor(readonly baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }
  private async get(path: string): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}${path}`, { headers: { Accept: "application/json" } });
    } catch (e) {
      throw new ApiError("ConnectionError", `cannot reach materials service at ${this.baseUrl} (${(e as Error).message})`);
    }
    if (!res.ok) throw await toApiError(res);
    return res.json();
  }
  async list(q?: string) {
    return normalizeList(await this.get(`/v1/materials?per_page=100${q ? `&q=${encodeURIComponent(q)}` : ""}`));
  }
  async data(id: string): Promise<NkData> {
    const d = (await this.get(`/v1/datasets/${encId(id)}/data`)) as JsonObject;
    const wl = nums(d.wavelength_nm);
    const k = d.k ?? d.n_imag;
    return { wavelength_nm: wl, n: nums(d.n ?? d.n_real), k: k ? nums(k).map((x) => (Number.isFinite(x) ? x : 0)) : wl.map(() => 0) };
  }
  async material(id: string) {
    // `/lightsmith` is current; `/omniscatter` is the deprecated alias older servers have.
    for (const route of ["lightsmith", "omniscatter"]) {
      try {
        return (await this.get(`/v1/datasets/${encId(id)}/${route}`)) as JsonObject;
      } catch (e) {
        if (!(e instanceof ApiError) || e.status !== 404) throw e;
      }
    }
    // No format endpoint: build the Tabulated material from the raw data.
    const d = await this.data(id);
    const keep = d.wavelength_nm.map((_, i) => i).filter((i) => Number.isFinite(d.wavelength_nm[i]) && Number.isFinite(d.n[i]));
    return {
      kind: "tabulated",
      wavelength_nm: keep.map((i) => d.wavelength_nm[i]),
      n_real: keep.map((i) => d.n[i]),
      n_imag: keep.map((i) => d.k[i]),
      source: `materials-db dataset ${id} (${this.baseUrl})`,
    };
  }
}

export class MockMaterialsClient implements MaterialsClient {
  readonly kind = "mock" as const;
  async list(q?: string) {
    const by = new Map<string, DbMaterial>();
    for (const r of LIBRARY) {
      const hay = `${r.name} ${r.description} ${r.aliases.join(" ")} ${r.dataset}`.toLowerCase();
      if (q && !hay.includes(q.toLowerCase())) continue;
      const m = by.get(r.name) ?? { id: r.name, name: r.name, description: r.description, datasets: [] };
      m.datasets.push({ id: `${r.name}/${r.dataset}`, name: r.dataset, range_nm: r.range_nm, reference: r.reference, doi: r.doi });
      by.set(r.name, m);
    }
    return [...by.values()];
  }
  private row(id: string) {
    const r = LIBRARY.find((x) => `${x.name}/${x.dataset}` === id);
    if (!r) throw new ApiError("NotFound", `no dataset ${id}`, 404);
    return r;
  }
  async data(id: string) {
    const r = this.row(id);
    return { wavelength_nm: r.wavelength_nm, n: r.n, k: r.k };
  }
  async material(id: string) {
    const r = this.row(id);
    return { kind: "tabulated", wavelength_nm: r.wavelength_nm, n_real: r.n, n_imag: r.k, source: `${r.reference} (via materials-db mock)` };
  }
}
