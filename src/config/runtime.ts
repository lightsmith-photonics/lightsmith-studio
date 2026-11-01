// Deployment configuration, read once at startup. Three layers, last one wins:
//   1. built-in defaults,
//   2. build-time Vite env (VITE_*), for `npm run build` / Tauri builds,
//   3. runtime `window.__STUDIO_CONFIG__` from /config.js, which the Docker image writes
//      from its environment at container start (docker/40-studio-config.sh).
// So one image can point at any compute / materials / sign-in deployment.

export type ServerMode = "mock" | "local" | "hosted";

export interface OidcConfig {
  /** Issuer URL; `${issuer}/.well-known/openid-configuration` must be CORS-readable. */
  issuer: string;
  clientId: string;
  scope: string;
  /** Optional `audience` parameter some IdPs need for API access tokens. */
  audience?: string;
}

export interface RuntimeConfig {
  /** Which server a first-time user starts on. */
  defaultServer: ServerMode;
  /** Hosted compute base URL ("" = same origin as Studio). */
  computeUrl: string;
  /** Local compute base URL. */
  localComputeUrl: string;
  /** materials-db base URL ("" = use the built-in bundled library only). */
  materialsUrl: string;
  /** Hosted sign-in: none (API key field only), standard OIDC, or the Community token handoff. */
  auth: { mode: "none" | "oidc" | "community"; oidc?: OidcConfig; communityUrl?: string };
}

type Partial2<T> = { [K in keyof T]?: T[K] extends object ? Partial<T[K]> : T[K] };

declare global {
  interface Window {
    __STUDIO_CONFIG__?: Partial2<RuntimeConfig>;
  }
}

const env = (import.meta.env ?? {}) as Record<string, string | undefined>;
const nonEmpty = (v: string | undefined) => (v && v.trim() ? v.trim() : undefined);

export function buildConfig(runtime: Partial2<RuntimeConfig> | undefined = globalThis.window?.__STUDIO_CONFIG__): RuntimeConfig {
  const fromEnv: Partial2<RuntimeConfig> = {
    defaultServer: nonEmpty(env.VITE_DEFAULT_SERVER) as ServerMode | undefined,
    computeUrl: nonEmpty(env.VITE_COMPUTE_URL),
    localComputeUrl: nonEmpty(env.VITE_LOCAL_COMPUTE_URL),
    materialsUrl: nonEmpty(env.VITE_MATERIALS_URL),
  };
  const oidcIssuer = nonEmpty(env.VITE_OIDC_ISSUER);
  if (oidcIssuer) fromEnv.auth = { mode: "oidc", oidc: { issuer: oidcIssuer, clientId: env.VITE_OIDC_CLIENT_ID ?? "", scope: env.VITE_OIDC_SCOPE ?? "openid profile" } };
  else if (nonEmpty(env.VITE_COMMUNITY_URL)) fromEnv.auth = { mode: "community", communityUrl: nonEmpty(env.VITE_COMMUNITY_URL) };

  const clean = <T extends object>(o: T | undefined): Partial<T> => Object.fromEntries(Object.entries(o ?? {}).filter(([, v]) => v !== undefined && v !== "")) as Partial<T>;
  const merged = { ...clean(fromEnv), ...clean(runtime) };
  const computeUrl = merged.computeUrl ?? "";
  return {
    defaultServer: (merged.defaultServer as ServerMode) ?? (computeUrl ? "hosted" : "local"),
    computeUrl,
    localComputeUrl: merged.localComputeUrl ?? "http://localhost:8200",
    materialsUrl: merged.materialsUrl ?? "",
    auth: { mode: "none", ...(fromEnv.auth as object), ...clean(runtime?.auth as object) } as RuntimeConfig["auth"],
  };
}

export const CONFIG = buildConfig();
