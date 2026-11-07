import { create } from "zustand";

export type CenterTab = "scene" | "preview" | "results" | "compare" | "sweep";
export type RightTab = "properties" | "run" | "json";
export type CodeTab = "python" | "cli" | "curl" | "mcp";

interface UiState {
  centerTab: CenterTab;
  rightTab: RightTab;
  code: CodeTab | null;
  settingsOpen: boolean;
  newOpen: boolean;
  openNew(v: boolean): void;
  setCenterTab(t: CenterTab): void;
  setRightTab(t: RightTab): void;
  openCode(t: CodeTab | null): void;
  openSettings(v: boolean): void;
}

export const useUi = create<UiState>((set) => ({
  centerTab: "scene",
  rightTab: "properties",
  code: null,
  settingsOpen: false,
  newOpen: false,
  openNew: (newOpen) => set({ newOpen }),
  setCenterTab: (centerTab) => set({ centerTab }),
  setRightTab: (rightTab) => set({ rightTab }),
  openCode: (code) => set({ code }),
  openSettings: (settingsOpen) => set({ settingsOpen }),
}));
