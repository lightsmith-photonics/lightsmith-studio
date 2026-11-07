// New project: pick the problem kind first, then a starting point.

import { useState } from "react";
import { useConnection } from "../state/connection";
import { newFromTemplate, newProblemOfKind } from "../state/actions";
import { KIND_TEMPLATES, kindMeta } from "../state/kinds";
import { TEMPLATES } from "../state/templates";
import { FDTD_TEMPLATES } from "../api/mock/snapshots";
import { loadSpec } from "../state/actions";
import { forgetCurrentFile } from "../lib/files";
import { toast } from "../state/toast";
import { useUi } from "../state/ui";
import { Modal } from "./Modal";

export function NewProjectDialog() {
  const open = useUi((s) => s.newOpen);
  const setOpen = useUi((s) => s.openNew);
  const doc = useConnection((s) => s.schema);
  const kinds = doc.problemKinds();
  const [kind, setKind] = useState(kinds[0]?.kind ?? "scattering");
  if (!open) return null;
  const pick = (f: () => void) => {
    try {
      f();
      setOpen(false);
    } catch (e) {
      toast((e as Error).message, "error");
    }
  };
  const meta = kindMeta(kind, kinds.find((k) => k.kind === kind)?.title);
  const description = doc.resolve(kinds.find((k) => k.kind === kind)?.node ?? {}).description as string | undefined;
  return (
    <Modal title="New project" onClose={() => setOpen(false)} wide testId="new-project">
      <div className="new-project">
        <div className="kind-grid" role="radiogroup" aria-label="Problem kind">
          {kinds.map((k) => {
            const m = kindMeta(k.kind, k.title);
            return (
              <button key={k.kind} className={`kind-card${k.kind === kind ? " active" : ""}`} onClick={() => setKind(k.kind)} data-testid={`kind-${k.kind}`} role="radio" aria-checked={k.kind === kind}>
                <span className="kind-icon">{m.icon}</span>
                <b>{m.label}</b>
                <span className="muted small">{m.blurb || k.title}</span>
              </button>
            );
          })}
        </div>
        <div className="kind-start">
          <h3>
            {meta.icon} {meta.label} <code className="muted small">kind: "{kind}"</code>
          </h3>
          {description && <p className="muted small">{description.split("\n")[0]}</p>}
          <h4>Start from</h4>
          {kind === "scattering" ? (
            <div className="start-list">
              {KIND_TEMPLATES[kind] && (
                <button className="start-item" onClick={() => pick(() => newProblemOfKind(kind, "example"))} data-testid="start-example">
                  <b>Example</b>
                  <span className="muted small">A gold sphere with near and far fields, solved by the library; its Preview shows every backend's discretisation.</span>
                </button>
              )}
              {TEMPLATES.map((t) => (
                <button key={t.id} className="start-item" onClick={() => pick(() => newFromTemplate(t.id))} data-testid={`start-${t.id}`}>
                  <b>{t.name}</b>
                  <span className="muted small">{t.description}</span>
                </button>
              ))}
            </div>
          ) : (
            <div className="start-list">
              {KIND_TEMPLATES[kind] && (
                <button className="start-item" onClick={() => pick(() => newProblemOfKind(kind, "example"))} data-testid="start-example">
                  <b>Example</b>
                  <span className="muted small">A small worked example the library has solved.</span>
                </button>
              )}
              {FDTD_TEMPLATES.filter((t) => t.spec.kind === kind).map((t) => (
                <button key={t.id} className="start-item" onClick={() => pick(() => (forgetCurrentFile(), loadSpec(t.spec, { fileName: null })))} data-testid={`start-${t.id}`}>
                  <b>{t.name}</b>
                  <span className="muted small">{t.description}</span>
                </button>
              ))}
              <button className="start-item" onClick={() => pick(() => newProblemOfKind(kind, "blank"))} data-testid="start-blank">
                <b>Blank</b>
                <span className="muted small">Required fields only, filled with schema defaults.</span>
              </button>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
