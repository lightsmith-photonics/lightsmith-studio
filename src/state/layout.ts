// The FDTD layout of the current spec, as the library builds it: Yee node planes, TFSF and flux boxes, CPML,
// refinement regions and mirror planes. Studio never computes these itself. In order, it asks:
//   1. the compute server, `POST /v1/layout` (proposed; API_ASSUMPTIONS.md);
//   2. in development, the library bridge of the Vite dev server (`POST /__library/v1/layout`, which runs
//      scripts/fdtd_layout.py against ../lightsmith);
//   3. the server's `POST /v1/estimate` for the FDTD backend, which already reports the mirror planes
//      (`symmetry.planes_nm`) and a graded-grid summary, but no node planes or boxes.
// While a new answer is on its way the previous one stays on screen, marked stale.

import { create } from "zustand";
import { ApiError, type FdtdLayout, type SymmetryInfo } from "../api/types";
import { canonical } from "../api/mock/snapshots";
import type { JsonObject } from "../schema/schema";
import { useConnection } from "./connection";

export type LayoutSource = "server" | "library bridge" | "snapshot" | "estimate";

/** What the estimate fallback gives: mirror planes and the grid summary, no geometry. */
export interface PartialLayout {
  symmetry?: SymmetryInfo;
  graded_grid?: Record<string, unknown>;
  cells?: number;
  spacing_nm?: number;
}

interface LayoutState {
  key: string | null;
  layout: FdtdLayout | null;
  partial: PartialLayout | null;
  source: LayoutSource | null;
  /** The layout on screen belongs to an earlier version of the spec. */
  stale: boolean;
  loading: boolean;
  /** Why there is no (full) layout: the library's error or the missing endpoint. */
  note: string | null;
  request(spec: JsonObject): void;
  clear(): void;
}

export const BRIDGE_URL = "/__library/v1/layout";
const DEBOUNCE_MS = 350;
let timer: ReturnType<typeof setTimeout> | undefined;
let seq = 0;

/** Problem kinds with an FDTD layout. */
export function hasFdtdLayout(spec: JsonObject): boolean {
  const k = typeof spec.kind === "string" ? spec.kind : "scattering";
  return k === "scattering" || k === "emission";
}

async function fromBridge(spec: JsonObject): Promise<FdtdLayout | null> {
  if (!import.meta.env.DEV) return null;
  let res: Response;
  try {
    res = await fetch(BRIDGE_URL, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ simulation: spec, method: "fdtd" }) });
  } catch {
    return null;
  }
  if (res.status === 404 || res.status === 501) return null; // no bridge, or no library next to Studio
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new ApiError(String(body?.error ?? `HTTP ${res.status}`), String(body?.message ?? res.statusText), res.status);
  return body as FdtdLayout;
}

export const useLayout = create<LayoutState>((set, get) => ({
  key: null,
  layout: null,
  partial: null,
  source: null,
  stale: false,
  loading: false,
  note: null,
  clear() {
    clearTimeout(timer);
    seq++;
    set({ key: null, layout: null, partial: null, source: null, stale: false, loading: false, note: null });
  },
  request(spec) {
    const key = canonical(spec);
    if (key === get().key && !get().stale) return;
    clearTimeout(timer);
    set({ stale: get().layout != null || get().partial != null, loading: true, key });
    const my = ++seq;
    timer = setTimeout(async () => {
      const client = useConnection.getState().client;
      const done = (v: Partial<LayoutState>) => my === seq && set({ loading: false, stale: false, partial: null, note: null, ...v });
      // No new layout: keep the last one on screen, marked stale, with the reason.
      const keep = (note: string) => (get().layout ? done({ layout: get().layout, source: get().source, stale: true, note }) : done({ layout: null, source: null, note }));
      let missing = "";
      try {
        const layout = await client.layout(spec, "fdtd");
        return done({ layout, source: client.kind === "mock" ? "snapshot" : "server", note: layout.error });
      } catch (e) {
        if (!(e instanceof ApiError) || (e.status !== 404 && e.status !== 405)) {
          return keep((e as Error).message);
        }
        missing = client.kind === "mock" ? (e as Error).message : "this compute server has no POST /v1/layout (proposed)";
      }
      try {
        const layout = await fromBridge(spec);
        if (layout) return done({ layout, source: "library bridge", note: layout.error });
      } catch (e) {
        return keep((e as Error).message);
      }
      if (client.kind === "http") {
        try {
          const est = (await client.estimate(spec, "fdtd", "cpu")) as Record<string, unknown>;
          return done({
            layout: null,
            partial: { symmetry: est.symmetry as SymmetryInfo, graded_grid: est.graded_grid as Record<string, unknown>, cells: est.cells as number, spacing_nm: est.spacing_nm as number },
            source: "estimate",
            note: `${missing}: mirror planes from /v1/estimate; no grid lines or boxes`,
          });
        } catch (e) {
          return keep((e as Error).message);
        }
      }
      keep(`${missing}. Run \`npm run dev\` next to ../lightsmith for the library bridge, or connect to a compute server.`);
    }, DEBOUNCE_MS);
  },
}));

/** Spacing (nm) of the cell around each node plane: the smaller of its two neighbours. */
export function nodeWidths(nodes: number[]): number[] {
  return nodes.map((x, i) => Math.min(i > 0 ? x - nodes[i - 1] : Infinity, i < nodes.length - 1 ? nodes[i + 1] - x : Infinity));
}
