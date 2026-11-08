// Set one number in a spec by JSON path, creating missing objects (or lists before an index): the rule of the
// compute server's sweep jobs (lightsmith_cloud/sweep.py), shared by Studio's own sweeps and the mock.

import { clone, isObject, type Json, type JsonObject, type Path } from "../schema/schema";

export function withValue(spec: JsonObject, path: Path, value: number): JsonObject {
  const s = clone(spec) as JsonObject;
  let o: JsonObject | Json[] = s;
  for (let i = 0; i < path.length - 1; i++) {
    const k = path[i] as never;
    const next = (o as Record<string, Json>)[k];
    if (!isObject(next ?? null) && !Array.isArray(next)) (o as Record<string, Json>)[k] = typeof path[i + 1] === "number" ? [] : {};
    o = (o as Record<string, Json>)[k] as JsonObject;
  }
  (o as Record<string, Json>)[path[path.length - 1] as never] = value;
  return s;
}
