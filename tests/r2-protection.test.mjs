import assert from "node:assert/strict";
import test from "node:test";
import { loadTypeScript, plain } from "./helpers/load-typescript.mjs";

const account = "a".repeat(32), bucket = "readlay-audio", origin = `https://${account}.r2.cloudflarestorage.com`;
const audioPath = "book/edition/voice/generation/chapter-0001.opus";
const baseEnv = { R2_ACCOUNT_ID: account, R2_AUDIO_BUCKET: bucket, SUPABASE_URL: "https://project.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "sb_secret_testing_only" };
const types = loadTypeScript("src/lib/r2-quota-types.ts");
const limits = { enabled: true, uploadsEnabled: true, classAEnabled: true, classBEnabled: true, storageLimitBytes: 9e9, classALimit: 800000, classBLimit: 8000000, warningPercent: 80, maxSnapshotAgeSeconds: 93600, readRequestsPerMinute: 60, version: 1 };

test("safety settings reject free-tier ceilings, 9 GiB, invalid booleans and non-integer budgets", () => {
  assert.ok(types.parseR2Limits(limits));
  for (const patch of [{ storageLimitBytes: 9 * 1024 ** 3 }, { classALimit: 1e6 }, { classBLimit: 1e7 }, { warningPercent: 100 }, { enabled: "false" }, { classALimit: -1 }, { classBLimit: 1.5 }, { maxSnapshotAgeSeconds: 999999 }]) assert.equal(types.parseR2Limits({ ...limits, ...patch }), null);
});
test("admin authority uses a stable GitHub ID and is closed by default", () => {
  const admin = env => loadTypeScript("src/lib/admin-identity.ts", { env });
  assert.equal(admin({}).isReadlayAdminId("123"), false);
  const { isReadlayAdminId } = admin({ READLAY_ADMIN_GITHUB_IDS: "123, 456, invalid" });
  assert.equal(isReadlayAdminId("123"), true); assert.equal(isReadlayAdminId("456"), true);
  for (const id of [123, "holsoma", "00123", "789", null]) assert.equal(isReadlayAdminId(id), false);
});
test("quota authorisation is server-only, does not follow redirects, and fails closed without leaking errors", async () => {
  const calls = [];
  let result = { allowed: true };
  const quota = loadTypeScript("src/lib/r2-quota.ts", { env: baseEnv, stubs: { "server-only": {} }, globals: { fetch: async (...args) => { calls.push(args); return Response.json(result); } } });
  await quota.reserveR2Operation("GetObject", "123");
  assert.equal(calls[0][0].origin, "https://project.supabase.co");
  assert.equal(calls[0][1].redirect, "error"); assert.equal(calls[0][1].headers.apikey, baseEnv.SUPABASE_SERVICE_ROLE_KEY);
  assert.equal(calls[0][1].headers.Authorization, undefined);
  assert.deepEqual(JSON.parse(calls[0][1].body), { p_account_id: account, p_bucket: bucket, p_operation: "GetObject", p_subject: "123", p_object_key: null, p_bytes: 0 });
  result = { allowed: false, reason: "class_b_limit" };
  await assert.rejects(quota.reserveR2Operation("GetObject", "123"), e => e.status === 503 && /Class B/.test(e.message));
  result = { allowed: "true" };
  await assert.rejects(quota.reserveR2Operation("GetObject", "123"));
  const broken = loadTypeScript("src/lib/r2-quota.ts", { env: baseEnv, stubs: { "server-only": {} }, globals: { fetch: async () => { throw Error(baseEnv.SUPABASE_SERVICE_ROLE_KEY); } } });
  await assert.rejects(broken.reserveR2Operation("GetObject", "123"), e => e.status === 503 && !e.message.includes(baseEnv.SUPABASE_SERVICE_ROLE_KEY));
});

function proxyHarness({ quotaFailure = false, failure, head = false } = {}) {
  const calls = { reservations: [], sends: [], destroyed: 0 };
  const quota = loadTypeScript("src/lib/r2-quota.ts", { env: baseEnv, stubs: { "server-only": {} } });
  const client = { destroy() { calls.destroyed++; }, async send(command) {
    calls.sends.push(command.input);
    if (failure) throw failure;
    return { ContentLength: 3, ContentRange: head ? undefined : "bytes 0-2/100", Body: { transformToWebStream: () => new Response("abc").body } };
  } };
  const proxy = loadTypeScript("src/lib/r2-audio.ts", { stubs: {
    "server-only": {}, "./r2-client": { r2Client: () => client },
    "./r2-quota": { ...quota, reserveR2Operation: async (...args) => { calls.reservations.push(args); if (quotaFailure) throw new quota.R2QuotaError(503, "Budget exhausted"); } },
    "@aws-sdk/client-s3": { GetObjectCommand: class { constructor(input) { this.input = input; } }, HeadObjectCommand: class { constructor(input) { this.input = input; } } },
  }, globals: { ReadableStream } });
  return { proxy, calls };
}
test("audio range requests reserve Class B before R2 and return bytes without exposing credentials", async () => {
  const { proxy, calls } = proxyHarness();
  const response = await proxy.streamR2Audio(new Request("https://readlay.test/audio", { headers: { Range: "bytes=0-2" } }), "123", { provider: "r2", origin, bucket }, audioPath, 100);
  assert.equal(response.status, 206); assert.equal(await response.text(), "abc");
  assert.deepEqual(plain(calls.reservations), [["GetObject", "123"]]);
  assert.equal(calls.sends[0].Range, "bytes=0-2"); assert.equal(calls.destroyed, 1);
  assert.equal(response.headers.get("Content-Range"), "bytes 0-2/100"); assert.equal(response.headers.get("Location"), null);
});
test("a blocked quota, invalid range or wrong destination cannot reach R2", async () => {
  const blocked = proxyHarness({ quotaFailure: true });
  await assert.rejects(blocked.proxy.streamR2Audio(new Request("https://readlay.test/audio"), "123", { provider: "r2", origin, bucket }, audioPath));
  assert.equal(blocked.calls.sends.length, 0);
  for (const range of ["bytes=0-2,6-8", "bytes=-0", "bytes=8-2", "bytes=999999999999999999999-", "garbage"]) {
    const { proxy, calls } = proxyHarness();
    const response = await proxy.streamR2Audio(new Request("https://readlay.test/audio", { headers: { Range: range } }), "123", { provider: "r2", origin, bucket }, audioPath);
    assert.equal(response.status, 416); assert.equal(calls.reservations.length, 0); assert.equal(calls.sends.length, 0);
  }
  const { proxy, calls } = proxyHarness();
  await assert.rejects(proxy.streamR2Audio(new Request("https://readlay.test/audio"), "123", { provider: "r2", origin: "https://public.r2.dev", bucket }, audioPath));
  assert.equal(calls.reservations.length, 0);
});
test("HEAD and upstream failures consume one reserved attempt and are never automatically retried", async () => {
  const { proxy, calls } = proxyHarness({ head: true });
  const response = await proxy.streamR2Audio(new Request("https://readlay.test/audio", { method: "HEAD" }), "123", { provider: "r2", origin, bucket }, audioPath);
  assert.equal(response.status, 200); assert.equal(await response.text(), ""); assert.deepEqual(plain(calls.reservations), [["HeadObject", "123"]]);
  const failed = proxyHarness({ failure: new Error("secret signed SDK request") });
  await assert.rejects(failed.proxy.streamR2Audio(new Request("https://readlay.test/audio"), "123", { provider: "r2", origin, bucket }, audioPath), e => e.status === 503 && !e.message.includes("secret signed"));
  assert.equal(failed.calls.sends.length, 1); assert.equal(failed.calls.reservations.length, 1);
  let config;
  const factory = loadTypeScript("src/lib/r2-client.ts", { stubs: { "server-only": {}, "./r2-quota": { r2Identity: () => ({ account, bucket }) }, "@aws-sdk/client-s3": { S3Client: class { constructor(value) { config = value; } } } }, env: { R2_ACCESS_KEY_ID: "test-access", R2_SECRET_ACCESS_KEY: "test-secret" } });
  factory.r2Client(); assert.equal(config.maxAttempts, 1);
});

const now = new Date("2026-10-21T08:00:00Z");
const op = (actionType, requests) => ({ dimensions: { actionType }, sum: { requests } });
const storageRow = (name, payloadSize, time = "2026-10-21T07:30:00Z") => ({ dimensions: { bucketName: name, datetime: time }, max: { payloadSize, metadataSize: 10, objectCount: 2, uploadCount: 0 } });
const metrics = () => ({ data: { viewer: { accounts: [{ r2OperationsAdaptiveGroups: [op("PutObject", 10), op("GetObject", 100), op("DeleteObject", 5)], monthlyOperations: [op("PutObject", 3), op("GetObject", 30)], r2StorageAdaptiveGroups: [storageRow(bucket, 1000), storageRow("other-bucket", 2000), storageRow(bucket, 500, "2026-10-21T06:00:00Z")] }] } } });
const metricsParser = loadTypeScript("src/lib/r2-metrics.ts", { stubs: { "server-only": {} } }).parseCloudflareR2Metrics;
test("account analytics cover other buckets and distinguish monthly totals from the protective 31-day window", () => {
  const result = metricsParser(metrics(), bucket, now);
  assert.equal(result.storageBytes, 3020); assert.equal(result.otherStorageBytes, 2010);
  assert.equal(result.classA, 10); assert.equal(result.classB, 100); assert.equal(result.monthlyClassA, 3); assert.equal(result.monthlyClassB, 30);
});
test("missing, truncated, stale, unknown-operation and partial-error analytics never become zero usage", () => {
  for (const mutate of [
    value => { value.errors = [{ message: "partial failure" }]; },
    value => { value.data.viewer.accounts = []; },
    value => { value.data.viewer.accounts[0].r2StorageAdaptiveGroups = []; },
    value => { value.data.viewer.accounts[0].r2StorageAdaptiveGroups[0].dimensions.datetime = "2026-10-18T00:00:00Z"; },
    value => { value.data.viewer.accounts[0].r2OperationsAdaptiveGroups.push(op("FutureUnknownOperation", 1)); },
    value => { value.data.viewer.accounts[0].r2OperationsAdaptiveGroups = Array(1000).fill(op("GetObject", 1)); },
    value => { value.data.viewer.accounts[0].r2StorageAdaptiveGroups[0].max.payloadSize = -1; },
  ]) { const value = metrics(); mutate(value); assert.throws(() => metricsParser(value, bucket, now)); }
});
