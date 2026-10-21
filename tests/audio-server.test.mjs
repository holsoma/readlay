import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import { Readable } from "node:stream";
import { gzipSync } from "node:zlib";
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

const wordContent = {
  editionId: "edition-a",
  chapters: [
    { id: "chapter-one", title: "One", paragraphs: ["First paragraph.", "Don't restart this paragraph halfway."] },
    { id: "chapter-two", title: "Two", paragraphs: ["Read 😀 slowly, then café."] },
  ],
};

function wordManifest() {
  // List the expected spoken words independently of the application's tokenizer.
  const chapterWords = [[['First', 'paragraph'], ["Don't", 'restart', 'this', 'paragraph', 'halfway']], [['Read', 'slowly', 'then', 'café']]];
  const audio = manifest();
  return {
    ...audio, schemaVersion: 2, alignment: "word", format: "opus", locationScheme: "readlay-canonical-epub-v1",
    coverage: { complete: true, totalChapters: 2, chapterIndices: [0, 1] },
    chapters: wordContent.chapters.map((chapter, chapterIndex) => ({
      chapterIndex, chapterId: chapter.id, title: chapter.title,
      audioPath: `${bookId}/edition-a/${narratorId}/generation-one/chapter-${String(chapterIndex + 1).padStart(4, "0")}.opus`,
      durationSeconds: chapter.paragraphs.length * 4, byteLength: 4096,
      segments: chapter.paragraphs.map((text, paragraphIndex) => ({
        paragraphIndex, startSeconds: paragraphIndex * 4, endSeconds: (paragraphIndex + 1) * 4, textHash: sha256(text),
      })),
      words: chapter.paragraphs.flatMap((text, paragraphIndex) => {
        let offset = 0;
        return chapterWords[chapterIndex][paragraphIndex].map((word, wordIndex) => {
          const charStart = text.indexOf(word, offset);
          assert.notEqual(charStart, -1, `The fixture word ${word} must exist in its source paragraph`);
          const charEnd = charStart + word.length;
          offset = charEnd;
          return {
            paragraphIndex, charStart, charEnd,
            startSeconds: paragraphIndex * 4 + wordIndex * 0.6,
            endSeconds: paragraphIndex * 4 + wordIndex * 0.6 + 0.45,
            cfi: `epubcfi(/6/${2 * (chapterIndex + 1)}[chapter-${chapterIndex + 1}]!/4/${2 * (paragraphIndex + 1)}/1:${charStart})`,
          };
        });
      }),
    })),
  };
}

function storeHarness({ audio = manifest(), marker, env = {}, fetch: fetchStub, sourceContent = content } = {}) {
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
      "@/lib/book-content": { getBookContent: async () => { calls.content++; return sourceContent; } },
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
  const r2 = [];
  const common = {
    "server-only": {},
    "@/auth": { authConfigured: configured, auth: async () => user ? { user: { id: user } } : null },
    "@/lib/audio-store": store,
    "@/lib/r2-audio": { streamR2Audio: async (...args) => { r2.push(args); return new Response("protected R2 audio", { headers: { "Referrer-Policy": "no-referrer", "Cache-Control": "private, no-store" } }); } },
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
    r2,
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
      [routes.metadata, new Request(`https://readlay.test/api/audio/${bookId}?narrator=${narratorId}&index=1`)],
      [routes.metadata, new Request(`https://readlay.test/api/audio/${bookId}?narrator=${narratorId}&chapter=0&v=generation-one`)],
      [routes.metadata, new Request(`https://readlay.test/api/audio/${bookId}?narrator=${narratorId}&chapter=-1`)],
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
  assert.deepEqual(plain(await valid.store.listNarrators(bookId)), [{ id: narratorId, name: "Alice", language: "en-GB", gender: "female", chapterIndices: [0] }]);
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

test("compressed manifests retain their uncompressed publication hash and corrupt gzip cannot fall back to stale JSON", async () => {
  const compressed = storeHarness();
  compressed.files.set("manifest.json.gz", gzipSync(compressed.files.get("manifest.json")));
  compressed.files.delete("manifest.json");
  assert.equal((await compressed.store.getAudioManifest(bookId, narratorId)).generationId, "generation-one");
  assert.equal(compressed.calls.files.some((file) => file.endsWith("manifest.json")), false);

  const corrupt = storeHarness();
  corrupt.files.set("manifest.json.gz", Buffer.from("invalid gzip"));
  await rejectsStatus(corrupt.store.getAudioManifest(bookId, narratorId), 404);
  assert.equal(corrupt.calls.files.some((file) => file.endsWith("manifest.json")), false);

  const oversized = storeHarness();
  oversized.files.set("manifest.json.gz", gzipSync(Buffer.alloc(64 * 1024 * 1024 + 1, 32)));
  await rejectsStatus(oversized.store.getAudioManifest(bookId, narratorId), 404);
});

test("R2 mode keeps legacy Supabase publications streaming from their original destination", async () => {
  const { store, calls } = storeHarness({ env: { AUDIO_STORAGE_MODE: "r2", R2_ACCOUNT_ID: "a".repeat(32), R2_AUDIO_BUCKET: "readlay-audio" }, fetch: async () => Response.json({ signedURL: `/object/sign/readlay-audio/${manifest().chapters[0].audioPath}?token=test` }) });
  const response = await routeHarness(store).stream.GET(streamRequest(), context());
  assert.equal(response.status, 307);
  assert.equal(new URL(response.headers.get("Location")).origin, origin);
  assert.equal(calls.fetch.length, 1);
});

test("R2 publication receipts use authenticated quota-checked streaming without a signed redirect", async () => {
  const account = "b".repeat(32);
  const storageOrigin = `https://${account}.r2.cloudflarestorage.com`;
  const audio = manifest();
  const { store, calls } = storeHarness({ audio, marker: { storageProvider: "r2", storageOrigin, bucket: "readlay-audio", generationId: audio.generationId, manifestHash: sha256(JSON.stringify(audio)) }, env: {
    AUDIO_STORAGE_MODE: "r2", R2_ACCOUNT_ID: account, R2_AUDIO_BUCKET: "readlay-audio", R2_ACCESS_KEY_ID: "test-access-id", R2_SECRET_ACCESS_KEY: "test-secret-key",
  } });
  const routes = routeHarness(store), response = await routes.stream.GET(streamRequest(), context());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Location"), null);
  assert.equal(routes.r2.length, 1);
  assert.equal(routes.r2[0][1], "github-user");
  assert.equal(routes.r2[0][2].origin, storageOrigin);
  assert.equal(response.headers.get("Referrer-Policy"), "no-referrer");
  assert.equal(calls.fetch.length, 0);
});

test("unexpected storage failures cannot expose SDK details or credentials in the playback response", async () => {
  const { store } = storeHarness({ fetch: async () => { throw new Error(`Private transport detail: ${secret}`); } });
  const response = await routeHarness(store).stream.GET(streamRequest(), context());
  assert.equal(response.status, 503);
  const body = await response.json();
  assert.equal(body.error, "The audio file could not be opened.");
  assert.equal(JSON.stringify(body).includes(secret), false);
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

test("word-aligned Opus narration covers every exact source word, including contractions and UTF-16 locations", async () => {
  const audio = wordManifest();
  const { store } = storeHarness({ audio, sourceContent: wordContent });
  const loaded = await store.getAudioManifest(bookId, narratorId);
  assert.equal(loaded.schemaVersion, 2);
  assert.equal(loaded.format, "opus");
  assert.equal(loaded.alignment, "word");
  assert.equal(loaded.chapters[0].words.length, 7);
  assert.equal(loaded.chapters[1].words.length, 4);
  const contraction = loaded.chapters[0].words[2];
  assert.equal(wordContent.chapters[0].paragraphs[1].slice(contraction.charStart, contraction.charEnd), "Don't");
  const afterEmoji = loaded.chapters[1].words[1];
  assert.equal(afterEmoji.charStart, 8, "the astral character occupies two UTF-16 code units");
  assert.equal(afterEmoji.cfi, "epubcfi(/6/4[chapter-2]!/4/2/1:8)");
  assert.deepEqual(plain(await store.listNarrators(bookId)), [{ id: narratorId, name: "Alice", language: "en-GB", gender: "female", chapterIndices: [0, 1] }]);
});

test("word narration rejects missing or extra lexical cues, changed source hashes and mismatched CFIs", async () => {
  for (const [name, change] of [
    ["missing word", audio => { audio.chapters[0].words.splice(3, 1); }],
    ["truncated final word", audio => { audio.chapters[1].words.pop(); }],
    ["inexact word end", audio => { audio.chapters[0].words[0].charEnd++; }],
    ["different paragraph hash", audio => { audio.chapters[0].segments[1].textHash = sha256("Changed text."); }],
    ["different CFI word offset", audio => { audio.chapters[1].words[1].cfi = "epubcfi(/6/4[chapter-2]!/4/2/1:9)"; }],
    ["different CFI chapter", audio => { audio.chapters[1].words[1].cfi = "epubcfi(/6/2[chapter-1]!/4/2/1:8)"; }],
    ["different CFI paragraph", audio => { audio.chapters[1].words[1].cfi = "epubcfi(/6/4[chapter-2]!/4/4/1:8)"; }],
    ["malicious CFI", audio => { audio.chapters[1].words[1].cfi = "javascript:alert(1)"; }],
    ["punctuation is not an extra spoken word", audio => {
      audio.chapters[0].words.splice(2, 0, {
        paragraphIndex: 0, charStart: 15, charEnd: 16, startSeconds: 2, endSeconds: 2.4,
        cfi: "epubcfi(/6/2[chapter-1]!/4/2/1:15)",
      });
    }],
    ["MP3 path in an Opus manifest", audio => { audio.chapters[0].audioPath = audio.chapters[0].audioPath.replace(/\.opus$/, ".mp3"); }],
    ["path traversal", audio => { audio.chapters[0].audioPath = `${bookId}/edition-a/${narratorId}/generation-one/../chapter-0001.opus`; }],
  ]) {
    const audio = wordManifest(); change(audio);
    const { store, calls } = storeHarness({ audio, sourceContent: wordContent });
    await assert.rejects(store.getAudioManifest(bookId, narratorId), error => error.status === 503, name);
    assert.deepEqual(plain(await store.listNarrators(bookId)), [], name);
    assert.equal(calls.fetch.length, 0, name);
  }
});

test("authenticated metadata index omits cue arrays and a chapter request returns exactly one complete chapter", async () => {
  const audio = wordManifest();
  const { store, calls } = storeHarness({ audio, sourceContent: wordContent });
  const routes = routeHarness(store);
  const base = `https://readlay.test/api/audio/${bookId}?narrator=${narratorId}&v=generation-one`;
  const response = await routes.metadata.GET(new Request(`${base}&index=1`), context());
  assert.equal(response.status, 200);
  assert.match(response.headers.get("Cache-Control"), /private.*no-store/);
  assert.equal(response.headers.get("Vary"), "Cookie");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  const index = await response.json();
  assert.equal(index.generationId, "generation-one");
  assert.equal(index.alignment, "word");
  assert.equal(index.chapters.length, 2);
  assert.equal(audioTypes.parseAudioManifestIndex(index)?.format, "opus");
  for (const chapter of index.chapters) {
    assert.equal(Object.hasOwn(chapter, "words"), false);
    assert.equal(Object.hasOwn(chapter, "segments"), false);
  }
  for (const chapterIndex of [0, 1]) {
    const chapterResponse = await routes.metadata.GET(new Request(`${base}&chapter=${chapterIndex}&index=1`), context());
    assert.equal(chapterResponse.status, 200);
    const chapter = await chapterResponse.json();
    assert.deepEqual(chapter, audio.chapters[chapterIndex]);
    assert.equal(Object.hasOwn(chapter, "chapters"), false);
    assert.equal(audioTypes.parseAudioChapter(chapter, true)?.chapterIndex, chapterIndex);
  }
  assert.equal(calls.fetch.length, 0, "metadata must never request a signed storage URL");
  assert.equal(routes.streams.length, 0);
});

test("Opus metadata and streams reject superseded generations and invalid chapter queries", async () => {
  const { store, calls } = storeHarness({ audio: wordManifest(), sourceContent: wordContent });
  const routes = routeHarness(store);
  const base = `https://readlay.test/api/audio/${bookId}?narrator=${narratorId}`;
  for (const suffix of ["&index=1&v=older-generation", "&chapter=0&v=older-generation"]) {
    const response = await routes.metadata.GET(new Request(`${base}${suffix}`), context());
    assert.equal(response.status, 404);
    assert.match(response.headers.get("Cache-Control"), /private.*no-store/);
    assert.equal((await response.text()).includes('"words"'), false);
  }
  assert.equal((await routes.stream.GET(streamRequest("&v=older-generation"), context())).status, 404);
  for (const chapter of ["", "-1", "0.5", "NaN", "1e0", "100000", "../1"]) {
    assert.equal((await routes.metadata.GET(new Request(`${base}&chapter=${encodeURIComponent(chapter)}`), context())).status, 400, chapter);
    const streamUrl = `https://readlay.test/api/audio/${bookId}/stream?narrator=${narratorId}&chapter=${encodeURIComponent(chapter)}`;
    assert.equal((await routes.stream.GET(new Request(streamUrl), context())).status, 400, chapter);
  }
  assert.equal((await routes.metadata.GET(new Request(`${base}&chapter=2`), context())).status, 404);
  assert.equal((await routes.stream.GET(new Request(`https://readlay.test/api/audio/${bookId}/stream?narrator=${narratorId}&chapter=2`), context())).status, 404);
  assert.equal(calls.fetch.length, 0);
  assert.equal(routes.streams.length, 0);
});

test("local Opus streaming advertises Ogg audio and supports byte-range seeks without signing a URL", async () => {
  const { store, calls } = storeHarness({
    audio: wordManifest(), sourceContent: wordContent, marker: null, env: { AUDIO_STORAGE_MODE: "local" },
  });
  const bytes = Buffer.from("OggS-test-opus-data");
  const routes = routeHarness(store, { localBytes: bytes });
  const complete = await routes.stream.GET(streamRequest("&v=generation-one"), context());
  assert.equal(complete.status, 200);
  assert.equal(complete.headers.get("Content-Type"), "audio/ogg");
  assert.equal(complete.headers.get("Accept-Ranges"), "bytes");
  assert.equal(complete.headers.get("Content-Length"), String(bytes.length));
  assert.equal(await complete.text(), bytes.toString());
  const partial = await routes.stream.GET(streamRequest("&v=generation-one", { Range: "bytes=5-8" }), context());
  assert.equal(partial.status, 206);
  assert.equal(partial.headers.get("Content-Type"), "audio/ogg");
  assert.equal(partial.headers.get("Content-Range"), `bytes 5-8/${bytes.length}`);
  assert.equal(await partial.text(), bytes.subarray(5, 9).toString());
  assert.match(partial.headers.get("Cache-Control"), /private.*no-store/);
  assert.equal(partial.headers.get("Vary"), "Cookie");
  assert.equal(partial.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(routes.streams.every(stream => stream.file.endsWith("chapter-0001.opus")), true);
  const opened = routes.streams.length;
  for (const range of ["bytes=999-", "bytes=8-5", "bytes=0-1,5-6"]) {
    const response = await routes.stream.GET(streamRequest("", { Range: range }), context());
    assert.equal(response.status, 416);
  }
  assert.equal(routes.streams.length, opened);
  assert.equal(calls.fetch.length, 0);
});
