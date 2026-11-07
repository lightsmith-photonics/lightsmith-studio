import { lazy, Suspense, useEffect, useState } from "react";
import { CodeDialog, SettingsDialog } from "./components/Dialogs";
import { JsonPanel } from "./components/JsonPanel";
import { NewProjectDialog } from "./components/NewProject";
import { KindScene } from "./components/kinds/KindScene";
import { specKind } from "./state/kinds";
import { Tabs } from "./components/Modal";
import { ObjectTree } from "./components/ObjectTree";
import { Properties } from "./components/Properties";
import { RunPanel } from "./components/RunPanel";
import { useIssues } from "./components/SpecForm";
import { StatusBar, Toolbar } from "./components/Toolbar";
import { parseDeepLink, resolveDeepLink, stripSpecFromLocation } from "./lib/deeplink";
import { parseSpecText } from "./lib/files";
import { isTauri } from "./lib/platform";
import { completeSignIn } from "./lib/auth";
import { CONFIG } from "./config/runtime";
import { addParticle, deleteSelection, duplicateSelection, loadSpec, openFileAction, runOperation, saveFileAction } from "./state/actions";
import { initialConnect, useConnection } from "./state/connection";
import { useJobs } from "./state/jobs";
import { useSpec } from "./state/store";
import { toast, useToasts } from "./state/toast";
import { useUi, type CenterTab, type RightTab } from "./state/ui";

// three.js and Plotly are large: load the scene and the results only when shown.
const Viewport = lazy(() => import("./components/Viewport").then((m) => ({ default: m.Viewport })));
const ResultsView = lazy(() => import("./components/Results").then((m) => ({ default: m.ResultsView })));
const CompareView = lazy(() => import("./components/CompareView").then((m) => ({ default: m.CompareView })));
const PreviewView = lazy(() => import("./components/Preview").then((m) => ({ default: m.PreviewView })));
const SweepView = lazy(() => import("./components/Sweep").then((m) => ({ default: m.SweepView })));

async function openLink(href: string) {
  try {
    const link = parseDeepLink(href);
    if (!link) return false;
    const spec = await resolveDeepLink(link);
    loadSpec(spec, { fileName: link.name ? `${link.name.replace(/\.json$/i, "")}.json` : null });
    toast("Opened spec from link");
    return true;
  } catch (e) {
    toast(`Could not open link: ${(e as Error).message}`, "error");
    return false;
  }
}

function useStartup() {
  useEffect(() => {
    // Finish a sign-in redirect first: it owns the query / fragment of this page load.
    const signedIn = completeSignIn(CONFIG.auth)
      .then((done) => done && toast("Signed in"))
      .catch((e) => toast(`Sign-in failed: ${(e as Error).message}`, "error"));
    void signedIn.then(() => openLink(location.href)).then((ok) => ok && stripSpecFromLocation());
    void initialConnect().then(() => {
      // re-normalise the autosaved / linked spec against the live schema
      loadSpec(useSpec.getState().spec, { resetHistory: true, fileName: useSpec.getState().fileName });
      useJobs.getState().resume();
    });
    if (isTauri()) {
      void (async () => {
        const dl = await import("@tauri-apps/plugin-deep-link");
        const first = await dl.getCurrent().catch(() => null);
        for (const u of first ?? []) await openLink(u);
        await dl.onOpenUrl((urls) => urls.forEach((u) => void openLink(u)));
      })().catch(() => {});
    }
  }, []);
}

function editable(t: EventTarget | null) {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable || !!el.closest(".cm-editor"));
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.ctrlKey || e.metaKey;
      const s = useSpec.getState();
      const k = e.key.toLowerCase();
      if (mod && k === "s") {
        e.preventDefault();
        void saveFileAction(e.shiftKey).catch((x) => toast((x as Error).message, "error"));
      } else if (mod && k === "o") {
        e.preventDefault();
        void openFileAction().catch((x) => toast((x as Error).message, "error"));
      } else if (mod && e.key === "Enter") {
        e.preventDefault();
        void runOperation("solve").catch(() => {});
      } else if (editable(e.target)) return;
      else if (mod && k === "z" && !e.shiftKey) (e.preventDefault(), s.undo());
      else if (mod && ((k === "z" && e.shiftKey) || k === "y")) (e.preventDefault(), s.redo());
      else if (mod && k === "c") s.copySelection() && toast("Copied particle");
      else if (mod && k === "v") s.paste();
      else if (mod && k === "d") (e.preventDefault(), duplicateSelection());
      else if (e.key === "Delete" || e.key === "Backspace") deleteSelection();
      else if (!mod && k === "a" && e.shiftKey) addParticle();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

function useDropSpec() {
  const [over, setOver] = useState(false);
  useEffect(() => {
    const dragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes("Files")) {
        e.preventDefault();
        setOver(true);
      }
    };
    const leave = (e: DragEvent) => !e.relatedTarget && setOver(false);
    const drop = async (e: DragEvent) => {
      setOver(false);
      const f = e.dataTransfer?.files[0];
      if (!f || e.defaultPrevented) return;
      e.preventDefault();
      if (!/\.json$/i.test(f.name)) return toast(`Drop a .json spec (got ${f.name}); CSV material data goes in the material picker`, "warn");
      try {
        loadSpec(parseSpecText(await f.text()), { fileName: f.name, resetHistory: true });
        toast(`Opened ${f.name}`);
      } catch (x) {
        toast(`${f.name}: ${(x as Error).message}`, "error");
      }
    };
    window.addEventListener("dragover", dragOver);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", drop);
    return () => {
      window.removeEventListener("dragover", dragOver);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", drop);
    };
  }, []);
  return over;
}

export default function App() {
  useStartup();
  useShortcuts();
  const dropping = useDropSpec();
  const ui = useUi();
  const issues = useIssues();
  const toasts = useToasts((s) => s.toasts);
  const runningJobs = useJobs((s) => s.jobs.filter((j) => j.status === "running" || j.status === "queued").length);
  const settingsOpen = useUi((s) => s.settingsOpen);
  const status = useConnection((s) => s.status);
  const kind = useSpec((s) => specKind(s.spec));

  return (
    <div className="app">
      <Toolbar />
      <div className="workspace">
        <aside className="left">
          <ObjectTree />
        </aside>
        <main className="center">
          <Tabs<CenterTab>
            value={ui.centerTab}
            onChange={ui.setCenterTab}
            tabs={[
              { id: "scene", label: "Scene" },
              { id: "preview", label: "Preview" },
              { id: "results", label: "Results" },
              { id: "compare", label: "Compare" },
              { id: "sweep", label: "Sweep" },
            ]}
            testId="center-tabs"
          />
          <div className="center-body">
            <Suspense fallback={<div className="loading">Loading…</div>}>
              {ui.centerTab === "scene" && (kind === "scattering" || kind === "emission" ? <Viewport /> : <KindScene kind={kind} />)}
              {ui.centerTab === "preview" && <PreviewView />}
              {ui.centerTab === "results" && <ResultsView />}
              {ui.centerTab === "compare" && <CompareView />}
              {ui.centerTab === "sweep" && <SweepView />}
            </Suspense>
          </div>
        </main>
        <aside className="right">
          <Tabs<RightTab>
            value={ui.rightTab}
            onChange={ui.setRightTab}
            tabs={[
              { id: "properties", label: "Properties" },
              { id: "run", label: <>Run{runningJobs ? <span className="badge">{runningJobs}</span> : null}</> },
              { id: "json", label: <>JSON{issues.length ? <span className="badge error">{issues.length}</span> : null}</> },
            ]}
            testId="right-tabs"
          />
          <div className="right-body">
            {ui.rightTab === "properties" && <Properties />}
            {ui.rightTab === "run" && <RunPanel />}
            {ui.rightTab === "json" && <JsonPanel />}
          </div>
        </aside>
      </div>
      <StatusBar issues={issues.length} />
      <CodeDialog />
      <NewProjectDialog />
      {settingsOpen && <SettingsDialog />}
      {dropping && <div className="drop-overlay">Drop a spec .json to open it</div>}
      {status === "error" && (
        <div className="banner error">
          Cannot reach the compute server. <button className="link" onClick={() => ui.openSettings(true)}>Server settings</button>
        </div>
      )}
      <div className="toasts" data-testid="toasts">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.level}`} onClick={() => useToasts.getState().dismiss(t.id)}>
            {t.text}
          </div>
        ))}
      </div>
    </div>
  );
}
