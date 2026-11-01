// 2D geometry helpers for profiles (rectangle, circle, ellipse, polygon) and for the xy
// footprint of 3D geometry (prism, box, ball), in nm.

import { isObject, type Json, type JsonObject, type Path } from "../../schema/schema";

export type XY = [number, number];

const num = (v: Json | undefined, d = 0) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const pair = (v: Json | undefined, d: XY = [0, 0]): XY => (Array.isArray(v) && v.length >= 2 ? [num(v[0], d[0]), num(v[1], d[1])] : d);

/** SVG path for a profile (y up is handled by the caller's transform). */
export function profilePath(p: Json): string {
  if (!isObject(p)) return "";
  switch (p.kind) {
    case "rectangle": {
      const [cx, cy] = pair(p.center_nm);
      const [w, h] = pair(p.size_nm, [1, 1]);
      return `M${cx - w / 2},${cy - h / 2}h${w}v${h}h${-w}z`;
    }
    case "circle": {
      const [cx, cy] = pair(p.center_nm);
      const r = num(p.radius_nm, 1);
      return `M${cx - r},${cy}a${r},${r} 0 1,0 ${2 * r},0a${r},${r} 0 1,0 ${-2 * r},0z`;
    }
    case "ellipse": {
      const [cx, cy] = pair(p.center_nm);
      const [a, b] = pair(p.semi_axes_nm, [1, 1]);
      const t = (num(p.angle_deg) * Math.PI) / 180;
      const pts = Array.from({ length: 72 }, (_, i) => {
        const s = (i / 72) * 2 * Math.PI;
        const x = a * Math.cos(s);
        const y = b * Math.sin(s);
        return [cx + x * Math.cos(t) - y * Math.sin(t), cy + x * Math.sin(t) + y * Math.cos(t)];
      });
      return `M${pts.map((q) => q.join(",")).join("L")}z`;
    }
    case "polygon": {
      const vs = (Array.isArray(p.vertices_nm) ? p.vertices_nm : []).map((v) => pair(v));
      return vs.length ? `M${vs.map((q) => q.join(",")).join("L")}z` : "";
    }
    default:
      return "";
  }
}

export function profileBounds(p: Json): [number, number, number, number] | null {
  if (!isObject(p)) return null;
  switch (p.kind) {
    case "rectangle": {
      const [cx, cy] = pair(p.center_nm);
      const [w, h] = pair(p.size_nm, [1, 1]);
      return [cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2];
    }
    case "circle": {
      const [cx, cy] = pair(p.center_nm);
      const r = num(p.radius_nm, 1);
      return [cx - r, cy - r, cx + r, cy + r];
    }
    case "ellipse": {
      const [cx, cy] = pair(p.center_nm);
      const m = Math.max(...pair(p.semi_axes_nm, [1, 1]));
      return [cx - m, cy - m, cx + m, cy + m];
    }
    case "polygon": {
      const vs = (Array.isArray(p.vertices_nm) ? p.vertices_nm : []).map((v) => pair(v));
      if (!vs.length) return null;
      return [Math.min(...vs.map((v) => v[0])), Math.min(...vs.map((v) => v[1])), Math.max(...vs.map((v) => v[0])), Math.max(...vs.map((v) => v[1]))];
    }
    default:
      return null;
  }
}

/** The profile translated by (dx, dy). */
export function moveProfile(p: JsonObject, dx: number, dy: number): JsonObject {
  const r = (x: number) => Math.round(x * 10) / 10;
  if (p.kind === "polygon") return { ...p, vertices_nm: ((p.vertices_nm as Json[]) ?? []).map((v) => pair(v)).map(([x, y]) => [r(x + dx), r(y + dy)]) };
  const [cx, cy] = pair(p.center_nm);
  return { ...p, center_nm: [r(cx + dx), r(cy + dy)] };
}

/** A 3D geometry's footprint in the xy plane, as a profile, plus how to move it. */
export function footprint(g: Json): { profile: JsonObject; at: Path; move: (dx: number, dy: number) => JsonObject } | null {
  if (!isObject(g)) return null;
  const r = (x: number) => Math.round(x * 10) / 10;
  if (g.kind === "prism" && isObject(g.profile)) return { profile: g.profile, at: ["profile"], move: (dx, dy) => ({ ...g, profile: moveProfile(g.profile as JsonObject, dx, dy) }) };
  if (g.kind === "box") {
    const c = (g.center_nm as number[]) ?? [0, 0, 0];
    const s = (g.size_nm as number[]) ?? [1, 1, 1];
    return { profile: { kind: "rectangle", center_nm: [c[0], c[1]], size_nm: [s[0], s[1]] }, at: [], move: (dx, dy) => ({ ...g, center_nm: [r(c[0] + dx), r(c[1] + dy), c[2]] }) };
  }
  if (g.kind === "ball") {
    const c = (g.center_nm as number[]) ?? [0, 0, 0];
    return { profile: { kind: "circle", center_nm: [c[0], c[1]], radius_nm: num(g.radius_nm, 1) }, at: [], move: (dx, dy) => ({ ...g, center_nm: [r(c[0] + dx), r(c[1] + dy), c[2]] }) };
  }
  return null;
}

/** Corners of the unit cell spanned by a1, a2 (centred on the origin). */
export function cellPolygon(a1: XY, a2: XY): XY[] {
  const h = (k: number, l: number): XY => [(k * a1[0] + l * a2[0]) / 2, (k * a1[1] + l * a2[1]) / 2];
  return [h(-1, -1), h(1, -1), h(1, 1), h(-1, 1)];
}
