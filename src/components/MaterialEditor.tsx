// Hand-crafted editor for any material field (particle, shell, substrate, and
// every material in other problem kinds). It replaces the generic union editor
// via a SchemaForm override but keeps all of that variant's fields.

import { useMemo, useState } from "react";
import { Field, type FieldProps, useForm } from "../schema/SchemaForm";
import { constKind, isObject, matchVariant, SchemaDoc, unionVariants, type Json, type JsonObject, type JSONSchema } from "../schema/schema";
import { findLibrary, LIBRARY, materialColor, materialLabel, materialRange, nkCurve } from "../physics/materials";
import { useSpec } from "../state/store";
import { wavelengthArray } from "../api/mock/solver";
import { MaterialPicker } from "./MaterialPicker";
import { NkSparkline } from "./Sparkline";

export function isMaterialNode(doc: SchemaDoc, node: JSONSchema): boolean {
  const vs = unionVariants(doc, node);
  if (!vs || vs.length < 3) return false;
  const kinds = vs.map((v) => constKind(doc, v));
  return kinds.includes("library") && (kinds.includes("constant_index") || kinds.includes("drude"));
}

/** The spec's wavelength span, for previews and range checks. */
export function useWavelengthBand(): [number, number] | null {
  const spec = useSpec((s) => s.spec);
  return useMemo(() => {
    if (!("wavelengths" in spec)) return null;
    const w = wavelengthArray(spec);
    return w.length ? [Math.min(...w), Math.max(...w)] : null;
  }, [spec]);
}

export function materialOverride(props: FieldProps) {
  const { doc } = useForm();
  if (!isMaterialNode(doc, props.node)) return undefined;
  return <MaterialEditor {...props} />;
}

export function MaterialEditor(props: FieldProps) {
  const { doc, onChange, issues } = useForm();
  const [picking, setPicking] = useState(false);
  const [open, setOpen] = useState(false);
  const band = useWavelengthBand();
  const value = props.value ?? null;
  const variants = unionVariants(doc, props.node)!;
  const idx = matchVariant(doc, props.node, value);
  const kind = isObject(value) ? String(value.kind) : "";
  const range = materialRange(value);
  const outOfRange = band && range && (band[0] < range[0] || band[1] > range[1]);
  const preview = useMemo(() => {
    if (!band) return null;
    const lo = range ? Math.max(range[0], band[0] - 100) : band[0] - 100;
    const hi = range ? Math.min(range[1], band[1] + 100) : band[1] + 100;
    const wl = Array.from({ length: 60 }, (_, i) => lo + ((hi - lo) * i) / 59);
    return { wl, ...nkCurve(value, wl) };
  }, [value, band, range]);
  const err = issues.get(props.path.join("/"));
  const set = (m: Json) => onChange(props.path, m);

  return (
    <div className="material-editor" data-schema-prop={props.propId} data-path={props.path.join("/")} data-editor="material">
      <div className="field-row">
        <label className="field-label">{props.label ?? "Material"}</label>
        <div className="field-input material-head">
          <span className="swatch" style={{ background: materialColor(value) }} />
          <button className="material-btn" onClick={() => setPicking(true)} data-testid={`pick-material-${props.path.join("/")}`} title="Choose from the library, the materials database, a model or a CSV file">
            {materialLabel(value)} ▾
          </button>
          <button className="icon" title="Edit parameters" onClick={() => setOpen(!open)}>
            {open ? "▴" : "✎"}
          </button>
        </div>
      </div>
      {preview && (
        <div className="field-row">
          <span className="field-label muted small">n, k</span>
          <div className="field-input">
            <NkSparkline wl={preview.wl} n={preview.n} k={preview.k} band={band} />
          </div>
        </div>
      )}
      {outOfRange && (
        <div className="warn-box" data-testid="material-range-warning">
          Data cover {range![0].toFixed(0)}–{range![1].toFixed(0)} nm only; the simulation asks for {band![0].toFixed(0)}–{band![1].toFixed(0)} nm.
          {kind === "library" && <CoveringDatasets value={value as JsonObject} band={band!} onPick={set} />}
        </div>
      )}
      {err && <div className="field-error">{err}</div>}
      {(open || !!err) && (
        <div className="material-params">
          <div className="field-row">
            <label className="field-label">Kind</label>
            <div className="field-input">
              <select
                value={idx}
                data-testid={`variant-${props.path.join("/")}`}
                onChange={(e) => {
                  const v = variants[Number(e.target.value)];
                  const k = constKind(doc, v);
                  if (k === "library") set({ kind: "library", name: "Au", dataset: "Johnson-Christy" });
                  else set({ ...((defaultValueFor(doc, v) as JsonObject) ?? {}) });
                }}
              >
                {variants.map((v, i) => (
                  <option key={i} value={i}>
                    {constKind(doc, v)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {kind === "library" ? <LibraryFields value={value as JsonObject} onChange={set} /> : <Field node={variants[idx]} value={value} path={props.path} depth={props.depth + 1} />}
        </div>
      )}
      {picking && <MaterialPicker value={value} band={band} onPick={set} onClose={() => setPicking(false)} />}
    </div>
  );
}

function defaultValueFor(doc: SchemaDoc, v: JSONSchema): Json {
  const r = doc.resolve(v);
  const out: JsonObject = {};
  for (const [k, p] of Object.entries<JSONSchema>(r.properties ?? {})) {
    const pr = doc.resolve(p);
    if ("const" in pr) out[k] = pr.const;
    else if ("default" in pr) out[k] = pr.default;
    else if ((r.required ?? []).includes(k)) out[k] = pr.type === "array" ? [] : pr.type === "string" ? "" : 1;
  }
  if (out.kind === "tabulated") Object.assign(out, { wavelength_nm: [400, 800], n_real: [1.5, 1.5], n_imag: [0, 0] });
  return out;
}

function LibraryFields(props: { value: JsonObject; onChange: (m: Json) => void }) {
  const names = [...new Set(LIBRARY.map((r) => r.name))];
  const row = findLibrary(String(props.value.name ?? ""), props.value.dataset as string | null);
  const datasets = LIBRARY.filter((r) => r.name === row?.name);
  return (
    <>
      <div className="field-row" data-schema-prop="LibraryMaterial.name">
        <label className="field-label">Name</label>
        <div className="field-input">
          <select value={row?.name ?? String(props.value.name)} onChange={(e) => props.onChange({ kind: "library", name: e.target.value, dataset: LIBRARY.find((r) => r.name === e.target.value && r.default)?.dataset ?? null })}>
            {!row && <option value={String(props.value.name)}>{String(props.value.name)} (not in bundled snapshot)</option>}
            {names.map((n) => (
              <option key={n} value={n}>
                {n} — {LIBRARY.find((r) => r.name === n)?.description}
              </option>
            ))}
          </select>
        </div>
      </div>
      <div className="field-row" data-schema-prop="LibraryMaterial.dataset">
        <label className="field-label">Dataset</label>
        <div className="field-input">
          <select value={row?.dataset ?? String(props.value.dataset ?? "")} onChange={(e) => props.onChange({ ...props.value, dataset: e.target.value })}>
            {datasets.map((d) => (
              <option key={d.dataset} value={d.dataset}>
                {d.dataset} ({d.range_nm[0].toFixed(0)}–{d.range_nm[1].toFixed(0)} nm){d.default ? " · default" : ""}
              </option>
            ))}
          </select>
        </div>
      </div>
      {row && (
        <div className="muted small cite">
          {row.reference}
          {row.doi && (
            <>
              {" "}
              doi:{row.doi}
            </>
          )}
        </div>
      )}
    </>
  );
}

function CoveringDatasets(props: { value: JsonObject; band: [number, number]; onPick: (m: Json) => void }) {
  const row = findLibrary(String(props.value.name ?? ""), props.value.dataset as string | null);
  const cover = LIBRARY.filter((r) => r.name === row?.name && r.dataset !== row?.dataset && r.range_nm[0] <= props.band[0] && r.range_nm[1] >= props.band[1]);
  if (!cover.length) return <> No bundled dataset covers it; narrow the wavelengths.</>;
  return (
    <>
      {" "}
      Use{" "}
      {cover.map((r, i) => (
        <span key={r.dataset}>
          {i > 0 && ", "}
          <button className="link" onClick={() => props.onPick(r.material_json)}>
            {r.dataset}
          </button>
        </span>
      ))}
      ?
    </>
  );
}
