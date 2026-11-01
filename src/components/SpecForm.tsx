// SchemaForm bound to the spec store at a path: the building block of every
// properties panel. Edits become `replace` ops (coalesced per field while typing).

import { useMemo } from "react";
import { SchemaForm } from "../schema/SchemaForm";
import { type Path } from "../schema/schema";
import { validateProblem, type Issue } from "../schema/validate";
import { useConnection } from "../state/connection";
import { getAt } from "../state/ops";
import { useSpec } from "../state/store";
import { materialOverride } from "./MaterialEditor";

export function useIssues(): Issue[] {
  const spec = useSpec((s) => s.spec);
  const doc = useConnection((s) => s.schema);
  return useMemo(() => validateProblem(doc, spec), [doc, spec]);
}

export function useIssueMap(): Map<string, string> {
  const issues = useIssues();
  return useMemo(() => {
    const m = new Map<string, string>();
    for (const i of issues) {
      const k = i.path.join("/");
      m.set(k, m.has(k) ? `${m.get(k)}; ${i.message}` : i.message);
    }
    return m;
  }, [issues]);
}

export const OVERRIDES = [materialOverride];

export function SpecForm(props: { path: Path; label?: string }) {
  const spec = useSpec((s) => s.spec);
  const apply = useSpec((s) => s.apply);
  const doc = useConnection((s) => s.schema);
  const issues = useIssueMap();
  const node = useMemo(() => doc.nodeAt(doc.problemNode(), spec, props.path), [doc, spec, props.path]);
  if (!node) return <div className="muted">No schema for {props.path.join(".")}</div>;
  return (
    <SchemaForm
      doc={doc}
      node={node}
      value={getAt(spec, props.path) ?? null}
      path={props.path}
      label={props.label}
      issues={issues}
      overrides={OVERRIDES}
      onChange={(path, value) => apply({ op: "replace", path, value }, { coalesceKey: path.join("/") })}
    />
  );
}
