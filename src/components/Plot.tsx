// Thin Plotly wrapper. Plotly is loaded lazily (it is the biggest dependency)
// and every plot gets PNG / SVG export buttons.

import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { exportFile } from "../lib/files";

/* eslint-disable @typescript-eslint/no-explicit-any */
let plotlyPromise: Promise<any> | null = null;
export function loadPlotly(): Promise<any> {
  plotlyPromise ??= import("plotly.js-dist-min").then((m) => m.default ?? m);
  return plotlyPromise;
}

export interface PlotHandle {
  exportImage(format: "png" | "svg", name: string): Promise<void>;
}

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

export function themedLayout(layout: any): any {
  const fg = css("--fg") || "#ddd";
  const grid = css("--border") || "#333";
  const axis = (a: any = {}) => ({ gridcolor: grid, zerolinecolor: grid, linecolor: grid, ...a });
  return {
    paper_bgcolor: "rgba(0,0,0,0)",
    plot_bgcolor: "rgba(0,0,0,0)",
    font: { color: fg, size: 11, family: "Inter, system-ui, sans-serif" },
    margin: { l: 60, r: 20, t: 20, b: 45 },
    legend: { orientation: "h", x: 0, y: 1.02, yanchor: "bottom" },
    ...layout,
    xaxis: axis(layout.xaxis),
    yaxis: axis(layout.yaxis),
    ...(layout.polar ? { polar: { bgcolor: "rgba(0,0,0,0)", ...layout.polar, radialaxis: axis(layout.polar.radialaxis), angularaxis: axis(layout.polar.angularaxis) } } : {}),
  };
}

export const Plot = forwardRef<PlotHandle, { data: any[]; layout?: any; height?: number | string; testId?: string; exportName?: string }>(function Plot(props, ref) {
  const el = useRef<HTMLDivElement>(null);
  const [err, setErr] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  useImperativeHandle(ref, () => ({
    async exportImage(format, name) {
      const Plotly = await loadPlotly();
      if (!el.current) return;
      const url: string = await Plotly.toImage(el.current, { format, width: 1200, height: 700, scale: format === "png" ? 2 : 1 });
      const blob = await (await fetch(url)).blob();
      await exportFile(blob, `${name}.${format}`, format === "png" ? "image/png" : "image/svg+xml");
    },
  }));

  useEffect(() => {
    let cancelled = false;
    loadPlotly()
      .then((Plotly) => {
        if (cancelled || !el.current) return;
        Plotly.react(el.current, props.data, themedLayout({ autosize: true, ...props.layout }), { responsive: true, displaylogo: false, modeBarButtonsToRemove: ["toImage", "sendDataToCloud"] });
        setReady(true);
      })
      .catch((e) => setErr(String(e)));
    return () => {
      cancelled = true;
    };
  }, [props.data, props.layout]);

  useEffect(() => {
    const node = el.current;
    return () => {
      if (node) void loadPlotly().then((P) => P.purge(node));
    };
  }, []);

  return (
    <div className="plot" style={{ height: props.height ?? 320 }} data-testid={props.testId} data-ready={ready}>
      {err && <div className="field-error">{err}</div>}
      <div ref={el} style={{ width: "100%", height: "100%" }} />
    </div>
  );
});

export function ExportButtons(props: { plot: React.RefObject<PlotHandle | null>; name: string; extra?: React.ReactNode }) {
  return (
    <span className="export-buttons">
      <button className="small" onClick={() => void props.plot.current?.exportImage("png", props.name)}>
        PNG
      </button>
      <button className="small" onClick={() => void props.plot.current?.exportImage("svg", props.name)}>
        SVG
      </button>
      {props.extra}
    </span>
  );
}
