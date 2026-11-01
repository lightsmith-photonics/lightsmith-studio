// Tiny n/k preview drawn as inline SVG (no plotting library needed).

export function NkSparkline(props: { wl: number[]; n: number[]; k: number[]; width?: number; height?: number; band?: [number, number] | null }) {
  const W = props.width ?? 180;
  const H = props.height ?? 44;
  const pts = props.wl.map((w, i) => [w, props.n[i], props.k[i]]).filter((p) => p.every(Number.isFinite));
  if (pts.length < 2) return <svg width={W} height={H} className="sparkline" />;
  const x0 = Math.min(...pts.map((p) => p[0]));
  const x1 = Math.max(...pts.map((p) => p[0]));
  const y1 = Math.max(...pts.flatMap((p) => [p[1], p[2]]), 1e-9);
  const X = (x: number) => ((x - x0) / (x1 - x0 || 1)) * (W - 4) + 2;
  const Y = (y: number) => H - 2 - (y / y1) * (H - 4);
  const line = (j: number) => pts.map((p, i) => `${i ? "L" : "M"}${X(p[0]).toFixed(1)},${Y(p[j]).toFixed(1)}`).join("");
  return (
    <svg width={W} height={H} className="sparkline" role="img" aria-label="n and k preview">
      {props.band && <rect x={X(Math.max(x0, props.band[0]))} width={Math.max(0, X(Math.min(x1, props.band[1])) - X(Math.max(x0, props.band[0])))} y={0} height={H} className="band" />}
      <path d={line(1)} className="n" />
      <path d={line(2)} className="k" />
    </svg>
  );
}
