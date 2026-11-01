// A 2D canvas (nm, y up) for cross-sections, unit cells and device top views. Shapes are spec
// paths: clicking selects that path in the tree, dragging moves the shape (one undoable,
// coalesced op per drag), the wheel zooms, dragging the background pans.

import { useMemo, useRef, useState } from "react";
import { materialColor } from "../../physics/materials";
import type { Json, JsonObject, Path } from "../../schema/schema";
import { useSpec } from "../../state/store";
import { profileBounds, profilePath, type XY } from "./geometry2d";

export interface Shape2D {
  key: string;
  /** Selected when clicked. */
  select: Path;
  profile: JsonObject;
  material: Json;
  label?: string;
  /** Return the replacement value for `select` after moving by (dx, dy); omit for fixed shapes. */
  move?: (dx: number, dy: number) => Json;
  ghost?: boolean;
  hatch?: boolean;
}

export interface Overlay2D {
  key: string;
  /** Closed polygon (frames, unit cells, windows) or open polyline (ports). */
  points: XY[];
  closed?: boolean;
  color: string;
  dash?: boolean;
  label?: string;
  select?: Path;
  arrow?: boolean;
}

const same = (a: Path | null, b: Path) => !!a && a.length === b.length && a.every((x, i) => x === b[i]);
const startsWith = (a: Path | null, b: Path) => !!a && b.every((x, i) => a[i] === x);

export function CrossSection(props: { shapes: Shape2D[]; overlays?: Overlay2D[]; title?: string; xLabel?: string; yLabel?: string; testId?: string; empty?: string }) {
  const selection = useSpec((s) => s.selection);
  const select = useSpec((s) => s.select);
  const apply = useSpec((s) => s.apply);
  const svg = useRef<SVGSVGElement>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<XY>([0, 0]);
  const [drag, setDrag] = useState<{ shape?: Shape2D; start: XY; last: XY; panStart?: XY } | null>(null);

  const bounds = useMemo(() => {
    const bs = [...props.shapes.map((s) => profileBounds(s.profile)), ...(props.overlays ?? []).map((o) => (o.points.length ? ([Math.min(...o.points.map((p) => p[0])), Math.min(...o.points.map((p) => p[1])), Math.max(...o.points.map((p) => p[0])), Math.max(...o.points.map((p) => p[1]))] as [number, number, number, number]) : null))].filter(Boolean) as [number, number, number, number][];
    if (!bs.length) return [-500, -500, 500, 500];
    const b = [Math.min(...bs.map((x) => x[0])), Math.min(...bs.map((x) => x[1])), Math.max(...bs.map((x) => x[2])), Math.max(...bs.map((x) => x[3]))];
    const pad = Math.max(b[2] - b[0], b[3] - b[1]) * 0.08 + 1;
    return [b[0] - pad, b[1] - pad, b[2] + pad, b[3] + pad];
  }, [props.shapes, props.overlays]);
  const w = (bounds[2] - bounds[0]) / zoom;
  const h = (bounds[3] - bounds[1]) / zoom;
  const cx = (bounds[0] + bounds[2]) / 2 + pan[0];
  const cy = (bounds[1] + bounds[3]) / 2 + pan[1];
  // y up: flip with a group transform; viewBox stays in screen orientation.
  const viewBox = `${cx - w / 2} ${-cy - h / 2} ${w} ${h}`;
  const unit = Math.max(w, h) / 600; // ~1 px in nm at 600 px

  const toNm = (e: React.PointerEvent): XY => {
    const el = svg.current!;
    const pt = el.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const m = el.getScreenCTM()?.inverse();
    const p = m ? pt.matrixTransform(m) : pt;
    return [p.x, -p.y];
  };

  const gridStep = useMemo(() => {
    const raw = Math.max(w, h) / 10;
    const pow = 10 ** Math.floor(Math.log10(raw));
    return [1, 2, 5, 10].map((f) => f * pow).find((s) => s >= raw) ?? raw;
  }, [w, h]);

  const gridLines = useMemo(() => {
    const lines: React.ReactElement[] = [];
    const x0 = Math.floor((cx - w) / gridStep) * gridStep;
    const y0 = Math.floor((cy - h) / gridStep) * gridStep;
    for (let x = x0; x <= cx + w; x += gridStep) lines.push(<line key={`x${x}`} x1={x} x2={x} y1={cy - h} y2={cy + h} className={Math.abs(x) < 1e-9 ? "axis0" : "grid"} />);
    for (let y = y0; y <= cy + h; y += gridStep) lines.push(<line key={`y${y}`} y1={y} y2={y} x1={cx - w} x2={cx + w} className={Math.abs(y) < 1e-9 ? "axis0" : "grid"} />);
    return lines;
  }, [cx, cy, w, h, gridStep]);

  return (
    <div className="cross-section" data-testid={props.testId ?? "cross-section"}>
      <svg
        ref={svg}
        viewBox={viewBox}
        preserveAspectRatio="xMidYMid meet"
        style={{ ["--u" as string]: unit }}
        onWheel={(e) => setZoom((z) => Math.min(50, Math.max(0.2, z * (e.deltaY < 0 ? 1.15 : 1 / 1.15))))}
        onPointerDown={(e) => {
          if (e.target === svg.current || (e.target as Element).classList.contains("grid") || (e.target as Element).classList.contains("axis0")) {
            const p = toNm(e);
            setDrag({ start: p, last: p, panStart: pan });
            (e.target as Element).setPointerCapture?.(e.pointerId);
          }
        }}
        onPointerMove={(e) => {
          if (!drag) return;
          const p = toNm(e);
          if (drag.panStart) {
            setPan([drag.panStart[0] - (p[0] - drag.start[0]) * 0.5, drag.panStart[1] - (p[1] - drag.start[1]) * 0.5]);
            return;
          }
          const s = drag.shape!;
          if (!s.move) return;
          const total: XY = [p[0] - drag.start[0], p[1] - drag.start[1]];
          const snap = (x: number) => (e.shiftKey ? x : Math.round(x / (gridStep / 10)) * (gridStep / 10));
          apply({ op: "replace", path: s.select, value: s.move(snap(total[0]), snap(total[1])) }, { coalesceKey: `drag2d:${s.select.join("/")}` });
          setDrag({ ...drag, last: p });
        }}
        onPointerUp={() => setDrag(null)}
        onPointerLeave={() => setDrag(null)}
      >
        <defs>
          <pattern id="hatch" width={gridStep / 4} height={gridStep / 4} patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2={gridStep / 4} stroke="#f2c94c" strokeWidth={unit * 1.5} />
          </pattern>
          <marker id="arrow" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
            <path d="M0,0L10,5L0,10z" fill="#4f9dff" />
          </marker>
        </defs>
        <g transform="scale(1,-1)">
          {gridLines}
          {props.shapes.map((s) => {
            const active = same(selection, s.select) || startsWith(selection, s.select);
            return (
              <path
                key={s.key}
                d={profilePath(s.profile)}
                className={`shape${active ? " active" : ""}${s.ghost ? " ghost" : ""}`}
                fill={s.hatch ? "url(#hatch)" : materialColor(s.material)}
                data-testid={`shape-${s.select.join("/")}`}
                onPointerDown={(e) => {
                  if (s.ghost) return;
                  e.stopPropagation();
                  select(s.select);
                  const p = toNm(e);
                  if (s.move) {
                    // s.move closes over the value at drag start, so the total offset is applied to it
                    setDrag({ shape: s, start: p, last: p });
                    (e.target as Element).setPointerCapture?.(e.pointerId);
                  }
                }}
              >
                {s.label && <title>{s.label}</title>}
              </path>
            );
          })}
          {(props.overlays ?? []).map((o) => (
            <polyline
              key={o.key}
              points={(o.closed ? [...o.points, o.points[0]] : o.points).map((p) => p.join(",")).join(" ")}
              className={`overlay${o.dash ? " dash" : ""}${o.select && same(selection, o.select) ? " active" : ""}`}
              stroke={o.color}
              markerEnd={o.arrow ? "url(#arrow)" : undefined}
              onPointerDown={(e) => {
                if (!o.select) return;
                e.stopPropagation();
                select(o.select);
              }}
            />
          ))}
        </g>
        {props.shapes
          .filter((s) => s.label && !s.ghost)
          .map((s) => {
            const b = profileBounds(s.profile);
            if (!b) return null;
            return (
              <text key={`t-${s.key}`} x={(b[0] + b[2]) / 2} y={-b[3] - unit * 6} className="shape-label" fontSize={unit * 12} textAnchor="middle">
                {s.label}
              </text>
            );
          })}
        {(props.overlays ?? [])
          .filter((o) => o.label && o.points.length)
          .map((o) => {
            // closed frames: label inside the top-left corner; lines: beside the first point
            const x0 = Math.min(...o.points.map((p) => p[0]));
            const y1 = Math.max(...o.points.map((p) => p[1]));
            return (
              <text key={`t-${o.key}`} x={x0 + unit * 6} y={-y1 + unit * 16} className="shape-label" fontSize={unit * 11} fill={o.color} textAnchor="start">
                {o.label}
              </text>
            );
          })}
      </svg>
      <div className="cs-toolbar">
        {props.title && <b>{props.title}</b>}
        <span className="muted small">
          grid {gridStep} nm · {props.xLabel ?? "x"} → {props.yLabel ?? "y"} ↑ · drag shapes to move (Shift: no snap) · wheel to zoom
        </span>
        <button className="small" onClick={() => (setZoom(1), setPan([0, 0]))}>
          Fit
        </button>
      </div>
      {!props.shapes.length && props.empty && <div className="cs-empty muted">{props.empty}</div>}
    </div>
  );
}
