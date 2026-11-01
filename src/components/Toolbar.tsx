import { useState } from "react";
import { recentFiles } from "../lib/files";
import { useConnection } from "../state/connection";
import { useSpec } from "../state/store";
import { openFileAction, openRecentAction, runOperation, saveFileAction } from "../state/actions";
import { toast } from "../state/toast";
import { useUi } from "../state/ui";
import { copyShareLink } from "./Dialogs";
import { AccountButton } from "./Account";
import { APP_NAME, PRODUCT } from "../config/brand";

function Menu(props: { label: React.ReactNode; children: React.ReactNode; testId?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="menu-wrap" onMouseLeave={() => setOpen(false)}>
      <button onClick={() => setOpen(!open)} data-testid={props.testId}>
        {props.label} ▾
      </button>
      {open && (
        <div className="menu" onClick={() => setOpen(false)}>
          {props.children}
        </div>
      )}
    </div>
  );
}

const run = (f: () => Promise<unknown> | unknown) => () => {
  try {
    const r = f();
    if (r instanceof Promise) r.catch((e) => toast((e as Error).message, "error"));
  } catch (e) {
    toast((e as Error).message, "error");
  }
};

export function Toolbar() {
  const s = useSpec();
  const conn = useConnection();
  const ui = useUi();
  const kind = typeof s.spec.kind === "string" ? s.spec.kind : "scattering";
  const recents = recentFiles();
  return (
    <header className="toolbar">
      <span className="brand" title={APP_NAME}>
        <img src="./favicon.svg" alt="" width={18} height={18} /> {PRODUCT} <b>Studio</b>
      </span>
      <Menu label="File" testId="menu-file">
        <button onClick={run(openFileAction)}>Open… <kbd>Ctrl+O</kbd></button>
        <button onClick={run(() => saveFileAction(false))} data-testid="save">Save <kbd>Ctrl+S</kbd></button>
        <button onClick={run(() => saveFileAction(true))}>Save as…</button>
        <hr />
        <div className="menu-title">Recent</div>
        {recents.length === 0 && <div className="menu-empty">none</div>}
        {recents.map((r) => (
          <button key={r.id} onClick={run(() => openRecentAction(r))} title={r.path ?? r.name}>
            {r.name}
          </button>
        ))}
      </Menu>
      <button onClick={() => ui.openNew(true)} data-testid="menu-new" title="New project: choose the problem kind">
        New…
      </button>
      <div className="btn-group">
        <button onClick={s.undo} disabled={!s.past.length} title="Undo (Ctrl+Z)" data-testid="undo">
          ↶
        </button>
        <button onClick={s.redo} disabled={!s.future.length} title="Redo (Ctrl+Shift+Z)" data-testid="redo">
          ↷
        </button>
      </div>
      <div className="btn-group">
        <button onClick={() => (s.copySelection() ? toast("Copied particle") : toast("Select a particle to copy", "warn"))} title="Copy particle (Ctrl+C)" data-testid="copy">
          Copy
        </button>
        <button onClick={() => (s.paste() ? undefined : toast("Nothing to paste", "warn"))} disabled={!s.clipboard} title="Paste particle (Ctrl+V)" data-testid="paste">
          Paste
        </button>
      </div>
      <span className="file-name" title={s.fileName ?? ""}>
        {s.fileName ? s.fileName.split(/[\\/]/).pop() : "untitled.json"}
        {s.dirty && " •"}
      </span>
      <span className="kind-badge" title="problem kind">
        {kind}
      </span>
      <span className="spacer" />
      <button onClick={() => ui.openCode("python")} data-testid="copy-python">
        Copy as Python
      </button>
      <button onClick={() => ui.openCode("cli")} data-testid="copy-cli">
        Copy as CLI
      </button>
      <button onClick={copyShareLink} title="Copy a link that opens this spec in Studio">
        Share link
      </button>
      <button className="primary" onClick={run(() => runOperation("solve").catch(() => {}))} title="Solve (Ctrl+Enter)" data-testid="toolbar-solve">
        ▶ Solve
      </button>
      <AccountButton />
      <button className={`server ${conn.status}`} onClick={() => ui.openSettings(true)} data-testid="server-button" title={conn.error ?? conn.client.baseUrl}>
        ● {conn.settings.mode === "mock" ? "Mock server" : conn.settings.mode === "hosted" ? "Hosted" : "Local"}
        {conn.status === "connecting" ? " …" : conn.status === "error" ? " (offline)" : ""}
      </button>
    </header>
  );
}

export function StatusBar(props: { issues: number }) {
  const conn = useConnection();
  const spec = useSpec((s) => s.spec);
  return (
    <footer className="statusbar" data-testid="statusbar">
      <span className={props.issues ? "error" : "ok"}>{props.issues ? `✗ ${props.issues} spec problem${props.issues > 1 ? "s" : ""}` : "✓ spec valid"}</span>
      <span>
        schema {String(spec.schema_version ?? "")} · {conn.schemaSource === "live" ? "live from server" : "bundled snapshot"} · {conn.schema.problemKinds().length} problem kinds
      </span>
      <span>
        {conn.backends.length} backends ({conn.backends.filter((b) => b.available).length} available)
      </span>
      <span className="spacer" />
      {conn.notice && <span className="notice">{conn.notice}</span>}
      <span>{conn.client.baseUrl}</span>
    </footer>
  );
}
