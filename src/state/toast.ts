import { create } from "zustand";

export interface Toast {
  id: number;
  text: string;
  level: "info" | "warn" | "error";
}

let seq = 0;

export const useToasts = create<{ toasts: Toast[]; dismiss(id: number): void }>((set, get) => ({
  toasts: [],
  dismiss(id) {
    set({ toasts: get().toasts.filter((t) => t.id !== id) });
  },
}));

export function toast(text: string, level: Toast["level"] = "info") {
  const id = ++seq;
  useToasts.setState((s) => ({ toasts: [...s.toasts.slice(-4), { id, text, level }] }));
  setTimeout(() => useToasts.getState().dismiss(id), level === "error" ? 8000 : 3500);
}
