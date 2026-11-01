// The center "Scene" view for every problem kind other than scattering (which has the 3D
// viewport). Each view draws the spec and edits it through spec ops; every field remains
// editable in the Properties panel's generated forms.

import { useMemo, useState } from "react";
import { wavelengthArray } from "../../api/mock/solver";
import { materialColor, materialLabel, nkAt } from "../../physics/materials";
import { clone, isObject, type Json, type JsonObject, type Path } from "../../schema/schema";
import { kindMeta } from "../../state/kinds";
import { useSpec } from "../../state/store";
import { CrossSection, type Overlay2D, type Shape2D } from "./CrossSection";
import { cellPolygon, footprint, moveProfile, type XY } from "./geometry2d";

const arr = (v: Json | undefined): JsonObject[] => (Array.isArray(v) ? v.filter(isObject) : []) as JsonObject[];
const pair = (v: Json | undefined, d: XY = [0, 0]): XY => (Array.isArray(v) && v.length >= 2 ? [Number(v[0]), Number(v[1])] : d);

export function KindScene({ kind }: { kind: string }) {
  switch (kind) {
    case "layer_stack":
      return <LayerStackScene />;
    case "periodic":
      return <PeriodicScene />;
    case "mode":
      return <ModeScene />;
    case "bands":
      return <BandsScene />;
    case "device":
      return <DeviceScene prefix={[]} />;
    case "optimization":
      return <DeviceScene prefix={["device"]} designRegions />;
    case "circuit":
      return <CircuitScene />;
    default:
      return (
        <div className="viewport empty" data-testid="viewport">
          <div>
            <h3>{kindMeta(kind).label}</h3>
            <p className="muted">No visual editor for this problem kind yet. Every field is editable in the Properties panel (generated from the library schema).</p>
          </div>
        </div>
      );
  }
}

function useMidWavelength(): number {
  const spec = useSpec((s) => s.spec);
  return useMemo(() => {
    try {
      const w = wavelengthArray(spec);
      return w.length ? w[Math.floor(w.length / 2)] : 600;
    } catch {
      return 600;
    }
  }, [spec]);
}

function nLabel(m: Json, wl: number): string {
  try {
    const { n, k } = nkAt(m, wl);
    return `n=${n.toFixed(3)}${k > 1e-4 ? `+${k.toFixed(3)}i` : ""}`;
  } catch {
    return "n=?";
  }
}

// --- layer stacks -------------------------------------------------------------------

const LAYER_PRESETS: { name: string; layer: JsonObject }[] = [
  { name: "SiO₂ 100 nm", layer: { thickness_nm: 100, material: { kind: "library", name: "SiO2", dataset: "Malitson" }, coherent: true } },
  { name: "Si₃N₄ (n=2) 80 nm", layer: { thickness_nm: 80, material: { kind: "constant_index", n_real: 2.0, n_imag: 0 }, coherent: true } },
  { name: "TiO₂ 60 nm", layer: { thickness_nm: 60, material: { kind: "library", name: "TiO2", dataset: "Siefke" }, coherent: true } },
  { name: "Ag 40 nm", layer: { thickness_nm: 40, material: { kind: "library", name: "Ag", dataset: "Johnson-Christy" }, coherent: true } },
  { name: "Au 30 nm", layer: { thickness_nm: 30, material: { kind: "library", name: "Au", dataset: "Johnson-Christy" }, coherent: true } },
  { name: "Glass slab 1 mm (incoherent)", layer: { thickness_nm: 1e6, material: { kind: "constant_index", n_real: 1.5, n_imag: 0 }, coherent: false } },
];

/** A vertical stack: superstrate, layers (height ~ thickness), substrate. Click to select. */
function StackDiagram(props: { layers: JsonObject[]; layerMaterial: (l: JsonObject) => Json; patterned?: boolean; testId?: string }) {
  const spec = useSpec((s) => s.spec);
  const selection = useSpec((s) => s.selection);
  const select = useSpec((s) => s.select);
  const wl = useMidWavelength();
  const maxT = Math.max(1, ...props.layers.map((l) => Math.min(Number(l.thickness_nm) || 0, 5000)));
  const sel = selection?.[0] === "layers" && typeof selection[1] === "number" ? selection[1] : null;
  const block = (label: string, m: Json, path: Path, sub: string) => (
    <div className={`stack-half${selection?.[0] === path[0] ? " active" : ""}`} style={{ background: materialColor(m) }} onClick={() => select(path)} data-testid={`stack-${path[0]}`}>
      <b>{label}</b> {materialLabel(m)} <span className="muted small">{nLabel(m, wl)} · {sub}</span>
    </div>
  );
  const total = props.layers.reduce((a, l) => a + (Number(l.thickness_nm) || 0), 0);
  return (
    <div className="stack" data-testid={props.testId ?? "layer-stack"}>
      {block("Superstrate", spec.superstrate, ["superstrate"], "semi-infinite")}
      {props.layers.length === 0 && <div className="stack-empty muted">No layers: a single interface.</div>}
      {props.layers.map((l, i) => {
        const t = Number(l.thickness_nm) || 0;
        const h = 22 + 110 * Math.sqrt(Math.min(t, 5000) / maxT);
        const m = props.layerMaterial(l);
        return (
          <div
            key={i}
            className={`stack-layer${sel === i ? " active" : ""}${l.coherent === false ? " incoherent" : ""}`}
            style={{ height: h, background: materialColor(m) }}
            onClick={() => select(["layers", i])}
            data-testid={`stack-layer-${i}`}
          >
            <span className="stack-idx">{i + 1}</span>
            <span>
              <b>{t >= 1e5 ? `${(t / 1e6).toPrecision(3)} mm` : `${t} nm`}</b> {materialLabel(m)}
              {props.patterned && <span className="badge">{arr(l.shapes).length} shapes</span>}
              {l.coherent === false && <span className="badge">incoherent</span>}
            </span>
            <span className="muted small">{nLabel(m, wl)}</span>
          </div>
        );
      })}
      {block("Substrate", spec.substrate, ["substrate"], "semi-infinite")}
      <div className="muted small">
        total {total.toLocaleString()} nm · n at λ = {wl.toFixed(0)} nm · heights ∝ √thickness
      </div>
    </div>
  );
}

function LayerStackScene() {
  const spec = useSpec((s) => s.spec);
  const apply = useSpec((s) => s.apply);
  const select = useSpec((s) => s.select);
  const selection = useSpec((s) => s.selection);
  const layers = arr(spec.layers);
  const [menu, setMenu] = useState(false);
  const sel = selection?.[0] === "layers" && typeof selection[1] === "number" ? selection[1] : null;
  const insertAt = sel === null ? layers.length : sel + 1;
  return (
    <div className="kind-scene" data-testid="viewport">
      <div className="kind-toolbar">
        <div className="menu-wrap">
          <button className="small" onClick={() => setMenu(!menu)} data-testid="add-layer">
            + Layer {sel !== null ? `after ${sel + 1}` : ""} ▾
          </button>
          {menu && (
            <div className="menu" onMouseLeave={() => setMenu(false)}>
              {LAYER_PRESETS.map((p) => (
                <button
                  key={p.name}
                  onClick={() => {
                    apply({ op: "add", path: ["layers", insertAt], value: clone(p.layer) });
                    select(["layers", insertAt]);
                    setMenu(false);
                  }}
                >
                  {p.name}
                </button>
              ))}
            </div>
          )}
        </div>
        <button className="small" disabled={sel === null || sel === 0} onClick={() => sel !== null && (apply({ op: "move", from: ["layers", sel], path: ["layers", sel - 1] }), select(["layers", sel - 1]))}>
          ↑
        </button>
        <button className="small" disabled={sel === null || sel >= layers.length - 1} onClick={() => sel !== null && (apply({ op: "move", from: ["layers", sel], path: ["layers", sel + 1] }), select(["layers", sel + 1]))}>
          ↓
        </button>
        <button className="small danger" disabled={sel === null} onClick={() => sel !== null && (apply({ op: "remove", path: ["layers", sel] }), select(["layers"]))}>
          Remove
        </button>
        <span className="muted small">
          Light comes from the superstrate · angles {JSON.stringify(spec.angles_deg ?? [0])}° · {JSON.stringify(spec.polarizations ?? ["s", "p"])}
        </span>
      </div>
      <StackDiagram layers={layers} layerMaterial={(l) => l.material} />
    </div>
  );
}

// --- periodic -------------------------------------------------------------------------

function PeriodicScene() {
  const spec = useSpec((s) => s.spec);
  const selection = useSpec((s) => s.selection);
  const layers = arr(spec.layers);
  const li = selection?.[0] === "layers" && typeof selection[1] === "number" ? Math.min(selection[1], layers.length - 1) : 0;
  const layer = layers[li];
  const a1 = pair(spec.lattice_a1_nm, [500, 0]);
  const a2raw = spec.lattice_a2_nm;
  const oneD = !Array.isArray(a2raw);
  const len1 = Math.hypot(...a1) || 1;
  const a2: XY = oneD ? [(-a1[1] / len1) * len1, (a1[0] / len1) * len1] : pair(a2raw);
  const shapes: Shape2D[] = [];
  const shapesOf = layer ? arr(layer.shapes) : [];
  for (const [k, l] of oneD ? [[0, 0]] : [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1], [0, 0]]) {
    const ghost = k !== 0 || l !== 0;
    shapesOf.forEach((s, j) => {
      if (!isObject(s.profile)) return;
      const off: XY = [k * a1[0] + l * a2[0], k * a1[1] + l * a2[1]];
      const base = s.profile as JsonObject;
      shapes.push({
        key: `${k},${l},${j}`,
        select: ["layers", li, "shapes", j],
        profile: ghost ? moveProfile(base, off[0], off[1]) : base,
        material: s.material,
        label: ghost ? undefined : (s.name as string) || `shape ${j + 1}`,
        ghost,
        move: ghost ? undefined : (dx, dy) => ({ ...s, profile: moveProfile(base, dx, dy) }),
      });
    });
  }
  const cell = cellPolygon(a1, a2);
  const overlays: Overlay2D[] = [{ key: "cell", points: cell, closed: true, color: "#38d39f", dash: oneD, label: oneD ? "1D period (invariant ⟂ a₁)" : "unit cell" }];
  return (
    <div className="kind-scene split" data-testid="viewport">
      <div className="split-left">
        <StackDiagram layers={layers} layerMaterial={(l) => l.background} patterned testId="periodic-stack" />
      </div>
      <div className="split-right">
        {layer ? (
          <CrossSection
            shapes={shapes}
            overlays={overlays}
            title={`Layer ${li + 1} unit cell · background ${materialLabel(layer.background)}`}
            empty="This layer has no shapes: add one under layers → shapes."
          />
        ) : (
          <div className="muted pad">Add a patterned layer.</div>
        )}
      </div>
    </div>
  );
}

// --- waveguide modes -------------------------------------------------------------------

function structures2D(list: JsonObject[], prefix: Path): Shape2D[] {
  return list.flatMap((s, i) =>
    isObject(s.profile)
      ? [
          {
            key: `${prefix.join("/")}/${i}`,
            select: [...prefix, i],
            profile: s.profile as JsonObject,
            material: s.material,
            label: (s.name as string) || `${(s.profile as JsonObject).kind} ${i + 1}`,
            move: (dx: number, dy: number) => ({ ...s, profile: moveProfile(s.profile as JsonObject, dx, dy) }),
          },
        ]
      : [],
  );
}

function rectPoints(c: XY, size: XY): XY[] {
  return [
    [c[0] - size[0] / 2, c[1] - size[1] / 2],
    [c[0] + size[0] / 2, c[1] - size[1] / 2],
    [c[0] + size[0] / 2, c[1] + size[1] / 2],
    [c[0] - size[0] / 2, c[1] + size[1] / 2],
  ];
}

function ModeScene() {
  const spec = useSpec((s) => s.spec);
  const wl = useMidWavelength();
  const shapes = structures2D(arr(spec.structures), ["structures"]);
  const overlays: Overlay2D[] = [
    { key: "window", points: rectPoints(pair(spec.window_center_nm), pair(spec.window_size_nm, [1000, 1000])), closed: true, color: "#38d39f", dash: true, label: "simulation window", select: ["window_size_nm"] },
  ];
  return (
    <div className="kind-scene" data-testid="viewport">
      <CrossSection
        shapes={shapes}
        overlays={overlays}
        title={`Waveguide cross-section · background ${materialLabel(spec.background)} (${nLabel(spec.background, wl)}) · propagation +z${spec.bend_radius_nm ? ` · bend R=${spec.bend_radius_nm} nm` : ""}`}
        empty="Add a structure (structures → + Add)."
      />
    </div>
  );
}

// --- photonic bands ----------------------------------------------------------------------

function BandsScene() {
  const spec = useSpec((s) => s.spec);
  const lv = (Array.isArray(spec.lattice_vectors_nm) ? spec.lattice_vectors_nm : []) as number[][];
  const a1: XY = [lv[0]?.[0] ?? 500, lv[0]?.[1] ?? 0];
  const a2: XY = [lv[1]?.[0] ?? 0, lv[1]?.[1] ?? 500];
  const twoD = spec.dimension !== 3;
  const base = twoD
    ? structures2D(arr(spec.structures_2d), ["structures_2d"])
    : arr(spec.structures).flatMap((s, i) => {
        const f = footprint(s.geometry);
        return f ? [{ key: `s${i}`, select: ["structures", i] as Path, profile: f.profile, material: s.material, label: (s.name as string) || `structure ${i + 1}`, move: (dx: number, dy: number) => ({ ...s, geometry: f.move(dx, dy) }) }] : [];
      });
  const shapes: Shape2D[] = [];
  for (const [k, l] of [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]])
    base.forEach((s) => shapes.push({ ...s, key: `${s.key}@${k},${l}`, profile: moveProfile(s.profile, k * a1[0] + l * a2[0], k * a1[1] + l * a2[1]), ghost: true, move: undefined, label: undefined }));
  shapes.push(...base);
  const kp = arr(spec.k_path).map((k) => k.label).join(" → ");
  return (
    <div className="kind-scene" data-testid="viewport">
      <CrossSection
        shapes={shapes}
        overlays={[{ key: "cell", points: cellPolygon(a1, a2), closed: true, color: "#38d39f", label: "unit cell" }]}
        title={`${twoD ? "2D" : "3D (top view)"} crystal · background ${materialLabel(spec.background)} · k-path ${kp || "—"} · ${spec.num_bands ?? 8} bands`}
        empty="Add an inclusion to the unit cell."
      />
    </div>
  );
}

// --- devices and inverse design ------------------------------------------------------------

function DeviceScene({ prefix, designRegions }: { prefix: Path; designRegions?: boolean }) {
  const spec = useSpec((s) => s.spec);
  const dev = (prefix.length ? (spec[prefix[0] as string] as JsonObject) : spec) ?? {};
  const shapes: Shape2D[] = arr(dev.structures).flatMap((s, i) => {
    const f = footprint(s.geometry);
    return f ? [{ key: `s${i}`, select: [...prefix, "structures", i], profile: f.profile, material: s.material, label: (s.name as string) || `structure ${i + 1}`, move: (dx: number, dy: number) => ({ ...s, geometry: f.move(dx, dy) }) }] : [];
  });
  if (designRegions)
    arr(spec.design_regions).forEach((d, i) => {
      const c = (d.center_nm as number[]) ?? [0, 0, 0];
      const sz = (d.size_nm as number[]) ?? [1000, 1000, 0];
      shapes.push({
        key: `d${i}`,
        select: ["design_regions", i],
        profile: { kind: "rectangle", center_nm: [c[0], c[1]], size_nm: [sz[0], sz[1]] },
        material: d.material_high,
        label: `design: ${(d.name as string) || i + 1}`,
        hatch: true,
        move: (dx, dy) => ({ ...d, center_nm: [Math.round((c[0] + dx) * 10) / 10, Math.round((c[1] + dy) * 10) / 10, c[2]] }),
      });
    });
  const overlays: Overlay2D[] = [{ key: "domain", points: rectPoints(pair(dev.domain_center_nm), pair(dev.domain_size_nm, [2000, 2000])), closed: true, color: "#38d39f", dash: true, label: "domain", select: [...prefix, "domain_size_nm"] }];
  arr(dev.ports).forEach((p, i) => {
    const c = (p.center_nm as number[]) ?? [0, 0, 0];
    const s = (p.size_nm as number[]) ?? [0, 1000, 0];
    const normal = s[0] === 0 ? 0 : s[1] === 0 ? 1 : 2;
    const sign = p.direction === "-" ? -1 : 1;
    const line: XY[] = normal === 0 ? [[c[0], c[1] - s[1] / 2], [c[0], c[1] + s[1] / 2]] : [[c[0] - s[0] / 2, c[1]], [c[0] + s[0] / 2, c[1]]];
    const L = Math.max(s[0], s[1]) * 0.25;
    overlays.push({ key: `p${i}`, points: line, color: "#ff8a4c", label: String(p.name ?? `port ${i + 1}`), select: [...prefix, "ports", i] });
    overlays.push({ key: `pa${i}`, points: [[c[0], c[1]], normal === 0 ? [c[0] + sign * L, c[1]] : [c[0], c[1] + sign * L]], color: "#4f9dff", arrow: true, select: [...prefix, "ports", i] });
  });
  const layout = isObject(dev.layout) ? dev.layout : null;
  return (
    <div className="kind-scene" data-testid="viewport">
      <CrossSection
        shapes={shapes}
        overlays={overlays}
        title={`${dev.dimension === 2 ? "2D device" : "3D device (top view)"} · background ${materialLabel(dev.background)}${layout ? ` · + GDS ${layout.path}` : ""}`}
        empty="Add structures, or import a GDS layout (layout)."
      />
    </div>
  );
}

// --- circuits ----------------------------------------------------------------------------------

function CircuitScene() {
  const spec = useSpec((s) => s.spec);
  const selection = useSpec((s) => s.selection);
  const select = useSpec((s) => s.select);
  const instances = isObject(spec.instances) ? spec.instances : {};
  const names = Object.keys(instances);
  const R = 180;
  const pos = new Map(names.map((n, i) => [n, [Math.cos((2 * Math.PI * i) / Math.max(1, names.length) - Math.PI / 2) * R, Math.sin((2 * Math.PI * i) / Math.max(1, names.length) - Math.PI / 2) * R] as XY]));
  const conns = (Array.isArray(spec.connections) ? spec.connections : []) as string[][];
  const ports = isObject(spec.ports) ? (spec.ports as Record<string, string>) : {};
  const inst = (ref: string) => String(ref).split(",")[0];
  return (
    <div className="kind-scene" data-testid="viewport">
      <svg className="netlist" viewBox="-320 -260 640 520" data-testid="netlist">
        {conns.map(([a, b], i) => {
          const p = pos.get(inst(a));
          const q = pos.get(inst(b));
          if (!p || !q) return null;
          return (
            <g key={i} className={`edge${selection?.[0] === "connections" && selection[1] === i ? " active" : ""}`} onClick={() => select(["connections", i])}>
              <line x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} />
              <text x={(p[0] + q[0]) / 2} y={(p[1] + q[1]) / 2 - 4} textAnchor="middle" className="edge-label">
                {String(a).split(",")[1]}–{String(b).split(",")[1]}
              </text>
            </g>
          );
        })}
        {Object.entries(ports).map(([name, ref], _i, all) => {
          const p = pos.get(inst(ref));
          if (!p) return null;
          // fan out several external ports on the same instance
          const siblings = all.filter(([, r]) => inst(r) === inst(ref));
          const k = siblings.findIndex(([n2]) => n2 === name);
          const spread = ((k - (siblings.length - 1) / 2) * Math.PI) / 7;
          const base = Math.atan2(p[1], p[0]) || -Math.PI / 2;
          const q: XY = [p[0] + Math.cos(base + spread) * 75, p[1] + Math.sin(base + spread) * 75];
          return (
            <g key={name} className="ext-port" onClick={() => select(["ports"])}>
              <line x1={p[0]} y1={p[1]} x2={q[0]} y2={q[1]} />
              <circle cx={q[0]} cy={q[1]} r={7} />
              <text x={q[0]} y={q[1] - 11} textAnchor="middle">
                {name}
              </text>
            </g>
          );
        })}
        {names.map((n) => {
          const [x, y] = pos.get(n)!;
          const comp = isObject(instances[n]) ? String((instances[n] as JsonObject).component) : "?";
          const active = selection?.[0] === "instances" && selection[1] === n;
          return (
            <g key={n} className={`node${active ? " active" : ""}`} onClick={() => select(["instances", n])} data-testid={`instance-${n}`}>
              <rect x={x - 52} y={y - 20} width={104} height={40} rx={6} />
              <text x={x} y={y - 3} textAnchor="middle" className="node-name">
                {n}
              </text>
              <text x={x} y={y + 12} textAnchor="middle" className="node-comp">
                {comp}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="cs-toolbar">
        <b>Netlist</b>
        <span className="muted small">
          {names.length} instances · {conns.length} connections · ports {Object.keys(ports).join(", ") || "—"} · click to edit
        </span>
      </div>
    </div>
  );
}
