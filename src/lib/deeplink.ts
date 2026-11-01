// Deep links: `<DEEP_LINK_SCHEME>://open?spec=…` (desktop) and `?spec=…` /
// `#spec=…` (web). `spec` is the spec JSON, either URI-encoded or base64url;
// `spec_url` points at a spec to fetch. See README "Deep links".

import { isObject, type Json } from "../schema/schema";
import { DEEP_LINK_SCHEME } from "../config/brand";

export interface DeepLink {
  spec?: Json;
  specUrl?: string;
  /** Display name (the community site passes `name`). */
  name?: string;
}

export function base64UrlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  const bin = atob(b64);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** Decode a `spec` parameter value (already URI-decoded by URLSearchParams). */
export function decodeSpecParam(v: string): Json {
  const t = v.trim();
  if (t.startsWith("{")) return JSON.parse(t);
  const parsed = JSON.parse(base64UrlDecode(t));
  if (!isObject(parsed)) throw new Error("spec must be a JSON object");
  return parsed;
}

function paramsOf(url: URL): URLSearchParams {
  const p = new URLSearchParams(url.search);
  if (url.hash.length > 1) new URLSearchParams(url.hash.slice(1)).forEach((v, k) => p.set(k, v));
  return p;
}

/** Parse a deep link or page URL. Returns null when it carries no spec. */
export function parseDeepLink(href: string): DeepLink | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  const p = paramsOf(url);
  const spec = p.get("spec");
  const specUrl = p.get("spec_url");
  const name = p.get("name") ? { name: p.get("name")! } : {};
  if (spec) return { spec: decodeSpecParam(spec), ...name };
  if (specUrl) {
    const u = new URL(specUrl);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("spec_url must be http(s)");
    return { specUrl: u.toString(), ...name };
  }
  return null;
}

export async function resolveDeepLink(link: DeepLink): Promise<Json> {
  if (link.spec !== undefined) return link.spec;
  const res = await fetch(link.specUrl!, { headers: { Accept: "application/json" } });
  if (!res.ok) throw new Error(`could not fetch spec (${res.status} ${res.statusText})`);
  return res.json();
}

/** A web link that opens this spec in Studio. */
export function shareLink(spec: Json, base = location.origin + location.pathname): string {
  return `${base}?spec=${base64UrlEncode(JSON.stringify(spec))}`;
}

export function desktopLink(spec: Json): string {
  return `${DEEP_LINK_SCHEME}://open?spec=${base64UrlEncode(JSON.stringify(spec))}`;
}

/** Remove spec params from the address bar once loaded (so reload does not clobber edits). */
export function stripSpecFromLocation() {
  const url = new URL(location.href);
  let changed = false;
  for (const k of ["spec", "spec_url", "name", "project"]) {
    if (url.searchParams.has(k)) {
      url.searchParams.delete(k);
      changed = true;
    }
  }
  if (url.hash.includes("spec")) {
    url.hash = "";
    changed = true;
  }
  if (changed) history.replaceState(null, "", url.toString());
}
