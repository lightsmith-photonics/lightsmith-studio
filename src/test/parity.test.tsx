// Parity test: every field of every problem kind in the library's JSON Schema
// must have an editor in Studio. It walks the schema and renders the generic
// form for every object definition with all optional fields switched on, then
// checks that each (definition, property) pair produced an editor.
//
// By default it uses the snapshot in src/generated/schema.json (refresh with
// `npm run sync:library`). Set STUDIO_SCHEMA_URL=http://localhost:8200/v1/schema
// to run it against a live compute server instead.

import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import bundled from "../generated/schema.json";
import backends from "../generated/backends.json";
import { SchemaForm } from "../schema/SchemaForm";
import { allFields, classify, maximalValue, refName, SchemaDoc, type JSONSchema } from "../schema/schema";

async function loadSchema(): Promise<JSONSchema> {
  const url = process.env.STUDIO_SCHEMA_URL;
  if (!url) return bundled as JSONSchema;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`could not fetch ${url}: ${res.status}`);
  return res.json();
}

const schema = await loadSchema();
const doc = new SchemaDoc(schema);

function renderedProps(node: JSONSchema, value: unknown): Set<string> {
  const { container } = render(<SchemaForm doc={doc} node={node} value={value as never} onChange={() => {}} />);
  return new Set([...container.querySelectorAll("[data-schema-prop]")].map((e) => e.getAttribute("data-schema-prop")!));
}

describe("schema parity", () => {
  const fields = allFields(doc);

  it("finds the problem kinds", () => {
    const kinds = doc.problemKinds().map((k) => k.kind);
    expect(kinds).toContain("scattering");
  });

  it("classifies every field with a known editor", () => {
    const unknown = fields.filter((f) => f.kind === "unknown").map((f) => f.id);
    expect(unknown, `fields without an editor: ${unknown.join(", ")}`).toEqual([]);
  });

  const objectDefs = Object.entries<JSONSchema>(doc.defs).filter(([, d]) => classify(doc, d) === "object");

  it.each(objectDefs.map(([name]) => [name]))("renders an editor for every property of %s", (name) => {
    const node = { $ref: `#/$defs/${name}` };
    const value = maximalValue(doc, node);
    const seen = renderedProps(node, value);
    const missing = Object.keys(doc.defs[name].properties ?? {}).filter((k) => !seen.has(`${name}.${k}`));
    expect(missing, `${name}: properties without an editor`).toEqual([]);
  });

  it("covers every field reachable from the root", () => {
    // Fields of named defs are covered above; inline objects (no $def) must be covered via their parent.
    const inline = fields.filter((f) => !doc.defs[f.def]);
    const node = doc.root;
    const seen = renderedProps(node, maximalValue(doc, node));
    const missing = inline.filter((f) => !refName(node) && f.def === (doc.resolve(node).title ?? "root") && !seen.has(f.id)).map((f) => f.id);
    expect(missing).toEqual([]);
  });

  it("fails for a field the GUI cannot edit (negative control)", () => {
    const future = new SchemaDoc({
      type: "object",
      title: "Future",
      properties: { ok: { type: "number" }, weird: { allOf: [{ type: "number" }, { minimum: 0 }] }, odd: { type: "frobnicate" } },
    });
    const bad = allFields(future).filter((f) => f.kind === "unknown").map((f) => f.id);
    expect(bad).toEqual(["Future.weird", "Future.odd"]);
  });

  it.each((backends as { name: string; options_schema: JSONSchema | null }[]).filter((b) => b.options_schema).map((b) => [b.name, b.options_schema!]))(
    "renders every option of backend %s",
    (_name, os) => {
      const odoc = new SchemaDoc(os);
      const { container } = render(<SchemaForm doc={odoc} node={os} value={maximalValue(odoc, os) as never} onChange={() => {}} />);
      const seen = new Set([...container.querySelectorAll("[data-schema-prop]")].map((e) => e.getAttribute("data-schema-prop")!.split(".").pop()));
      const missing = Object.keys(os.properties ?? {}).filter((k) => !seen.has(k));
      expect(missing).toEqual([]);
    },
  );
});
