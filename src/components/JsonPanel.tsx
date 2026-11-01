// Live spec JSON. It is the app state itself: editing here is the same as
// editing in the GUI (one undoable op), and it validates against the schema.

import { json } from "@codemirror/lang-json";
import CodeMirror from "@uiw/react-codemirror";
import { useEffect, useMemo, useState } from "react";
import { isObject } from "../schema/schema";
import { useSpec } from "../state/store";
import { useIssues } from "./SpecForm";

export function JsonPanel() {
  const spec = useSpec((s) => s.spec);
  const lastOps = useSpec((s) => s.lastOps);
  const select = useSpec((s) => s.select);
  const issues = useIssues();
  const text = useMemo(() => JSON.stringify(spec, null, 2), [spec]);
  const [draft, setDraft] = useState(text);
  const [err, setErr] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const extensions = useMemo(() => [json()], []);
  useEffect(() => {
    if (!focused) setDraft(text);
  }, [text, focused]);

  return (
    <div className="json-panel" data-testid="json-panel">
      <div className="row">
        <span className="muted small grow">Spec JSON — identical to what the CLI reads. Edits apply as you type (undo with Ctrl+Z).</span>
        <button className="small" onClick={() => void navigator.clipboard?.writeText(text)}>
          Copy
        </button>
      </div>
      <div onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} className="cm-wrap">
        <CodeMirror
          value={draft}
          height="100%"
          theme="dark"
          extensions={extensions}
          basicSetup={{ foldGutter: true, lineNumbers: true }}
          onChange={(v) => {
            setDraft(v);
            try {
              const parsed = JSON.parse(v);
              if (!isObject(parsed)) throw new Error("the spec must be a JSON object");
              setErr(null);
              if (JSON.stringify(parsed) !== JSON.stringify(spec)) useSpec.getState().apply({ op: "replace", path: [], value: parsed }, { coalesceKey: "json-editor" });
            } catch (e) {
              setErr((e as Error).message);
            }
          }}
          data-testid="json-editor"
        />
      </div>
      {err && <div className="field-error">JSON: {err}</div>}
      <div className="issues" data-testid="issues">
        {issues.length === 0 ? (
          <div className="ok small">✓ valid against the {"schema"}</div>
        ) : (
          issues.map((i, k) => (
            <button key={k} className="issue" onClick={() => select(i.path.slice(0, i.path[0] === "particles" ? 2 : 1))}>
              <code>{i.path.join(".") || "(root)"}</code> {i.message}
            </button>
          ))
        )}
      </div>
      <div className="muted small last-op" data-testid="last-op">
        Last edit: {lastOps.map((o) => `${o.op} /${("path" in o ? o.path : []).join("/")}`).join(", ") || "—"}
      </div>
      <div className="muted small">
        Scripting: <code>window.studio.apply([{"{"}op: "replace", path: ["medium_index"], value: 1.5{"}"}])</code> — see README.
      </div>
    </div>
  );
}
