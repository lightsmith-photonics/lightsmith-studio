// Preview tab: what the chosen backend will discretise for the current spec, before the run, as the library
// plans it (state/layout.ts; scripts/solver_layout.py). One view per layout kind: Yee grids, device grids with
// ports and PML, DDA dipole lattices, BEM surface meshes, Mie/T-matrix multipole orders, RCWA harmonics, FDE
// cross-section grids, EME/BPM cells, PWE k-paths and plane waves. Nothing here is computed by Studio.

import { useEffect, useMemo, useState } from "react";
import { isObject, type Json, type JsonObject } from "../schema/schema";
import { useConnection } from "../state/connection";
import { usePreview } from "../state/layout";
import { useSpec } from "../state/store";
import { footprint, profilePath } from "./kinds/geometry2d";
import { Plot } from "./Plot";
import { useSupport } from "./RunPanel";
import { svgPathToPoints } from "./viewers/KindResults";

const COLORS = ["#4f9dff", "#ff8a4c", "#38d39f", "#e45bd0", "#f2c94c", "#8c7bff", "#ff5d5d", "#4cd7e4"];
const GRID = "rgba(160,180,200,0.45)";
const PML = "rgba(140,123,255,0.18)";
const MAX_LINES = 160;

type P = Record<string, unknown>;
const arr = (v: unknown): number[] => (Array.isArray(v) ? (v as number[]) : []);

/** Every k-th node plane, so a dense grid stays readable; the step is reported. */
function decimate(nodes: number[]): { nodes: number[]; step: number } {
  const step = Math.max(1, Math.ceil(nodes.length / MAX_LINES));
  return { nodes: nodes.filter((_, i) => i % step === 0 || i === nodes.length - 1), step };
}

/** Plotly line segments (x, y arrays with null breaks) for vertical lines at xs and horizontal at ys. */
function gridLines(xs: number[], ys: number[]) {
  const x: (number | null)[] = [];
  const y: (number | null)[] = [];
  const [y0, y1] = [ys[0], ys[ys.length - 1]];
  const [x0, x1] = [xs[0], xs[xs.length - 1]];
  for (const v of xs) x.push(v, v, null), y.push(y0, y1, null);
  for (const v of ys) x.push(x0, x1, null), y.push(v, v, null);
  return { x, y, mode: "lines", line: { color: GRID, width: 0.7 }, hoverinfo: "skip", showlegend: false };
}

function rect(x0: number, x1: number, y0: number, y1: number, color: string, name?: string) {
  return { x: [x0, x1, x1, x0, x0], y: [y0, y0, y1, y1, y0], mode: "lines", fill: "toself", fillcolor: color, line: { width: 0 }, name, showlegend: !!name, hoverinfo: name ? "name" : "skip" };
}

/** Outlines of the spec's structures in the plane the layout uses. */
function outlines(spec: JsonObject): { x: number[]; y: number[]; name: string }[] {
  const out: { x: number[]; y: number[]; name: string }[] = [];
  const add = (profile: Json, name: string) => {
    const pts = svgPathToPoints(profilePath(profile));
    if (pts.length) out.push({ x: [...pts.map((p) => p[0]), pts[0][0]], y: [...pts.map((p) => p[1]), pts[0][1]], name });
  };
  const kind = spec.kind;
  const dev = kind === "optimization" && isObject(spec.device) ? spec.device : spec;
  for (const [i, s] of (Array.isArray(dev.structures) ? dev.structures : []).entries()) {
    if (!isObject(s)) continue;
    const name = typeof s.name === "string" && s.name ? s.name : `structure ${i + 1}`;
    if (isObject(s.profile)) add(s.profile, name);
    else if (isObject(s.geometry)) {
      const f = footprint(s.geometry);
      if (f) add(f.profile, name);
    }
  }
  return out;
}

const outlineTraces = (spec: JsonObject) =>
  outlines(spec).map((o, i) => ({ x: o.x, y: o.y, mode: "lines", name: o.name, line: { color: COLORS[(i + 1) % COLORS.length], width: 2 }, hoverinfo: "name", showlegend: i < 6 }));

const equal = { yaxis: { scaleanchor: "x", scaleratio: 1, title: { text: "y (nm)" } }, xaxis: { title: { text: "x (nm)" } } };

function DeviceGrid({ p, spec }: { p: P; spec: JsonObject }) {
  const nodes = (p.nodes_nm as number[][]) ?? [];
  const xs = decimate(nodes[0] ?? []);
  const ys = decimate(nodes[1] ?? []);
  const lo = arr(p.pml_inner_lo_nm);
  const hi = arr(p.pml_inner_hi_nm);
  const X = nodes[0] ?? [0];
  const Y = nodes[1] ?? [0];
  const [x0, x1, y0, y1] = [X[0], X[X.length - 1], Y[0], Y[Y.length - 1]];
  const data: unknown[] = [
    rect(x0, lo[0], y0, y1, PML, "PML"),
    rect(hi[0], x1, y0, y1, PML),
    rect(lo[0], hi[0], y0, lo[1], PML),
    rect(lo[0], hi[0], hi[1], y1, PML),
    gridLines(xs.nodes, ys.nodes),
    ...outlineTraces(spec),
  ];
  for (const r of (p.design_regions as P[]) ?? []) {
    const rx = arr(r.x_nm);
    const ry = arr(r.y_nm);
    data.push({ x: [rx[0], rx[1], rx[1], rx[0], rx[0]], y: [ry[0], ry[0], ry[1], ry[1], ry[0]], mode: "lines", line: { color: "#e45bd0", dash: "dash", width: 2 }, name: `design ${r.name} (${(r.shape as number[]).join("×")}, filter ${r.filter_radius_cells} cells)` });
  }
  for (const port of (p.ports as P[]) ?? []) {
    const ax = port.axis as string;
    const win = (port.window_nm as Record<string, number[]>) ?? {};
    const t = ax === "x" ? "y" : "x";
    const w = win[t] ?? [t === "y" ? y0 : x0, t === "y" ? y1 : x1];
    const s = port.source_nm as number;
    const seg = ax === "x" ? { x: [s, s], y: w } : { x: w, y: [s, s] };
    data.push({ ...seg, mode: "lines+text", text: [String(port.name), ""], textposition: "top center", line: { color: "#ff5d5d", width: 3 }, name: `port ${port.name} (${port.direction}${ax}, ${port.num_modes} mode${port.num_modes === 1 ? "" : "s"})` });
    if (typeof port.monitor_nm === "number") {
      const m = port.monitor_nm as number;
      data.push({ ...(ax === "x" ? { x: [m, m], y: w } : { x: w, y: [m, m] }), mode: "lines", line: { color: "#ff5d5d", width: 1, dash: "dot" }, showlegend: false, hoverinfo: "skip" });
    }
  }
  return (
    <>
      <Plot data={data} layout={{ ...equal, hovermode: "closest", xaxis: { ...equal.xaxis, range: [x0 - 0.05 * (x1 - x0), x1 + 0.05 * (x1 - x0)] }, yaxis: { ...equal.yaxis, range: [y0 - 0.05 * (y1 - y0), y1 + 0.05 * (y1 - y0)] } }} height={460} testId="preview-plot" />
      <p className="muted small">
        Grid lines {xs.step > 1 || ys.step > 1 ? `every ${Math.max(xs.step, ys.step)} cells` : "at every node"}; shaded: PML; red: port planes (dotted: monitor planes).
        {p.two_d ? " 2D: invariant along z." : " 3D grid: the xy plane at z nodes shown in the summary."} {String(p.note ?? "")}
      </p>
    </>
  );
}

function CrossSectionGrid({ p, spec }: { p: P; spec: JsonObject }) {
  const xs = decimate(arr(p.x_nm));
  const ys = decimate(arr(p.y_nm));
  const pml = (p.pml_cells as number[][]) ?? [
    [0, 0],
    [0, 0],
  ];
  const X = arr(p.x_nm);
  const Y = arr(p.y_nm);
  const dx = Number(p.dx_nm);
  const dy = Number(p.dy_nm);
  const data: unknown[] = [];
  if (pml[0][0]) data.push(rect(X[0], X[0] + pml[0][0] * dx, Y[0], Y[Y.length - 1], PML, "PML"));
  if (pml[0][1]) data.push(rect(X[X.length - 1] - pml[0][1] * dx, X[X.length - 1], Y[0], Y[Y.length - 1], PML));
  if (pml[1][0]) data.push(rect(X[0], X[X.length - 1], Y[0], Y[0] + pml[1][0] * dy, PML));
  if (pml[1][1]) data.push(rect(X[0], X[X.length - 1], Y[Y.length - 1] - pml[1][1] * dy, Y[Y.length - 1], PML));
  data.push(Y.length > 1 ? gridLines(xs.nodes, ys.nodes) : { x: xs.nodes, y: xs.nodes.map(() => 0), mode: "markers", marker: { size: 3, color: GRID }, name: "nodes (slab: invariant in y)" });
  data.push(...outlineTraces(spec));
  return (
    <>
      <Plot data={data} layout={{ ...equal, hovermode: "closest", xaxis: { ...equal.xaxis, range: [X[0] - 0.05 * (X[X.length - 1] - X[0]), X[X.length - 1] + 0.05 * (X[X.length - 1] - X[0])] }, ...(Y.length > 1 ? { yaxis: { ...equal.yaxis, range: [Y[0] - 0.05 * (Y[Y.length - 1] - Y[0]), Y[Y.length - 1] + 0.05 * (Y[Y.length - 1] - Y[0])] } } : {}) }} height={420} testId="preview-plot" />
      <p className="muted small">
        Grid lines {Math.max(xs.step, ys.step) > 1 ? `every ${Math.max(xs.step, ys.step)} cells` : "at every node"} · boundary {String(p.boundary ?? "")}
        {(p.symmetry as boolean[] | undefined)?.some(Boolean) ? ` · mirror symmetry ${JSON.stringify(p.symmetry)}` : ""} · {String(p.num_modes ?? "")} modes solved.
      </p>
    </>
  );
}

function Cells({ p, spec }: { p: P; spec: JsonObject }) {
  const cells = (p.cells as P[]) ?? [];
  const ax = p.axis as string;
  const outs = outlineTraces(spec);
  const ys = outs.flatMap((o) => o.y as number[]);
  const xsAll = outs.flatMap((o) => o.x as number[]);
  const [t0, t1] = ax === "x" ? [Math.min(...ys, -1000), Math.max(...ys, 1000)] : [Math.min(...xsAll, -1000), Math.max(...xsAll, 1000)];
  const span = Math.min(t1 - t0, 4 * (Number(p.hi_nm) - Number(p.lo_nm)));
  const c = (t0 + t1) / 2;
  const [a, b] = [c - span / 2, c + span / 2];
  const bounds = [...new Set(cells.flatMap((x) => [x.start_nm as number, x.stop_nm as number]))];
  const lx: (number | null)[] = [];
  const ly: (number | null)[] = [];
  for (const v of bounds) ax === "x" ? (lx.push(v, v, null), ly.push(a, b, null)) : (lx.push(a, b, null), ly.push(v, v, null));
  const bpm = typeof p.step_nm === "number";
  return (
    <>
      <Plot
        data={[...outs, { x: lx, y: ly, mode: "lines", line: { color: "#f2c94c", width: 1.4 }, name: `cell boundaries (${cells.length} cells)` }]}
        layout={{
          ...equal,
          hovermode: "closest",
          [ax === "x" ? "xaxis" : "yaxis"]: { ...(ax === "x" ? equal.xaxis : equal.yaxis), range: [Number(p.lo_nm) - 0.15 * (Number(p.hi_nm) - Number(p.lo_nm)), Number(p.hi_nm) + 0.15 * (Number(p.hi_nm) - Number(p.lo_nm))] },
        }}
        height={340}
        testId="preview-plot"
      />
      <Plot
        data={[
          {
            type: "bar",
            x: cells.map((x) => ((x.start_nm as number) + (x.stop_nm as number)) / 2),
            width: cells.map((x) => (x.stop_nm as number) - (x.start_nm as number)),
            y: cells.map((x) => (bpm ? (x.steps as number) : Number(p.modes_per_cell))),
            marker: { color: "#4f9dff", line: { color: "#14171c", width: 1 } },
            name: bpm ? "steps per cell" : "modes per cell",
          },
        ]}
        layout={{ xaxis: { title: { text: `${ax} (nm)` } }, yaxis: { title: { text: bpm ? "propagation steps" : "modes per cell" } } }}
        height={200}
        testId="preview-cells-plot"
      />
      <p className="muted small">
        {bpm ? `Steps of at most ${Number(p.step_nm).toPrecision(4)} nm per cell; a taper is staircased into slices.` : `Each cell is uniform along ${ax}; ${p.modes_per_cell} modes are solved per cell and matched at its faces.`} Cross-section grid{" "}
        {arr((p.cross_section as P)?.x_nm).length} × {arr((p.cross_section as P)?.y_nm).length}.
      </p>
    </>
  );
}

function DipoleLattice({ p }: { p: P }) {
  const pts = (p.points_nm as number[][]) ?? [];
  const slot = arr(p.material_slot);
  return (
    <>
      <Plot
        data={[
          {
            type: "scatter3d",
            mode: "markers",
            x: pts.map((q) => q[0]),
            y: pts.map((q) => q[1]),
            z: pts.map((q) => q[2]),
            marker: { size: 2.2, color: slot.map((s) => COLORS[s % COLORS.length]), opacity: 0.85 },
            hoverinfo: "skip",
            name: "dipoles",
          },
        ]}
        layout={{ scene: { aspectmode: "data", xaxis: { title: { text: "x (nm)" } }, yaxis: { title: { text: "y (nm)" } }, zaxis: { title: { text: "z (nm)" } } }, margin: { l: 0, r: 0, t: 10, b: 0 } }}
        height={460}
        testId="preview-plot"
      />
      <p className="muted small">
        {Number(p.n_dipoles).toLocaleString()} dipoles on a {Number(p.spacing_nm).toPrecision(4)} nm cubic lattice{Number(p.stride) > 1 ? ` (every ${p.stride}th shown)` : ""}; colour = material region.
        {p.extrapolate ? ` Extrapolation runs lattices of ${(p.extrapolate as number[]).join(", ")} dipoles per diameter; the largest is shown.` : ""}
      </p>
    </>
  );
}

function SurfaceMesh({ p }: { p: P }) {
  const v = (p.verts_nm as number[][]) ?? [];
  const t = (p.tris as number[][]) ?? [];
  const surf = arr(p.tri_surface);
  const edges = useMemo(() => {
    const x: (number | null)[] = [];
    const y: (number | null)[] = [];
    const z: (number | null)[] = [];
    for (const tri of t.slice(0, 8000)) for (const [a, b] of [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]]) x.push(v[a][0], v[b][0], null), y.push(v[a][1], v[b][1], null), z.push(v[a][2], v[b][2], null);
    return { x, y, z };
  }, [v, t]);
  return (
    <>
      <Plot
        data={[
          { type: "mesh3d", x: v.map((q) => q[0]), y: v.map((q) => q[1]), z: v.map((q) => q[2]), i: t.map((q) => q[0]), j: t.map((q) => q[1]), k: t.map((q) => q[2]), facecolor: surf.map((s) => COLORS[s % COLORS.length]), opacity: 0.55, flatshading: true, hoverinfo: "skip", name: "surfaces" },
          { type: "scatter3d", mode: "lines", ...edges, line: { color: "#dfe3ea", width: 1 }, hoverinfo: "skip", name: "edges" },
        ]}
        layout={{ scene: { aspectmode: "data" }, margin: { l: 0, r: 0, t: 10, b: 0 }, showlegend: false }}
        height={460}
        testId="preview-plot"
      />
      <p className="muted small">
        {Number(p.n_triangles).toLocaleString()} triangles, target element size {Number(p.mesh_size_nm).toPrecision(4)} nm{Number(p.stride) > 1 ? ` (every ${p.stride}th triangle shown)` : ""}. The unknowns are two surface currents per edge.
      </p>
    </>
  );
}

function Multipoles({ p }: { p: P }) {
  if (Array.isArray(p.n_max))
    return (
      <>
        <Plot
          data={[
            { x: arr(p.wavelengths_nm), y: arr(p.n_max), mode: "lines+markers", line: { shape: "hv", color: COLORS[0], width: 2 }, name: "multipole order n_max" },
            { x: arr(p.wavelengths_nm), y: arr(p.size_parameter), mode: "lines", yaxis: "y2", line: { color: COLORS[1], dash: "dot" }, name: "size parameter x" },
          ]}
          layout={{ xaxis: { title: { text: "vacuum wavelength (nm)" } }, yaxis: { title: { text: "n_max" }, rangemode: "tozero" }, yaxis2: { title: { text: "x = k r" }, overlaying: "y", side: "right" } }}
          height={300}
          testId="preview-plot"
        />
        <p className="muted small">Orders kept per wavelength (Wiscombe's rule; layered spheres add margin){p.fixed_n_max ? `; fixed by the option n_max = ${p.fixed_n_max}` : ""}. {String(p.note ?? "")}</p>
      </>
    );
  const l = arr(p.lmax);
  return (
    <>
      <Plot
        data={[{ type: "bar", x: l.map((_, i) => `particle ${i + 1}`), y: l, marker: { color: COLORS[0] }, name: "lmax" }]}
        layout={{ yaxis: { title: { text: "lmax" }, rangemode: "tozero" } }}
        height={260}
        testId="preview-plot"
      />
      <p className="muted small">
        Multipole order per particle at the shortest wavelength (more for close neighbours); {String(p.modes)} modes in the cluster T-matrix{p.lmax_global != null ? `; lmax ${p.lmax_global} for the global T-matrix` : ""}.
      </p>
    </>
  );
}

function Harmonics({ p }: { p: P }) {
  const h = (p.harmonics as number[][]) ?? [];
  const layers = (p.layers as P[]) ?? [];
  return (
    <>
      <div className="row wrap">
        <div style={{ flex: "1 1 320px" }}>
          <Plot
            data={[{ x: h.map((q) => q[0]), y: h.map((q) => q[1]), mode: "markers", marker: { size: 7, color: h.map((q) => (q[0] === 0 && q[1] === 0 ? "#ff8a4c" : "#4f9dff")) }, name: "orders (m, n)" }]}
            layout={{ xaxis: { title: { text: "m" }, zeroline: true }, yaxis: { title: { text: "n" }, scaleanchor: "x" } }}
            height={320}
            testId="preview-plot"
          />
        </div>
        <div style={{ flex: "1 1 260px" }}>
          <Plot
            data={layers.map((l, i) => ({ type: "bar", x: ["stack"], y: [l.thickness_nm], name: `layer ${i + 1}${l.patterned ? ` (${l.shapes} shapes)` : ""}`, marker: { color: l.patterned ? COLORS[(i + 3) % COLORS.length] : "#5b6472" } }))}
            layout={{ barmode: "stack", yaxis: { title: { text: "thickness (nm)" }, autorange: "reversed" } }}
            height={320}
            testId="preview-layers-plot"
          />
        </div>
      </div>
      <p className="muted small">
        {h.length} Fourier orders (orange: the zeroth). {String(p.note ?? "")}
      </p>
    </>
  );
}

function PlaneWaves({ p }: { p: P }) {
  const k = (p.k_reduced as number[][]) ?? [];
  const labels = (p.k_labels as Record<string, string>) ?? {};
  const pols = (p.polarizations as Record<string, P>) ?? {};
  const dense = Object.entries(pols).find(([, v]) => Array.isArray(v.g_indices));
  const g = (dense?.[1].g_indices as number[][]) ?? [];
  return (
    <>
      <div className="row wrap">
        <div style={{ flex: "1 1 320px" }}>
          <Plot
            data={[
              { x: k.map((q) => q[0]), y: k.map((q) => q[1]), mode: "lines+markers", marker: { size: 4 }, line: { color: COLORS[0] }, name: "k-path" },
              { x: Object.keys(labels).map((i) => k[Number(i)]?.[0]), y: Object.keys(labels).map((i) => k[Number(i)]?.[1]), mode: "text", text: Object.values(labels), textposition: "top right", textfont: { size: 14, color: "#f2c94c" }, showlegend: false },
            ]}
            layout={{ xaxis: { title: { text: "k₁ (reduced)" } }, yaxis: { title: { text: "k₂ (reduced)" }, scaleanchor: "x" } }}
            height={320}
            testId="preview-plot"
          />
        </div>
        {g.length > 0 && (
          <div style={{ flex: "1 1 320px" }}>
            <Plot
              data={[{ x: g.map((q) => q[0]), y: g.map((q) => q[1] ?? 0), mode: "markers", marker: { size: 3, color: COLORS[2] }, name: `${g.length} plane waves (${dense![0]})` }]}
              layout={{ xaxis: { title: { text: "G index 1" } }, yaxis: { title: { text: "G index 2" }, scaleanchor: "x" } }}
              height={320}
              testId="preview-gvectors-plot"
            />
          </div>
        )}
      </div>
      <p className="muted small">
        {k.length} k-points.{" "}
        {Object.entries(pols)
          .map(([pol, v]) => `${pol}: ${v.num_plane_waves} plane waves, ${v.solver}${v.grid ? ` on a ${(v.grid as number[]).join("×")} FFT grid` : ""}`)
          .join(" · ")}
      </p>
    </>
  );
}

function YeeGrid({ p }: { p: P }) {
  const g = p.grid as P;
  const nodes = (g?.nodes_nm as number[][]) ?? [];
  return (
    <>
      <Plot
        data={nodes.map((n, a) => ({ x: n.slice(0, -1).map((v, i) => (v + n[i + 1]) / 2), y: n.slice(0, -1).map((v, i) => n[i + 1] - v), mode: "lines+markers", marker: { size: 3 }, name: `${"xyz"[a]} cells`, line: { color: COLORS[a] } }))}
        layout={{ xaxis: { title: { text: "position (nm)" } }, yaxis: { title: { text: "cell width (nm)" }, rangemode: "tozero" } }}
        height={280}
        testId="preview-plot"
      />
      <p className="muted small">Cell widths along each axis ({String(g?.kind)} grid). The Scene tab draws the TFSF and flux boxes, CPML, mirror planes and a mesh slice.</p>
    </>
  );
}

/** FDTD unit cell (periodic structures, layer stacks): x–depth section with the layers, z planes and CPML. */
function UnitCell({ p }: { p: P }) {
  const xs = decimate(arr(p.x_nm));
  const zs = decimate(arr(p.z_nm));
  const Z = arr(p.z_nm);
  const X = arr(p.x_nm);
  const [x0, x1] = [X[0], X[X.length - 1]];
  const pml = (p.pml_inner_z_nm as number[]) ?? [Z[0], Z[Z.length - 1]];
  const planes = (p.planes_nm as Record<string, number>) ?? {};
  const tops = arr(p.layer_tops_nm);
  const th = arr(p.layer_thicknesses_nm);
  const data: unknown[] = [
    rect(x0, x1, Z[0], pml[0], PML, "CPML"),
    rect(x0, x1, pml[1], Z[Z.length - 1], PML),
    ...tops.map((t, i) => rect(x0, x1, t, t + th[i], `rgba(${i % 2 ? "79,157,255" : "56,211,159"},0.18)`, `layer ${i + 1} (${th[i]} nm)`)),
    gridLines(xs.nodes, zs.nodes),
    ...Object.entries(planes).map(([name, z], i) => ({
      x: [x0, x1],
      y: [z, z],
      mode: "lines+text",
      text: i % 2 ? ["", name] : [name, ""],
      textposition: i % 2 ? "bottom left" : "top right",
      line: { color: ["#f2c94c", "#ff8a4c", "#dfe3ea", "#dfe3ea", "#f2c94c"][i % 5], width: name.startsWith("stack") ? 1 : 2.5, dash: name.startsWith("stack") ? "dot" : "solid" },
      name,
      showlegend: false,
    })),
  ];
  const inv = (p.invariant as boolean[]) ?? [false, false];
  return (
    <>
      <Plot data={data} layout={{ xaxis: { title: { text: "x (nm)" } }, yaxis: { title: { text: "depth below the top of the stack (nm)" }, autorange: "reversed" }, hovermode: "closest" }} height={460} testId="preview-plot" />
      <p className="muted small">
        One period ({(p.n_cells as number[]).join(" × ")} cells{inv[0] || inv[1] ? `; invariant along ${inv[0] ? "x" : ""}${inv[1] ? "y" : ""}: one cell` : ""}), periodic in x and y, CPML along z. Grid lines{" "}
        {Math.max(xs.step, zs.step) > 1 ? `every ${Math.max(xs.step, zs.step)} cells` : "at every node"}.
      </p>
    </>
  );
}

function Visual({ kind, p, spec }: { kind: string; p: P; spec: JsonObject }) {
  switch (kind) {
    case "unit_cell":
      return <UnitCell p={p} />;
    case "device_grid":
      return <DeviceGrid p={p} spec={spec} />;
    case "cross_section_grid":
      return <CrossSectionGrid p={p} spec={spec} />;
    case "cells":
      return <Cells p={p} spec={spec} />;
    case "dipole_lattice":
      return <DipoleLattice p={p} />;
    case "surface_mesh":
      return <SurfaceMesh p={p} />;
    case "multipoles":
      return <Multipoles p={p} />;
    case "harmonics":
      return <Harmonics p={p} />;
    case "plane_waves":
      return <PlaneWaves p={p} />;
    case "yee_grid":
      return <YeeGrid p={p} />;
    default:
      return <p className="muted">{String(p.note ?? "Nothing to draw for this backend.")}</p>;
  }
}

const show = (v: unknown) => (Array.isArray(v) ? v.join(" × ") : typeof v === "number" ? (Number.isInteger(v) ? v.toLocaleString() : String(Number(v.toPrecision(5)))) : String(v));

export function PreviewView() {
  const spec = useSpec((s) => s.spec);
  const conn = useConnection();
  const pv = usePreview();
  const { list } = useSupport();
  const kind = typeof spec.kind === "string" ? spec.kind : "scattering";
  const relevant = conn.backends.filter((b) => !b.problem_kinds || b.problem_kinds.includes(kind));
  const runnable = (list ?? []).filter((s) => s.available && s.supported).map((s) => s.name);
  const fromRun = relevant.find((b) => b.name === conn.method) ?? relevant.find((b) => b.method === conn.method && runnable.includes(b.name));
  const [sel, setSel] = useState<string | null>(null);
  const backend = (sel && relevant.some((b) => b.name === sel) ? sel : null) ?? fromRun?.name ?? runnable[0] ?? relevant[0]?.name ?? "auto";
  useEffect(() => {
    if (backend !== "auto") pv.request(spec, backend);
  }, [spec, backend]); // eslint-disable-line react-hooks/exhaustive-deps
  const L = pv.method === backend ? pv.solver : null;
  const summary = L?.summary ?? (pv.partial ? Object.fromEntries(Object.entries(pv.partial.estimate).filter(([k, v]) => !["backend", "method", "framework", "device"].includes(k) && (typeof v !== "object" || Array.isArray(v)))) : null);
  return (
    <div className="results-main padded" data-testid="preview-view">
      <div className="row wrap">
        <h4 className="grow">What the solver will discretise</h4>
        <label className="small">
          backend{" "}
          <select value={backend} onChange={(e) => setSel(e.target.value)} data-testid="preview-backend">
            {relevant.map((b) => (
              <option key={b.name} value={b.name}>
                {b.name} ({b.method}){list && !runnable.includes(b.name) ? " — not for this spec" : ""}
              </option>
            ))}
          </select>
        </label>
      </div>
      {pv.loading && !L && <p className="muted">Asking the library…</p>}
      {L?.error && (
        <div className="warn-box" data-testid="preview-error">
          {L.error}
        </div>
      )}
      {summary && (
        <table className="summary-table kv-table" data-testid="preview-summary">
          <tbody>
            {Object.entries(summary).map(([k, v]) => (
              <tr key={k}>
                <th>{k}</th>
                <td>{show(v)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {L && <Visual kind={L.layout_kind} p={L.payload as P} spec={spec} />}
      {(L?.warnings ?? []).map((w, i) => (
        <div key={i} className="muted small">
          ⚠ {w}
        </div>
      ))}
      <p className="muted small" data-testid="preview-source">
        {pv.source ? `From the library (${pv.source})${pv.stale ? ", before your last edit" : ""}${pv.loading && L ? " · updating…" : ""}.` : ""} {pv.note && !L?.error ? pv.note : ""}
      </p>
    </div>
  );
}
