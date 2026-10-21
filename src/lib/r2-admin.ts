import "server-only";
import { auth, authConfigured } from "@/auth";
import { isReadlayAdminId } from "./admin-identity";
import { R2QuotaError } from "./r2-quota";

export async function requireR2Admin(): Promise<string> {
  const session = authConfigured ? await auth() : null;
  if (!session?.user?.id) throw new R2QuotaError(401, "Sign in with the administrator's GitHub account.");
  if (!isReadlayAdminId(session.user.id)) throw new R2QuotaError(403, "Administrator access is required.");
  return session.user.id;
}
export const quotaPrivateHeaders = { "Cache-Control": "private, no-store, max-age=0", Vary: "Cookie", "X-Content-Type-Options": "nosniff" };
export function quotaErrorResponse(error: unknown) {
  return Response.json({ error: error instanceof R2QuotaError ? error.message : "R2 usage protection is temporarily unavailable." },
    { status: error instanceof R2QuotaError ? error.status : 503, headers: quotaPrivateHeaders });
}
export async function readQuotaAction(request: Request): Promise<unknown> {
  if (request.headers.get("origin") !== new URL(request.url).origin) throw new R2QuotaError(400, "Invalid request origin.");
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json" || !request.body) throw new R2QuotaError(400, "Send a JSON request.");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 4096) { await reader.cancel(); throw new Error("Body too large"); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch { throw new R2QuotaError(400, "Send a valid JSON request no larger than 4 KB."); }
  finally { reader.releaseLock(); }
}
