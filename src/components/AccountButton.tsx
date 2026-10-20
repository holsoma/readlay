"use client";

import { useState } from "react";
import { LogOut } from "lucide-react";
import { signOut, useSession } from "next-auth/react";
import { useReadlay } from "./ReadlayProvider";

function GitHubMark({ size = 17 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 .9a11.1 11.1 0 0 0-3.5 21.6c.6.1.8-.2.8-.5v-2.1c-3.4.7-4.1-1.5-4.1-1.5-.6-1.4-1.4-1.8-1.4-1.8-1.1-.8.1-.8.1-.8 1.2.1 1.8 1.2 1.8 1.2 1.1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.6-1.4-5.6-6.2 0-1.4.5-2.5 1.3-3.4-.1-.3-.6-1.6.2-3.3 0 0 1-.3 3.4 1.3a11.8 11.8 0 0 1 6.2 0c2.4-1.6 3.4-1.3 3.4-1.3.8 1.7.3 3 .2 3.3.8.9 1.3 2 1.3 3.4 0 4.8-2.9 5.9-5.6 6.2.4.4.8 1.1.8 2.3V22c0 .3.2.6.8.5A11.1 11.1 0 0 0 12 .9Z" /></svg>;
}

export function AccountButton({ mobile = false }: { mobile?: boolean }) {
  const { data: session, status } = useSession();
  const { openAuth, notify } = useReadlay();
  const [pending, setPending] = useState(false);
  const login = session?.user.login ? `@${session.user.login}` : session?.user.name || "GitHub account";

  async function leaveAccount() {
    if (pending) return;
    setPending(true);
    try {
      await signOut({ redirectTo: "/" });
    } catch {
      setPending(false);
      notify("Sign-out did not finish. Try again.");
    }
  }

  if (status === "authenticated") return <button className={mobile ? "mobile-account" : "button signin account-button"} onClick={leaveAccount} disabled={pending} aria-label={`Sign out of ${login}`} title={`Sign out of ${login}`}><LogOut size={mobile ? 19 : 17} /><span className="account-name">{pending ? "Signing out…" : login}</span>{!mobile && <span className="account-action">Sign out</span>}</button>;
  return <button className={mobile ? "mobile-account" : "button signin"} onClick={openAuth} disabled={status === "loading"}><GitHubMark size={mobile ? 19 : 17} /><span>{status === "loading" ? "Checking account…" : mobile ? "Sign in" : "Sign in with GitHub"}</span></button>;
}
