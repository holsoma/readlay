import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { initialEnvironmentText, validatedValues, vercelArguments, uploadVariable, PROJECT_REF, PROJECT_URL, VARIABLE_NAMES } from "../configure_storage.mjs";

const fakeSecret = "sb_secret_this_is_an_original_test_fixture_key";
const environment = { SUPABASE_URL: PROJECT_URL, SUPABASE_SERVICE_ROLE_KEY: fakeSecret, AUDIO_STORAGE_BUCKET: "readlay-audio", AUDIO_STORAGE_MODE: "supabase" };

test("initialisation preserves auth, database and existing storage secret lines", () => {
  const source = "AUTH_SECRET=original-auth-value\r\nDATABASE_URL='original database value'\r\nSUPABASE_SERVICE_ROLE_KEY=original-storage-secret\r\nAUDIO_STORAGE_MODE=local\r\n";
  const result = initialEnvironmentText(source);
  assert.ok(result.includes("AUTH_SECRET=original-auth-value\r\n"));
  assert.ok(result.includes("DATABASE_URL='original database value'\r\n"));
  assert.ok(result.includes("SUPABASE_SERVICE_ROLE_KEY=original-storage-secret\r\n"));
  assert.ok(result.includes(`SUPABASE_URL=${PROJECT_URL}\r\n`));
  assert.ok(result.includes("AUDIO_STORAGE_MODE=supabase\r\n"));
  assert.equal(result, initialEnvironmentText(result));
});

test("initialisation adds a blank key field and rejects duplicate storage fields", () => {
  assert.match(initialEnvironmentText("AUTH_SECRET=fixture\n"), /SUPABASE_SERVICE_ROLE_KEY=\n/);
  assert.throws(() => initialEnvironmentText("AUDIO_STORAGE_MODE=local\nAUDIO_STORAGE_MODE=supabase\n"), /more than once/);
});

test("a populated key assignment with surrounding whitespace is recognised and preserved", () => {
  const populatedLine = "  SUPABASE_SERVICE_ROLE_KEY = original-storage-secret";
  const result = initialEnvironmentText(populatedLine + "\nAUTH_SECRET=original-auth\n");
  assert.ok(result.includes(populatedLine + "\n"));
  assert.equal(result.match(/SUPABASE_SERVICE_ROLE_KEY/g).length, 1);
});

test("only server-only keys for the approved project are accepted", () => {
  assert.deepEqual(validatedValues(environment), environment);
  const payload = Buffer.from(JSON.stringify({ role: "service_role", ref: PROJECT_REF })).toString("base64url");
  assert.ok(validatedValues({ ...environment, SUPABASE_SERVICE_ROLE_KEY: `header.${payload}.signature` }));
  for (const key of ["", "sb_publishable_test_key", "abc.def.ghi", fakeSecret + "\nextra"]) {
    assert.throws(() => validatedValues({ ...environment, SUPABASE_SERVICE_ROLE_KEY: key }));
  }
  assert.throws(() => validatedValues({ ...environment, SUPABASE_URL: "https://unrelated.supabase.co" }));
  const anonPayload = Buffer.from(JSON.stringify({ role: "anon", ref: PROJECT_REF })).toString("base64url");
  assert.throws(() => validatedValues({ ...environment, SUPABASE_SERVICE_ROLE_KEY: `header.${anonPayload}.signature` }));
});

test("Vercel argument allowlist excludes all auth and database values", () => {
  for (const name of VARIABLE_NAMES) {
    const args = vercelArguments(name);
    assert.ok(args.includes("production,preview"));
    assert.ok(args.includes("--sensitive"));
    assert.ok(!args.includes(fakeSecret));
  }
  assert.throws(() => vercelArguments("AUTH_SECRET"));
  assert.throws(() => vercelArguments("DATABASE_URL"));
});

test("secret is passed through stdin, app credentials are stripped, CLI output is discarded", async () => {
  let captured;
  const spawn = (executable, args, options) => {
    captured = { executable, args, options, input: "" };
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({ write(chunk, _encoding, callback) { captured.input += chunk.toString(); callback(); } });
    child.stdin.on("finish", () => {
      child.stdout.end(fakeSecret);
      child.stderr.end(Buffer.from(fakeSecret).toString("base64"));
      queueMicrotask(() => child.emit("close", 0));
    });
    return child;
  };
  await uploadVariable("SUPABASE_SERVICE_ROLE_KEY", fakeSecret, spawn, { ...environment, AUTH_SECRET: "original-auth", DATABASE_URL: "original-db", POSTGRES_PASSWORD: "original-postgres" });
  assert.equal(captured.input, fakeSecret + "\n");
  assert.ok(!JSON.stringify(captured.args).includes(fakeSecret));
  for (const name of [...VARIABLE_NAMES, "AUTH_SECRET", "DATABASE_URL", "POSTGRES_PASSWORD"]) assert.equal(captured.options.env[name], undefined);
  assert.equal(captured.options.windowsHide, true);
});
