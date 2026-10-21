import assert from "node:assert/strict";
import test from "node:test";
import { loadTypeScript } from "./helpers/load-typescript.mjs";
import { prepareEnvironment, validateEnvironment, vercelArguments } from "../scripts/audio/configure_r2_protection.mjs";

function harness({ id = "123", configured = true, administrators = "123" } = {}) {
  const calls = [];
  const quota = loadTypeScript("src/lib/r2-quota.ts", { stubs: { "server-only": {} } });
  const admin = loadTypeScript("src/lib/r2-admin.ts", { stubs: { "server-only": {}, "./r2-quota": quota,
    "@/auth": { authConfigured: configured, auth: async () => id ? { user: { id, login: "pretend-admin", isAdmin: true } } : null },
  }, env: { READLAY_ADMIN_GITHUB_IDS: administrators } });
  const stubs = { "@/lib/r2-admin": admin, "@/lib/r2-quota": { ...quota, getR2QuotaStatus: async () => { calls.push("status"); return { verified: true }; },
    updateR2Limits: async value => { calls.push(value); return { saved: true }; } },
    "@/lib/r2-metrics": { refreshR2Usage: async () => { calls.push("refresh"); return { refreshed: true }; } } };
  return { calls, quota, api: loadTypeScript("src/app/api/admin/r2-usage/route.ts", { stubs }),
    refresh: loadTypeScript("src/app/api/admin/r2-usage/refresh/route.ts", { stubs }), admin };
}
const request = (body = {}, headers = {}) => new Request("https://readlay.test/api/admin/r2-usage", { method: "POST", headers: { Origin: "https://readlay.test", "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });

test("admin routes reject missing sessions, unlisted IDs and user-controlled admin claims before any usage request", async () => {
  for (const [auth, status] of [[{ id: null }, 401], [{ configured: false }, 401], [{ id: "456" }, 403], [{ administrators: "" }, 403]]) {
    const { api, refresh, calls } = harness(auth);
    for (const response of [await api.GET(), await api.POST(request()), await refresh.POST(request())]) {
      assert.equal(response.status, status); assert.match(response.headers.get("Cache-Control"), /private.*no-store/);
    }
    assert.deepEqual(calls, []);
  }
});
test("admin mutations require the same origin, bounded valid JSON and cannot reset usage counters", async () => {
  const { api, refresh, calls } = harness();
  for (const value of [request({}, { Origin: "https://outside.test" }), request({}, { "Content-Type": "text/plain" }), request({ padding: "x".repeat(5000) })]) assert.equal((await api.POST(value)).status, 400);
  assert.equal((await refresh.POST(request({}, { Origin: "https://outside.test" }))).status, 400);
  assert.deepEqual(calls, []);
  assert.equal((await api.GET()).status, 200); assert.deepEqual(calls, ["status"]);
  const quota = loadTypeScript("src/lib/r2-quota.ts", { stubs: { "server-only": {} } });
  await assert.rejects(quota.updateR2Limits({ reservedClassB: 0 }), e => e.status === 400);
});
test("cron refresh requires the exact server-only secret before contacting Cloudflare or R2", async () => {
  let calls = 0;
  const { admin, quota } = harness();
  for (const env of [{}, { CRON_SECRET: "short" }, { CRON_SECRET: "a".repeat(32) }]) {
    const route = loadTypeScript("src/app/api/internal/r2-usage/refresh/route.ts", { env, globals: { Buffer }, stubs: {
      "@/lib/r2-quota": quota, "@/lib/r2-admin": admin, "@/lib/r2-metrics": { refreshR2Usage: async () => { calls++; return {}; } },
    } });
    assert.equal((await route.GET(new Request("https://readlay.test/cron"))).status, 401);
    assert.equal((await route.GET(new Request("https://readlay.test/cron", { headers: { Authorization: "Bearer incorrect" } }))).status, 401);
    if (env.CRON_SECRET?.length >= 32) assert.equal((await route.GET(new Request("https://readlay.test/cron", { headers: { Authorization: "Bearer " + env.CRON_SECRET } }))).status, 200);
  }
  assert.equal(calls, 1);
});
test("environment setup retains existing secrets and can upload only the three approved protection values", () => {
  const original = "AUTH_SECRET=keep-auth\nSUPABASE_SERVICE_ROLE_KEY=keep-service\nCLOUDFLARE_R2_ANALYTICS_TOKEN=" + "t".repeat(40) + "\n";
  const prepared = prepareEnvironment(original, "123", () => "c".repeat(40));
  assert.ok(prepared.startsWith(original)); assert.match(prepared, /READLAY_ADMIN_GITHUB_IDS=123/);
  assert.equal(prepareEnvironment(prepared, "456", () => { throw Error("must not replace a secret"); }), prepared);
  const values = validateEnvironment({ CLOUDFLARE_R2_ANALYTICS_TOKEN: "t".repeat(40), READLAY_ADMIN_GITHUB_IDS: "123", CRON_SECRET: "c".repeat(40) });
  assert.deepEqual(Object.keys(values), ["CLOUDFLARE_R2_ANALYTICS_TOKEN", "READLAY_ADMIN_GITHUB_IDS", "CRON_SECRET"]);
  for (const name of Object.keys(values)) { const args = vercelArguments(name); assert.ok(args.includes("--sensitive")); assert.ok(args.includes("production")); assert.equal(args.includes("preview"), false); }
  for (const name of ["DATABASE_URL", "AUTH_SECRET", "SUPABASE_SERVICE_ROLE_KEY", "R2_SECRET_ACCESS_KEY"]) assert.throws(() => vercelArguments(name));
});
