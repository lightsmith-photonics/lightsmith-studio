// Material picker: bundled library, the materials-db service, custom models
// (constant n / ε, Drude, Drude–Lorentz) and tabulated CSV import, with n/k
// previews over the simulation's wavelength range.

import { useEffect, useMemo, useState } from "react";
import { useConnection } from "../state/connection";
import { LIBRARY, nkCurve, materialLabel, parseNkCsv } from "../physics/materials";
import { SchemaForm } from "../schema/SchemaForm";
import { defaultFor, type Json, type JsonObject } from "../schema/schema";
import type { DbMaterial, NkData } from "../api/materialsDb";
import { Modal, Tabs } from "./Modal";
import { Plot } from "./Plot";

type Tab = "library" | "db" | "custom" | "csv";

const PRESETS: { name: string; m: JsonObject }[] = [
  { name: "Glass (n = 1.5)", m: { kind: "constant_index", n_real: 1.5, n_imag: 0 } },
  { name: "Polystyrene (n = 1.59)", m: { kind: "constant_index", n_real: 1.59, n_imag: 0 } },
  { name: "Silicon-like (n = 3.5)", m: { kind: "constant_index", n_real: 3.5, n_imag: 0 } },
  { name: "Gold-like Drude", m: { kind: "drude", eps_inf: 9.5, wp_ev: 9.0, gamma_ev: 0.07 } },
  { name: "Silver-like Drude", m: { kind: "drude", eps_inf: 3.7, wp_ev: 9.1, gamma_ev: 0.018 } },
  {
    name: "Gold Drude–Lorentz (2 poles)",
    m: {
      kind: "drude_lorentz",
      eps_inf: 5.9,
      wp_ev: 8.9,
      gamma_ev: 0.07,
      poles: [
        { delta_eps: 1.3, omega0_ev: 2.7, gamma_ev: 0.6 },
        { delta_eps: 2.1, omega0_ev: 3.9, gamma_ev: 1.3 },
      ],
    },
  },
];

function grid(lo: number, hi: number, n = 200): number[] {
  return Array.from({ length: n }, (_, i) => lo + ((hi - lo) * i) / (n - 1));
}

export function NkPlot(props: { material?: Json; data?: NkData | null; band?: [number, number] | null; height?: number }) {
  const traces = useMemo(() => {
    let wl: number[];
    let n: number[];
    let k: number[];
    if (props.data) ({ wavelength_nm: wl, n, k } = props.data);
    else if (props.material) {
      const lo = props.band ? Math.max(100, props.band[0] - 0.25 * (props.band[1] - props.band[0])) : 300;
      const hi = props.band ? props.band[1] + 0.25 * (props.band[1] - props.band[0]) : 1200;
      wl = grid(lo, hi);
      ({ n, k } = nkCurve(props.material, wl));
    } else return [];
    return [
      { x: wl, y: n, name: "n", mode: "lines", line: { color: "#4f9dff" } },
      { x: wl, y: k, name: "k", mode: "lines", line: { color: "#ff8a4c" } },
    ];
  }, [props.material, props.data, props.band]);
  const layout = useMemo(
    () => ({
      xaxis: { title: { text: "wavelength (nm)" } },
      yaxis: { title: { text: "n, k" } },
      margin: { l: 50, r: 10, t: 10, b: 40 },
      shapes: props.band ? [{ type: "rect", xref: "x", yref: "paper", x0: props.band[0], x1: props.band[1], y0: 0, y1: 1, fillcolor: "rgba(120,200,120,0.12)", line: { width: 0 } }] : [],
    }),
    [props.band],
  );
  return <Plot data={traces} layout={layout} height={props.height ?? 240} testId="nk-plot" />;
}

export function MaterialPicker(props: { value: Json; band: [number, number] | null; onPick: (m: JsonObject) => void; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>(() => ((props.value as JsonObject)?.kind === "library" || !props.value ? "library" : "custom"));
  const [candidate, setCandidate] = useState<JsonObject | null>(null);
  const [preview, setPreview] = useState<NkData | null>(null);
  const [info, setInfo] = useState<string>("");

  return (
    <Modal
      title="Choose material"
      onClose={props.onClose}
      wide
      testId="material-picker"
      footer={
        <>
          <span className="muted grow">{candidate ? materialLabel(candidate) : "Select a material"}</span>
          <button onClick={props.onClose}>Cancel</button>
          <button className="primary" disabled={!candidate} data-testid="material-use" onClick={() => candidate && (props.onPick(candidate), props.onClose())}>
            Use material
          </button>
        </>
      }
    >
      <Tabs
        value={tab}
        onChange={(t) => {
          setTab(t);
          setCandidate(null);
          setPreview(null);
          setInfo("");
        }}
        tabs={[
          { id: "library", label: "Bundled library" },
          { id: "db", label: "Materials database" },
          { id: "custom", label: "Model" },
          { id: "csv", label: "Import CSV" },
        ]}
      />
      <div className="picker">
        <div className="picker-left">
          {tab === "library" && <LibraryList onSelect={(m, i) => (setCandidate(m), setPreview(null), setInfo(i))} selected={candidate} />}
          {tab === "db" && <DbList onSelect={(m, d, i) => (setCandidate(m), setPreview(d), setInfo(i))} />}
          {tab === "custom" && <CustomModel initial={(props.value as JsonObject)?.kind !== "library" && (props.value as JsonObject)?.kind !== "tabulated" ? (props.value as JsonObject) : null} onChange={(m) => (setCandidate(m), setPreview(null), setInfo(""))} />}
          {tab === "csv" && <CsvImport onChange={(m) => (setCandidate(m), setPreview(null), setInfo(m ? `${(m.wavelength_nm as number[]).length} rows` : ""))} />}
        </div>
        <div className="picker-right">
          {candidate || preview ? <NkPlot material={candidate ?? undefined} data={preview} band={props.band} /> : <div className="empty">No material selected</div>}
          {info && <div className="picker-info">{info}</div>}
          {props.band && <div className="muted small">Shaded: the simulation's wavelength range ({props.band[0].toFixed(0)}–{props.band[1].toFixed(0)} nm)</div>}
        </div>
      </div>
    </Modal>
  );
}

function LibraryList(props: { onSelect: (m: JsonObject, info: string) => void; selected: JsonObject | null }) {
  const [q, setQ] = useState("");
  const rows = LIBRARY.filter((r) => `${r.name} ${r.description} ${r.aliases.join(" ")} ${r.dataset}`.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <input placeholder="Search (gold, Si, JC…)" value={q} onChange={(e) => setQ(e.target.value)} className="search" data-testid="library-search" />
      <ul className="list">
        {rows.map((r) => {
          const sel = props.selected?.name === r.name && props.selected?.dataset === r.dataset;
          return (
            <li key={`${r.name}/${r.dataset}`} className={sel ? "selected" : ""}>
              <button
                className="list-btn"
                data-testid={`lib-${r.name}-${r.dataset}`}
                onClick={() =>
                  props.onSelect(
                    { ...r.material_json },
                    `${r.description}, ${r.dataset}: ${r.range_nm[0]}–${r.range_nm[1]} nm. ${r.reference}${r.doi ? ` doi:${r.doi}` : ""}. ${r.comments ?? ""} Data: refractiveindex.info (${r.license}).`,
                  )
                }
              >
                <b>{r.name}</b> <span className="muted">{r.dataset}</span>
                {r.default && <span className="badge">default</span>}
                <span className="muted right">
                  {r.range_nm[0].toFixed(0)}–{r.range_nm[1].toFixed(0)} nm
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function DbList(props: { onSelect: (m: JsonObject, d: NkData, info: string) => void }) {
  const client = useConnection((s) => s.materials);
  const [q, setQ] = useState("");
  const [items, setItems] = useState<DbMaterial[]>([]);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    setBusy(true);
    const t = setTimeout(() => {
      client
        .list(q || undefined)
        .then((x) => live && (setItems(x), setErr(null)))
        .catch((e) => live && setErr((e as Error).message))
        .finally(() => live && setBusy(false));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, client]);
  const pick = async (m: DbMaterial, dsId: string) => {
    try {
      const [data, mat] = await Promise.all([client.data(dsId), client.material(dsId)]);
      const ds = m.datasets.find((d) => d.id === dsId);
      props.onSelect(mat, data, `${m.name} / ${ds?.name}${ds?.reference ? ` — ${ds.reference}` : ""}${ds?.doi ? ` doi:${ds.doi}` : ""}`);
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  return (
    <>
      <input placeholder="Search the materials database" value={q} onChange={(e) => setQ(e.target.value)} className="search" />
      <div className="muted small">
        {client.kind === "mock" ? "Mock materials service (bundled data). Set a materials-db URL in Server settings." : `Service: ${(client as unknown as { baseUrl: string }).baseUrl}`}
        {busy && " · loading…"}
      </div>
      {err && <div className="field-error">{err}</div>}
      <ul className="list">
        {items.map((m) =>
          m.datasets.map((d) => (
            <li key={d.id}>
              <button className="list-btn" onClick={() => void pick(m, d.id)}>
                <b>{m.name}</b> <span className="muted">{d.name}</span>
                {d.range_nm && (
                  <span className="muted right">
                    {d.range_nm[0].toFixed(0)}–{d.range_nm[1].toFixed(0)} nm
                  </span>
                )}
              </button>
            </li>
          )),
        )}
      </ul>
    </>
  );
}

const MODEL_KINDS = [
  { def: "ConstantIndex", label: "Constant n + ik" },
  { def: "ConstantPermittivity", label: "Constant ε" },
  { def: "Drude", label: "Drude" },
  { def: "DrudeLorentz", label: "Drude–Lorentz" },
];

function CustomModel(props: { initial: JsonObject | null; onChange: (m: JsonObject) => void }) {
  const doc = useConnection((s) => s.schema);
  const kinds = MODEL_KINDS.filter((k) => doc.defs[k.def]);
  const initialDef = kinds.find((k) => doc.resolve({ $ref: `#/$defs/${k.def}` }).properties?.kind?.const === props.initial?.kind)?.def ?? kinds[0]?.def;
  const [def, setDef] = useState(initialDef);
  const [value, setValue] = useState<Json>(() => props.initial ?? defaultFor(doc, { $ref: `#/$defs/${initialDef}` }));
  useEffect(() => props.onChange(value as JsonObject), [value]); // eslint-disable-line react-hooks/exhaustive-deps
  const node = { $ref: `#/$defs/${def}` };
  return (
    <>
      <div className="row wrap">
        {kinds.map((k) => (
          <button
            key={k.def}
            className={k.def === def ? "chip active" : "chip"}
            onClick={() => {
              setDef(k.def);
              setValue(defaultFor(doc, { $ref: `#/$defs/${k.def}` }));
            }}
          >
            {k.label}
          </button>
        ))}
      </div>
      <div className="row wrap presets">
        <span className="muted small">Presets:</span>
        {PRESETS.map((p) => (
          <button
            key={p.name}
            className="link"
            onClick={() => {
              const d = kinds.find((k) => doc.resolve({ $ref: `#/$defs/${k.def}` }).properties?.kind?.const === p.m.kind)?.def;
              if (d) setDef(d);
              setValue(JSON.parse(JSON.stringify(p.m)));
            }}
          >
            {p.name}
          </button>
        ))}
      </div>
      <SchemaForm
        doc={doc}
        node={node}
        value={value}
        onChange={(path, v) =>
          setValue((cur) => {
            if (path.length === 0) return v;
            const copy = JSON.parse(JSON.stringify(cur));
            let o = copy;
            for (const k of path.slice(0, -1)) o = o[k];
            o[path[path.length - 1]] = v;
            return copy;
          })
        }
      />
    </>
  );
}

function CsvImport(props: { onChange: (m: JsonObject | null) => void }) {
  const [text, setText] = useState("");
  const [unit, setUnit] = useState<"nm" | "um">("nm");
  const [source, setSource] = useState("");
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!text.trim()) return props.onChange(null);
    try {
      props.onChange(parseNkCsv(text, unit, source || undefined));
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
      props.onChange(null);
    }
  }, [text, unit, source]); // eslint-disable-line react-hooks/exhaustive-deps
  const onFile = async (f: File | undefined) => {
    if (!f) return;
    setText(await f.text());
    if (!source) setSource(f.name);
  };
  return (
    <div
      className="csv-import"
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void onFile(e.dataTransfer.files[0]);
      }}
    >
      <p className="muted small">
        Three columns: wavelength, n, k (comma, tab or space separated; <code>#</code> comments and a header row are fine). This is the same format as{" "}
        <code>Tabulated.from_csv</code> and refractiveindex.info exports. Drop a file here or paste.
      </p>
      <div className="row">
        <input type="file" accept=".csv,.txt,.tsv" onChange={(e) => void onFile(e.target.files?.[0])} data-testid="csv-file" />
        <label>
          unit{" "}
          <select value={unit} onChange={(e) => setUnit(e.target.value as "nm" | "um")}>
            <option value="nm">nm</option>
            <option value="um">µm</option>
          </select>
        </label>
      </div>
      <textarea rows={10} value={text} onChange={(e) => setText(e.target.value)} placeholder={"# wl_nm, n, k\n400, 1.47, 1.95\n500, 0.97, 1.87\n600, 0.25, 2.98"} data-testid="csv-text" />
      <input placeholder="Source / citation (stored in the spec)" value={source} onChange={(e) => setSource(e.target.value)} />
      {err && <div className="field-error">{err}</div>}
    </div>
  );
}
