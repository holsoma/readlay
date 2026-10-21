import "server-only";
import { parseR2Limits, parseR2QuotaStatus, type R2Limits, type R2QuotaStatus } from "./r2-quota-types";

export class R2QuotaError extends Error {
  constructor(public readonly status: 400 | 401 | 403 | 409 | 429 | 503, message: string) { super(message); }
}

export function r2Identity() {
  const account = process.env.R2_ACCOUNT_ID?.trim().toLowerCase();
  const bucket = process.env.R2_AUDIO_BUCKET?.trim() || "readlay-audio";
  if (!account || !/^[a-f0-9]{32}$/.test(account) || !/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(bucket)) throw new R2QuotaError(503, "R2 usage protection is not configured.");
  return { account, bucket };
}

/** Only the server and trusted preparation process hold this key. Never follow redirects. */
export async function r2QuotaRpc(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
  if (!/^readlay_r2_[a-z_]+$/.test(name)) throw new R2QuotaError(503, "R2 usage protection is unavailable.");
  const { account, bucket } = r2Identity();
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  let origin: URL;
  try { origin = new URL(process.env.SUPABASE_URL || ""); } catch { throw new R2QuotaError(503, "R2 usage protection is not configured."); }
  if (!key || /\s/.test(key) || origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new R2QuotaError(503, "R2 usage protection is not configured.");
  const headers: Record<string, string> = { apikey: key, "Content-Type": "application/json" };
  if (!key.startsWith("sb_secret_")) headers.Authorization = `Bearer ${key}`;
  try {
    const response = await fetch(new URL(`/rest/v1/rpc/${name}`, origin), {
      method: "POST", headers, body: JSON.stringify({ ...args, p_account_id: account, p_bucket: bucket }),
      redirect: "error", cache: "no-store", signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error("Quota service rejected the request");
    const bytes = await response.text();
    if (bytes.length > 512_000) throw new Error("Quota response too large");
    return bytes ? JSON.parse(bytes) : null;
  } catch { throw new R2QuotaError(503, "R2 usage could not be verified. No new R2 request was authorised."); }
}

export async function getR2QuotaStatus(): Promise<R2QuotaStatus> {
  await r2QuotaRpc("readlay_r2_bind");
  const status = parseR2QuotaStatus(await r2QuotaRpc("readlay_r2_status"));
  if (!status) throw new R2QuotaError(503, "R2 usage could not be verified.");
  return status;
}
const reasons: Record<string, string> = {
  configuration: "R2 usage protection is not configured.", paused: "R2 requests are paused by the administrator.",
  usage_unavailable: "Audiobook storage requests are paused until usage can be verified.",
  inventory_unavailable: "Uploads are paused until a complete storage inventory is available.",
  class_a_limit: "The R2 Class A safety controls have paused uploads and lists.",
  class_b_limit: "The R2 Class B safety controls have paused listening.",
  verification_limit: "Uploads are paused because the readback verification budget is exhausted.",
  storage_limit: "The R2 storage safety limit has been reached. Uploads are paused.",
  uploads_paused: "Uploads are paused by the administrator.",
  multipart_pending: "Uploads are paused while unfinished multipart uploads need review.",
  read_rate: "Too many audio requests. Wait a minute and try again.",
};
export type R2Operation = "GetObject" | "HeadObject" | "HeadBucket" | "PutObject" | "ListObjectsV2";
export async function reserveR2Operation(operation: R2Operation, subject: string, objectKey?: string, bytes = 0): Promise<void> {
  const result = await r2QuotaRpc("readlay_r2_reserve", { p_operation: operation, p_subject: subject, p_object_key: objectKey ?? null, p_bytes: bytes });
  if (!result || typeof result !== "object" || !("allowed" in result) || result.allowed !== true) {
    const reason = result && typeof result === "object" && "reason" in result && typeof result.reason === "string" ? result.reason : "usage_unavailable";
    throw new R2QuotaError(reason === "read_rate" ? 429 : 503, reasons[reason] || "R2 requests are paused until usage can be verified.");
  }
}
export async function updateR2Limits(value: unknown): Promise<R2QuotaStatus> {
  const limits: R2Limits | null = parseR2Limits(value);
  if (!limits) throw new R2QuotaError(400, "Use positive safety limits below the free allowances, with storage no higher than 9 GB.");
  if (await r2QuotaRpc("readlay_r2_update_limits", { p_limits: limits }) !== true) throw new R2QuotaError(409, "These settings changed in another session. Reload before saving.");
  return getR2QuotaStatus();
}
