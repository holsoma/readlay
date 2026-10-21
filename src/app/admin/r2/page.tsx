import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import { requireR2Admin } from "@/lib/r2-admin";
import { getR2QuotaStatus, R2QuotaError } from "@/lib/r2-quota";
import { R2UsageDashboard } from "@/components/R2UsageDashboard";
import "./usage.css";

export const metadata: Metadata = { title: "R2 usage", robots: { index: false, follow: false } };
export const dynamic = "force-dynamic";
export default async function R2AdminPage() {
  try { await requireR2Admin(); }
  catch (error) {
    if (error instanceof R2QuotaError && error.status === 401) redirect("/sign-in?callbackUrl=%2Fadmin%2Fr2");
    notFound();
  }
  let status = null, error = null;
  try { status = await getR2QuotaStatus(); }
  catch { error = "Usage could not be loaded. Check the Supabase quota migration and server configuration, then reload."; }
  return <R2UsageDashboard initialStatus={status} initialError={error} analyticsConfigured={!!process.env.CLOUDFLARE_R2_ANALYTICS_TOKEN?.trim()} />;
}
