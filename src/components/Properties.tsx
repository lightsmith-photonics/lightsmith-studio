// Properties panel for the selected tree node. Hand-crafted helpers (presets,
// polarization angle, plane fitting, per-backend options) sit on top of
// schema-generated forms, so every field stays editable.

import { halfExtent, wavelengthArray } from "../api/mock/solver";
import { materialLabel, materialRange } from "../physics/materials";
import { isObject, prettyKey, SchemaDoc, type Json, type JsonObject, type Path } from "../schema/schema";
import { SchemaForm } from "../schema/SchemaForm";
import { useConnection } from "../state/connection";
import { getAt } from "../state/ops";
import { particleExtent, useSpec } from "../state/store";
import { deleteSelection, duplicateSelection } from "../state/actions";
import { PARTICLE_PRESETS } from "../state/templates";
import { shapeLabel } from "./ObjectTree";
import { OVERRIDES, SpecForm, useIssueMap } from "./SpecForm";

export function Properties() {
  const selection = useSpec((s) => s.selection) ?? [];
  const spec = useSpec((s) => s.spec);
  const kind = typeof spec.kind === "string" ? spec.kind : "scattering";
  const head = selection[0];
  let body: React.ReactNode;
  if (kind !== "scattering") body = <SpecForm path={selection} label={selection.length ? prettyKey(String(selection[selection.length - 1])) : undefined} />;
  else if (selection.length === 0) body = <WholeSpec />;
  else if (head === "particles" && typeof selection[1] === "number") body = <ParticleEditor index={selection[1]} />;
  else if (head === "illumination" || head === "medium_index" || head === "orientation_average") body = <EnvironmentEditor />;
  else if (head === "wavelengths") body = <WavelengthsEditor />;
  else if (head === "substrate") body = <SubstrateEditor />;
  else if (head === "outputs") body = <OutputsEditor focus={selection[1] as string | undefined} />;
  else if (head === "options") body = <OptionsEditor />;
  else body = <SpecForm path={selection} label={prettyKey(String(selection[selection.length - 1]))} />;
  return (
    <div className="properties" data-testid="properties">
      {body}
    </div>
  );
}

function Section(props: { title: React.ReactNode; children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <section className="prop-section">
      <h3>
        {props.title}
        <span className="spacer" />
        {props.right}
      </h3>
      {props.children}
    </section>
  );
}

function WholeSpec() {
  const doc = useConnection((s) => s.schema);
  return (
    <Section title="Simulation (all fields)">
      <p className="muted small">Every field of the problem, generated from the library's JSON Schema{doc ? "" : ""}. The tree on the left gives friendlier editors for the common parts.</p>
      <SpecForm path={[]} />
    </Section>
  );
}

// --- particles --------------------------------------------------------------------

function ParticleEditor(props: { index: number }) {
  const spec = useSpec((s) => s.spec);
  const apply = useSpec((s) => s.apply);
  const p = getAt(spec, ["particles", props.index]);
  if (!isObject(p)) return <div className="muted">No particle {props.index + 1}</div>;
  const shape = isObject(p.shape) ? p.shape : {};
  const path: Path = ["particles", props.index];
  const setShapeKind = (id: string) => {
    if (shape.kind === id) return;
    const preset = PARTICLE_PRESETS.find((x) => x.id === id)!.particle;
    // keep the size roughly the same when switching shapes
    const r = particleExtent(p);
    const s0 = preset.shape as JsonObject;
    const s1: JsonObject = { ...s0 };
    if (id === "sphere") s1.radius_nm = r;
    if (id === "spheroid") Object.assign(s1, { semi_axis_xy_nm: r * 0.6, semi_axis_z_nm: r });
    if (id === "cylinder") Object.assign(s1, { radius_nm: r * 0.4, length_nm: 2 * r });
    if (id === "layered_sphere") Object.assign(s1, { core_radius_nm: r * 0.75, shells: [{ thickness_nm: r * 0.25, material: p.material }] });
    apply({ op: "replace", path: [...path, "shape"], value: s1 });
  };
  const vol = volumeOf(shape);
  const h = halfExtent(shape);
  return (
    <>
      <Section
        title={`Particle ${props.index + 1}`}
        right={
          <>
            <button className="small" onClick={duplicateSelection} title="Ctrl+D">
              Duplicate
            </button>
            <button className="small danger" onClick={deleteSelection} title="Del">
              Delete
            </button>
          </>
        }
      >
        <div className="chips" role="radiogroup" aria-label="shape">
          {PARTICLE_PRESETS.map((x) => (
            <button key={x.id} className={shape.kind === x.id ? "chip active" : "chip"} onClick={() => setShapeKind(x.id)} data-testid={`shape-${x.id}`}>
              {x.name}
            </button>
          ))}
        </div>
        <SpecForm path={[...path, "shape"]} />
        <div className="muted small derived">
          {shapeLabel(shape)} · volume {fmtNum(vol)} nm³ · r_eq {fmtNum(Math.cbrt((3 * vol) / (4 * Math.PI)))} nm · box {h.map((x) => fmtNum(2 * x)).join(" × ")} nm
        </div>
      </Section>
      <Section title="Material">
        <SpecForm path={[...path, "material"]} label="Material" />
      </Section>
      <Section
        title="Position (nm)"
        right={
          <button className="small" onClick={() => apply({ op: "replace", path: [...path, "position_nm"], value: [0, 0, 0] })}>
            Centre
          </button>
        }
      >
        <SpecForm path={[...path, "position_nm"]} label="x, y, z" />
      </Section>
      <OtherFields path={path} known={["shape", "material", "position_nm"]} />
    </>
  );
}

/** Fields of the object at `path` that the hand-crafted editor above does not show. */
function OtherFields(props: { path: Path; known: string[] }) {
  const spec = useSpec((s) => s.spec);
  const doc = useConnection((s) => s.schema);
  const node = doc.resolve(doc.nodeAt(doc.problemNode(), spec, props.path) ?? {});
  const extra = Object.keys(node.properties ?? {}).filter((k) => !props.known.includes(k));
  if (!extra.length) return null;
  return (
    <Section title="More fields">
      {extra.map((k) => (
        <SpecForm key={k} path={[...props.path, k]} label={prettyKey(k)} />
      ))}
    </Section>
  );
}

function volumeOf(s: JsonObject): number {
  const [x, y, z] = halfExtent(s);
  if (s.kind === "cylinder") return Math.PI * x * x * 2 * z;
  return (4 / 3) * Math.PI * x * y * z;
}

export function fmtNum(x: number): string {
  if (!Number.isFinite(x)) return "—";
  const a = Math.abs(x);
  if (a !== 0 && (a >= 1e5 || a < 1e-2)) return x.toExponential(2);
  return String(Number(x.toPrecision(4)));
}

// --- environment ------------------------------------------------------------------

const MEDIA = [
  { name: "vacuum / air", n: 1.0 },
  { name: "water", n: 1.333 },
  { name: "ethanol", n: 1.361 },
  { name: "glass", n: 1.5 },
  { name: "immersion oil", n: 1.518 },
];
const DIRS: { label: string; k: number[] }[] = [
  { label: "+z", k: [0, 0, 1] },
  { label: "−z", k: [0, 0, -1] },
  { label: "+x", k: [1, 0, 0] },
  { label: "−x", k: [-1, 0, 0] },
  { label: "+y", k: [0, 1, 0] },
  { label: "−y", k: [0, -1, 0] },
];

/** Orthonormal basis (u, v) perpendicular to k, with u as close to x (or z) as possible. */
function perpBasis(k: number[]): [number[], number[]] {
  const n = Math.hypot(...k) || 1;
  const kh = k.map((x) => x / n);
  const ref = Math.abs(kh[0]) < 0.9 ? [1, 0, 0] : [0, 0, 1];
  const d = ref[0] * kh[0] + ref[1] * kh[1] + ref[2] * kh[2];
  let u = ref.map((x, i) => x - d * kh[i]);
  const un = Math.hypot(...u);
  u = u.map((x) => x / un);
  const v = [kh[1] * u[2] - kh[2] * u[1], kh[2] * u[0] - kh[0] * u[2], kh[0] * u[1] - kh[1] * u[0]];
  return [u, v];
}

const round = (x: number) => (Math.abs(x) < 1e-12 ? 0 : Number(x.toPrecision(12)));

function EnvironmentEditor() {
  const spec = useSpec((s) => s.spec);
  const apply = useSpec((s) => s.apply);
  const ill = isObject(spec.illumination) ? spec.illumination : {};
  const k = (ill.direction as number[]) ?? [0, 0, 1];
  const e = (ill.polarization as number[]) ?? [1, 0, 0];
  const [u, v] = perpBasis(k);
  const psi = (Math.atan2(e[0] * v[0] + e[1] * v[1] + e[2] * v[2], e[0] * u[0] + e[1] * u[1] + e[2] * u[2]) * 180) / Math.PI;
  const setPsi = (deg: number) => {
    const r = (deg * Math.PI) / 180;
    apply({ op: "replace", path: ["illumination", "polarization"], value: u.map((x, i) => round(Math.cos(r) * x + Math.sin(r) * v[i])) }, { coalesceKey: "psi" });
  };
  const setK = (kk: number[]) => {
    const [uu] = perpBasis(kk);
    apply({ op: "replace", path: ["illumination"], value: { ...ill, direction: kk, polarization: uu.map(round) } });
  };
  return (
    <>
      <Section title="Host medium">
        <SpecForm path={["medium_index"]} label="Refractive index" />
        <div className="chips">
          {MEDIA.map((m) => (
            <button key={m.name} className={spec.medium_index === m.n ? "chip active" : "chip"} onClick={() => apply({ op: "replace", path: ["medium_index"], value: m.n })}>
              {m.name} {m.n}
            </button>
          ))}
        </div>
      </Section>
      <Section title="Plane-wave illumination">
        <div className="field-row">
          <label className="field-label">Direction</label>
          <div className="field-input chips">
            {DIRS.map((d) => (
              <button key={d.label} className={d.k.every((x, i) => x === k[i]) ? "chip active" : "chip"} onClick={() => setK(d.k)} data-testid={`dir-${d.label}`}>
                {d.label}
              </button>
            ))}
          </div>
        </div>
        <div className="field-row">
          <label className="field-label" title="Angle of E in the plane perpendicular to k">
            Polarization angle ψ
          </label>
          <div className="field-input">
            <input type="range" min={-180} max={180} step={1} value={Math.round(psi)} onChange={(ev) => setPsi(Number(ev.target.value))} data-testid="psi" />
            <span className="hint">{psi.toFixed(0)}°</span>
            {[0, 45, 90].map((d) => (
              <button key={d} className="link" onClick={() => setPsi(d)}>
                {d}°
              </button>
            ))}
          </div>
        </div>
        <SpecForm path={["illumination"]} />
      </Section>
      <Section title="Orientation">
        <SpecForm path={["orientation_average"]} label="Orientation average" />
      </Section>
    </>
  );
}

// --- wavelengths ----------------------------------------------------------------

const BANDS = [
  { name: "UV–Vis 300–800", r: [300, 800, 101] },
  { name: "Visible 400–800", r: [400, 800, 81] },
  { name: "Vis–NIR 400–1100", r: [400, 1100, 141] },
  { name: "NIR 700–1600", r: [700, 1600, 91] },
];

function allMaterials(spec: JsonObject): { where: string; m: Json }[] {
  const out: { where: string; m: Json }[] = [];
  ((spec.particles as Json[]) ?? []).forEach((p, i) => {
    if (!isObject(p)) return;
    out.push({ where: `particle ${i + 1}`, m: p.material });
    if (isObject(p.shape) && Array.isArray(p.shape.shells)) p.shape.shells.forEach((s, j) => isObject(s) && out.push({ where: `particle ${i + 1} shell ${j + 1}`, m: s.material }));
  });
  if (isObject(spec.substrate)) out.push({ where: "substrate", m: spec.substrate.material });
  return out;
}

function WavelengthsEditor() {
  const spec = useSpec((s) => s.spec);
  const apply = useSpec((s) => s.apply);
  const wl = wavelengthArray(spec);
  const lo = Math.min(...wl);
  const hi = Math.max(...wl);
  const problems = allMaterials(spec)
    .map((x) => ({ ...x, r: materialRange(x.m) }))
    .filter((x) => x.r && wl.length && (lo < x.r[0] || hi > x.r[1]));
  return (
    <Section title="Wavelengths (vacuum, nm)">
      <div className="chips">
        {BANDS.map((b) => (
          <button key={b.name} className="chip" onClick={() => apply({ op: "replace", path: ["wavelengths"], value: { start_nm: b.r[0], stop_nm: b.r[1], num: b.r[2] } })}>
            {b.name}
          </button>
        ))}
      </div>
      <SpecForm path={["wavelengths"]} label="Wavelengths" />
      <div className="muted small derived">
        {wl.length} wavelengths{wl.length > 1 ? ` · ${fmtNum(lo)}–${fmtNum(hi)} nm · step ${fmtNum((hi - lo) / (wl.length - 1))} nm` : ""} · in the medium λ/n = {fmtNum(lo / Number(spec.medium_index ?? 1))}–{fmtNum(hi / Number(spec.medium_index ?? 1))} nm
      </div>
      {problems.map((p) => (
        <div key={p.where} className="warn-box">
          {p.where}: {materialLabel(p.m)} has data for {p.r![0]}–{p.r![1]} nm only.
        </div>
      ))}
    </Section>
  );
}

// --- substrate ----------------------------------------------------------------

function SubstrateEditor() {
  const spec = useSpec((s) => s.spec);
  const apply = useSpec((s) => s.apply);
  const bottom = Math.min(...((spec.particles as JsonObject[]) ?? []).filter(isObject).map((p) => ((p.position_nm as number[]) ?? [0, 0, 0])[2] - halfExtent(p.shape as JsonObject)[2]));
  return (
    <Section
      title="Substrate"
      right={
        isObject(spec.substrate) && Number.isFinite(bottom) ? (
          <button className="small" onClick={() => apply({ op: "replace", path: ["substrate", "interface_z_nm"], value: Number(bottom.toPrecision(10)) })} title="Move the interface to the lowest particle surface">
            Touch particles
          </button>
        ) : undefined
      }
    >
      <p className="muted small">Semi-infinite half-space z &lt; interface. Not every backend supports a substrate; the Run panel says which.</p>
      <SpecForm path={["substrate"]} label="Enable substrate" />
    </Section>
  );
}

// --- outputs ----------------------------------------------------------------------

function OutputsEditor(props: { focus?: string }) {
  const spec = useSpec((s) => s.spec);
  const apply = useSpec((s) => s.apply);
  const out = isObject(spec.outputs) ? spec.outputs : {};
  const nf = isObject(out.near_field) ? out.near_field : null;
  const ff = isObject(out.far_field) ? out.far_field : null;
  const ext = Math.max(
    20,
    ...((spec.particles as JsonObject[]) ?? []).filter(isObject).map((p) => {
      const pos = (p.position_nm as number[]) ?? [0, 0, 0];
      return Math.max(...pos.map(Math.abs)) + particleExtent(p);
    }),
  );
  const wl = wavelengthArray(spec);
  const mid = wl.length ? Number(wl[Math.floor(wl.length / 2)].toPrecision(6)) : 600;
  return (
    <>
      {(!props.focus || props.focus === "cross_sections") && (
        <Section title="Cross sections">
          <SpecForm path={["outputs", "cross_sections"]} label="Cross sections" />
        </Section>
      )}
      {(!props.focus || props.focus === "near_field") && (
        <Section
          title="Near field"
          right={
            nf ? (
              <button className="small" onClick={() => apply({ op: "replace", path: ["outputs", "near_field", "half_width_nm"], value: Math.ceil(ext * 1.5) })}>
                Fit to scene
              </button>
            ) : (
              <button className="small" data-testid="enable-near-field" onClick={() => apply({ op: "replace", path: ["outputs", "near_field"], value: { plane: "xz", offset_nm: 0, half_width_nm: Math.ceil(ext * 1.5), points: 101, wavelengths_nm: [mid] } })}>
                Enable
              </button>
            )
          }
        >
          <p className="muted small">|E|²/|E₀|² on a square plane, drawn in green in the 3D view.</p>
          <SpecForm path={["outputs", "near_field"]} label="Near field" />
        </Section>
      )}
      {(!props.focus || props.focus === "far_field") && (
        <Section
          title="Far field"
          right={
            <>
              <button className="small" onClick={() => apply({ op: "replace", path: ["outputs", "far_field"], value: { theta_deg: range(0, 180, 37), phi_deg: [0, 90], wavelengths_nm: ff?.wavelengths_nm ?? [mid] } })}>
                E/H planes
              </button>
              <button className="small" onClick={() => apply({ op: "replace", path: ["outputs", "far_field"], value: { theta_deg: range(0, 180, 37), phi_deg: range(0, 360, 37), wavelengths_nm: ff?.wavelengths_nm ?? [mid] } })}>
                Full sphere
              </button>
            </>
          }
        >
          <p className="muted small">dC_sca/dΩ on a θ × φ grid. θ from the incident direction; φ = 0 is the E-plane, 90 the H-plane.</p>
          <SpecForm path={["outputs", "far_field"]} label="Far field" />
        </Section>
      )}
      {!props.focus && <OtherFields path={["outputs"]} known={["cross_sections", "near_field", "far_field"]} />}
    </>
  );
}

function range(a: number, b: number, n: number): number[] {
  return Array.from({ length: n }, (_, i) => Number((a + ((b - a) * i) / (n - 1)).toPrecision(10)));
}

// --- solver options ----------------------------------------------------------------

function OptionsEditor() {
  const spec = useSpec((s) => s.spec);
  const apply = useSpec((s) => s.apply);
  const backends = useConnection((s) => s.backends);
  const issues = useIssueMap();
  const kind = typeof spec.kind === "string" ? spec.kind : "scattering";
  const opts = isObject(spec.options) ? spec.options : {};
  const relevant = backends.filter((b) => !b.problem_kinds || b.problem_kinds.includes(kind));
  const methods = [...new Set(relevant.map((b) => b.method))];
  const known = new Set([...methods, ...relevant.map((b) => b.name)]);
  const setKey = (key: string, value: Json | undefined) => {
    if (value === undefined) {
      if (key in opts) apply({ op: "remove", path: ["options", key] });
    } else apply({ op: "replace", path: ["options", key] , value }, { coalesceKey: `options/${key}` });
  };
  return (
    <>
      <Section title="Solver options">
        <p className="muted small">
          <code>options[method]</code> applies to every backend of that method; <code>options[backend]</code> applies to one backend and wins. Forms come from each backend's
          options model when the server publishes it.
        </p>
      </Section>
      {methods.map((m) => {
        const bs = relevant.filter((b) => b.method === m);
        return (
          <Section key={m} title={<>{m.toUpperCase()}</>}>
            {[m, ...bs.map((b) => b.name)].map((key) => {
              const schemaOwner = key === m ? bs.find((b) => b.options_schema) : bs.find((b) => b.name === key);
              const os = schemaOwner?.options_schema;
              const value = isObject(opts[key]) ? (opts[key] as JsonObject) : undefined;
              return (
                <details key={key} className="group" open={!!value} data-testid={`options-${key}`}>
                  <summary>
                    <code>options["{key}"]</code> {key === m ? <span className="muted">(all {m} backends)</span> : <span className="muted">(backend)</span>}
                    {value && (
                      <button className="link" onClick={(e) => (e.preventDefault(), setKey(key, undefined))}>
                        reset
                      </button>
                    )}
                  </summary>
                  {os ? (
                    <SchemaForm
                      doc={new SchemaDoc(os)}
                      node={os}
                      value={value ?? {}}
                      path={["options", key]}
                      issues={issues}
                      overrides={OVERRIDES}
                      onChange={(path, v) => {
                        const rel = path.slice(2);
                        const next = JSON.parse(JSON.stringify(value ?? {}));
                        if (rel.length === 0) return setKey(key, v);
                        let o = next;
                        for (const k of rel.slice(0, -1)) o = o[k] ??= {};
                        if (v === null && os.properties?.[String(rel[0])]?.default === null) delete o[rel[rel.length - 1]];
                        else o[rel[rel.length - 1]] = v;
                        setKey(key, next);
                      }}
                    />
                  ) : (
                    <p className="muted small">This server publishes no options schema for {key}; edit the raw options below.</p>
                  )}
                </details>
              );
            })}
          </Section>
        );
      })}
      <Section title="Raw options (all keys)">
        {Object.keys(opts).some((k) => !known.has(k)) && <div className="warn-box">Keys not matching any backend or method on this server: {Object.keys(opts).filter((k) => !known.has(k)).join(", ")}</div>}
        <SpecForm path={["options"]} label="options" />
      </Section>
    </>
  );
}
