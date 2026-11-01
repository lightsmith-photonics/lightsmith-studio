// Open / save spec files (the same JSON the CLI reads) and keep recent files.
// Desktop uses Tauri's dialog + fs plugins (real paths); the web build uses the
// File System Access API where available and falls back to upload/download.

import { get as idbGet, set as idbSet } from "idb-keyval";
import { isObject, type JsonObject } from "../schema/schema";
import { isTauri } from "./platform";
import { SPEC_FILE_LABEL } from "../config/brand";

export interface OpenedFile {
  name: string;
  text: string;
  /** Desktop: absolute path. */
  path?: string;
  /** Web: handle for "Save" without a dialog. */
  handle?: FileSystemFileHandle;
}

export interface RecentFile {
  id: string;
  name: string;
  path: string | null;
  at: string;
}

const RECENT_KEY = "studio:recent";
const RECENT_MAX = 10;
let currentHandle: FileSystemFileHandle | undefined;
let currentPath: string | undefined;

const JSON_FILTER = [{ name: SPEC_FILE_LABEL, extensions: ["json"] }];

type PickerWindow = Window & {
  showOpenFilePicker?: (o?: unknown) => Promise<FileSystemFileHandle[]>;
  showSaveFilePicker?: (o?: unknown) => Promise<FileSystemFileHandle>;
};

export function parseSpecText(text: string): JsonObject {
  const v = JSON.parse(text);
  if (!isObject(v)) throw new Error("a spec file must contain a JSON object");
  return v;
}

export async function openSpecFile(): Promise<OpenedFile | null> {
  if (isTauri()) {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const { readTextFile } = await import("@tauri-apps/plugin-fs");
    const path = await open({ multiple: false, directory: false, filters: JSON_FILTER });
    if (!path || Array.isArray(path)) return null;
    const text = await readTextFile(path);
    currentPath = path;
    return { name: path.split(/[\\/]/).pop() ?? path, text, path };
  }
  const w = window as PickerWindow;
  if (w.showOpenFilePicker) {
    try {
      const [handle] = await w.showOpenFilePicker({ types: [{ description: SPEC_FILE_LABEL, accept: { "application/json": [".json"] } }] });
      const file = await handle.getFile();
      currentHandle = handle;
      return { name: file.name, text: await file.text(), handle };
    } catch (e) {
      if ((e as Error).name === "AbortError") return null;
      throw e;
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,application/json";
    input.onchange = async () => {
      const f = input.files?.[0];
      resolve(f ? { name: f.name, text: await f.text() } : null);
    };
    input.click();
  });
}

/** Open a path directly (desktop recents, CLI args). */
export async function openPath(path: string): Promise<OpenedFile> {
  const { readTextFile } = await import("@tauri-apps/plugin-fs");
  const text = await readTextFile(path);
  currentPath = path;
  return { name: path.split(/[\\/]/).pop() ?? path, text, path };
}

export function forgetCurrentFile() {
  currentHandle = undefined;
  currentPath = undefined;
}

export function setCurrentFile(f: OpenedFile) {
  currentHandle = f.handle;
  currentPath = f.path;
}

export async function saveSpecFile(spec: JsonObject, suggested: string, saveAs = false): Promise<{ name: string; path?: string } | null> {
  const text = JSON.stringify(spec, null, 2) + "\n";
  if (isTauri()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { writeTextFile } = await import("@tauri-apps/plugin-fs");
    let path = saveAs ? undefined : currentPath;
    if (!path) path = (await save({ defaultPath: suggested, filters: JSON_FILTER })) ?? undefined;
    if (!path) return null;
    await writeTextFile(path, text);
    currentPath = path;
    return { name: path.split(/[\\/]/).pop() ?? path, path };
  }
  const w = window as PickerWindow;
  if (w.showSaveFilePicker) {
    try {
      let handle = saveAs ? undefined : currentHandle;
      if (!handle) handle = await w.showSaveFilePicker({ suggestedName: suggested, types: [{ description: SPEC_FILE_LABEL, accept: { "application/json": [".json"] } }] });
      const writable = await (handle as FileSystemFileHandle & { createWritable(): Promise<FileSystemWritableFileStream> }).createWritable();
      await writable.write(text);
      await writable.close();
      currentHandle = handle;
      return { name: handle.name };
    } catch (e) {
      if ((e as Error).name === "AbortError") return null;
      throw e;
    }
  }
  downloadText(text, suggested, "application/json");
  return { name: suggested };
}

export function downloadText(text: string, name: string, type = "text/plain") {
  downloadBlob(new Blob([text], { type }), name);
}

export function downloadBlob(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Save an export (CSV, PNG, SVG, JSON): a native dialog on desktop, a download on the web. */
export async function exportFile(data: string | Blob, name: string, type: string) {
  if (isTauri()) {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const fs = await import("@tauri-apps/plugin-fs");
    const ext = name.split(".").pop() ?? "";
    const path = await save({ defaultPath: name, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
    if (!path) return;
    if (typeof data === "string") await fs.writeTextFile(path, data);
    else await fs.writeFile(path, new Uint8Array(await data.arrayBuffer()));
    return;
  }
  if (typeof data === "string") downloadText(data, name, type);
  else downloadBlob(data, name);
}

// --- recent files --------------------------------------------------------------

export function recentFiles(): RecentFile[] {
  try {
    return JSON.parse(globalThis.localStorage?.getItem(RECENT_KEY) ?? "[]");
  } catch {
    return [];
  }
}

export async function addRecent(name: string, path: string | null, spec: JsonObject) {
  const id = path ?? `web:${name}`;
  const list = [{ id, name, path, at: new Date().toISOString() }, ...recentFiles().filter((r) => r.id !== id)].slice(0, RECENT_MAX);
  try {
    globalThis.localStorage?.setItem(RECENT_KEY, JSON.stringify(list));
    // The web build cannot reopen a path, so it keeps a copy of the content.
    if (!path) await idbSet(`recent:${id}`, spec);
  } catch {
    /* best effort */
  }
}

export async function openRecent(r: RecentFile): Promise<OpenedFile> {
  if (r.path && isTauri()) return openPath(r.path);
  const spec = await idbGet(`recent:${r.id}`).catch(() => undefined);
  if (!spec) throw new Error(`"${r.name}" is no longer available`);
  forgetCurrentFile();
  return { name: r.name, text: JSON.stringify(spec) };
}
