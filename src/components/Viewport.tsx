// 3D scene: particles drawn to scale (1 unit = 1 nm, z up), a translate gizmo
// on the selected particle, the substrate half-space, incidence (k) and
// polarization (E) arrows, and the requested near-field plane.

import { Html, OrbitControls, TransformControls } from "@react-three/drei";
import { Canvas, useThree } from "@react-three/fiber";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { halfExtent } from "../api/mock/solver";
import { materialColor } from "../physics/materials";
import { isObject, type Json, type JsonObject } from "../schema/schema";
import { selectedParticle, useSpec } from "../state/store";

THREE.Object3D.DEFAULT_UP.set(0, 0, 1);

type Vec3 = [number, number, number];

function unit(v: number[]): Vec3 {
  const n = Math.hypot(...v) || 1;
  return [v[0] / n, v[1] / n, v[2] / n];
}

const METALS = new Set(["Au", "Ag", "Al", "Cu"]);

function matProps(m: Json, selected: boolean, opacity = 1) {
  const metal = (isObject(m) && m.kind === "library" && METALS.has(String(m.name))) || (isObject(m) && (m.kind === "drude" || m.kind === "drude_lorentz"));
  return {
    color: materialColor(m),
    metalness: metal ? 0.75 : 0.05,
    roughness: metal ? 0.3 : 0.55,
    emissive: selected ? new THREE.Color("#3a6df0") : new THREE.Color("#000000"),
    emissiveIntensity: selected ? 0.16 : 0,
    transparent: opacity < 1,
    opacity,
    depthWrite: opacity >= 1,
  };
}

function ShapeMesh(props: { shape: JsonObject; material: Json; selected: boolean }) {
  const s = props.shape;
  const n = (k: string) => Number(s[k]) || 1;
  switch (s.kind) {
    case "sphere":
      return (
        <mesh castShadow>
          <sphereGeometry args={[n("radius_nm"), 64, 40]} />
          <meshStandardMaterial {...matProps(props.material, props.selected)} />
        </mesh>
      );
    case "spheroid":
      return (
        <mesh scale={[n("semi_axis_xy_nm"), n("semi_axis_xy_nm"), n("semi_axis_z_nm")]}>
          <sphereGeometry args={[1, 64, 40]} />
          <meshStandardMaterial {...matProps(props.material, props.selected)} />
        </mesh>
      );
    case "cylinder":
      return (
        <mesh rotation={[Math.PI / 2, 0, 0]}>
          <cylinderGeometry args={[n("radius_nm"), n("radius_nm"), n("length_nm"), 64]} />
          <meshStandardMaterial {...matProps(props.material, props.selected)} />
        </mesh>
      );
    case "layered_sphere": {
      const shells = ((s.shells as JsonObject[]) ?? []).filter(isObject);
      const radii = [n("core_radius_nm")];
      for (const sh of shells) radii.push(radii[radii.length - 1] + (Number(sh.thickness_nm) || 0));
      const mats = [props.material, ...shells.map((sh) => sh.material)];
      return (
        <group>
          {radii.map((r, i) => (
            <mesh key={i} renderOrder={radii.length - i}>
              <sphereGeometry args={[r, 64, 40]} />
              <meshStandardMaterial {...matProps(mats[i], props.selected, i === 0 ? 1 : 0.32)} side={i === 0 ? THREE.FrontSide : THREE.DoubleSide} />
            </mesh>
          ))}
        </group>
      );
    }
    default:
      return (
        <mesh>
          <boxGeometry args={[20, 20, 20]} />
          <meshStandardMaterial color="#888" wireframe />
        </mesh>
      );
  }
}

function Arrow(props: { from: Vec3; dir: Vec3; length: number; color: string; label: string; width: number }) {
  const q = useMemo(() => new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...props.dir)), [props.dir]);
  const head = props.length * 0.22;
  const shaft = props.length - head;
  return (
    <group position={props.from} quaternion={q}>
      <mesh position={[0, shaft / 2, 0]}>
        <cylinderGeometry args={[props.width, props.width, shaft, 16]} />
        <meshBasicMaterial color={props.color} />
      </mesh>
      <mesh position={[0, shaft + head / 2, 0]}>
        <coneGeometry args={[props.width * 2.6, head, 24]} />
        <meshBasicMaterial color={props.color} />
      </mesh>
      <Html position={[0, props.length * 1.08, 0]} center className="scene-label" style={{ color: props.color }}>
        {props.label}
      </Html>
    </group>
  );
}

function sceneBounds(particles: JsonObject[]): { center: Vec3; radius: number } {
  if (!particles.length) return { center: [0, 0, 0], radius: 50 };
  const lo = [Infinity, Infinity, Infinity];
  const hi = [-Infinity, -Infinity, -Infinity];
  for (const p of particles) {
    const pos = (p.position_nm as number[]) ?? [0, 0, 0];
    const h = isObject(p.shape) ? halfExtent(p.shape) : [20, 20, 20];
    for (let i = 0; i < 3; i++) {
      lo[i] = Math.min(lo[i], pos[i] - h[i]);
      hi[i] = Math.max(hi[i], pos[i] + h[i]);
    }
  }
  const center = [0, 1, 2].map((i) => (lo[i] + hi[i]) / 2) as Vec3;
  const radius = Math.max(10, Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2);
  return { center, radius };
}

function CameraRig(props: { center: Vec3; radius: number; fitToken: number }) {
  const { camera, controls } = useThree();
  useEffect(() => {
    const d = props.radius * 6.5;
    camera.up.set(0, 0, 1);
    camera.position.set(props.center[0] + d * 0.62, props.center[1] - d * 0.72, props.center[2] + d * 0.42);
    (camera as THREE.PerspectiveCamera).near = props.radius / 200;
    (camera as THREE.PerspectiveCamera).far = props.radius * 200;
    camera.updateProjectionMatrix();
    const c = controls as unknown as { target?: THREE.Vector3; update?: () => void } | null;
    c?.target?.set(...props.center);
    c?.update?.();
    camera.lookAt(...props.center);
  }, [props.fitToken, controls]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

function Particle(props: { p: JsonObject; index: number; selected: boolean; gizmo: boolean; snap: number | null; orbiting: (v: boolean) => void }) {
  const ref = useRef<THREE.Group>(null!);
  const [obj, setObj] = useState<THREE.Group | null>(null);
  const apply = useSpec((s) => s.apply);
  const select = useSpec((s) => s.select);
  const pos = ((props.p.position_nm as number[]) ?? [0, 0, 0]) as Vec3;
  useEffect(() => setObj(ref.current), []);
  return (
    <>
      <group
        ref={ref}
        position={pos}
        onClick={(e) => {
          e.stopPropagation();
          select(["particles", props.index]);
        }}
        userData={{ particle: props.index }}
      >
        {isObject(props.p.shape) && <ShapeMesh shape={props.p.shape} material={props.p.material} selected={props.selected} />}
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
            if (next.some((v, i) => v !== pos[i])) apply({ op: "replace", path: ["particles", props.index, "position_nm"], value: next }, { coalesceKey: `drag:${props.index}` });
          }}
        />
      )}
    </>
  );
}

function NearFieldPlane(props: { req: JsonObject; center: Vec3 }) {
  const hw = Number(props.req.half_width_nm) || 50;
  const off = Number(props.req.offset_nm) || 0;
  const plane = String(props.req.plane ?? "xz");
  const rot: Vec3 = plane === "xy" ? [0, 0, 0] : plane === "xz" ? [Math.PI / 2, 0, 0] : [0, Math.PI / 2, 0];
  const pos: Vec3 = plane === "xy" ? [0, 0, off] : plane === "xz" ? [0, off, 0] : [off, 0, 0];
  return (
    <group position={pos} rotation={rot}>
      <mesh renderOrder={10}>
        <planeGeometry args={[2 * hw, 2 * hw]} />
        <meshBasicMaterial color="#38d39f" transparent opacity={0.1} side={THREE.DoubleSide} depthWrite={false} />
      </mesh>
      <lineSegments>
        <edgesGeometry args={[new THREE.PlaneGeometry(2 * hw, 2 * hw)]} />
        <lineBasicMaterial color="#38d39f" />
      </lineSegments>
      <Html position={[hw, hw, 0]} className="scene-label" style={{ color: "#38d39f" }}>
        near field {plane}
      </Html>
    </group>
  );
}

export function Viewport() {
  const spec = useSpec((s) => s.spec);
  const selection = useSpec((s) => s.selection);
  const select = useSpec((s) => s.select);
  const [fit, setFit] = useState(0);
  const [gizmo, setGizmo] = useState(true);
  const [snap, setSnap] = useState<number | null>(1);
  const [orbit, setOrbit] = useState(true);
  const particles = useMemo(() => ((spec.particles as Json[]) ?? []).filter(isObject) as JsonObject[], [spec.particles]);
  const { center, radius } = useMemo(() => sceneBounds(particles), [particles]);
  const sel = selectedParticle(selection);
  const ill = isObject(spec.illumination) ? spec.illumination : {};
  const k = unit((ill.direction as number[]) ?? [0, 0, 1]);
  const e = unit((ill.polarization as number[]) ?? [1, 0, 0]);
  const R = radius;
  const kFrom: Vec3 = [center[0] - k[0] * R * 2.6, center[1] - k[1] * R * 2.6, center[2] - k[2] * R * 2.6];
  const sub = isObject(spec.substrate) ? spec.substrate : null;
  const out = isObject(spec.outputs) ? spec.outputs : {};
  const nf = isObject(out.near_field) ? out.near_field : null;
  const subZ = sub ? Number(sub.interface_z_nm) || 0 : 0;
  // refit when the number of particles changes (templates, paste)
  useEffect(() => setFit((f) => f + 1), [particles.length]);

  if (typeof spec.kind === "string" && spec.kind !== "scattering") {
    return (
      <div className="viewport empty" data-testid="viewport">
        <div>
          <h3>{spec.kind} problem</h3>
          <p className="muted">The 3D scene builder covers scattering problems. Every field of this problem kind is editable in the Properties panel (generated from the library schema).</p>
        </div>
      </div>
    );
  }

  return (
    <div className="viewport" data-testid="viewport">
      <Canvas camera={{ fov: 40, up: [0, 0, 1], position: [R * 2, -R * 2.4, R * 1.4] }} onPointerMissed={() => select([])} gl={{ preserveDrawingBuffer: true, antialias: true }}>
        <color attach="background" args={["#14171c"]} />
        <hemisphereLight args={["#dfe8ff", "#2a2a30", 0.9]} />
        <directionalLight position={[R * 3, -R * 2, R * 4]} intensity={1.6} />
        <directionalLight position={[-R * 3, R * 2, -R]} intensity={0.4} />
        <OrbitControls makeDefault enabled={orbit} />
        <CameraRig center={center} radius={radius} fitToken={fit} />
        <gridHelper args={[R * 8, 16, "#3a3f4a", "#262a32"]} rotation={[Math.PI / 2, 0, 0]} position={[center[0], center[1], sub ? subZ - 0.01 : center[2] - R]} />
        <axesHelper args={[R * 0.5]} position={[center[0] - R * 1.6, center[1] - R * 1.6, sub ? subZ : center[2] - R]} />
        {particles.map((p, i) => (
          <Particle key={i} p={p} index={i} selected={sel === i} gizmo={gizmo} snap={snap} orbiting={setOrbit} />
        ))}
        {sub && (
          <mesh position={[center[0], center[1], subZ - R * 0.3]} onClick={(ev) => (ev.stopPropagation(), select(["substrate"]))}>
            <boxGeometry args={[R * 7, R * 7, R * 0.6]} />
            <meshStandardMaterial color={materialColor(sub.material)} transparent opacity={0.35} depthWrite={false} />
          </mesh>
        )}
        <Arrow from={kFrom} dir={k} length={R * 1.5} color="#4f9dff" label="k" width={R * 0.025} />
        <Arrow from={kFrom} dir={e} length={R * 0.8} color="#ff5d5d" label="E" width={R * 0.02} />
        {nf && <NearFieldPlane req={nf} center={center} />}
      </Canvas>
      <div className="viewport-toolbar">
        <button className="small" onClick={() => setFit((f) => f + 1)} title="Fit view">
          ⤢ Fit
        </button>
        <label className="small">
          <input type="checkbox" checked={gizmo} onChange={(ev) => setGizmo(ev.target.checked)} /> Move gizmo
        </label>
        <label className="small">
          snap{" "}
          <select value={snap ?? 0} onChange={(ev) => setSnap(Number(ev.target.value) || null)}>
            <option value={0}>off</option>
            <option value={0.5}>0.5 nm</option>
            <option value={1}>1 nm</option>
            <option value={5}>5 nm</option>
            <option value={10}>10 nm</option>
          </select>
        </label>
      </div>
      <div className="viewport-legend">
        <span style={{ color: "#4f9dff" }}>■</span> k ({k.map((v) => v.toFixed(2)).join(", ")}) <span style={{ color: "#ff5d5d" }}>■</span> E ({e.map((v) => v.toFixed(2)).join(", ")}) · medium n = {String(spec.medium_index ?? 1)} · extent ≈ {(2 * radius).toFixed(0)} nm · grid cell {((R * 8) / 16).toFixed(1)} nm
      </div>
    </div>
  );
}
