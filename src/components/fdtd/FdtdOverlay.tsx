// FDTD simulation objects in the 3D scene (1 unit = 1 nm, z up).
// From the library's layout (state/layout.ts): TFSF box, flux boxes, CPML, auto-refined regions, mirror planes
// and the Yee node planes on a slice. From the spec: mesh-override boxes (selectable, moved with the gizmo like
// particles), the Gaussian beam's focus, waist and envelope, and the emission dipole.

import { Html, Line, TransformControls } from "@react-three/drei";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import type { FdtdLayout, SymmetryInfo } from "../../api/types";
import { beamGeometry, dipoleGeometry, meshOverrides, selectedOverride, type BeamGeometry, type DipoleGeometry, type MeshOverrideBox } from "../../state/fdtd";
import { nodeWidths } from "../../state/layout";
import type { JsonObject } from "../../schema/schema";
import { useSpec } from "../../state/store";

type Vec3 = [number, number, number];

export const FDTD_COLORS = {
  tfsf: "#ff9f43",
  flux_total: "#4cd7e4",
  flux_scattered: "#f2c94c",
  flux_radiated: "#f2c94c",
  pml: "#8c7bff",
  override: "#e45bd0",
  auto: "#c58be0",
  pec: "#ff5d5d",
  pmc: "#4f9dff",
  beam: "#7fb8ff",
  dipole: "#ffd166",
  mesh: "#9fb3c8",
};

const AXES = ["x", "y", "z"] as const;
export type SliceAxis = (typeof AXES)[number];

/** The 12 edges of a box as line-segment point pairs. */
function boxEdges(lo: number[], hi: number[]): Vec3[] {
  const c = (i: number): Vec3 => [i & 1 ? hi[0] : lo[0], i & 2 ? hi[1] : lo[1], i & 4 ? hi[2] : lo[2]];
  const pairs = [
    [0, 1], [2, 3], [4, 5], [6, 7],
    [0, 2], [1, 3], [4, 6], [5, 7],
    [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  return pairs.flatMap(([a, b]) => [c(a), c(b)]);
}

function WireBox(props: { lo: number[]; hi: number[]; color: string; dashed?: boolean; label?: string; width?: number; testId?: string }) {
  const pts = useMemo(() => boxEdges(props.lo, props.hi), [props.lo, props.hi]);
  const span = Math.max(...props.hi.map((h, i) => h - props.lo[i]));
  return (
    <group userData={{ testId: props.testId }}>
      <Line points={pts} segments color={props.color} lineWidth={props.width ?? 1.4} dashed={props.dashed} dashSize={span / 40} gapSize={span / 60} transparent opacity={0.95} />
      {props.label && (
        <Html position={[props.hi[0], props.lo[1], props.hi[2]]} className="scene-label" style={{ color: props.color }}>
          {props.label}
        </Html>
      )}
    </group>
  );
}

/** The six absorbing slabs between the domain boundary and the CPML's inner faces. */
function PmlShell({ layout }: { layout: FdtdLayout }) {
  const { lo_nm: lo, hi_nm: hi } = layout.domain_nm;
  const ilo = layout.pml.inner_lo_nm;
  const ihi = layout.pml.inner_hi_nm;
  const slabs: { c: Vec3; s: Vec3 }[] = [];
  for (let a = 0; a < 3; a++) {
    for (const [from, to] of [
      [lo[a], ilo[a]],
      [ihi[a], hi[a]],
    ]) {
      const blo = [...lo];
      const bhi = [...hi];
      blo[a] = from;
      bhi[a] = to;
      // trim the other axes to the inner faces so slabs do not overlap at edges and corners (except along x)
      for (let b = 0; b < a; b++) {
        blo[b] = ilo[b];
        bhi[b] = ihi[b];
      }
      slabs.push({ c: [0, 1, 2].map((i) => (blo[i] + bhi[i]) / 2) as Vec3, s: [0, 1, 2].map((i) => Math.max(1e-3, bhi[i] - blo[i])) as Vec3 });
    }
  }
  return (
    <group>
      {slabs.map((b, i) => (
        <mesh key={i} position={b.c} renderOrder={1} raycast={() => null}>
          <boxGeometry args={b.s} />
          <meshBasicMaterial color={FDTD_COLORS.pml} transparent opacity={0.07} depthWrite={false} side={THREE.DoubleSide} />
        </mesh>
      ))}
      <WireBox lo={lo} hi={hi} color={FDTD_COLORS.pml} width={1} />
      <WireBox lo={ilo} hi={ihi} color={FDTD_COLORS.pml} dashed width={1} />
    </group>
  );
}

function MirrorPlanes({ sym, lo, hi }: { sym: SymmetryInfo; lo: number[]; hi: number[] }) {
  const planes = Object.entries(sym.planes_nm ?? {});
  return (
    <group>
      {planes.map(([ax, pos]) => {
        const a = AXES.indexOf(ax as SliceAxis);
        const pec = /antisymmetric|PEC/i.test(sym.mirrors[ax] ?? "");
        const color = pec ? FDTD_COLORS.pec : FDTD_COLORS.pmc;
        const c = [0, 1, 2].map((i) => (i === a ? pos : (lo[i] + hi[i]) / 2)) as Vec3;
        const size = [0, 1, 2].map((i) => (i === a ? 0 : hi[i] - lo[i]));
        // a plane in local xy: rotated about y (x normal) its local x runs along world z
        const inPlane = size.filter((_, i) => i !== a);
        const [w, h] = a === 0 ? [inPlane[1], inPlane[0]] : inPlane;
        const rot: Vec3 = a === 0 ? [0, Math.PI / 2, 0] : a === 1 ? [Math.PI / 2, 0, 0] : [0, 0, 0];
        return (
          <group key={ax} position={c} rotation={rot} userData={{ testId: `mirror-${ax}` }}>
            <mesh renderOrder={2} raycast={() => null}>
              <planeGeometry args={[w, h]} />
              <meshBasicMaterial color={color} transparent opacity={0.13} side={THREE.DoubleSide} depthWrite={false} />
            </mesh>
            <lineSegments>
              <edgesGeometry args={[new THREE.PlaneGeometry(w, h)]} />
              <lineBasicMaterial color={color} />
            </lineSegments>
            <Html position={[-w / 2, h / 2, 0]} className="scene-label" style={{ color }}>
              {ax} mirror · {pec ? "PEC (odd)" : "PMC (even)"}
            </Html>
          </group>
        );
      })}
    </group>
  );
}

/** A mesh-override box from the spec: click to select it, drag its centre with the gizmo. */
function OverrideBox(props: { box: MeshOverrideBox; selected: boolean; gizmo: boolean; snap: number | null; orbiting: (v: boolean) => void }) {
  const ref = useRef<THREE.Group>(null!);
  const [obj, setObj] = useState<THREE.Group | null>(null);
  const apply = useSpec((s) => s.apply);
  const select = useSpec((s) => s.select);
  const { box } = props;
  useEffect(() => setObj(ref.current), []);
  const half = box.size.map((s) => s / 2);
  const s = box.spacing;
  return (
    <>
      <group
        ref={ref}
        position={box.center}
        onClick={(e) => {
          e.stopPropagation();
          select(box.path);
        }}
        userData={{ override: box.index }}
      >
        <mesh renderOrder={3}>
          <boxGeometry args={box.size} />
          <meshBasicMaterial color={FDTD_COLORS.override} transparent opacity={props.selected ? 0.2 : 0.1} depthWrite={false} />
        </mesh>
        <WireBox lo={half.map((h) => -h)} hi={half} color={FDTD_COLORS.override} width={props.selected ? 2.4 : 1.5} />
        <Html position={[half[0], -half[1], half[2]]} className="scene-label" style={{ color: FDTD_COLORS.override }}>
          override {box.index + 1} · {s.every((v) => v === s[0]) ? `${s[0]} nm` : s.join("/") + " nm"}
        </Html>
      </group>
      {props.selected && props.gizmo && obj && (
        <TransformControls
          object={obj}
          mode="translate"
          size={0.8}
          translationSnap={props.snap}
          onMouseDown={() => props.orbiting(false)}
          onMouseUp={() => props.orbiting(true)}
          onObjectChange={() => {
            const o = obj.position;
            const r = (x: number) => Math.round(x * 10) / 10;
            const next = [r(o.x), r(o.y), r(o.z)];
            if (next.some((v, i) => v !== box.center[i])) apply({ op: "replace", path: [...box.path, "center_nm"], value: next }, { coalesceKey: `drag:${box.path.join("/")}` });
          }}
        />
      )}
    </>
  );
}

/** Orthonormal vectors perpendicular to `d`, the first along `pref` projected (the polarisation). */
function perp(d: Vec3, pref: Vec3): [Vec3, Vec3] {
  const dot = pref[0] * d[0] + pref[1] * d[1] + pref[2] * d[2];
  let u = pref.map((x, i) => x - dot * d[i]) as Vec3;
  let n = Math.hypot(...u);
  if (n < 1e-9) {
    const ref: Vec3 = Math.abs(d[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1];
    const t = ref[0] * d[0] + ref[1] * d[1] + ref[2] * d[2];
    u = ref.map((x, i) => x - t * d[i]) as Vec3;
    n = Math.hypot(...u);
  }
  u = u.map((x) => x / n) as Vec3;
  const v: Vec3 = [d[1] * u[2] - d[2] * u[1], d[2] * u[0] - d[0] * u[2], d[0] * u[1] - d[1] * u[0]];
  return [u, v];
}

/** Focus marker, waist ring and the paraxial 1/e² envelope w(z) = w0 √(1 + (z/z_R)²), in the E and H planes. */
function GaussianBeamGlyph({ beam, reach }: { beam: BeamGeometry; reach: number }) {
  const { focus: f, dir: d, waist: w0, rayleigh: zr } = beam;
  const [u, v] = perp(d, beam.pol);
  const L = Math.max(reach, 1.2 * w0);
  const at = (z: number, side: Vec3, sign: number): Vec3 => {
    const w = w0 * Math.sqrt(1 + (z / zr) ** 2);
    return [0, 1, 2].map((i) => f[i] + z * d[i] + sign * w * side[i]) as Vec3;
  };
  const N = 48;
  const zs = Array.from({ length: N + 1 }, (_, i) => -L + (2 * L * i) / N);
  const curves = [u, v].flatMap((side) => [1, -1].map((sg) => zs.map((z) => at(z, side, sg))));
  const ring = Array.from({ length: 65 }, (_, i) => {
    const t = (i / 64) * 2 * Math.PI;
    return [0, 1, 2].map((k) => f[k] + w0 * (Math.cos(t) * u[k] + Math.sin(t) * v[k])) as Vec3;
  });
  const axis: Vec3[] = [at(-L, u, 0), at(L, u, 0)];
  const m = Math.min(w0, reach) * 0.08;
  return (
    <group userData={{ testId: "beam" }}>
      {curves.map((pts, i) => (
        <Line key={i} points={pts} color={FDTD_COLORS.beam} lineWidth={i < 2 ? 1.6 : 1} transparent opacity={i < 2 ? 0.9 : 0.5} />
      ))}
      <Line points={axis} color={FDTD_COLORS.beam} lineWidth={1} dashed dashSize={L / 30} gapSize={L / 40} />
      <Line points={ring} color={FDTD_COLORS.beam} lineWidth={2} />
      <Line points={[[f[0] - m, f[1], f[2]], [f[0] + m, f[1], f[2]], [f[0], f[1] - m, f[2]], [f[0], f[1] + m, f[2]], [f[0], f[1], f[2] - m], [f[0], f[1], f[2] + m]]} segments color="#ffffff" lineWidth={2} />
      <Html position={ring[8]} className="scene-label" style={{ color: FDTD_COLORS.beam }}>
        focus · w₀ {w0} nm @ {Number(beam.wavelength.toPrecision(4))} nm · z_R {Number(zr.toPrecision(3))} nm
      </Html>
    </group>
  );
}

/** The emission dipole: a double-headed moment arrow through its position. */
function DipoleGlyph(props: { dip: DipoleGeometry; size: number; selected: boolean; gizmo: boolean; snap: number | null; orbiting: (v: boolean) => void }) {
  const ref = useRef<THREE.Group>(null!);
  const [obj, setObj] = useState<THREE.Group | null>(null);
  const apply = useSpec((s) => s.apply);
  const select = useSpec((s) => s.select);
  useEffect(() => setObj(ref.current), []);
  const { position: p, orientation: o } = props.dip;
  const q = useMemo(() => new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...o)), [o]);
  const L = props.size;
  const head = L * 0.28;
  return (
    <>
      <group
        ref={ref}
        position={p}
        onClick={(e) => {
          e.stopPropagation();
          select(["dipole"]);
        }}
        userData={{ testId: "dipole" }}
      >
        <group quaternion={q}>
          <mesh>
            <cylinderGeometry args={[L * 0.05, L * 0.05, L * 1.4, 16]} />
            <meshStandardMaterial color={FDTD_COLORS.dipole} emissive={props.selected ? "#ffd166" : "#000"} emissiveIntensity={props.selected ? 0.5 : 0} />
          </mesh>
          <mesh position={[0, L * 0.7 + head / 2, 0]}>
            <coneGeometry args={[L * 0.14, head, 24]} />
            <meshStandardMaterial color={FDTD_COLORS.dipole} />
          </mesh>
          <mesh>
            <sphereGeometry args={[L * 0.12, 24, 16]} />
            <meshStandardMaterial color="#ffffff" />
          </mesh>
        </group>
        <Html position={[L * 0.3, 0, L * 0.3]} className="scene-label" style={{ color: FDTD_COLORS.dipole }}>
          p ({o.map((v) => v.toFixed(2)).join(", ")})
        </Html>
      </group>
      {props.selected && props.gizmo && obj && (
        <TransformControls
          object={obj}
          mode="translate"
          size={0.8}
          translationSnap={props.snap}
          onMouseDown={() => props.orbiting(false)}
          onMouseUp={() => props.orbiting(true)}
          onObjectChange={() => {
            const v = obj.position;
            const r = (x: number) => Math.round(x * 10) / 10;
            const next = [r(v.x), r(v.y), r(v.z)];
            if (next.some((x, i) => x !== p[i])) apply({ op: "replace", path: ["dipole", "position_nm"], value: next }, { coalesceKey: "drag:dipole" });
          }}
        />
      )}
    </>
  );
}

/**
 * The library's Yee node planes crossing a slice: lines at every node plane of the two in-plane axes, coloured
 * from fine (bright) to coarse cells. On a mirror-symmetric run the solver steps one image of this grid.
 */
function MeshSlice({ layout, axis, offset }: { layout: FdtdLayout; axis: SliceAxis; offset: number }) {
  const a = AXES.indexOf(axis);
  const [b, c] = [0, 1, 2].filter((i) => i !== a);
  const geom = useMemo(() => {
    const nodes = layout.grid.nodes_nm;
    const lo = layout.domain_nm.lo_nm;
    const hi = layout.domain_nm.hi_nm;
    const all = [...nodeWidths(nodes[b]), ...nodeWidths(nodes[c])];
    const wmin = Math.min(...all);
    const wmax = Math.max(...all);
    const fine = new THREE.Color("#ffffff");
    const coarse = new THREE.Color(FDTD_COLORS.mesh).multiplyScalar(0.55);
    const pos: number[] = [];
    const col: number[] = [];
    const push = (along: number, other: number, x: number, w: number) => {
      const t = wmax > wmin ? (Math.log(w) - Math.log(wmin)) / (Math.log(wmax) - Math.log(wmin)) : 1;
      const k = coarse.clone().lerp(fine, 1 - t);
      for (const y of [lo[other], hi[other]]) {
        const p = [0, 0, 0];
        p[a] = offset;
        p[along] = x;
        p[other] = y;
        pos.push(...p);
        col.push(k.r, k.g, k.b);
      }
    };
    const wb = nodeWidths(nodes[b]);
    const wc = nodeWidths(nodes[c]);
    nodes[b].forEach((x, i) => push(b, c, x, wb[i]));
    nodes[c].forEach((x, i) => push(c, b, x, wc[i]));
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.Float32BufferAttribute(col, 3));
    return g;
  }, [layout, a, b, c, offset]);
  useEffect(() => () => geom.dispose(), [geom]);
  const lo = layout.domain_nm.lo_nm;
  const hi = layout.domain_nm.hi_nm;
  const centre = [0, 1, 2].map((i) => (i === a ? offset : (lo[i] + hi[i]) / 2)) as Vec3;
  const rot: Vec3 = a === 0 ? [0, Math.PI / 2, 0] : a === 1 ? [Math.PI / 2, 0, 0] : [0, 0, 0];
  const w = hi[b] - lo[b];
  const h = hi[c] - lo[c];
  return (
    <group userData={{ testId: "mesh-slice" }}>
      <mesh position={centre} rotation={rot} renderOrder={0} raycast={() => null}>
        <planeGeometry args={a === 0 ? [h, w] : [w, h]} />
        <meshBasicMaterial color="#0b0d10" transparent opacity={0.55} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <lineSegments geometry={geom} renderOrder={5}>
        <lineBasicMaterial vertexColors transparent opacity={0.9} depthTest={false} />
      </lineSegments>
    </group>
  );
}

export interface FdtdOverlayProps {
  spec: JsonObject;
  layout: FdtdLayout | null;
  /** Mirror planes when only the estimate is available (no layout). */
  symmetry: SymmetryInfo | null;
  stale: boolean;
  showLayout: boolean;
  slice: SliceAxis | null;
  sliceOffset: number;
  sceneRadius: number;
  sceneCenter: Vec3;
  gizmo: boolean;
  snap: number | null;
  orbiting: (v: boolean) => void;
}

export function FdtdOverlay(p: FdtdOverlayProps) {
  const selection = useSpec((s) => s.selection);
  const overrides = useMemo(() => meshOverrides(p.spec), [p.spec]);
  const beam = useMemo(() => beamGeometry(p.spec), [p.spec]);
  const dip = useMemo(() => dipoleGeometry(p.spec), [p.spec]);
  const selOverride = selectedOverride(selection);
  const L = p.layout;
  const boxes = p.showLayout && L ? L.boxes : [];
  const sym = L?.symmetry ?? p.symmetry;
  // mirror planes span the CPML's inner box, or the scene when only the estimate's planes are known
  const R = p.sceneRadius * 2;
  const planeLo = L ? L.pml.inner_lo_nm : p.sceneCenter.map((x) => x - R);
  const planeHi = L ? L.pml.inner_hi_nm : p.sceneCenter.map((x) => x + R);
  const reach = L ? Math.max(...L.domain_nm.hi_nm.map((h, i) => (h - L.domain_nm.lo_nm[i]) / 2)) : p.sceneRadius * 3;
  return (
    <group>
      {p.showLayout && L && (
        <group visible={true}>
          <PmlShell layout={L} />
          {boxes.map((b) => (
            <WireBox key={b.name} lo={b.lo_nm} hi={b.hi_nm} color={FDTD_COLORS[b.name as keyof typeof FDTD_COLORS] ?? "#ccc"} dashed={b.name !== "tfsf"} width={b.name === "tfsf" ? 2 : 1.3} label={b.name === "tfsf" ? "TFSF" : undefined} testId={`box-${b.name}`} />
          ))}
          {L.regions
            .filter((r) => r.source === "auto")
            .map((r, i) => (
              <WireBox key={`auto-${i}`} lo={r.lo_nm} hi={r.hi_nm} color={FDTD_COLORS.auto} dashed width={1} label={`auto ${Number(Math.min(...r.spacing_nm).toPrecision(3))} nm`} />
            ))}
        </group>
      )}
      {p.showLayout && sym && <MirrorPlanes sym={sym} lo={planeLo} hi={planeHi} />}
      {p.slice && L && <MeshSlice layout={L} axis={p.slice} offset={p.sliceOffset} />}
      {overrides.map((b) => (
        <OverrideBox key={b.index} box={b} selected={selOverride === b.index} gizmo={p.gizmo} snap={p.snap} orbiting={p.orbiting} />
      ))}
      {beam && <GaussianBeamGlyph beam={beam} reach={reach} />}
      {dip && <DipoleGlyph dip={dip} size={Math.max(4, p.sceneRadius * 0.35)} selected={!!selection && selection[0] === "dipole"} gizmo={p.gizmo} snap={p.snap} orbiting={p.orbiting} />}
    </group>
  );
}
