// Desktop (Tauri) vs web. Everything platform-specific goes through here so the
// same bundle runs in both.

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export const platformName = (): "desktop" | "web" => (isTauri() ? "desktop" : "web");
