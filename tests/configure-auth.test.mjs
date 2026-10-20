import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { createRedactor, vercelArguments } from "../scripts/configure-auth.mjs";

const clientId = "readlay-test-client-id";
const secret = "readlay-test-secret-1234567890";

test("OAuth upload arguments never contain credentials or unrelated variable names", () => {
  for (const name of ["AUTH_GITHUB_ID", "AUTH_GITHUB_SECRET"]) {
    const args = vercelArguments(name);
    assert.equal(args.includes(clientId), false);
    assert.equal(args.includes(secret), false);
    assert.equal(args.includes("--value"), false);
    assert.equal(args.includes("--environment"), true);
    assert.equal(args.includes("production,preview"), true);
    assert.equal(args.includes("--sensitive"), true);
    assert.equal(args.includes("holsoma"), true);
  }
  assert.throws(() => vercelArguments("AUTH_SECRET"));
  assert.throws(() => vercelArguments("DATABASE_URL"));
  assert.throws(() => vercelArguments("AUTH_GITHUB_ID & echo unsafe"));
});

test("CLI output redaction covers both OAuth values and ANSI and encoded forms", () => {
  const redact = createRedactor([clientId, secret]);
  const output = redact(`stdout ${clientId}\nstderr \u001b[31m${secret}\u001b[0m\n${Buffer.from(secret).toString("base64")}`);
  assert.equal(output.includes(clientId), false);
  assert.equal(output.includes(secret), false);
  assert.equal(output.includes(Buffer.from(secret).toString("base64")), false);
  assert.equal(output.includes("\u001b"), false);
  assert.equal(output.match(/\[redacted\]/g).length, 3);
});

test("missing OAuth value fails before a Vercel command and does not print the supplied value", () => {
  const env = { ...process.env, AUTH_GITHUB_ID: clientId };
  delete env.AUTH_GITHUB_SECRET;
  const result = spawnSync(process.execPath, ["scripts/configure-auth.mjs", "--check"], { env, encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /AUTH_GITHUB_SECRET/);
  assert.match(result.stderr, /No Vercel changes were made/);
  assert.equal(`${result.stdout}${result.stderr}`.includes(clientId), false);
});
