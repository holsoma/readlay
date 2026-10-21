import "server-only";
import { ListObjectsV2Command } from "@aws-sdk/client-s3";
import { r2Client } from "./r2-client";
import { getR2QuotaStatus, R2QuotaError, r2Identity, r2QuotaRpc, reserveR2Operation } from "./r2-quota";

const classA = new Set(["listbuckets", "putbucket", "listobjects", "listobjectsv2", "putobject", "copyobject", "completemultipartupload", "createmultipartupload", "lifecyclestoragetiertransition", "listmultipartuploads", "uploadpart", "uploadpartcopy", "listparts", "putbucketencryption", "putbucketcors", "putbucketlifecycleconfiguration"]);
const classB = new Set(["headbucket", "headobject", "getobject", "usagesummary", "getbucketencryption", "getbucketlocation", "getbucketcors", "getbucketlifecycleconfiguration"]);
const free = new Set(["deleteobject", "deletebucket", "abortmultipartupload"]);
// Dashboard configuration reads occur in Analytics but have no explicit class in
// the published pricing list. Charge both protective budgets rather than omit them.
const conservative = new Set(["getbucketnotificationconfiguration", "getbucketsippyconfiguration"]);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
function integer(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("Invalid metric");
  return value;
}
export type R2Snapshot = { period: string; classA: number; classB: number; monthlyClassA: number; monthlyClassB: number; storageBytes: number; otherStorageBytes: number; objectCount: number; pendingMultipartUploads: number; storageAt: string };

/** Account-wide, never a bucket-only approximation of the account free allowance. */
export function parseCloudflareR2Metrics(value: unknown, bucket: string, now = new Date()): R2Snapshot {
  if (!record(value) || (value.errors != null && (!Array.isArray(value.errors) || value.errors.length)) || !record(value.data) || !record(value.data.viewer)) throw new Error("Invalid analytics response");
  const accounts = value.data.viewer.accounts;
  if (!Array.isArray(accounts) || accounts.length !== 1 || !record(accounts[0])) throw new Error("Account analytics unavailable");
  const operations = accounts[0].r2OperationsAdaptiveGroups, storage = accounts[0].r2StorageAdaptiveGroups;
  if (!Array.isArray(operations) || operations.length >= 1000 || !Array.isArray(storage) || !storage.length || storage.length >= 10000) throw new Error("Incomplete account analytics");
  function operationTotals(items: unknown) {
    if (!Array.isArray(items) || items.length >= 1000) throw new Error("Incomplete operation analytics");
    let a = 0, b = 0;
    for (const row of items) {
    if (!record(row) || !record(row.sum) || !record(row.dimensions) || typeof row.dimensions.actionType !== "string") throw new Error("Invalid operation analytics");
    const action = row.dimensions.actionType.toLowerCase().replace(/[^a-z0-9]/g, ""), n = integer(row.sum.requests);
    if (classA.has(action)) a += n;
    else if (classB.has(action)) b += n;
    else if (conservative.has(action)) { a += n; b += n; }
    else if (!free.has(action) && n) throw new Error("An R2 operation is not classified");
    }
    return { a: integer(a), b: integer(b) };
  }
  const { a, b } = operationTotals(operations), monthly = operationTotals(accounts[0].monthlyOperations);
  const buckets = new Map<string, { bytes: number; objects: number; multipart: number; latest: number }>();
  for (const row of storage) {
    if (!record(row) || !record(row.max) || !record(row.dimensions) || typeof row.dimensions.bucketName !== "string" || !row.dimensions.bucketName || typeof row.dimensions.datetime !== "string") throw new Error("Invalid storage analytics");
    const latest = Date.parse(row.dimensions.datetime);
    if (!Number.isFinite(latest) || latest > now.getTime() || latest < now.getTime() - 26 * 3600_000) throw new Error("Stale storage analytics");
    const bytes = integer(row.max.payloadSize) + integer(row.max.metadataSize), objects = integer(row.max.objectCount), multipart = integer(row.max.uploadCount);
    const previous = buckets.get(row.dimensions.bucketName);
    buckets.set(row.dimensions.bucketName, { bytes: Math.max(bytes, previous?.bytes ?? 0), objects: Math.max(objects, previous?.objects ?? 0), multipart: Math.max(multipart, previous?.multipart ?? 0), latest: Math.max(latest, previous?.latest ?? 0) });
  }
  if (!buckets.has(bucket)) throw new Error("The configured bucket has no storage observations");
  const rows = [...buckets.entries()];
  const sum = (get: (entry: [string, { bytes: number; objects: number; multipart: number; latest: number }]) => number) => integer(rows.reduce((total, entry) => total + get(entry), 0));
  return { period: now.toISOString().slice(0, 7) + "-01", classA: a, classB: b, monthlyClassA: monthly.a, monthlyClassB: monthly.b,
    storageBytes: sum(([, row]) => row.bytes), otherStorageBytes: sum(([name, row]) => name === bucket ? 0 : row.bytes),
    objectCount: sum(([, row]) => row.objects), pendingMultipartUploads: sum(([, row]) => row.multipart),
    storageAt: new Date(Math.min(...rows.map(([, row]) => row.latest))).toISOString() };
}

export async function fetchCloudflareR2Metrics(): Promise<R2Snapshot> {
  const token = process.env.CLOUDFLARE_R2_ANALYTICS_TOKEN?.trim();
  if (!token || /\s/.test(token)) throw new R2QuotaError(503, "Add the server-only Cloudflare Analytics token before enabling R2 requests.");
  const { account, bucket } = r2Identity(), now = new Date();
  const query = `query ReadlayUsage($account: string!, $month: Time!, $lookback: Time!, $storageStart: Time!, $end: Time!) {
    viewer { accounts(filter: {accountTag: $account}) {
      r2OperationsAdaptiveGroups(limit: 1000, filter: {datetime_geq: $lookback, datetime_leq: $end}) { sum { requests } dimensions { actionType } }
      monthlyOperations: r2OperationsAdaptiveGroups(limit: 1000, filter: {datetime_geq: $month, datetime_leq: $end}) { sum { requests } dimensions { actionType } }
      r2StorageAdaptiveGroups(limit: 10000, filter: {datetime_geq: $storageStart, datetime_leq: $end}, orderBy: [datetime_DESC]) {
        max { payloadSize metadataSize objectCount uploadCount } dimensions { bucketName datetime }
      }
    } }
  }`;
  const response = await fetch("https://api.cloudflare.com/client/v4/graphql", { method: "POST", redirect: "error", cache: "no-store",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, signal: AbortSignal.timeout(20_000),
    body: JSON.stringify({ query, variables: { account, month: now.toISOString().slice(0, 7) + "-01T00:00:00Z", lookback: new Date(now.getTime() - 31 * 86400_000 + 1000).toISOString(), storageStart: new Date(now.getTime() - 26 * 3600_000).toISOString(), end: now.toISOString() } }) });
  if (!response.ok) throw new Error("Analytics request failed");
  const text = await response.text();
  if (text.length > 8_000_000) throw new Error("Analytics response too large");
  return parseCloudflareR2Metrics(JSON.parse(text), bucket, now);
}

export async function refreshR2Usage() {
  await r2QuotaRpc("readlay_r2_bind");
  const token = crypto.randomUUID();
  const lease = await r2QuotaRpc("readlay_r2_begin_refresh", { p_token: token });
  if (!record(lease) || typeof lease.startedAt !== "string" || !Number.isFinite(Date.parse(lease.startedAt))) throw new R2QuotaError(429, "A refresh is running or was started less than five minutes ago.");
  let stage = process.env.CLOUDFLARE_R2_ANALYTICS_TOKEN?.trim() ? "analytics_unavailable" : "analytics_configuration";
  try {
    const snapshot = await fetchCloudflareR2Metrics();
    await r2QuotaRpc("readlay_r2_observe", { p_token: token, p_snapshot: snapshot });
    stage = "inventory_unavailable";
    const { bucket } = r2Identity(), inventoryStartedAt = lease.startedAt;
    const client = r2Client();
    const objects: { key: string; size: number }[] = [];
    const seen = new Set<string>(), continuations = new Set<string>();
    let continuation: string | undefined;
    try {
      for (let page = 0; page < 100; page++) {
        await reserveR2Operation("ListObjectsV2", "operator");
        const response = await client.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1000, ContinuationToken: continuation }), { abortSignal: AbortSignal.timeout(20_000) });
        if (response.$metadata.httpStatusCode !== 200 || typeof response.IsTruncated !== "boolean" || !Number.isSafeInteger(response.KeyCount) || response.KeyCount! < 0 || response.KeyCount! > 1000 || (response.Contents ?? []).length !== response.KeyCount) throw new Error("Incomplete inventory page");
        for (const object of response.Contents ?? []) {
          if (!object.Key || seen.has(object.Key) || typeof object.Size !== "number" || !Number.isSafeInteger(object.Size) || object.Size < 0) throw new Error("Incomplete inventory");
          seen.add(object.Key); objects.push({ key: object.Key, size: object.Size });
        }
        if (!response.IsTruncated) {
          await r2QuotaRpc("readlay_r2_finish_inventory", { p_token: token, p_objects: objects, p_inventory_started_at: inventoryStartedAt, p_other_storage_bytes: snapshot.otherStorageBytes });
          return getR2QuotaStatus();
        }
        if (!response.NextContinuationToken || continuations.has(response.NextContinuationToken)) throw new Error("Incomplete inventory");
        continuation = response.NextContinuationToken; continuations.add(continuation);
      }
      throw new Error("Inventory exceeded the reviewed page limit");
    } finally { client.destroy(); }
  } catch {
    try { await r2QuotaRpc("readlay_r2_fail_refresh", { p_token: token, p_reason: stage }); } catch { /* Missing/expired observations still fail closed. */ }
    throw new R2QuotaError(503, stage === "inventory_unavailable" ? "Cloudflare metrics were refreshed, but the bucket inventory could not be completed. Uploads remain paused." : "Cloudflare usage could not be verified. Check the Analytics token and refresh again after five minutes.");
  }
}
