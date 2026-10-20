"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { ArrowRight } from "lucide-react";

export function SignInForm({ configured, callbackUrl }: { configured: boolean; callbackUrl: string }) {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");

  async function continueWithGitHub() {
    if (!configured || pending) return;
    setPending(true);
    setError("");
    try {
      await signIn("github", { redirectTo: callbackUrl });
    } catch {
      setPending(false);
      setError("GitHub could not be reached. Try again.");
    }
  }

  return <div className="sign-in-form">
    <button className="button primary auth-github" disabled={!configured || pending} onClick={continueWithGitHub}>{pending ? "Opening GitHub…" : "Continue with GitHub"}<ArrowRight size={18} /></button>
    {error && <p className="sign-in-error" role="alert">{error}</p>}
  </div>;
}
