// window.studio: the scripting / agent API. Everything the GUI can do is a
// call here, and every spec change is a list of ops (see state/ops.ts), so a
// script, a browser-automation agent or a parent page can drive Studio.

import { cliCode, pythonCode } from "./codegen";
import { loadResult, useJobs } from "../state/jobs";
import { useConnection } from "../state/connection";
import { useSpec } from "../state/store";
import { currentIssues, loadSpec, newFromTemplate, runOperation } from "../state/actions";
import { TEMPLATES } from "../state/templates";
import type { Op } from "../state/ops";
import type { Json, JsonObject, Path } from "../schema/schema";
import type { Operation } from "../api/types";
import { TERMINAL } from "../api/compute";

function waitFor(key: string, timeoutMs = 10 * 60_000): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => (unsub(), reject(new Error("timed out"))), timeoutMs);
    const check = () => {
      const j = useJobs.getState().jobs.find((x) => x.key === key);
      if (j && TERMINAL.has(j.status) && (j.status !== "succeeded" || j.hasResult)) {
        clearTimeout(t);
        unsub();
        if (j.status === "succeeded") void loadResult(key).then(resolve);
        else reject(new Error(j.error ? `${j.error.error}: ${j.error.message}` : j.status));
      }
    };
    const unsub = useJobs.subscribe(check);
    check();
  });
}

async function run(op: Operation, opts?: { method?: string; device?: string; methods?: string[] }) {
  const rec = await runOperation(op, opts);
  return { job: rec.key, result: await waitFor(rec.key) };
}

export const studioApi = {
  version: 1,
  /** The spec (a copy). */
  getSpec: (): JsonObject => JSON.parse(JSON.stringify(useSpec.getState().spec)),
  setSpec: (spec: Json) => loadSpec(spec),
  /** Apply spec ops: {op: "replace"|"add"|"remove"|"move", path: [...], value?}. Undoable. */
  apply: (ops: Op | Op[]) => useSpec.getState().apply(ops),
  undo: () => useSpec.getState().undo(),
  redo: () => useSpec.getState().redo(),
  select: (path: Path | null) => useSpec.getState().select(path),
  validate: () => currentIssues(),
  schema: () => useConnection.getState().schema.root,
  backends: () => useConnection.getState().backends,
  doctor: () => useConnection.getState().doctor,
  templates: () => TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.description })),
  loadTemplate: (id: string) => newFromTemplate(id),
  setRun: (o: { method?: string; device?: string; compareMethods?: string[] }) => {
    const c = useConnection.getState();
    if (o.method) c.setMethod(o.method);
    if (o.device) c.setDevice(o.device);
    if (o.compareMethods) c.setCompareMethods(o.compareMethods);
  },
  estimate: () => {
    const c = useConnection.getState();
    return c.client.estimate(useSpec.getState().spec, c.method, c.device);
  },
  supports: () => {
    const c = useConnection.getState();
    return c.client.supports(useSpec.getState().spec, c.backends);
  },
  /** Submit and wait: resolves with {job, result}. */
  solve: (opts?: { method?: string; device?: string }) => run("solve", opts),
  compare: (opts?: { methods?: string[]; device?: string }) => run("compare", opts),
  jobs: () => useJobs.getState().jobs,
  result: (jobKey: string) => loadResult(jobKey),
  cancel: (jobKey: string) => useJobs.getState().cancel(jobKey),
  python: (operation: Operation = "solve") => {
    const c = useConnection.getState();
    return pythonCode(useSpec.getState().spec, { operation, method: c.method, device: c.device, methods: c.compareMethods });
  },
  cli: (operation: Operation = "solve", shell: "bash" | "powershell" = "bash") => {
    const c = useConnection.getState();
    return cliCode(useSpec.getState().spec, { operation, method: c.method, device: c.device, methods: c.compareMethods }, shell);
  },
  /** Subscribe to spec changes; returns an unsubscribe function. */
  onChange: (cb: (spec: JsonObject, ops: Op[]) => void) => useSpec.subscribe((s, prev) => s.spec !== prev.spec && cb(s.spec, s.lastOps)),
};

export type StudioApi = typeof studioApi;

declare global {
  interface Window {
    studio: StudioApi;
  }
}

/**
 * postMessage bridge for embedding Studio in an iframe (e.g. the community site):
 *   parent.postMessage({studio: "getSpec" | "setSpec" | "apply" | "validate", id, spec?, ops?}, "*")
 * replies with {studio: "reply", id, result | error}.
 */
export function installScripting() {
  window.studio = studioApi;
  window.addEventListener("message", (ev) => {
    const msg = ev.data;
    if (!msg || typeof msg !== "object" || typeof msg.studio !== "string" || msg.studio === "reply") return;
    const reply = (body: object) => (ev.source as Window | null)?.postMessage({ studio: "reply", id: msg.id, ...body }, { targetOrigin: ev.origin === "null" ? "*" : ev.origin });
    try {
      let result: unknown;
      if (msg.studio === "getSpec") result = studioApi.getSpec();
      else if (msg.studio === "setSpec") result = studioApi.setSpec(msg.spec);
      else if (msg.studio === "apply") result = studioApi.apply(msg.ops);
      else if (msg.studio === "validate") result = studioApi.validate();
      else throw new Error(`unknown command ${msg.studio}`);
      reply({ result: result ?? null });
    } catch (e) {
      reply({ error: (e as Error).message });
    }
  });
}
