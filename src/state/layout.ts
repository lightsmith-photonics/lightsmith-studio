// What a backend will discretise for the current spec, as the library plans it (lightsmith.discretization):
// grids, meshes, dipole lattices, harmonics, cells, plane waves. Studio never computes these itself.
// In order, it asks:
//   1. the compute server, `POST /v1/discretization` (API_ASSUMPTIONS.md, "Solver layouts");
//   2. in development, the library bridge of the Vite dev server (`POST /__library/v1/layout`, which runs
//      scripts/solver_layout.py against ../lightsmith);
//   3. the server's `POST /v1/estimate` for the same backend: its figures, and for FDTD the mirror planes.
// While a new answer is on its way the previous one stays on screen, marked stale.

import { create, type StoreApi, type UseBoundStore } from "zustand";
import { ApiError, toFdtdLayout, type FdtdLayout, type SolverLayout, type SymmetryInfo } from "../api/types";
import { canonical } from "../api/mock/snapshots";
import type { JsonObject } from "../schema/schema";
import { useConnection } from "./connection";

export type LayoutSource = "server" | "library bridge" | "snapshot" | "estimate";

/** What the estimate fallback gives: the backend's figures; for FDTD, the mirror planes. */
export interface PartialLayout {
  estimate: Record<string, unknown>;
  symmetry?: SymmetryInfo;
}

export interface LayoutState {
  key: string | null;
  method: string;
  /** The library's layout (any backend). */
  solver: SolverLayout | null;
  /** The same, flattened, when it is an FDTD scattering or emission layout. */
  layout: FdtdLayout | null;
  partial: PartialLayout | null;
  source: LayoutSource | null;
  /** The layout on screen belongs to an earlier version of the spec. */
  stale: boolean;
  loading: boolean;
  /** Why there is no (full) layout: the library's error or the missing endpoint. */
  note: string | null;
  request(spec: JsonObject, method?: string): void;
  clear(): void;
}

export const BRIDGE_URL = "/__library/v1/layout";
const DEBOUNCE_MS = 350;

/** Problem kinds with an FDTD layout in the 3D view. */
export function hasFdtdLayout(spec: JsonObject): boolean {
  const k = typeof spec.kind === "string" ? spec.kind : "scattering";
  return k === "scattering" || k === "emission";
}

async function fromBridge(spec: JsonObject, method: string): Promise<SolverLayout | null> {
  if (!import.meta.env.DEV) return null;
  let res: Response;
  try {
    res = await fetch(BRIDGE_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ simulation: spec, method }) });
  } catch {
    return null;
  }
  if (res.status === 404 || res.status === 501) return null; // no bridge, or no library next to Studio
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(String(body?.error ?? `HTTP ${res.status}`), String(body?.message ?? res.statusText), res.status);
  return body as SolverLayout;
}

function createLayoutStore(defaultMethod: string): UseBoundStore<StoreApi<LayoutState>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let seq = 0;
  return create<LayoutState>((set, get) => ({
    key: null,
    method: defaultMethod,
    solver: null,
    layout: null,
    partial: null,
    source: null,
    stale: false,
    loading: false,
    note: null,
    clear() {
      clearTimeout(timer);
      seq++;
      set({ key: null, solver: null, layout: null, partial: null, source: null, stale: false, loading: false, note: null });
    },
    request(spec, method = defaultMethod) {
      const key = `${method}|${canonical(spec)}`;
      if (key === get().key && !get().stale) return;
      clearTimeout(timer);
      // a different backend's layout is not a stale version of this one
      const sameMethod = get().method === method;
      set({
        stale: sameMethod && (get().solver != null || get().partial != null),
        loading: true,
        key,
        method,
        ...(sameMethod ? {} : { solver: null, layout: null, partial: null, source: null, note: null }),
      });
      const my = ++seq;
      timer = setTimeout(async () => {
        const client = useConnection.getState().client;
        const done = (v: Partial<LayoutState>) => my === seq && set({ loading: false, stale: false, partial: null, note: null, ...v });
        const ok = (solver: SolverLayout, source: LayoutSource) => done({ solver, layout: toFdtdLayout(solver), source, note: solver.error });
        // No new layout: keep the last one on screen, marked stale, with the reason.
        const keep = (note: string) => (get().solver ? done({ solver: get().solver, layout: get().layout, source: get().source, stale: true, note }) : done({ solver: null, layout: null, source: null, note }));
        let missing = "";
        try {
          return ok(await client.layout(spec, method), client.kind === "mock" ? "snapshot" : "server");
        } catch (e) {
          if (!(e instanceof ApiError) || (e.status !== 404 && e.status !== 405)) return keep((e as Error).message);
          missing = client.kind === "mock" ? (e as Error).message : "this compute server has no POST /v1/discretization";
        }
        try {
          const l = await fromBridge(spec, method);
          if (l) return ok(l, "library bridge");
        } catch (e) {
          return keep((e as Error).message);
        }
        if (client.kind === "http") {
          try {
            const est = (await client.estimate(spec, method, "cpu")) as Record<string, unknown>;
            return done({
              solver: null,
              layout: null,
              partial: { estimate: est, symmetry: est.symmetry as SymmetryInfo | undefined },
              source: "estimate",
              note: `${missing}: the figures come from /v1/estimate; nothing to draw`,
            });
          } catch (e) {
            return keep((e as Error).message);
          }
        }
        keep(`${missing}. Run \`npm run dev\` next to ../lightsmith for the library bridge, or connect to a compute server.`);
      }, DEBOUNCE_MS);
    },
  }));
}

/** FDTD layout for the 3D view (scattering and emission). */
export const useLayout = createLayoutStore("fdtd");
/** The Preview tab: the layout of the backend chosen there. */
export const usePreview = createLayoutStore("auto");

/** Spacing (nm) of the cell around each node plane: the smaller of its two neighbours. */
export function nodeWidths(nodes: number[]): number[] {
  return nodes.map((x, i) => Math.min(i > 0 ? x - nodes[i - 1] : Infinity, i < nodes.length - 1 ? nodes[i + 1] - x : Infinity));
}
