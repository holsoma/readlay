import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { loadTypeScript, plain } from "./helpers/load-typescript.mjs";

const sha256 = (value) => createHash("sha256").update(value, "utf8").digest("hex");
const bookId = "atomic-habits";
const narratorId = "Alice";
const origin = "https://storage.example.test";
const secret = "test-only-service-role-key";
const audioTypes = loadTypeScript("src/lib/audio-types.ts");
const content = {
  editionId: "edition-a",
  chapters: [{ id: "chapter-one", title: "One", paragraphs: ["First paragraph.", "Second paragraph."] }],
};

function manifest() {
  return {
    schemaVersion: 1, bookId, editionId: "edition-a", generationId: "generation-one",
    narrator: { id: narratorId, name: "Alice", language: "en-GB", engine: "kokoro", voice: "bf_emma" },
    alignment: "paragraph", sampleRate: 24000,
    coverage: { complete: true, totalChapters: 1, chapterIndices: [0] },
    chapters: [{
      chapterIndex: 0, chapterId: "chapter-one", title: "One",
      audioPath: `${bookId}/edition-a/${narratorId}/generation-one/chapter-0001.mp3`,
      durationSeconds: 8,
      segments: content.chapters[0].paragraphs.map((text, index) => ({
        paragraphIndex: index, startSeconds: index * 4, endSeconds: (index + 1) * 4, textHash: sha256(text),
      })),
    }],
  };
}

function storeHarness({ audio = manifest(), marker, env = {}, fetch: fetchStub } = {}) {
  const bytes = JSON.stringify(audio);
  const publication = marker === undefined ? {
    storageOrigin: origin, bucket: "readlay-audio", generationId: audio.generationId, manifestHash: sha256(bytes),
  } : marker;
  const files = new Map([["manifest.json", bytes]]);
  if (publication !== null) files.set("published.json", JSON.stringify(publication));
  const calls = { files: [], content: 0, fetch: [] };
  const environment = { SUPABASE_URL: origin, SUPABASE_SERVICE_ROLE_KEY: secret, ...env };
  const store = loadTypeScript("src/lib/audio-store.ts", {
    stubs: {
      "server-only": {},
      "@/data/books": { books: [{ id: bookId, editionId: "edition-a" }] },
      "@/lib/audio-types": audioTypes,
      "@/lib/book-content": { getBookContent: async () => { calls.content++; return content; } },
      "node:fs/promises": {
        readFile: async (file) => {
          calls.files.push(file);
          const name = path.basename(file);
          if (files.has(name)) return files.get(name);
          throw Object.assign(new Error("Missing test file"), { code: "ENOENT" });
        },
        readdir: async () => [{ name: narratorId, isDirectory: () => true }],
      },
    },
    globals: {
      process: { env: environment, cwd: () => process.cwd() },
      fetch: async (...args) => {
        calls.fetch.push(args);
        if (fetchStub) return fetchStub(...args);
        throw new Error("Unexpected storage request");
      },
    },
  });
  return { store, calls, files };
}

function routeHarness(store, { user = "github-user", configured = true, localBytes = Buffer.from("0123456789") } = {}) {
  const streams = [];
  const common = {
    "@/auth": { authConfigured: configured, auth: async () => user ? { user: { id: user } } : null },
    "@/lib/audio-store": store,
    "node:fs/promises": { stat: async () => ({ size: localBytes.length }) },
    "node:fs": { createReadStream: (file, { start, end }) => {
      streams.push({ file, start, end });
      return Readable.from([localBytes.subarray(start, end + 1)]);
    } },
  };
  return {
    metadata: loadTypeScript("src/app/api/audio/[bookId]/route.ts", { stubs: common }),
    stream: loadTypeScript("src/app/api/audio/[bookId]/stream/route.ts", { stubs: common }),
    streams,
  };
}

const context = () => ({ params: Promise.resolve({ bookId }) });
const streamRequest = (suffix = "", headers) => new Request(
  `https://readlay.test/api/audio/${bookId}/stream?narrator=${narratorId}&chapter=0${suffix}`, { headers },
);
const rejectsStatus = (promise, status) => assert.rejects(promise, (error) => error.status === status);

test("both audio routes reject missing GitHub sessions before opening private files", async () => {
  for (const auth of [{ user: null }, { configured: false }]) {
    const { store, calls } = storeHarness();
    const routes = routeHarness(store, auth);
    for (const [api, request] of [
      [routes.metadata, new Request(`https://readlay.test/api/audio/${bookId}`)],
      [routes.metadata, new Request(`https://readlay.test/api/audio/${bookId}?narrator=${narratorId}`)],
      [routes.stream, streamRequest()],
    ]) {
      const response = await api.GET(request, context());
      assert.equal(response.status, 401);
      assert.match(response.headers.get("Cache-Control"), /private.*no-store/);
      assert.equal(response.headers.get("Vary"), "Cookie");
    }
    assert.equal(calls.files.length, 0);
    assert.equal(calls.content, 0);
    assert.equal(calls.fetch.length, 0);
  }
});

test("prepared narration requires the current edition, exact paragraph hashes and a contained object path", async () => {
  const valid = storeHarness();
  assert.equal((await valid.store.getAudioManifest(bookId, narratorId)).generationId, "generation-one");
  assert.deepEqual(plain(await valid.store.listNarrators(bookId)), [{ id: narratorId, name: "Alice", language: "en-GB" }]);
  for (const change of [
    (audio) => { audio.editionId = "old-edition"; },
    (audio) => { audio.chapters[0].chapterId = "another-chapter"; },
    (audio) => { audio.chapters[0].segments[0].textHash = sha256("Changed paragraph."); },
    (audio) => { audio.chapters[0].segments.pop(); },
    (audio) => { audio.chapters[0].audioPath = "../../outside.mp3"; },
    (audio) => { audio.chapters[0].audioPath = audio.chapters[0].audioPath.replace("generation-one/", "generation-one/../"); },
    (audio) => { audio.chapters[0].audioPath = audio.chapters[0].audioPath.replace("generation-one", "older-generation"); },
  ]) {
    const audio = manifest();
    change(audio);
    const { store } = storeHarness({ audio });
    await rejectsStatus(store.getAudioManifest(bookId, narratorId), 503);
  }
  const { store, calls } = storeHarness();
  await rejectsStatus(store.getAudioManifest(bookId, "../Alice"), 400);
  await rejectsStatus(store.getAudioManifest("unknown-book", narratorId), 404);
  assert.equal(calls.files.length, 0);
});

test("Supabase narration is activated only by the exact manifest bytes and matching storage destination", async () => {
  const validMarker = {
    storageOrigin: origin, bucket: "readlay-audio", generationId: "generation-one", manifestHash: sha256(JSON.stringify(manifest())),
  };
  for (const marker of [
    null,
    { ...validMarker, manifestHash: "0".repeat(64) },
    { ...validMarker, storageOrigin: "https://different-storage.example.test" },
    { ...validMarker, bucket: "another-bucket" },
    { ...validMarker, generationId: "older-generation" },
  ]) {
    const { store } = storeHarness({ marker });
    await rejectsStatus(store.getAudioManifest(bookId, narratorId), 404);
    assert.deepEqual(plain(await store.listNarrators(bookId)), []);
  }
  const { store, files } = storeHarness();
  files.set("manifest.json", `${files.get("manifest.json")}\n`);
  await rejectsStatus(store.getAudioManifest(bookId, narratorId), 404);
});

test("explicit local preview can read unpublished narration but Vercel requires activation", async () => {
  const local = storeHarness({ marker: null, env: { AUDIO_STORAGE_MODE: "local" } });
  assert.equal((await local.store.getAudioManifest(bookId, narratorId)).bookId, bookId);
  assert.ok(local.store.localAudioFile(manifest().chapters[0].audioPath));
  assert.equal(local.store.localAudioFile("../../outside.mp3"), null);
  const deployed = storeHarness({ marker: null, env: { AUDIO_STORAGE_MODE: "local", VERCEL: "1" } });
  await rejectsStatus(deployed.store.getAudioManifest(bookId, narratorId), 404);
  assert.equal(deployed.store.localAudioFile(manifest().chapters[0].audioPath), null);
});

test("stream rejects a superseded generation before opening audio or requesting a signed URL", async () => {
  const { store, calls } = storeHarness();
  const routes = routeHarness(store);
  const response = await routes.stream.GET(streamRequest("&v=older-generation"), context());
  assert.equal(response.status, 404);
  assert.equal(calls.fetch.length, 0);
  assert.equal(routes.streams.length, 0);
});

test("signing accepts only the requested object at the configured origin and keeps credentials out of responses", async () => {
  const audioPath = manifest().chapters[0].audioPath;
  const pathname = `/storage/v1/object/sign/readlay-audio/${audioPath}`;
  let signedURL = `/object/sign/readlay-audio/${audioPath}?token=test-token`;
  const { store, calls } = storeHarness({ fetch: async () => ({ ok: true, json: async () => ({ signedURL }) }) });
  const signed = await store.signedAudioUrl(audioPath, 8);
  assert.equal(signed, `${origin}${pathname}?token=test-token`);
  assert.equal(signed.includes(secret), false);
  assert.equal(calls.fetch[0][1].headers.Authorization, `Bearer ${secret}`);
  assert.equal(calls.fetch[0][1].cache, "no-store");
  for (const invalid of [
    `https://attacker.test${pathname}?token=test-token`,
    `${origin}/storage/v1/object/sign/readlay-audio/another.mp3?token=test-token`,
    `${origin}${pathname}`,
  ]) {
    signedURL = invalid;
    await assert.rejects(store.signedAudioUrl(audioPath, 8), (error) => error.status === 503 && !String(error).includes(secret));
  }
  const failure = storeHarness({ fetch: async () => { throw new Error(`Storage failure: ${secret}`); } });
  const response = await routeHarness(failure.store).stream.GET(streamRequest(), context());
  assert.equal(response.status, 503);
  assert.equal((await response.text()).includes(secret), false);
});

test("modern Supabase secret keys authenticate as API keys without an invalid bearer JWT", async () => {
  const apiKey = "sb_secret_test_only_not_a_real_key";
  const audioPath = manifest().chapters[0].audioPath;
  const { store, calls } = storeHarness({
    env: { SUPABASE_SERVICE_ROLE_KEY: apiKey },
    fetch: async () => ({ ok: true, json: async () => ({ signedURL: `/object/sign/readlay-audio/${audioPath}?token=test-token` }) }),
  });
  const signed = await store.signedAudioUrl(audioPath, 8);
  assert.equal(calls.fetch[0][1].headers.apikey, apiKey);
  assert.equal(Object.hasOwn(calls.fetch[0][1].headers, "Authorization"), false);
  assert.equal(signed.includes(apiKey), false);
});

test("authenticated storage redirects are private and keep the signed token out of the manifest", async () => {
  const audioPath = manifest().chapters[0].audioPath;
  const { store } = storeHarness({ fetch: async () => ({
    ok: true, json: async () => ({ signedURL: `/object/sign/readlay-audio/${audioPath}?token=test-token` }),
  }) });
  const routes = routeHarness(store);
  const response = await routes.stream.GET(streamRequest("&v=generation-one"), context());
  assert.equal(response.status, 307);
  assert.equal(new URL(response.headers.get("Location")).origin, origin);
  assert.match(response.headers.get("Cache-Control"), /private.*no-store/);
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  const metadata = await routes.metadata.GET(new Request(`https://readlay.test/api/audio/${bookId}?narrator=${narratorId}`), context());
  const body = await metadata.text();
  assert.equal(metadata.status, 200);
  assert.equal(body.includes("test-token"), false);
  assert.equal(body.includes(secret), false);
});

test("local streaming returns the requested bytes and rejects unsatisfiable or multiple ranges", async () => {
  const { store, calls } = storeHarness({ marker: null, env: { AUDIO_STORAGE_MODE: "local" } });
  const routes = routeHarness(store);
  for (const [range, expected, contentRange] of [
    ["bytes=2-5", "2345", "bytes 2-5/10"],
    ["bytes=-3", "789", "bytes 7-9/10"],
    ["bytes=8-", "89", "bytes 8-9/10"],
  ]) {
    const response = await routes.stream.GET(streamRequest("", { Range: range }), context());
    assert.equal(response.status, 206);
    assert.equal(response.headers.get("Content-Range"), contentRange);
    assert.equal(response.headers.get("Content-Length"), String(expected.length));
    assert.match(response.headers.get("Cache-Control"), /private.*no-store/);
    assert.equal(await response.text(), expected);
  }
  const opened = routes.streams.length;
  for (const range of ["bytes=10-", "bytes=5-2", "bytes=0-1,4-5", "bytes=-0"]) {
    const response = await routes.stream.GET(streamRequest("", { Range: range }), context());
    assert.equal(response.status, 416);
    assert.equal(response.headers.get("Content-Range"), "bytes */10");
  }
  assert.equal(routes.streams.length, opened);
  assert.equal(calls.fetch.length, 0);
});
