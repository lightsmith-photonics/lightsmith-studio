// Object tree: every node is a path into the spec. Scattering problems get a
// curated tree; any top-level field the curated tree does not know about (new
// library features, other problem kinds) still gets its own node.

import { useState } from "react";
import { isObject, prettyKey, type Json, type JsonObject, type Path } from "../schema/schema";
import { materialColor, materialLabel } from "../physics/materials";
import { useConnection } from "../state/connection";
import { useSpec } from "../state/store";
import { addParticle, deleteSelection, duplicateSelection } from "../state/actions";
import { PARTICLE_PRESETS } from "../state/templates";
import { kindMeta } from "../state/kinds";
import { addMeshOverride, meshOverrides } from "../state/fdtd";
import { useIssues } from "./SpecForm";

const CURATED = new Set(["kind", "schema_version", "particles", "medium_index", "illumination", "wavelengths", "substrate", "orientation_average", "outputs", "options"]);

function same(a: Path | null, b: Path) {
  return !!a && a.length === b.length && a.every((x, i) => x === b[i]);
}

function Node(props: { path: Path; label: React.ReactNode; depth?: number; off?: boolean; testId?: string; actions?: React.ReactNode; errors?: number }) {
  const selection = useSpec((s) => s.selection);
  const select = useSpec((s) => s.select);
  const active = same(selection, props.path);
  return (
    <div
      className={`tree-node${active ? " active" : ""}${props.off ? " off" : ""}`}
      style={{ paddingLeft: 8 + (props.depth ?? 0) * 14 }}
      onClick={() => select(props.path)}
      data-testid={props.testId ?? `tree-${props.path.join("/") || "root"}`}
      role="treeitem"
      aria-selected={active}
    >
      <span className="tree-label">{props.label}</span>
      {!!props.errors && <span className="badge error" title="validation problems">{props.errors}</span>}
      {props.actions && <span className="tree-actions" onClick={(e) => e.stopPropagation()}>{props.actions}</span>}
    </div>
  );
}

export function shapeLabel(shape: Json): string {
  if (!isObject(shape)) return "?";
  switch (shape.kind) {
    case "sphere":
      return `Sphere r=${shape.radius_nm}`;
    case "spheroid":
      return `Spheroid ${shape.semi_axis_xy_nm}/${shape.semi_axis_z_nm}`;
    case "cylinder":
      return `Cylinder r=${shape.radius_nm} L=${shape.length_nm}`;
    case "layered_sphere":
      return `Layered r₀=${shape.core_radius_nm} +${Array.isArray(shape.shells) ? shape.shells.length : 0}`;
    default:
      return String(shape.kind);
  }
}

export function ObjectTree() {
  const spec = useSpec((s) => s.spec);
  const doc = useConnection((s) => s.schema);
  const issues = useIssues();
  const [menu, setMenu] = useState(false);
  const errs = (prefix: Path) => issues.filter((i) => prefix.every((p, j) => i.path[j] === p)).length;
  const kind = typeof spec.kind === "string" ? spec.kind : "scattering";
  const node = doc.resolve(doc.nodeAt(doc.problemNode(), spec, []) ?? {});
  const variantNode = node.oneOf || node.anyOf ? doc.resolve(doc.problemKinds().find((k) => k.kind === kind)?.node ?? {}) : node;
  const topProps = Object.keys(variantNode.properties ?? {});

  if (kind !== "scattering") {
    const meta = kindMeta(kind, variantNode.title);
    return (
      <div className="tree" role="tree" data-testid="object-tree">
        <Node path={[]} label={<b>{meta.icon} {meta.label}</b>} errors={issues.length} />
        {topProps
          .filter((k) => k !== "kind")
          .map((k) => (
            <TopNode key={k} k={k} value={spec[k]} errs={errs} />
          ))}
      </div>
    );
  }

  const particles = ((spec.particles as Json[]) ?? []).filter(isObject) as JsonObject[];
  const outputs = isObject(spec.outputs) ? spec.outputs : {};
  const overrides = meshOverrides(spec);
  const ill = isObject(spec.illumination) ? spec.illumination : {};
  const extra = topProps.filter((k) => !CURATED.has(k));
  return (
    <div className="tree" role="tree" data-testid="object-tree">
      <Node path={[]} label={<b>Simulation</b>} errors={issues.length} />
      <Node path={["illumination"]} depth={1} label={`Environment · n=${spec.medium_index ?? 1}${ill.kind === "gaussian_beam" ? ` · beam w₀ ${ill.waist_nm} nm` : ""}`} errors={errs(["illumination"]) + errs(["medium_index"])} />
      <Node path={["wavelengths"]} depth={1} label={wavelengthSummary(spec.wavelengths)} errors={errs(["wavelengths"])} />
      <Node path={["substrate"]} depth={1} label={isObject(spec.substrate) ? `Substrate · ${materialLabel(spec.substrate.material)}` : "Substrate (off)"} off={!isObject(spec.substrate)} errors={errs(["substrate"])} />
      <div className="tree-section">
        <span>Particles ({particles.length})</span>
        <span className="spacer" />
        <div className="menu-wrap">
          <button className="icon" title="Add particle" onClick={() => setMenu(!menu)} data-testid="add-particle">
            ＋
          </button>
          {menu && (
            <div className="menu" onMouseLeave={() => setMenu(false)}>
              {PARTICLE_PRESETS.map((p) => (
                <button key={p.id} onClick={() => (addParticle(p.id), setMenu(false))} data-testid={`add-${p.id}`}>
                  {p.name}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {particles.map((p, i) => (
        <Node
          key={i}
          path={["particles", i]}
          depth={1}
          testId={`tree-particle-${i}`}
          errors={errs(["particles", i])}
          label={
            <>
              <span className="swatch" style={{ background: materialColor(p.material) }} />
              {i + 1}. {shapeLabel(p.shape)} <span className="muted">{materialLabel(p.material)}</span>
            </>
          }
          actions={
            <>
              <button className="icon" title="Duplicate (Ctrl+D)" onClick={() => (useSpec.getState().select(["particles", i]), duplicateSelection())}>
                ⧉
              </button>
              <button className="icon danger" title="Delete (Del)" onClick={() => (useSpec.getState().select(["particles", i]), deleteSelection())}>
                ✕
              </button>
            </>
          }
        />
      ))}
      <Node path={["outputs"]} depth={1} label="Outputs" errors={errs(["outputs"])} />
      <Node path={["outputs", "near_field"]} depth={2} label={isObject(outputs.near_field) ? `Near field (${outputs.near_field.plane ?? "xz"})` : "Near field (off)"} off={!isObject(outputs.near_field)} />
      <Node path={["outputs", "far_field"]} depth={2} label={isObject(outputs.far_field) ? "Far field" : "Far field (off)"} off={!isObject(outputs.far_field)} />
      <Node path={["outputs", "resonances"]} depth={2} label={isObject(outputs.resonances) ? "Resonances (Q)" : "Resonances (off)"} off={!isObject(outputs.resonances)} />
      <div className="tree-section">
        <span title="options.fdtd.mesh_override: refinement boxes of a graded FDTD grid">FDTD mesh overrides ({overrides.length})</span>
        <span className="spacer" />
        <button className="icon" title="Add a mesh-override box (FDTD)" onClick={addMeshOverride} data-testid="add-mesh-override">
          ＋
        </button>
      </div>
      {overrides.map((b) => (
        <Node
          key={b.index}
          path={b.path}
          depth={1}
          testId={`tree-override-${b.index}`}
          errors={errs(b.path)}
          label={
            <>
              <span className="swatch" style={{ background: "#e45bd0" }} />
              Override {b.index + 1} <span className="muted">{b.spacing.every((v) => v === b.spacing[0]) ? b.spacing[0] : b.spacing.join("/")} nm · {b.size.join(" × ")}</span>
            </>
          }
          actions={
            <button className="icon danger" title="Delete" onClick={() => (useSpec.getState().apply({ op: "remove", path: b.path }), useSpec.getState().select(["options"]))}>
              ✕
            </button>
          }
        />
      ))}
      <Node path={["options"]} depth={1} label={`Solver options${isObject(spec.options) && Object.keys(spec.options).length ? ` (${Object.keys(spec.options).join(", ")})` : ""}`} errors={errs(["options"])} />
      {extra.map((k) => (
        <Node key={k} path={[k]} depth={1} label={prettyKey(k)} errors={errs([k])} />
      ))}
    </div>
  );
}

/** Label for an array item / map entry: its name, else its kind, else its index. */
function itemLabel(v: Json, fallback: string): React.ReactNode {
  if (!isObject(v)) return fallback;
  const name = typeof v.name === "string" && v.name ? v.name : typeof v.label === "string" && v.label ? v.label : null;
  const kind = isObject(v.profile) ? v.profile.kind : isObject(v.geometry) ? v.geometry.kind : isObject(v.shape) ? shapeLabel(v.shape) : typeof v.component === "string" ? v.component : v.kind;
  const mat = "material" in v ? v.material : "background" in v ? v.background : undefined;
  return (
    <>
      {mat !== undefined && <span className="swatch" style={{ background: materialColor(mat) }} />}
      {name ?? fallback} {kind ? <span className="muted">{String(kind)}</span> : null}
      {typeof v.thickness_nm === "number" && <span className="muted"> {v.thickness_nm} nm</span>}
    </>
  );
}

/** A top-level field; arrays of objects and maps list their entries as children. */
function TopNode(props: { k: string; value: Json | undefined; errs: (p: Path) => number }) {
  const { k, value } = props;
  const children: [string | number, Json][] = Array.isArray(value) && value.some(isObject) ? value.map((v, i) => [i, v]) : isObject(value ?? null) && k !== "options" && Object.values(value as JsonObject).length > 0 && Object.values(value as JsonObject).every(isObject) ? Object.entries(value as JsonObject) : [];
  const count = Array.isArray(value) ? ` (${value.length})` : "";
  return (
    <>
      <Node
        path={[k]}
        depth={1}
        label={
          <>
            {prettyKey(k)}
            {count}
            {value !== undefined && value !== null && !isObject(value) && !Array.isArray(value) && <span className="muted"> {summary(value)}</span>}
            {value !== undefined && isMaterial(value) && <span className="muted"> {materialLabel(value)}</span>}
          </>
        }
        errors={props.errs([k])}
        off={value === null || value === undefined}
      />
      {children.map(([i, v]) => (
        <Node key={String(i)} path={[k, i]} depth={2} label={itemLabel(v, typeof i === "number" ? `#${i + 1}` : String(i))} errors={props.errs([k, i])} />
      ))}
    </>
  );
}

function isMaterial(v: Json | undefined): boolean {
  return isObject(v ?? null) && typeof (v as JsonObject).kind === "string" && ["library", "constant_index", "constant_permittivity", "drude", "drude_lorentz", "tabulated"].includes((v as JsonObject).kind as string);
}

function summary(v: Json): string {
  const s = JSON.stringify(v);
  return s.length > 28 ? s.slice(0, 26) + "…" : s;
}

function wavelengthSummary(w: Json | undefined): string {
  if (Array.isArray(w)) return `Wavelengths · ${w.length} values`;
  if (isObject(w)) return `Wavelengths · ${w.start_nm}–${w.stop_nm} nm × ${w.num}`;
  return "Wavelengths";
}
