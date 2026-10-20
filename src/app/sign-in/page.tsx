import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { auth, authConfigured, safeCallbackPath } from "@/auth";
import { AppShell } from "@/components/AppShell";
import { SignInForm } from "./SignInForm";

export const metadata: Metadata = { title: "Sign in", description: "Sign in to Readlay with GitHub to read the library.", robots: { index: false, follow: false } };

const authErrors: Record<string, string> = {
  AccessDenied: "GitHub sign-in was cancelled or access was declined. You can try again.",
  OAuthAccountNotLinked: "This GitHub account could not be connected. Try signing in again.",
  Configuration: "GitHub sign-in is unavailable. The site owner needs to check its configuration.",
  Verification: "This sign-in link has expired. Start again below.",
};

export default async function SignInPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const callbackUrl = safeCallbackPath(params.callbackUrl);
  const session = authConfigured ? await auth() : null;
  if (session?.user.id) redirect(callbackUrl);
  const error = typeof params.error === "string" ? authErrors[params.error] || "GitHub sign-in did not finish. Try again below." : "";

  return <AppShell title="Sign in"><section className="sign-in-page">
    <div className="sign-in-card">
      <span className="auth-mark" aria-hidden="true"><i /><i /></span>
      <h1>Sign in to read.</h1>
      <p>Sign in with GitHub to read the library.</p>
      {error && <p className="sign-in-error" role="alert">{error}</p>}
      {!authConfigured && <p className="sign-in-setup" role="status">GitHub sign-in is not configured yet.</p>}
      <SignInForm configured={authConfigured} callbackUrl={callbackUrl} />
      <p className="sign-in-privacy">GitHub shares your basic profile. Readlay does not request access to your repositories.</p>
      <Link className="text-link" href="/">Back to the library</Link>
    </div>
  </section></AppShell>;
}
