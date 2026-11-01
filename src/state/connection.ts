// Which compute / materials servers Studio talks to, what they report
// (schema, backends, doctor), and the run settings (method, device) that map
// to CLI flags rather than spec fields.

import { create } from "zustand";
import backendsJson from "../generated/backends.json";
import doctorJson from "../generated/doctor.json";
import schemaJson from "../generated/schema.json";
import { HttpComputeClient, MockComputeClient, type ComputeClient } from "../api/compute";
import { HttpMaterialsClient, MockMaterialsClient, type MaterialsClient } from "../api/materialsDb";
import type { BackendInfo, Doctor } from "../api/types";
import { SchemaDoc, type JSONSchema } from "../schema/schema";
import { CONFIG, type ServerMode } from "../config/runtime";
import { getSession } from "../lib/auth";
import { LIBRARY } from "../config/brand";

export type { ServerMode };

export interface Settings {
  mode: ServerMode;
  localUrl: string;
  hostedUrl: string;
  apiKey: string;
  materialsMode: "mock" | "http";
  materialsUrl: string;
}

const SETTINGS_KEY = "studio:settings";

export const DEFAULT_SETTINGS: Settings = {
  mode: CONFIG.defaultServer,
  localUrl: CONFIG.localComputeUrl,
  hostedUrl: CONFIG.computeUrl,
  apiKey: "",
  materialsMode: CONFIG.materialsUrl ? "http" : "mock",
  materialsUrl: CONFIG.materialsUrl || "http://localhost:8100",
};

function loadSettings(): { settings: Settings; saved: boolean } {
  try {
    const raw = globalThis.localStorage?.getItem(SETTINGS_KEY);
    if (raw) return { settings: { ...DEFAULT_SETTINGS, ...JSON.parse(raw) }, saved: true };
  } catch {
    /* ignore */
  }
  return { settings: DEFAULT_SETTINGS, saved: false };
}

export function makeClient(s: Settings): ComputeClient {
  if (s.mode === "mock") return mockClient;
  // Hosted: the signed-in Community session wins over a pasted API key.
  if (s.mode === "hosted") return new HttpComputeClient(s.hostedUrl || location.origin, () => getSession()?.accessToken ?? (s.apiKey || undefined));
  return new HttpComputeClient(s.localUrl);
}

export function makeMaterialsClient(s: Settings): MaterialsClient {
  return s.materialsMode === "http" ? new HttpMaterialsClient(s.materialsUrl) : new MockMaterialsClient();
}

const mockClient = new MockComputeClient();

export interface ConnectionState {
  settings: Settings;
  status: "idle" | "connecting" | "connected" | "error";
  error: string | null;
  notice: string | null;
  schema: SchemaDoc;
  schemaSource: "bundled" | "live";
  backends: BackendInfo[];
  doctor: Doctor | null;
  method: string;
  device: string;
  compareMethods: string[];
  client: ComputeClient;
  materials: MaterialsClient;

  updateSettings(patch: Partial<Settings>): void;
  connect(opts?: { fallbackToMock?: boolean }): Promise<void>;
  setMethod(m: string): void;
  setDevice(d: string): void;
  setCompareMethods(m: string[]): void;
}

const initial = loadSettings();

export const useConnection = create<ConnectionState>((set, get) => ({
  settings: initial.settings,
  status: "idle",
  error: null,
  notice: null,
  schema: new SchemaDoc(schemaJson as JSONSchema),
  schemaSource: "bundled",
  backends: backendsJson as unknown as BackendInfo[],
  doctor: doctorJson as Doctor,
  method: "auto",
  device: "auto",
  compareMethods: [],
  client: makeClient(initial.settings),
  materials: makeMaterialsClient(initial.settings),

  updateSettings(patch) {
    const settings = { ...get().settings, ...patch };
    try {
      globalThis.localStorage?.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      /* ignore */
    }
    set({ settings, client: makeClient(settings), materials: makeMaterialsClient(settings), notice: null });
  },

  async connect(opts) {
    const client = get().client;
    set({ status: "connecting", error: null });
    try {
      const [schema, backends, doctor] = await Promise.all([client.schema(), client.backends(), client.doctor().catch(() => null)]);
      if (get().client !== client) return; // settings changed meanwhile
      set({
        status: "connected",
        schema: new SchemaDoc(schema),
        schemaSource: client.kind === "mock" ? "bundled" : "live",
        backends,
        doctor,
      });
    } catch (e) {
      if (get().client !== client) return;
      if (opts?.fallbackToMock && client.kind !== "mock") {
        const url = client.baseUrl;
        set({ settings: { ...get().settings, mode: "mock" }, client: mockClient });
        await get().connect();
        set({ notice: `No compute server at ${url}; using the built-in mock server. Start one with \`uv run ${LIBRARY.server}\` in services/compute and pick "Local" in Server settings.` });
        return;
      }
      set({ status: "error", error: (e as Error).message });
    }
  },

  setMethod(method) {
    set({ method });
  },
  setDevice(device) {
    set({ device });
  },
  setCompareMethods(compareMethods) {
    set({ compareMethods });
  },
}));

/** First connection at startup: only auto-fall back to the mock when the user never chose a server. */
export function initialConnect() {
  // A hosted deployment that is down must say so, not quietly switch to the mock.
  return useConnection.getState().connect({ fallbackToMock: !initial.saved && initial.settings.mode === "local" });
}
