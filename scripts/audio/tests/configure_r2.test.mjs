import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile, unlink, rmdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { initialEnvironmentText, validatedValues, vercelArguments, uploadVariable, verifyVercelProject, VARIABLE_NAMES } from "../configure_r2.mjs";

const environment = { R2_ACCOUNT_ID: "a".repeat(32), R2_ACCESS_KEY_ID: "b".repeat(32), R2_SECRET_ACCESS_KEY: "c".repeat(64), R2_AUDIO_BUCKET: "readlay-audio", AUDIO_STORAGE_MODE: "supabase" };

test("R2 initialisation preserves working storage mode, account credentials and all other application fields", () => {
  const source = "AUTH_SECRET=auth-fixture\r\nDATABASE_URL='database fixture'\r\nSUPABASE_SERVICE_ROLE_KEY=supabase-fixture\r\nAUDIO_STORAGE_MODE=supabase\r\n  R2_ACCESS_KEY_ID = original-access\r\nR2_SECRET_ACCESS_KEY=original-secret\r\nR2_ACCOUNT_ID=original-account\r\n";
  const result = initialEnvironmentText(source);
  for (const line of source.trimEnd().split("\r\n")) assert.ok(result.includes(line + "\r\n"));
  assert.match(result, /R2_AUDIO_BUCKET=readlay-audio\r\n/);
  assert.equal(result, initialEnvironmentText(result));
  assert.match(initialEnvironmentText("AUTH_SECRET=fixture\n"), /AUDIO_STORAGE_MODE=supabase\n/);
  assert.match(initialEnvironmentText("AUDIO_STORAGE_MODE=r2\n"), /AUDIO_STORAGE_MODE=r2\n/);
});

test("R2 initialisation adds empty credential fields and rejects duplicates", () => {
  const result = initialEnvironmentText("");
  for (const name of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]) assert.ok(result.includes(`${name}=\n`));
  assert.throws(() => initialEnvironmentText("R2_ACCESS_KEY_ID=one\nR2_ACCESS_KEY_ID=two\n"), /more than once/);
});

test("R2 credentials are validated without forcing an existing Supabase deployment to switch", () => {
  assert.deepEqual(validatedValues(environment), environment);
  assert.equal(validatedValues({ ...environment, AUDIO_STORAGE_MODE: "r2" }).AUDIO_STORAGE_MODE, "r2");
  for (const change of [{ R2_ACCOUNT_ID: "" }, { R2_ACCOUNT_ID: "https://wrong.example" }, { R2_ACCESS_KEY_ID: "not-a-key" },
    { R2_SECRET_ACCESS_KEY: "c".repeat(63) }, { R2_SECRET_ACCESS_KEY: "c".repeat(64) + "\nextra" },
    { R2_AUDIO_BUCKET: "Other_Bucket" }, { AUDIO_STORAGE_MODE: "local" }]) {
    assert.throws(() => validatedValues({ ...environment, ...change }));
  }
});

test("Vercel upload accepts only the five R2 fields and never exposes values in argv", async () => {
  for (const name of VARIABLE_NAMES) {
    const args = vercelArguments(name);
    assert.ok(args.includes("production,preview"));
    assert.ok(args.includes("--sensitive"));
    assert.ok(args.includes("holsoma"));
    assert.ok(!args.includes(environment.R2_SECRET_ACCESS_KEY));
  }
  for (const name of ["SUPABASE_SERVICE_ROLE_KEY", "AUTH_SECRET", "DATABASE_URL", "NEXT_PUBLIC_R2_SECRET_ACCESS_KEY"]) assert.throws(() => vercelArguments(name));
  let captured;
  const fakeSpawn = (executable, args, options) => {
    captured = { executable, args, options, input: "" };
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.stdin = new Writable({ write(chunk, _encoding, callback) { captured.input += chunk.toString(); callback(); } });
    child.stdin.on("finish", () => {
      child.stdout.end(environment.R2_SECRET_ACCESS_KEY);
      child.stderr.end(Buffer.from(environment.R2_SECRET_ACCESS_KEY).toString("base64"));
      queueMicrotask(() => child.emit("close", 0));
    });
    return child;
  };
  const source = { ...environment, AUTH_SECRET: "auth", DATABASE_URL: "database", SUPABASE_SERVICE_ROLE_KEY: "supabase", CLOUDFLARE_API_TOKEN: "cloudflare" };
  await uploadVariable("R2_SECRET_ACCESS_KEY", environment.R2_SECRET_ACCESS_KEY, fakeSpawn, source);
  assert.equal(captured.input, environment.R2_SECRET_ACCESS_KEY + "\n");
  assert.ok(!JSON.stringify(captured.args).includes(environment.R2_SECRET_ACCESS_KEY));
  for (const name of Object.keys(source)) assert.equal(captured.options.env[name], undefined);
  assert.equal(captured.options.windowsHide, true);
});

test("R2 configuration targets only the existing Readlay Vercel project", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "readlay-r2-test-"));
  const file = path.join(directory, "project.json");
  try {
    const project = { projectName: "readlay", projectId: "prj_8q0BAGbufA0TTsLstL8LkmK9wFjU", orgId: "team_Wmt30x1aiIAIFLHGzoYq11OK" };
    await writeFile(file, JSON.stringify(project));
    await verifyVercelProject(file);
    await writeFile(file, JSON.stringify({ ...project, orgId: "different-team" }));
    await assert.rejects(verifyVercelProject(file), /does not match/);
  } finally {
    await unlink(file).catch((error) => { if (error.code !== "ENOENT") throw error; });
    await rmdir(directory);
  }
});
