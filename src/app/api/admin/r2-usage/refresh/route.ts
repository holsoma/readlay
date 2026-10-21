import { refreshR2Usage } from "@/lib/r2-metrics";
import { requireR2Admin, quotaPrivateHeaders, quotaErrorResponse, readQuotaAction } from "@/lib/r2-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    await requireR2Admin();
    await readQuotaAction(request);
    return Response.json(await refreshR2Usage(), { headers: quotaPrivateHeaders });
  } catch (error) { return quotaErrorResponse(error); }
}
