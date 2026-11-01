// Spec edits as data. Every UI action (and every script / agent action) is a
// list of these ops applied to the spec JSON, which makes the whole GUI
// replayable and scriptable. Paths are arrays of keys / indices.

import { isObject, type Json, type Path } from "../schema/schema";

export type Op =
  | { op: "replace"; path: Path; value: Json }
  /** Insert into an array at path (last segment is the index, "-" appends) or add an object key. */
  | { op: "add"; path: Path; value: Json }
  | { op: "remove"; path: Path }
  | { op: "move"; from: Path; path: Path };

export function getAt(root: Json | undefined, path: Path): Json | undefined {
  let cur: Json | undefined = root;
  for (const k of path) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string | number, Json>)[k as never];
  }
  return cur;
}

function shallowCopy(v: Json): Json {
  if (Array.isArray(v)) return v.slice();
  if (isObject(v)) return { ...v };
  return v;
}

/** Return a copy of root with fn applied to the container at `path` (copy-on-write along the path). */
function updateIn(root: Json, path: Path, fn: (container: Json) => Json): Json {
  if (path.length === 0) return fn(root);
  const [head, ...rest] = path;
  const base: Json = root === null || typeof root !== "object" ? (typeof head === "number" ? [] : {}) : root;
  const copy = shallowCopy(base) as Record<string | number, Json>;
  copy[head as never] = updateIn(copy[head as never] ?? (typeof rest[0] === "number" ? [] : {}), rest, fn);
  return copy as Json;
}

export function setAt(root: Json, path: Path, value: Json): Json {
  if (path.length === 0) return value;
  const parent = path.slice(0, -1);
  const key = path[path.length - 1];
  return updateIn(root, parent, (c) => {
    const copy = shallowCopy(c) as Record<string | number, Json>;
    copy[key as never] = value;
    return copy as Json;
  });
}

export function removeAt(root: Json, path: Path): Json {
  const parent = path.slice(0, -1);
  const key = path[path.length - 1];
  return updateIn(root, parent, (c) => {
    if (Array.isArray(c)) return c.filter((_, i) => i !== key);
    if (isObject(c)) {
      const { [key as string]: _drop, ...rest } = c;
      return rest;
    }
    return c;
  });
}

export function addAt(root: Json, path: Path, value: Json): Json {
  const parent = path.slice(0, -1);
  const key = path[path.length - 1];
  return updateIn(root, parent, (c) => {
    if (Array.isArray(c)) {
      const arr = c.slice();
      const idx = key === "-" ? arr.length : Math.max(0, Math.min(arr.length, Number(key)));
      arr.splice(idx, 0, value);
      return arr;
    }
    return { ...(isObject(c) ? c : {}), [key as string]: value };
  });
}

export function applyOp(root: Json, op: Op): Json {
  switch (op.op) {
    case "replace":
      return setAt(root, op.path, op.value);
    case "add":
      return addAt(root, op.path, op.value);
    case "remove":
      return removeAt(root, op.path);
    case "move": {
      const v = getAt(root, op.from);
      if (v === undefined) return root;
      return addAt(removeAt(root, op.from), op.path, v);
    }
  }
}

export function applyOps(root: Json, ops: Op[]): Json {
  return ops.reduce(applyOp, root);
}
