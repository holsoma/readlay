import assert from "node:assert/strict";
import test from "node:test";
import { loadTypeScript, plain } from "./helpers/load-typescript.mjs";

const account = "a".repeat(32);
const origin = `https://${account}.r2.cloudflarestorage.com`;
const audioPath = "book/edition/kokoro-am_michael/generation/chapter-0001.opus";
const environment = { R2_ACCOUNT_ID: account, R2_AUDIO_BUCKET: "readlay-audio", R2_ACCESS_KEY_ID: "test-access-id", R2_SECRET_ACCESS_KEY: "test-secret-key" };

function storageHarness({ env = {}, signedUrl, signingError } = {}) {
  const calls = { clients: [], commands: [], signatures: [], destroyed: 0 };
  const storage = loadTypeScript("src/lib/audio-storage.ts", {
    stubs: {
      "server-only": {},
      "@aws-sdk/client-s3": {
        S3Client: class { constructor(config) { calls.clients.push(config); } destroy() { calls.destroyed++; } },
        GetObjectCommand: class { constructor(input) { calls.commands.push(input); } },
      },
      "@aws-sdk/s3-request-presigner": { getSignedUrl: async (_client, _command, options) => {
        calls.signatures.push(options);
        if (signingError) throw signingError;
        return signedUrl ?? `${origin}/readlay-audio/${audioPath}?X-Amz-Signature=test&X-Amz-Expires=${options.expiresIn}`;
      } },
    },
    globals: { process: { env: { ...environment, ...env } } },
  });
  return { storage, calls };
}

test("R2 signing uses the private account endpoint and one exact read-only object", async () => {
  const { storage, calls } = storageHarness();
  const destination = storage.audioStorageDestination("r2");
  const signed = new URL(await storage.createSignedAudioUrl(destination, audioPath, 10800));
  assert.equal(signed.origin, origin);
  assert.deepEqual(plain(calls.commands), [{ Bucket: "readlay-audio", Key: audioPath }]);
  assert.equal(calls.clients[0].region, "auto");
  assert.equal(calls.clients[0].endpoint, origin);
  assert.equal(calls.clients[0].forcePathStyle, true);
  assert.deepEqual(plain(calls.signatures), [{ expiresIn: 15300 }], "slow playback remains valid without a permanent public URL");
  assert.equal(calls.destroyed, 1);
  assert.equal(signed.href.includes(environment.R2_SECRET_ACCESS_KEY), false);
});

test("storage receipts select their own provider and reject changed accounts, buckets and unknown providers", () => {
  const { storage } = storageHarness({ env: { AUDIO_STORAGE_MODE: "r2", SUPABASE_URL: "https://old.example.test", AUDIO_STORAGE_BUCKET: "old-audio" } });
  assert.equal(storage.publicationStorageDestination({ storageOrigin: "https://old.example.test", bucket: "old-audio" }).provider, "supabase");
  assert.equal(storage.publicationStorageDestination({ storageProvider: "r2", storageOrigin: origin, bucket: "readlay-audio" }).provider, "r2");
  for (const receipt of [
    { storageProvider: "r2", storageOrigin: "https://public.r2.dev", bucket: "readlay-audio" },
    { storageProvider: "r2", storageOrigin: origin, bucket: "other-bucket" },
    { storageProvider: "other", storageOrigin: origin, bucket: "readlay-audio" },
    { storageOrigin: origin, bucket: "readlay-audio" },
  ]) assert.equal(storage.publicationStorageDestination(receipt), null);
});

test("R2 never signs malformed paths or accepts redirects to another origin or object", async () => {
  for (const path of ["../outside.opus", "book/edition/voice/generation/../chapter-0001.opus", audioPath + "?leak=1", audioPath.replace("opus", "html")]) {
    const { storage, calls } = storageHarness();
    await assert.rejects(storage.createSignedAudioUrl(storage.audioStorageDestination("r2"), path, 60));
    assert.equal(calls.clients.length, 0);
  }
  for (const signedUrl of [
    `https://other.example.test/readlay-audio/${audioPath}?X-Amz-Signature=test&X-Amz-Expires=3600`,
    `${origin}/another-bucket/${audioPath}?X-Amz-Signature=test&X-Amz-Expires=3600`,
    `${origin}/readlay-audio/${audioPath}?X-Amz-Expires=3600`,
    `${origin}/readlay-audio/${audioPath}?X-Amz-Signature=test&X-Amz-Expires=999999`,
  ]) {
    const { storage, calls } = storageHarness({ signedUrl });
    await assert.rejects(storage.createSignedAudioUrl(storage.audioStorageDestination("r2"), audioPath, 60));
    assert.equal(calls.destroyed, 1);
  }
});

test("R2 rejects invalid configuration before signing and releases a failed signer", async () => {
  for (const env of [{ R2_ACCOUNT_ID: "../outside" }, { R2_ACCOUNT_ID: "" }, { R2_AUDIO_BUCKET: "../outside" }]) {
    const { storage } = storageHarness({ env });
    assert.throws(() => storage.audioStorageDestination("r2"));
  }
  for (const env of [{ R2_ACCESS_KEY_ID: "" }, { R2_SECRET_ACCESS_KEY: "" }]) {
    const { storage, calls } = storageHarness({ env });
    await assert.rejects(storage.createSignedAudioUrl(storage.audioStorageDestination("r2"), audioPath, 60));
    assert.equal(calls.clients.length, 0);
  }
  const { storage, calls } = storageHarness({ signingError: new Error("Private SDK detail") });
  await assert.rejects(storage.createSignedAudioUrl(storage.audioStorageDestination("r2"), audioPath, 60));
  assert.equal(calls.destroyed, 1);
});

test("the official AWS SDK produces a path-scoped R2 GET signature without contacting storage", async () => {
  const storage = loadTypeScript("src/lib/audio-storage.ts", { stubs: { "server-only": {} }, globals: { process: { env: environment } } });
  const signed = new URL(await storage.createSignedAudioUrl(storage.audioStorageDestination("r2"), audioPath, 60));
  assert.equal(signed.origin, origin);
  assert.equal(decodeURIComponent(signed.pathname), `/readlay-audio/${audioPath}`);
  assert.equal(signed.searchParams.get("X-Amz-Algorithm"), "AWS4-HMAC-SHA256");
  assert.equal(signed.searchParams.get("X-Amz-Expires"), "3600");
  assert.match(signed.searchParams.get("X-Amz-Credential"), /\/auto\/s3\/aws4_request$/);
  assert.equal(signed.searchParams.get("X-Amz-SignedHeaders"), "host");
  assert.equal(signed.href.includes(environment.R2_SECRET_ACCESS_KEY), false);
});
