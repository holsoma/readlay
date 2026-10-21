import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const runtime = new URL("../.local/verification-runtime/node_modules/@electric-sql/pglite/dist/index.js", import.meta.url);
const account = "a".repeat(32), bucket = "readlay-audio";
test("real PostgreSQL R2 quotas protect concurrent requests, storage reservations, roles and monitoring failures", { skip: !existsSync(runtime) && "Local PostgreSQL verification runtime is not installed." }, async t => {
  const { PGlite } = await import(runtime.href);
  const db = new PGlite();
  try {
    await db.exec("CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;");
    await db.exec(readFileSync(new URL("../supabase/migrations/20261021083942_r2_usage_protection.sql", import.meta.url), "utf8"));
    const call = async (name, ...args) => (await db.query(`SELECT public.readlay_r2_${name}(${args.map((_, i) => `$${i + 1}`).join(",")}) AS value`, args)).rows[0].value;
    await call("bind", account, bucket);
    const status = () => call("status", account, bucket);
    const reserve = (operation, key = null, bytes = 0, subject = "operator") => call("reserve", account, bucket, operation, subject, key, bytes);
    const period = new Date().toISOString().slice(0, 7) + "-01";
    async function refresh({ objects = [], storage = 1000, other = 0, multipart = 0, a = 100, b = 100 } = {}) {
      await db.exec("UPDATE public.readlay_r2_limits SET refresh_started_at = NULL, refresh_until = NULL");
      const token = crypto.randomUUID(), lease = await call("begin_refresh", account, bucket, token);
      const snapshot = { period, classA: a, classB: b, monthlyClassA: a, monthlyClassB: b, storageBytes: storage, objectCount: objects.length,
        pendingMultipartUploads: multipart, storageAt: new Date().toISOString() };
      await call("observe", account, bucket, token, JSON.stringify(snapshot));
      await call("finish_inventory", account, bucket, token, JSON.stringify(objects), lease.startedAt, other);
    }
    async function reset() {
      await db.exec("TRUNCATE public.readlay_r2_months, public.readlay_r2_objects, public.readlay_r2_read_rates; UPDATE public.readlay_r2_limits SET enabled=true, uploads_enabled=true, class_a_enabled=true, class_b_enabled=true, storage_limit_bytes=9000000000, class_a_limit=800000, class_b_limit=8000000, warning_percent=80, max_snapshot_age_seconds=93600, read_requests_per_minute=60, version=1, last_refresh_error=NULL, refresh_token=NULL, refresh_started_at=NULL, refresh_until=NULL;");
    }
    await t.test("a fresh installation blocks all R2 calls until observations exist", async () => {
      assert.equal((await status()).health.fresh, false);
      for (const operation of ["GetObject", "HeadBucket", "ListObjectsV2", "PutObject"]) assert.equal((await reserve(operation, operation === "PutObject" ? "ebooks/a/file.epub" : null, operation === "PutObject" ? 100 : 0)).allowed, false);
      assert.equal((await db.query("SELECT count(*) AS n FROM public.readlay_r2_objects")).rows[0].n, 0);
    });
    await t.test("concurrent uploads cannot collectively cross the storage cap", async () => {
      await reset(); await refresh(); await db.exec("UPDATE public.readlay_r2_limits SET storage_limit_bytes=2000");
      const results = await Promise.all(Array.from({ length: 10 }, (_, i) => reserve("PutObject", `ebooks/a/${i}.epub`, 400)));
      assert.equal(results.filter(r => r.allowed).length, 2);
      assert.equal((await status()).usage.effectiveStorageBytes, 1800);
      assert.equal((await reserve("PutObject", "ebooks/a/exact.epub", 200)).reason, "storage_limit", "an upload exactly reaching the cap is blocked");
      assert.equal((await reserve("GetObject")).allowed, true, "storage exhaustion does not block the separate read budget");
    });
    await t.test("uncertain PUTs reserve space once, retries reserve new operations and bytes cannot change", async () => {
      await reset(); await refresh();
      assert.equal((await reserve("PutObject", "ebooks/a/file.epub", 400)).allowed, true);
      assert.equal((await reserve("PutObject", "ebooks/a/file.epub", 400)).allowed, true);
      assert.equal((await status()).usage.pendingStorageBytes, 400);
      assert.equal((await status()).usage.reservedClassA, 2);
      assert.equal((await reserve("PutObject", "ebooks/a/file.epub", 401)).reason, "immutable_object");
      assert.equal((await status()).usage.reservedClassA, 2);
      await refresh({ storage: 1400, objects: [{ key: "ebooks/a/file.epub", size: 400 }] });
      assert.equal((await status()).usage.pendingStorageBytes, 0);
      assert.equal((await status()).usage.effectiveStorageBytes, 1400);
      assert.equal((await status()).usage.reservedClassA, 2, "refresh does not refund possibly billed operations");
    });
    await t.test("objects reserved during an inventory remain protected even if that inventory sees them", async () => {
      await reset(); await refresh();
      await db.exec("UPDATE public.readlay_r2_limits SET refresh_started_at=NULL");
      const token = crypto.randomUUID(), lease = await call("begin_refresh", account, bucket, token);
      await call("observe", account, bucket, token, JSON.stringify({ period, classA: 100, classB: 100, monthlyClassA: 100, monthlyClassB: 100, storageBytes: 1000, objectCount: 0, pendingMultipartUploads: 0, storageAt: new Date().toISOString() }));
      assert.equal((await reserve("PutObject", "ebooks/a/new.epub", 100)).allowed, true);
      await call("finish_inventory", account, bucket, token, JSON.stringify([{ key: "ebooks/a/new.epub", size: 100 }]), lease.startedAt, 0);
      assert.equal((await status()).usage.pendingStorageBytes, 100, "a concurrent write must not lose its reservation");
    });
    await t.test("Class A and B caps are independent and atomic", async () => {
      await reset(); await refresh(); await db.exec("UPDATE public.readlay_r2_limits SET class_a_limit=101, class_b_limit=102");
      const writes = await Promise.all(Array.from({ length: 5 }, () => reserve("ListObjectsV2")));
      assert.equal(writes.filter(r => r.allowed).length, 1);
      assert.equal((await reserve("GetObject")).allowed, true); assert.equal((await reserve("HeadObject")).allowed, true);
      assert.equal((await reserve("GetObject")).reason, "class_b_limit");
      assert.equal((await reserve("PutObject", "ebooks/a/file.epub", 100)).reason, "class_a_limit");
    });
    await t.test("previous-month reservations are not forgotten by a calendar reset", async () => {
      await reset(); await refresh();
      await db.exec("INSERT INTO public.readlay_r2_months (period,reserved_class_b) VALUES ((date_trunc('month',now() AT TIME ZONE 'UTC') - interval '1 month')::date,500)");
      assert.equal((await status()).usage.effectiveClassB, 600);
      await db.exec("UPDATE public.readlay_r2_limits SET class_b_limit=600");
      assert.equal((await reserve("GetObject")).reason, "class_b_limit");
    });
    await t.test("stale observations, unknown accounts and unfinished multipart uploads fail closed", async () => {
      await reset(); await refresh({ multipart: 1 });
      assert.equal((await reserve("PutObject", "ebooks/a/file.epub", 10)).reason, "multipart_pending");
      assert.equal((await reserve("GetObject")).allowed, true);
      await db.exec("UPDATE public.readlay_r2_months SET observed_at=clock_timestamp()-interval '27 hours'");
      assert.equal((await reserve("GetObject")).reason, "usage_unavailable");
      assert.equal((await call("reserve", "b".repeat(32), bucket, "GetObject", "operator", null, 0)).reason, "configuration");
    });
    await t.test("rate limits stop a single signed-in user consuming all read operations", async () => {
      await reset(); await refresh(); await db.exec("UPDATE public.readlay_r2_limits SET read_requests_per_minute=2");
      assert.equal((await reserve("GetObject", null, 0, "123")).allowed, true);
      assert.equal((await reserve("HeadObject", null, 0, "123")).allowed, true);
      assert.equal((await reserve("GetObject", null, 0, "123")).reason, "read_rate");
      assert.equal((await reserve("GetObject", null, 0, "456")).allowed, true);
      assert.equal((await status()).usage.reservedClassB, 3);
    });
    await t.test("failed inventories cannot invalidate a verified Class B budget or release space", async () => {
      await reset(); await refresh(); await reserve("PutObject", "ebooks/a/file.epub", 123);
      await db.exec("UPDATE public.readlay_r2_limits SET refresh_started_at=NULL");
      const token = crypto.randomUUID(); await call("begin_refresh", account, bucket, token);
      await call("fail_refresh", account, bucket, token, "inventory_unavailable");
      assert.equal((await status()).health.fresh, true); assert.equal((await status()).health.inventoryFresh, false);
      assert.equal((await reserve("GetObject")).allowed, true);
      assert.equal((await reserve("PutObject", "ebooks/a/other.epub", 1)).reason, "inventory_unavailable");
      assert.equal((await status()).usage.pendingStorageBytes, 123);
      await db.exec("UPDATE public.readlay_r2_limits SET refresh_started_at=NULL");
      const nextToken = crypto.randomUUID(); await call("begin_refresh", account, bucket, nextToken);
      await call("fail_refresh", account, bucket, nextToken, "analytics_unavailable");
      assert.equal((await reserve("GetObject")).reason, "usage_unavailable");
    });
    await t.test("settings preserve pauses, reject unsafe ceilings and detect stale admin updates", async () => {
      await reset(); await refresh();
      const settings = (await status()).limits;
      assert.equal(await call("update_limits", account, bucket, JSON.stringify({ ...settings, uploadsEnabled: false })), true);
      assert.equal((await reserve("PutObject", "ebooks/a/file.epub", 1)).reason, "uploads_paused");
      assert.equal(await call("update_limits", account, bucket, JSON.stringify(settings)), false);
      await assert.rejects(call("update_limits", account, bucket, JSON.stringify({ ...settings, version: 2, classALimit: 1000000 })), /check constraint/);
      assert.equal((await status()).limits.version, 2);
    });
    await t.test("refresh leases, null inventories and missing snapshots cannot fabricate a verified zero", async () => {
      await reset();
      const token = crypto.randomUUID(), lease = await call("begin_refresh", account, bucket, token);
      assert.ok(lease.startedAt); assert.equal(await call("begin_refresh", account, bucket, crypto.randomUUID()), null);
      await assert.rejects(call("observe", account, bucket, null, JSON.stringify({})), /lease mismatch/);
      await assert.rejects(call("finish_inventory", account, bucket, token, null, lease.startedAt, 0), /Invalid R2 inventory/);
      assert.equal((await status()).health.fresh, false);
    });
    await t.test("anonymous and ordinary authenticated roles cannot read or execute the quota service", async () => {
      for (const role of ["anon", "authenticated"]) {
        await db.exec(`SET ROLE ${role}`);
        await assert.rejects(db.query("SELECT * FROM public.readlay_r2_limits"), /permission denied/);
        await assert.rejects(call("status", account, bucket), /permission denied/);
        await assert.rejects(call("reserve", account, bucket, "GetObject", "123", null, 0), /permission denied/);
        await db.exec("RESET ROLE");
      }
      const security = (await db.query("SELECT count(*) AS n FROM pg_proc WHERE proname LIKE 'readlay_r2_%' AND prosecdef")).rows[0];
      assert.equal(security.n, 0, "all quota functions must remain SECURITY INVOKER");
      await db.exec("SET ROLE service_role"); assert.ok(await status()); await db.exec("RESET ROLE");
    });
  } finally { await db.close(); }
});
