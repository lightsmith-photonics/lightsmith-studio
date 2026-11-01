// A form generated from the live JSON Schema. It is the parity guarantee: every
// field of every problem kind is editable here, even fields added to the
// library after this GUI was written. Hand-crafted editors plug in through
// `FormOverrides` (by def name) but always keep this form one click away.

import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import {
  classify,
  clone,
  constKind,
  defaultFor,
  discriminatorProp,
  isObject,
  matchVariant,
  optionalInner,
  prettyKey,
  refName,
  SchemaDoc,
  unionHasNull,
  unionVariants,
  type Json,
  type JsonObject,
  type JSONSchema,
  type Path,
} from "./schema";

export type OnChange = (path: Path, value: Json) => void;

export interface Override {
  (props: FieldProps): ReactNode | undefined;
}

interface FormCtx {
  doc: SchemaDoc;
  onChange: OnChange;
  issues: Map<string, string>;
  /** Hand-crafted editors; each returns undefined to fall back to the generic one. */
  overrides: Override[];
}

const Ctx = createContext<FormCtx | null>(null);
export const useForm = () => {
  const c = useContext(Ctx);
  if (!c) throw new Error("SchemaForm context missing");
  return c;
};

export interface FieldProps {
  node: JSONSchema;
  value: Json | undefined;
  path: Path;
  label?: string;
  /** "Def.prop" id used by the parity test. */
  propId?: string;
  required?: boolean;
  depth: number;
}

export function SchemaForm(props: {
  doc: SchemaDoc;
  node: JSONSchema;
  value: Json;
  onChange: OnChange;
  path?: Path;
  issues?: Map<string, string>;
  overrides?: Override[];
  label?: string;
}) {
  const ctx: FormCtx = { doc: props.doc, onChange: props.onChange, issues: props.issues ?? new Map(), overrides: props.overrides ?? [] };
  return (
    <Ctx.Provider value={ctx}>
      <div className="schema-form">
        <Field node={props.node} value={props.value} path={props.path ?? []} depth={0} label={props.label} />
      </div>
    </Ctx.Provider>
  );
}

const pk = (p: Path) => p.join("/");

export function Field(props: FieldProps) {
  const { doc, overrides } = useForm();
  for (const o of overrides) {
    const out = o(props);
    if (out !== undefined) return <>{out}</>;
  }
  const kind = classify(doc, props.node);
  switch (kind) {
    case "object":
      return <ObjectField {...props} />;
    case "union":
      return <UnionField {...props} />;
    case "optional":
      return <OptionalField {...props} />;
    case "array":
      return <ArrayField {...props} />;
    case "tuple":
      return <TupleField {...props} />;
    case "map":
      return <MapField {...props} />;
    case "json":
      return <Row {...props} kind={kind}>{<JsonInput value={props.value ?? null} path={props.path} />}</Row>;
    case "null":
      return <Row {...props} kind={kind}><span className="muted">none</span></Row>;
    case "unknown":
      return (
        <Row {...props} kind={kind}>
          <span className="badge warn" title="This schema construct has no dedicated editor; edit it as JSON.">unsupported</span>
          <JsonInput value={props.value ?? null} path={props.path} />
        </Row>
      );
    default:
      return <Row {...props} kind={kind}><ScalarInput {...props} kind={kind} /></Row>;
  }
}

/** A labelled row for scalar-ish fields. */
function Row(props: FieldProps & { kind: string; children: ReactNode }) {
  const { doc, issues } = useForm();
  const r = doc.resolve(props.node);
  const err = issues.get(pk(props.path));
  return (
    <div className={`field-row${err ? " has-error" : ""}`} data-schema-prop={props.propId} data-path={pk(props.path)} data-editor={props.kind}>
      {props.label !== undefined && (
        <label className="field-label" title={r.description ?? ""}>
          {props.label}
          {props.required && <span className="req">*</span>}
        </label>
      )}
      <div className="field-input">
        {props.children}
        {err && <div className="field-error">{err}</div>}
      </div>
    </div>
  );
}

function hint(r: JSONSchema): string {
  const parts: string[] = [];
  if (typeof r.exclusiveMinimum === "number") parts.push(`> ${r.exclusiveMinimum}`);
  if (typeof r.minimum === "number") parts.push(`≥ ${r.minimum}`);
  if (typeof r.exclusiveMaximum === "number") parts.push(`< ${r.exclusiveMaximum}`);
  if (typeof r.maximum === "number") parts.push(`≤ ${r.maximum}`);
  return parts.join(", ");
}

export function NumberInput(props: {
  value: Json | undefined;
  onCommit: (v: number) => void;
  integer?: boolean;
  min?: number;
  exclusiveMin?: number;
  step?: number;
  title?: string;
  testId?: string;
  className?: string;
  placeholder?: string;
}) {
  const { value, onCommit, integer } = props;
  const [text, setText] = useState(value === undefined || value === null ? "" : String(value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(value === undefined || value === null ? "" : String(value));
  }, [value, focused]);
  const parsed = text.trim() === "" ? NaN : Number(text);
  const bad =
    text.trim() !== "" &&
    (!Number.isFinite(parsed) ||
      (integer && !Number.isInteger(parsed)) ||
      (props.min !== undefined && parsed < props.min) ||
      (props.exclusiveMin !== undefined && parsed <= props.exclusiveMin));
  return (
    <input
      className={`num${bad ? " invalid" : ""} ${props.className ?? ""}`}
      inputMode="decimal"
      value={text}
      title={props.title}
      placeholder={props.placeholder}
      data-testid={props.testId}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      onChange={(e) => {
        setText(e.target.value);
        const v = Number(e.target.value);
        if (e.target.value.trim() !== "" && Number.isFinite(v) && (!integer || Number.isInteger(v))) onCommit(v);
      }}
      onKeyDown={(e) => {
        if (e.key === "ArrowUp" || e.key === "ArrowDown") {
          e.preventDefault();
          const step = props.step ?? (integer ? 1 : Math.max(1e-6, Math.abs(Number(value) || 1) * 0.05));
          const next = (Number(value) || 0) + (e.key === "ArrowUp" ? step : -step);
          onCommit(integer ? Math.round(next) : Number(next.toPrecision(10)));
        }
      }}
    />
  );
}

function ScalarInput(props: FieldProps & { kind: string }) {
  const { doc, onChange } = useForm();
  const r = doc.resolve(props.node);
  const set = (v: Json) => onChange(props.path, v);
  switch (props.kind) {
    case "number":
    case "integer":
      return (
        <span className="num-wrap">
          <NumberInput
            value={props.value}
            integer={props.kind === "integer"}
            min={r.minimum}
            exclusiveMin={r.exclusiveMinimum}
            onCommit={set}
            placeholder={r.default != null ? `default ${r.default}` : undefined}
            title={hint(r)}
            testId={`input-${pk(props.path)}`}
          />
          {hint(r) && <span className="hint">{hint(r)}</span>}
        </span>
      );
    case "boolean":
      return <input type="checkbox" checked={(props.value ?? r.default) === true} onChange={(e) => set(e.target.checked)} data-testid={`input-${pk(props.path)}`} />;
    case "enum":
      return (
        <select value={JSON.stringify(props.value ?? r.default ?? null)} onChange={(e) => set(JSON.parse(e.target.value))} data-testid={`input-${pk(props.path)}`}>
          {(r.enum as Json[]).map((o) => (
            <option key={JSON.stringify(o)} value={JSON.stringify(o)}>
              {String(o)}
            </option>
          ))}
        </select>
      );
    case "const":
      return <span className="badge">{String(r.const)}</span>;
    default:
      return <input value={props.value == null ? "" : String(props.value)} onChange={(e) => set(e.target.value)} data-testid={`input-${pk(props.path)}`} />;
  }
}

function ObjectField(props: FieldProps) {
  const { doc } = useForm();
  const r = doc.resolve(props.node);
  const owner = refName(props.node) ?? r.title ?? props.propId ?? "object";
  const value = isObject(props.value ?? null) ? (props.value as JsonObject) : {};
  const required: string[] = r.required ?? [];
  const body = (
    <div className="object-body">
      {Object.entries<JSONSchema>(r.properties ?? {}).map(([k, p]) => (
        <Field
          key={k}
          node={p}
          value={value[k] === undefined ? undefined : value[k]}
          path={[...props.path, k]}
          label={prettyKey(k, doc.resolve(p))}
          propId={`${owner}.${k}`}
          required={required.includes(k)}
          depth={props.depth + 1}
        />
      ))}
    </div>
  );
  if (props.label === undefined) return <div data-schema-prop={props.propId} data-path={pk(props.path)}>{body}</div>;
  return (
    <details className="group" open={props.depth < 3} data-schema-prop={props.propId} data-path={pk(props.path)} data-editor="object">
      <summary title={r.description ?? ""}>
        {props.label}
        {props.required && <span className="req">*</span>}
      </summary>
      {body}
    </details>
  );
}

function variantLabel(doc: SchemaDoc, v: JSONSchema, prop?: string): string {
  const k = prop ? constKind(doc, v, prop) : undefined;
  if (k) return k;
  const r = doc.resolve(v);
  if (r.type === "array") return "list";
  return refName(v) ?? r.title ?? String(r.type ?? "value");
}

function UnionField(props: FieldProps) {
  const { doc, onChange } = useForm();
  const variants = unionVariants(doc, props.node)!;
  const nullable = unionHasNull(doc, props.node);
  const prop = discriminatorProp(doc, props.node);
  const isNull = props.value === null || props.value === undefined;
  const idx = isNull && nullable ? -1 : matchVariant(doc, props.node, props.value ?? null);
  const choose = (i: number) => {
    if (i < 0) return onChange(props.path, null);
    // keep fields that the new variant also has (e.g. switching material kind keeps nothing, list<->range keeps nothing)
    const next = defaultFor(doc, variants[i]);
    if (isObject(next) && isObject(props.value ?? null)) {
      const r = doc.resolve(variants[i]);
      for (const [k, v] of Object.entries(props.value as JsonObject)) if (k !== prop && r.properties?.[k] && !(k in next)) next[k] = clone(v);
    }
    onChange(props.path, next);
  };
  const selector = (
    <select value={idx} onChange={(e) => choose(Number(e.target.value))} data-testid={`variant-${pk(props.path)}`} className="variant-select">
      {nullable && <option value={-1}>none</option>}
      {variants.map((v, i) => (
        <option key={i} value={i}>
          {variantLabel(doc, v, prop)}
        </option>
      ))}
    </select>
  );
  return (
    <div className="union" data-schema-prop={props.propId} data-path={pk(props.path)} data-editor="union">
      <div className="field-row">
        {props.label !== undefined && (
          <label className="field-label" title={doc.resolve(props.node).description ?? ""}>
            {props.label}
            {props.required && <span className="req">*</span>}
          </label>
        )}
        <div className="field-input">{selector}</div>
      </div>
      {idx >= 0 && (
        <div className="union-body">
          <Field node={variants[idx]} value={props.value} path={props.path} depth={props.depth + 1} />
        </div>
      )}
    </div>
  );
}

function OptionalField(props: FieldProps) {
  const { doc, onChange } = useForm();
  const inner = optionalInner(doc, props.node)!;
  const on = props.value !== null && props.value !== undefined;
  const innerKind = classify(doc, inner);
  const toggle = (
    <input
      type="checkbox"
      checked={on}
      data-testid={`toggle-${pk(props.path)}`}
      onChange={(e) => onChange(props.path, e.target.checked ? defaultFor(doc, inner) : null)}
      title={on ? "Set to null (off)" : "Enable"}
    />
  );
  const scalar = !["object", "union", "array", "map", "optional"].includes(innerKind) || (innerKind === "array" && isFlatArray(doc, inner));
  if (scalar) {
    return (
      <div className="field-row" data-schema-prop={props.propId} data-path={pk(props.path)} data-editor="optional">
        <label className="field-label" title={doc.resolve(props.node).description ?? ""}>
          {toggle} {props.label}
        </label>
        <div className="field-input">{on ? <Field node={inner} value={props.value} path={props.path} depth={props.depth + 1} /> : <span className="muted">default</span>}</div>
      </div>
    );
  }
  return (
    <div className="optional" data-schema-prop={props.propId} data-path={pk(props.path)} data-editor="optional">
      <label className="optional-head" title={doc.resolve(props.node).description ?? ""}>
        {toggle} {props.label}
      </label>
      {on && (
        <div className="optional-body">
          <Field node={inner} value={props.value} path={props.path} depth={props.depth + 1} />
        </div>
      )}
    </div>
  );
}

function isFlatArray(doc: SchemaDoc, node: JSONSchema): boolean {
  const r = doc.resolve(node);
  const k = classify(doc, r.items);
  return k === "number" || k === "integer" || k === "string";
}

/** Comma/space separated numbers or strings. Also accepts "start:stop:num" for evenly spaced numbers. */
export function ListInput(props: { value: Json | undefined; onCommit: (v: Json[]) => void; numeric: boolean; integer?: boolean; testId?: string; placeholder?: string }) {
  const toText = (v: Json | undefined) => (Array.isArray(v) ? v.join(", ") : "");
  const [text, setText] = useState(toText(props.value));
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(toText(props.value));
  }, [props.value, focused]);
  const parse = (t: string): Json[] | null => {
    const s = t.trim();
    if (!s) return [];
    const range = /^(-?[\d.eE+-]+)\s*:\s*(-?[\d.eE+-]+)\s*:\s*(\d+)$/.exec(s);
    if (props.numeric && range) {
      const [a, b, n] = [Number(range[1]), Number(range[2]), Number(range[3])];
      if (n < 1) return null;
      return Array.from({ length: n }, (_, i) => (n === 1 ? a : Number((a + ((b - a) * i) / (n - 1)).toPrecision(12))));
    }
    const parts = s.split(/[\s,;]+/).filter(Boolean);
    if (!props.numeric) return parts;
    const nums = parts.map(Number);
    if (nums.some((x) => !Number.isFinite(x) || (props.integer && !Number.isInteger(x)))) return null;
    return nums;
  };
  const parsed = parse(text);
  return (
    <span className="list-wrap">
      <input
        className={parsed === null ? "invalid" : ""}
        value={text}
        placeholder={props.placeholder ?? (props.numeric ? "1, 2, 3  or  start:stop:num" : "a, b, c")}
        data-testid={props.testId}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          setText(e.target.value);
          const v = parse(e.target.value);
          if (v) props.onCommit(v);
        }}
      />
      <span className="hint">{Array.isArray(props.value) ? `${props.value.length} values` : ""}</span>
    </span>
  );
}

function ArrayField(props: FieldProps) {
  const { doc, onChange } = useForm();
  const r = doc.resolve(props.node);
  const items: Json[] = Array.isArray(props.value) ? props.value : [];
  const itemKind = classify(doc, r.items);
  if (["number", "integer", "string"].includes(itemKind)) {
    return (
      <Row {...props} kind="array">
        <ListInput value={props.value} numeric={itemKind !== "string"} integer={itemKind === "integer"} onCommit={(v) => onChange(props.path, v)} testId={`input-${pk(props.path)}`} />
      </Row>
    );
  }
  const min = r.minItems ?? 0;
  const max = r.maxItems ?? Infinity;
  const set = (next: Json[]) => onChange(props.path, next);
  return (
    <details className="group array" open={props.depth < 3} data-schema-prop={props.propId} data-path={pk(props.path)} data-editor="array">
      <summary title={r.description ?? ""}>
        {props.label ?? "items"} <span className="muted">[{items.length}]</span>
        {props.required && <span className="req">*</span>}
      </summary>
      {items.map((it, i) => (
        <div className="array-item" key={i}>
          <div className="array-item-head">
            <span className="muted">#{i + 1}</span>
            <span className="spacer" />
            <button className="icon" title="Move up" disabled={i === 0} onClick={() => set(swap(items, i, i - 1))}>
              ↑
            </button>
            <button className="icon" title="Move down" disabled={i === items.length - 1} onClick={() => set(swap(items, i, i + 1))}>
              ↓
            </button>
            <button className="icon" title="Duplicate" disabled={items.length >= max} onClick={() => set([...items.slice(0, i + 1), clone(it), ...items.slice(i + 1)])}>
              ⧉
            </button>
            <button className="icon danger" title="Remove" disabled={items.length <= min} onClick={() => set(items.filter((_, j) => j !== i))}>
              ✕
            </button>
          </div>
          <Field node={r.items} value={it} path={[...props.path, i]} depth={props.depth + 1} />
        </div>
      ))}
      <button className="small" disabled={items.length >= max} onClick={() => set([...items, defaultFor(doc, r.items)])} data-testid={`add-${pk(props.path)}`}>
        + Add
      </button>
    </details>
  );
}

function swap<T>(a: T[], i: number, j: number): T[] {
  const b = a.slice();
  [b[i], b[j]] = [b[j], b[i]];
  return b;
}

function TupleField(props: FieldProps) {
  const { doc, onChange } = useForm();
  const r = doc.resolve(props.node);
  const vals: Json[] = Array.isArray(props.value) ? props.value : (defaultFor(doc, props.node) as Json[]);
  const allScalar = (r.prefixItems as JSONSchema[]).every((p) => ["number", "integer", "string", "boolean", "enum"].includes(classify(doc, p)));
  if (!allScalar) {
    return (
      <Row {...props} kind="tuple">
        <div className="tuple-nested">
          {(r.prefixItems as JSONSchema[]).map((p, i) => (
            <Field key={i} node={p} value={vals[i]} path={[...props.path, i]} depth={props.depth + 1} label={`[${i}]`} />
          ))}
        </div>
      </Row>
    );
  }
  const allNumeric = (r.prefixItems as JSONSchema[]).every((p) => ["number", "integer"].includes(classify(doc, p)));
  const axis = !allNumeric ? [] : r.prefixItems.length === 3 ? ["x", "y", "z"] : r.prefixItems.length === 2 ? ["x", "y"] : [];
  return (
    <Row {...props} kind="tuple">
      <span className="tuple">
        {(r.prefixItems as JSONSchema[]).map((p, i) => {
          const k = classify(doc, p);
          return (
            <span key={i} className="tuple-cell">
              {axis[i] && <span className="axis">{axis[i]}</span>}
              {k === "number" || k === "integer" ? (
                <NumberInput value={vals[i]} integer={k === "integer"} onCommit={(v) => onChange([...props.path, i], v)} testId={`input-${pk([...props.path, i])}`} />
              ) : (
                <input value={vals[i] == null ? "" : String(vals[i])} onChange={(e) => onChange([...props.path, i], e.target.value)} />
              )}
            </span>
          );
        })}
      </span>
    </Row>
  );
}

function MapField(props: FieldProps) {
  const { doc, onChange } = useForm();
  const r = doc.resolve(props.node);
  const value = isObject(props.value ?? null) ? (props.value as JsonObject) : {};
  const [newKey, setNewKey] = useState("");
  const add = () => {
    const k = newKey.trim();
    if (!k || k in value) return;
    onChange(props.path, { ...value, [k]: defaultFor(doc, r.additionalProperties) });
    setNewKey("");
  };
  return (
    <details className="group map" open={props.depth < 3} data-schema-prop={props.propId} data-path={pk(props.path)} data-editor="map">
      <summary title={r.description ?? ""}>
        {props.label ?? "entries"} <span className="muted">{`{${Object.keys(value).length}}`}</span>
      </summary>
      {Object.entries(value).map(([k, v]) => (
        <div className="array-item" key={k}>
          <div className="array-item-head">
            <code>{k}</code>
            <span className="spacer" />
            <button
              className="icon danger"
              title="Remove"
              onClick={() => {
                const { [k]: _drop, ...rest } = value;
                onChange(props.path, rest);
              }}
            >
              ✕
            </button>
          </div>
          <Field node={r.additionalProperties} value={v} path={[...props.path, k]} depth={props.depth + 1} />
        </div>
      ))}
      <div className="map-add">
        <input placeholder="new key" value={newKey} onChange={(e) => setNewKey(e.target.value)} onKeyDown={(e) => e.key === "Enter" && add()} data-testid={`mapkey-${pk(props.path)}`} />
        <button className="small" onClick={add} disabled={!newKey.trim()}>
          + Add
        </button>
      </div>
    </details>
  );
}

/** Free-form JSON (for `dict[str, Any]` fields). Commits on valid JSON. */
export function JsonInput(props: { value: Json; path: Path; onCommit?: (v: Json) => void }) {
  const form = useContext(Ctx);
  const commit = props.onCommit ?? ((v: Json) => form?.onChange(props.path, v));
  const [text, setText] = useState(JSON.stringify(props.value, null, 1));
  const [err, setErr] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  useEffect(() => {
    if (!focused) setText(JSON.stringify(props.value, null, 1));
  }, [props.value, focused]);
  return (
    <span className="json-input">
      <textarea
        rows={Math.min(8, Math.max(2, text.split("\n").length))}
        value={text}
        spellCheck={false}
        data-testid={`json-${pk(props.path)}`}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          setText(e.target.value);
          try {
            const v = JSON.parse(e.target.value);
            setErr(null);
            commit(v);
          } catch (x) {
            setErr((x as Error).message);
          }
        }}
      />
      {err && <span className="field-error">{err}</span>}
    </span>
  );
}
