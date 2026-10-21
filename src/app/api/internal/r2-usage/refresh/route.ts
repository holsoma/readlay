import { timingSafeEqual } from "node:crypto";
import { refreshR2Usage } from "@/lib/r2-metrics";
import { R2QuotaError } from "@/lib/r2-quota";
import { quotaPrivateHeaders, quotaErrorResponse } from "@/lib/r2-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;
export async function GET(request: Request) {
  try {
    const secret = process.env.CRON_SECRET;
    const expected = Buffer.from(`Bearer ${secret || ""}`), actual = Buffer.from(request.headers.get("authorization") || "");
    if (!secret || secret.length < 32 || actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new R2QuotaError(401, "Unauthorised.");
    return Response.json(await refreshR2Usage(), { headers: quotaPrivateHeaders });
  } catch (error) { return quotaErrorResponse(error); }
}
