// "Copy as Python / CLI / curl": the current spec and run settings as code that
// does exactly what the GUI would do. This is the visible side of the 1:1
// parity: anything Studio runs, the library runs the same way.

import { isObject, type Json } from "../schema/schema";
import type { Operation } from "../api/types";
import { LIBRARY } from "../config/brand";

export interface RunArgs {
  operation: Operation;
  method: string;
  device: string;
  methods?: string[] | null;
}

const PY_INDENT = "    ";

function pyString(s: string): string {
  return JSON.stringify(s); // JSON string escapes are valid Python string escapes
}

function pyScalar(v: Json): string {
  if (v === null) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : v > 0 ? 'float("inf")' : v < 0 ? 'float("-inf")' : 'float("nan")';
  return pyString(v as string);
}

function isFlat(v: Json[]): boolean {
  return v.every((x) => x === null || typeof x !== "object");
}

function wrapList(items: string[], indent: string, open: string, close: string, width = 96): string {
  const one = open + items.join(", ") + close;
  if (one.length + indent.length <= width) return one;
  const lines: string[] = [];
  let line = "";
  for (const it of items) {
    if (line && line.length + it.length + 2 > width - indent.length - PY_INDENT.length) {
      lines.push(line + ",");
      line = it;
    } else line = line ? `${line}, ${it}` : it;
  }
  if (line) lines.push(line + ",");
  return `${open}\n${lines.map((l) => indent + PY_INDENT + l).join("\n")}\n${indent}${close}`;
}

export function toPython(v: Json, indent = ""): string {
  if (Array.isArray(v)) {
    if (v.length === 0) return "[]";
    if (isFlat(v)) return wrapList(v.map(pyScalar), indent, "[", "]");
    return `[\n${v.map((x) => indent + PY_INDENT + toPython(x, indent + PY_INDENT) + ",").join("\n")}\n${indent}]`;
  }
  if (isObject(v)) {
    const keys = Object.keys(v);
    if (keys.length === 0) return "{}";
    const flat = keys.every((k) => v[k] === null || typeof v[k] !== "object" || (Array.isArray(v[k]) && isFlat(v[k] as Json[]) && (v[k] as Json[]).length <= 3));
    const parts = keys.map((k) => `${pyString(k)}: ${toPython(v[k], indent + PY_INDENT)}`);
    if (flat) {
      const one = `{${parts.join(", ")}}`;
      if (one.length + indent.length <= 96) return one;
    }
    return `{\n${parts.map((p) => indent + PY_INDENT + p + ",").join("\n")}\n${indent}}`;
  }
  return pyScalar(v);
}

function pyArgs(a: RunArgs): string {
  const out: string[] = [];
  if (a.operation === "compare") {
    if (a.methods?.length) out.push(`methods=${toPython(a.methods)}`);
  } else out.push(`method=${pyString(a.method)}`);
  out.push(`device=${pyString(a.device)}`);
  return out.join(", ");
}

const isScatteringSpec = (spec: Json) => !isObject(spec) || spec.kind === undefined || spec.kind === "scattering";

export function pythonCode(spec: Json, a: RunArgs): string {
  const head = `import ${LIBRARY.python} as ${LIBRARY.alias}\n\nspec = ${toPython(spec)}\n\n`;
  switch (a.operation) {
    case "estimate":
      return head + `print(${LIBRARY.alias}.estimate(spec, ${pyArgs(a)}))\n`;
    case "compare":
      // Scattering: relative differences of the cross sections; other kinds: their own (R/T/A, |S|², n_eff, ...).
      return (
        head +
        `cmp = ${LIBRARY.alias}.compare(spec, ${pyArgs(a)})\n` +
        `print("reference:", cmp["reference"])\n` +
        `for name, diff in cmp["relative_difference"].items():\n` +
        `    print(name, diff)\n` +
        `for name in cmp.get("not_compared", []):\n` +
        `    print(name, "cannot be compared with the reference")\n`
      );
    default:
      // Only cross sections have summary(); every result of every kind is a pydantic model.
      return (
        head +
        `print(${LIBRARY.alias}.estimate(spec, ${pyArgs(a)}))  # size / memory before running\n` +
        `result = ${LIBRARY.alias}.solve(spec, ${pyArgs(a)})\n` +
        (isScatteringSpec(spec)
          ? `print(result.summary())\n`
          : `with open("result.json", "w", encoding="utf-8") as f:\n` +
            `    f.write(result.model_dump_json())\n` +
            `print(result.kind, "from", result.backend, "written to result.json")\n`) +
        `for w in result.warnings:\n` +
        `    print("warning:", w)\n`
      );
  }
}

export type Shell = "bash" | "powershell";

function cliFlags(a: RunArgs): string {
  const f: string[] = [];
  if (a.operation === "compare") {
    if (a.methods?.length) f.push(`--methods ${a.methods.join(",")}`);
  } else f.push(`--method ${a.method}`);
  f.push(`--device ${a.device}`);
  return f.join(" ");
}

export function cliCode(spec: Json, a: RunArgs, shell: Shell = "bash", file = "spec.json"): string {
  const json = JSON.stringify(spec, null, 2);
  const write = shell === "bash" ? `cat > ${file} <<'EOF'\n${json}\nEOF\n` : `@'\n${json}\n'@ | Set-Content -Encoding utf8 ${file}\n`;
  const out = a.operation === "estimate" ? "" : ` -o ${a.operation === "compare" ? "compare" : "result"}.json`;
  const pre = a.operation === "solve" ? `${LIBRARY.cli} estimate ${file} ${cliFlags({ ...a, operation: "estimate" })}\n` : "";
  return `${write}${pre}${LIBRARY.cli} ${a.operation} ${file} ${cliFlags(a)}${out}\n`;
}

/** The compute API request Studio itself sends. */
export function curlCode(spec: Json, a: RunArgs, baseUrl: string, withKey: boolean): string {
  const body = JSON.stringify(
    a.operation === "estimate"
      ? { simulation: spec, method: a.method, device: a.device }
      : a.operation === "compare"
        ? { simulation: spec, kind: "compare", methods: a.methods ?? null, device: a.device }
        : { simulation: spec, kind: "solve", method: a.method, device: a.device },
    null,
    2,
  );
  const auth = withKey ? ` \\\n  -H "Authorization: Bearer $LIGHTSMITH_API_KEY"` : "";
  const path = a.operation === "estimate" ? "/v1/estimate" : "/v1/jobs";
  return `curl -sS -X POST ${baseUrl.replace(/\/+$/, "")}${path} \\\n  -H "Content-Type: application/json"${auth} \\\n  --data-binary @- <<'EOF'\n${body}\nEOF\n`;
}

/** Arguments for the MCP tool of the same name (LIBRARY.mcp's `estimate`, `solve` and `compare` take `problem`). */
export function mcpCall(spec: Json, a: RunArgs): string {
  const args: Record<string, Json> = { problem: spec, device: a.device };
  if (a.operation === "compare") args.methods = a.methods ?? null;
  else args.method = a.method;
  return JSON.stringify({ tool: a.operation, arguments: args }, null, 2);
}
