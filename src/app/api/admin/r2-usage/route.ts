import { getR2QuotaStatus, updateR2Limits } from "@/lib/r2-quota";
import { requireR2Admin, quotaPrivateHeaders, quotaErrorResponse, readQuotaAction } from "@/lib/r2-admin";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try { await requireR2Admin(); return Response.json(await getR2QuotaStatus(), { headers: quotaPrivateHeaders }); }
  catch (error) { return quotaErrorResponse(error); }
}
export async function POST(request: Request) {
  try {
    await requireR2Admin();
    return Response.json(await updateR2Limits(await readQuotaAction(request)), { headers: quotaPrivateHeaders });
  } catch (error) { return quotaErrorResponse(error); }
}
