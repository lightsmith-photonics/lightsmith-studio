// Code export ("Copy as Python / CLI / curl / MCP") and server settings.

import { useState } from "react";
import { cliCode, curlCode, mcpCall, pythonCode, type Shell } from "../lib/codegen";
import { desktopLink, shareLink } from "../lib/deeplink";
import { isTauri } from "../lib/platform";
import type { Operation } from "../api/types";
import { useConnection, type ServerMode } from "../state/connection";
import { useSpec } from "../state/store";
import { toast } from "../state/toast";
import { useUi, type CodeTab } from "../state/ui";
import { Modal, Tabs } from "./Modal";
import { LIBRARY, PRODUCT } from "../config/brand";
import { setManualToken, signOut } from "../lib/auth";
import { signInConfigured, startSignIn, useSession } from "./Account";

export function CodeDialog() {
  const tab = useUi((s) => s.code);
  const open = useUi((s) => s.openCode);
  const spec = useSpec((s) => s.spec);
  const conn = useConnection();
  const [op, setOp] = useState<Operation>("solve");
  const [shell, setShell] = useState<Shell>(navigator.userAgent.includes("Windows") ? "powershell" : "bash");
  if (!tab) return null;
  const args = { operation: op, method: conn.method, device: conn.device, methods: op === "compare" && conn.compareMethods.length ? conn.compareMethods : null };
  const baseUrl = conn.client.kind === "mock" ? "http://localhost:8200" : conn.client.baseUrl;
  const code =
    tab === "python"
      ? pythonCode(spec, args)
      : tab === "cli"
        ? cliCode(spec, args, shell)
        : tab === "curl"
          ? curlCode(spec, args, baseUrl, conn.settings.mode === "hosted")
          : mcpCall(spec, args);
  const copy = async () => {
    await navigator.clipboard.writeText(code);
    toast(`Copied ${tab === "python" ? "Python" : tab === "cli" ? "CLI" : tab === "curl" ? "curl" : "MCP"} code`);
  };
  return (
    <Modal
      title="Run this outside Studio"
      onClose={() => open(null)}
      wide
      testId="code-dialog"
      footer={
        <>
          <span className="muted small grow">Same spec, method and device as the GUI. The library is the single source of truth.</span>
          <button className="primary" onClick={() => void copy()} data-testid="copy-code">
            Copy
          </button>
        </>
      }
    >
      <div className="row wrap">
        <Tabs
          value={tab}
          onChange={(t: CodeTab) => open(t)}
          tabs={[
            { id: "python", label: "Python" },
            { id: "cli", label: "CLI" },
            { id: "curl", label: "HTTP (curl)" },
            { id: "mcp", label: "MCP tool call" },
          ]}
        />
        <span className="grow" />
        <select value={op} onChange={(e) => setOp(e.target.value as Operation)} data-testid="code-op">
          <option value="solve">solve</option>
          <option value="estimate">estimate</option>
          <option value="compare">compare</option>
        </select>
        {tab === "cli" && (
          <select value={shell} onChange={(e) => setShell(e.target.value as Shell)}>
            <option value="bash">bash / zsh</option>
            <option value="powershell">PowerShell</option>
          </select>
        )}
      </div>
      <pre className="code" data-testid="code-text">
        {code}
      </pre>
    </Modal>
  );
}

export function copyShareLink() {
  const spec = useSpec.getState().spec;
  const link = isTauri() ? desktopLink(spec) : shareLink(spec);
  void navigator.clipboard.writeText(link).then(() => toast(link.length > 8000 ? "Copied link (long: consider sharing the .json file instead)" : "Copied share link"));
}

function HostedAccount() {
  const session = useSession();
  const [token, setToken] = useState("");
  return (
    <div className="panel" data-testid="hosted-account">
      {session ? (
        <div className="row">
          <span className="grow">
            Signed in as <b>{session.name ?? "?"}</b> <span className="muted small">({session.source})</span>
          </span>
          <button className="small" onClick={signOut}>
            Sign out
          </button>
        </div>
      ) : signInConfigured() ? (
        <div className="row">
          <span className="grow muted small">Sign in with your {PRODUCT} Community account to run on the hosted service.</span>
          <button className="small primary" onClick={startSignIn}>
            Sign in
          </button>
        </div>
      ) : (
        <div className="muted small">This deployment has no sign-in configured; use an API key or paste a token.</div>
      )}
      {!session && (
        <div className="row">
          <input type="password" className="grow" placeholder="…or paste an access token (JWT)" value={token} autoComplete="off" onChange={(e) => setToken(e.target.value)} />
          <button className="small" disabled={!token.trim()} onClick={() => (setManualToken(token), setToken(""))}>
            Use token
          </button>
        </div>
      )}
    </div>
  );
}

export function SettingsDialog() {
  const openSettings = useUi((s) => s.openSettings);
  const conn = useConnection();
  const [s, setS] = useState(conn.settings);
  const [testing, setTesting] = useState(false);
  const save = async () => {
    conn.updateSettings(s);
    setTesting(true);
    await useConnection.getState().connect();
    setTesting(false);
    const st = useConnection.getState();
    if (st.status === "connected") {
      toast(`Connected to ${st.client.baseUrl}`);
      openSettings(false);
    }
  };
  const modes: { id: ServerMode; label: string; help: string }[] = [
    { id: "local", label: "Local server", help: `services/compute on this machine, no auth (uv run ${LIBRARY.server})` },
    { id: "hosted", label: "Hosted endpoint", help: "a hosted compute service; requests carry your API key" },
    { id: "mock", label: "Built-in mock", help: "in-browser stand-in for development and demos; approximate physics" },
  ];
  return (
    <Modal
      title="Server settings"
      onClose={() => openSettings(false)}
      testId="settings-dialog"
      footer={
        <>
          {conn.error && <span className="field-error grow">{conn.error}</span>}
          <button onClick={() => openSettings(false)}>Close</button>
          <button className="primary" onClick={() => void save()} disabled={testing} data-testid="settings-save">
            {testing ? "Connecting…" : "Save & connect"}
          </button>
        </>
      }
    >
      <h4>Compute</h4>
      {modes.map((m) => (
        <label key={m.id} className="radio-row">
          <input type="radio" name="mode" checked={s.mode === m.id} onChange={() => setS({ ...s, mode: m.id })} data-testid={`mode-${m.id}`} />
          <span>
            <b>{m.label}</b> <span className="muted small">{m.help}</span>
          </span>
        </label>
      ))}
      {s.mode === "local" && (
        <div className="field-row">
          <label className="field-label">URL</label>
          <div className="field-input">
            <input value={s.localUrl} onChange={(e) => setS({ ...s, localUrl: e.target.value })} data-testid="local-url" />
          </div>
        </div>
      )}
      {s.mode === "hosted" && (
        <>
          <div className="field-row">
            <label className="field-label">URL</label>
            <div className="field-input">
              <input value={s.hostedUrl} placeholder="https://compute.example.org" onChange={(e) => setS({ ...s, hostedUrl: e.target.value })} />
            </div>
          </div>
          <HostedAccount />
          <div className="field-row">
            <label className="field-label">API key</label>
            <div className="field-input">
              <input type="password" value={s.apiKey} autoComplete="off" onChange={(e) => setS({ ...s, apiKey: e.target.value })} />
            </div>
          </div>
          <p className="muted small">
            An API key (<code>osk_…</code>) is the alternative to signing in, e.g. on the desktop app. It is kept in this browser's local storage
            {isTauri() ? " (app data on desktop)" : ""} and sent only to the URL above. A signed-in session takes precedence.
          </p>
        </>
      )}
      <h4>Materials database</h4>
      <label className="radio-row">
        <input type="radio" name="mat" checked={s.materialsMode === "http"} onChange={() => setS({ ...s, materialsMode: "http" })} /> <b>materials-db service</b>
      </label>
      {s.materialsMode === "http" && (
        <div className="field-row">
          <label className="field-label">URL</label>
          <div className="field-input">
            <input value={s.materialsUrl} onChange={(e) => setS({ ...s, materialsUrl: e.target.value })} />
          </div>
        </div>
      )}
      <label className="radio-row">
        <input type="radio" name="mat" checked={s.materialsMode === "mock"} onChange={() => setS({ ...s, materialsMode: "mock" })} /> <b>Built-in (bundled datasets only)</b>
      </label>
      {conn.doctor && (
        <>
          <h4>Environment (doctor)</h4>
          <pre className="raw-json small">{JSON.stringify(conn.doctor, null, 2)}</pre>
        </>
      )}
    </Modal>
  );
}
