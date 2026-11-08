// Hosted sign-in. Studio keeps no user database: it obtains a bearer token for the compute
// service from the Lightsmith Community account, in one of two ways (runtime config `auth.mode`):
//
//  - "oidc": standard OpenID Connect Authorization Code flow with PKCE (public client, no secret).
//  - "community": a redirect handoff to the Community app, which sends the user back with a
//    short-lived compute JWT in the URL fragment:
//      GET {communityUrl}/studio/connect?return_to=<studio url>&state=<nonce>
//      -> 302 <return_to>#access_token=<jwt>&token_type=Bearer&expires_in=<s>&state=<nonce>
//
// Tokens live in sessionStorage (per tab, gone when the tab closes), never in localStorage. The nonce of a sign-in
// under way is in localStorage: an emailed sign-in link opens a new tab, and that tab has to be able to finish it.

import type { OidcConfig, RuntimeConfig } from "../config/runtime";

export interface Session {
  accessToken: string;
  /** Epoch ms, or null if the token did not say. */
  expiresAt: number | null;
  name: string | null;
  source: "oidc" | "community" | "manual";
}

const SESSION_KEY = "studio:session";
const PENDING_KEY = "studio:auth-pending";
const PENDING_MAX_AGE_MS = 3_600_000;
const listeners = new Set<(s: Session | null) => void>();

function store(): Storage | undefined {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

function pendingStore(): Storage | undefined {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
}

export function getSession(): Session | null {
  try {
    const s = JSON.parse(store()?.getItem(SESSION_KEY) ?? "null") as Session | null;
    if (s && s.expiresAt !== null && s.expiresAt < Date.now() + 10_000) return null;
    return s;
  } catch {
    return null;
  }
}

function setSession(s: Session | null) {
  if (s) store()?.setItem(SESSION_KEY, JSON.stringify(s));
  else store()?.removeItem(SESSION_KEY);
  listeners.forEach((l) => l(s));
}

export function onSessionChange(cb: (s: Session | null) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function signOut() {
  setSession(null);
}

/** Use a token obtained elsewhere: a compute API key (`lsk_`) or a pasted access token. */
export function setManualToken(token: string) {
  setSession({ accessToken: token.trim(), expiresAt: jwtExpiry(token), name: jwtName(token), source: "manual" });
}

function b64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomString(n = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(n)));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

/** Payload of a JWT, unverified (display and expiry only; the server verifies). */
export function jwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (!part) return null;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((part.length + 3) % 4);
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
  } catch {
    return null;
  }
}

function jwtExpiry(token: string): number | null {
  const exp = jwtPayload(token)?.exp;
  return typeof exp === "number" ? exp * 1000 : null;
}

function jwtName(token: string): string | null {
  const p = jwtPayload(token);
  return (p?.name ?? p?.preferred_username ?? p?.email ?? p?.sub ?? null) as string | null;
}

/** Where the IdP sends the user back: this page without query or fragment. */
export function redirectUri(): string {
  return location.origin + location.pathname;
}

interface Pending {
  kind: "oidc" | "community";
  state: string;
  verifier?: string;
  returnTo: string;
  /** Epoch ms; a sign-in left unfinished for longer no longer counts. */
  startedAt: number;
}

async function discover(oidc: OidcConfig) {
  const res = await fetch(`${oidc.issuer.replace(/\/+$/, "")}/.well-known/openid-configuration`);
  if (!res.ok) throw new Error(`OIDC discovery failed (${res.status})`);
  return (await res.json()) as { authorization_endpoint: string; token_endpoint: string; end_session_endpoint?: string };
}

export async function signIn(cfg: RuntimeConfig["auth"]) {
  const state = randomString();
  const returnTo = location.href.split("#")[0];
  if (cfg.mode === "oidc" && cfg.oidc) {
    const meta = await discover(cfg.oidc);
    const verifier = randomString(48);
    pendingStore()?.setItem(PENDING_KEY, JSON.stringify({ kind: "oidc", state, verifier, returnTo, startedAt: Date.now() } satisfies Pending));
    const url = new URL(meta.authorization_endpoint);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: cfg.oidc.clientId,
      redirect_uri: redirectUri(),
      scope: cfg.oidc.scope || "openid profile",
      state,
      code_challenge: await pkceChallenge(verifier),
      code_challenge_method: "S256",
      ...(cfg.oidc.audience ? { audience: cfg.oidc.audience } : {}),
    }).toString();
    location.assign(url.toString());
    return;
  }
  if (cfg.mode === "community" && cfg.communityUrl) {
    pendingStore()?.setItem(PENDING_KEY, JSON.stringify({ kind: "community", state, returnTo, startedAt: Date.now() } satisfies Pending));
    const url = new URL(`${cfg.communityUrl.replace(/\/+$/, "")}/studio/connect`);
    url.search = new URLSearchParams({ return_to: redirectUri(), state }).toString();
    location.assign(url.toString());
    return;
  }
  throw new Error("sign-in is not configured for this deployment");
}

/**
 * Finish a sign-in redirect if this page load is one. Returns true when it handled the URL.
 * Must run before anything else reads the address bar.
 */
export async function completeSignIn(cfg: RuntimeConfig["auth"]): Promise<boolean> {
  const raw = pendingStore()?.getItem(PENDING_KEY);
  let pending: Pending | null = null;
  try {
    pending = raw ? (JSON.parse(raw) as Pending) : null;
  } catch {
    pendingStore()?.removeItem(PENDING_KEY);
  }
  if (pending && !(Date.now() - pending.startedAt < PENDING_MAX_AGE_MS)) {
    pendingStore()?.removeItem(PENDING_KEY);
    pending = null;
  }
  if (!pending) {
    // A handoff nobody here asked for (a stale or crafted link): never leave a token in the address bar.
    if (/(^#|&)access_token=/.test(location.hash)) history.replaceState(null, "", location.pathname + location.search);
    return false;
  }
  const query = new URLSearchParams(location.search);
  const frag = new URLSearchParams(location.hash.slice(1));
  const params = pending.kind === "community" ? frag : query;
  if (!params.has("state") && !params.has("error")) return false;
  pendingStore()?.removeItem(PENDING_KEY);
  const { returnTo } = pending;
  const clean = () => history.replaceState(null, "", returnTo);
  try {
    if (params.get("error")) throw new Error(`${params.get("error")}: ${params.get("error_description") ?? ""}`);
    if (params.get("state") !== pending.state) throw new Error("sign-in state mismatch; please try again");
    if (pending.kind === "community") {
      const token = params.get("access_token");
      if (!token) throw new Error("the Community app returned no token");
      const expiresIn = Number(params.get("expires_in"));
      setSession({ accessToken: token, expiresAt: Number.isFinite(expiresIn) && expiresIn > 0 ? Date.now() + expiresIn * 1000 : jwtExpiry(token), name: jwtName(token), source: "community" });
      return true;
    }
    if (!cfg.oidc) throw new Error("OIDC is not configured");
    const meta = await discover(cfg.oidc);
    const res = await fetch(meta.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: params.get("code") ?? "",
        redirect_uri: redirectUri(),
        client_id: cfg.oidc.clientId,
        code_verifier: pending.verifier ?? "",
      }),
    });
    if (!res.ok) throw new Error(`token exchange failed (${res.status})`);
    const tok = (await res.json()) as { access_token: string; expires_in?: number; id_token?: string };
    setSession({
      accessToken: tok.access_token,
      expiresAt: tok.expires_in ? Date.now() + tok.expires_in * 1000 : jwtExpiry(tok.access_token),
      name: (tok.id_token && jwtName(tok.id_token)) || jwtName(tok.access_token),
      source: "oidc",
    });
    return true;
  } finally {
    clean();
  }
}
