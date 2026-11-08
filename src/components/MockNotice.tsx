// A result from the built-in mock server says so wherever it is shown: its numbers are an in-browser approximation
// or the library's solved example, not a solution by a real solver of the spec on screen.

import { isCompare, isSweep } from "../api/types";

/** The first mock warning of a result (of compare and sweep results: of any result in them). */
export function mockWarningOf(result: unknown): string | null {
  if (isCompare(result)) return firstMock(Object.values(result.results));
  if (isSweep(result)) return firstMock(result.results);
  if (!result || typeof result !== "object") return null;
  const warnings = (result as { warnings?: unknown }).warnings;
  return Array.isArray(warnings) ? ((warnings.find((w) => typeof w === "string" && w.startsWith("mock server")) as string | undefined) ?? null) : null;
}

function firstMock(results: unknown[]): string | null {
  for (const r of results) {
    const w = mockWarningOf(r);
    if (w) return w;
  }
  return null;
}

export function MockNotice({ results }: { results: unknown[] }) {
  const w = firstMock(results);
  if (!w) return null;
  return (
    <div className="warn-box" data-testid="mock-notice">
      ⚠ {w}. Connect to a compute server (Server settings) for the library's solution.
    </div>
  );
}
