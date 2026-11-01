// Hosted-mode account: sign in with the Lightsmith Community account (OIDC or the Community
// token handoff, per runtime config), show who is signed in, sign out.

import { useSyncExternalStore } from "react";
import { CONFIG } from "../config/runtime";
import { PRODUCT } from "../config/brand";
import { getSession, onSessionChange, signIn, signOut, type Session } from "../lib/auth";
import { useConnection } from "../state/connection";
import { toast } from "../state/toast";

let cached: Session | null = getSession();
const subscribe = (cb: () => void) =>
  onSessionChange((s) => {
    cached = s;
    cb();
  });

export function useSession(): Session | null {
  return useSyncExternalStore(subscribe, () => cached);
}

export const signInConfigured = () => CONFIG.auth.mode !== "none";

export function startSignIn() {
  signIn(CONFIG.auth).catch((e) => toast(`Sign-in failed: ${(e as Error).message}`, "error"));
}

export function AccountButton() {
  const session = useSession();
  const mode = useConnection((s) => s.settings.mode);
  if (mode !== "hosted" || !signInConfigured()) return null;
  if (!session)
    return (
      <button onClick={startSignIn} data-testid="sign-in" title={`Sign in with your ${PRODUCT} Community account`}>
        Sign in
      </button>
    );
  return (
    <button
      onClick={() => {
        signOut();
        toast("Signed out");
      }}
      title={`Signed in via ${session.source}${session.expiresAt ? `, until ${new Date(session.expiresAt).toLocaleTimeString()}` : ""}. Click to sign out.`}
      data-testid="signed-in"
    >
      {session.name ?? "Signed in"} ⏏
    </button>
  );
}
