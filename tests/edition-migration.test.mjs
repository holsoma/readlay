import assert from "node:assert/strict";
import test from "node:test";
import { loadTypeScript, plain } from "./helpers/load-typescript.mjs";

const source = "b17d5f5bc348f3d6", target = "1234567890abcdef";
const functions = loadTypeScript("src/lib/edition-migration.ts");
const mapping = () => ({ schemaVersion: 1, bookId: "seven-habits", fromEditionId: source, toEditionId: target, paragraphs: {
  "0:0": { sourceLength: 18, target: { chapterIndex: 1, paragraphIndex: 0, charOffset: 2 }, words: [[2, 7, 1, 0, 2, 7], [8, 13, 1, 0, 8, 13]] },
} });
const chapters = [{ paragraphs: ["Front matter"] }, { paragraphs: ["A habit grows."] }];

test("edition maps expose coordinates only and validate real complete target words and UTF-16 boundaries", () => {
  const parsed = functions.parseEditionMigration({ ...mapping(), sourceText: "Private passage" }, chapters);
  assert.equal(parsed.toEditionId, target);
  assert.equal(Object.hasOwn(parsed, "sourceText"), false);
  for (const invalid of [
    { ...mapping(), bookId: "../../secret" }, { ...mapping(), toEditionId: source }, { ...mapping(), toEditionId: "arbitrary" },
    { ...mapping(), paragraphs: { "0:0": { ...mapping().paragraphs["0:0"], words: [[2, 7, 1, 0, 2, 6]] } } },
    { ...mapping(), paragraphs: { "0:0": { ...mapping().paragraphs["0:0"], words: [[2, 7, 1, 0, 2, 7], [6, 13, 1, 0, 8, 13]] } } },
    { ...mapping(), paragraphs: { "0:0": { ...mapping().paragraphs["0:0"], target: { chapterIndex: 1, paragraphIndex: 9, charOffset: 0 } } } },
  ]) assert.equal(functions.parseEditionMigration(invalid, chapters), null);
  const astral = mapping(); astral.paragraphs["0:0"].target.charOffset = 1;
  assert.equal(functions.parseEditionMigration(astral, [{ paragraphs: [] }, { paragraphs: ["😀 word"] }]), null);
});

test("progress uses matched words and reviewed anchors while vocabulary requires an exact mapped lexical range", () => {
  assert.deepEqual(plain(functions.migrateReadingPosition(mapping(), { chapterIndex: 0, paragraphIndex: 0, charOffset: 10 })), {
    chapterIndex: 1, paragraphIndex: 0, charOffset: 8, cfi: "epubcfi(/6/4[chapter-2]!/4/2/1:8)",
  });
  assert.equal(functions.migrateReadingPosition(mapping(), { chapterIndex: 0, paragraphIndex: 0, charOffset: 16 }).charOffset, 2);
  assert.equal(functions.migrateReadingPosition(mapping(), { chapterIndex: 0, paragraphIndex: 0, charOffset: 19 }), null);
  assert.equal(functions.migrateReadingPosition(mapping(), { chapterIndex: 0, paragraphIndex: 0, charOffset: 2, cfi: "epubcfi(/6/2[chapter-1]!/4/2/1:8)" }), null, "migration must not sanitise a mismatched old CFI into a valid saved location");
  const occurrence = { id: "word-id", bookId: "seven-habits", editionId: source, chapterIndex: 0, paragraphIndex: 0, charStart: 2, charEnd: 7, sentence: "Original context.", selectedText: "habit" };
  const migrated = functions.migrateWordOccurrence(mapping(), occurrence);
  assert.equal(migrated.sentence, "Original context.");
  assert.equal(migrated.id, "word-id");
  assert.equal(migrated.editionId, target);
  assert.equal(migrated.cfiRange, "epubcfi(/6/4[chapter-2]!/4/2,/1:2,/1:7)");
  assert.equal(functions.migrateWordOccurrence(mapping(), { ...occurrence, charEnd: 6 }), null);
  assert.equal(functions.migrateWordOccurrence(mapping(), { ...occurrence, paragraphIndex: 1 }), null);
});

test("browser cache migration preserves current data, converts unsent additions and removals, and does not mutate the archive", () => {
  const oldKey = `seven-habits:${source}`, newKey = `seven-habits:${target}`;
  const base = { savedIds: ["seven-habits"], progressByEdition: { [oldKey]: { chapterIndex: 0, paragraphIndex: 0, charOffset: 8 } },
    bookmarks: [{ id: `${oldKey}:0:0`, bookId: "seven-habits", editionId: source, chapterIndex: 0, paragraphIndex: 0, text: "Original context" }], lastReadBookId: "seven-habits" };
  const cache = { base, pending: [{ id: "remove", action: { type: "bookmark", bookId: "seven-habits", editionId: source, chapterIndex: 0, paragraphIndex: 0, saved: false } }] };
  const archived = JSON.stringify(cache);
  const projected = functions.migrateCachedLibrary(cache, [mapping()]);
  assert.equal(projected.base.progressByEdition[newKey].charOffset, 8);
  assert.equal(projected.base.progressByEdition[oldKey], undefined);
  assert.equal(projected.base.bookmarks[0].id, `${newKey}:1:0`);
  assert.equal(projected.pending[0].action.saved, false);
  assert.equal(projected.pending[0].action.chapterIndex, 1);
  assert.equal(projected.pending[0].action.editionId, target);
  assert.equal(JSON.stringify(cache), archived);
  assert.deepEqual(plain(functions.migrateCachedLibrary(projected, [mapping()])), plain(projected), "reloading cannot reintroduce old data");
  const current = { chapterIndex: 1, paragraphIndex: 0, charOffset: 13 };
  cache.base.progressByEdition[newKey] = current;
  cache.pending.push({ id: "stale-progress", action: { type: "progress", bookId: "seven-habits", editionId: source, chapterIndex: 0, paragraphIndex: 0, charOffset: 2 } });
  const preserved = functions.migrateCachedLibrary(cache, [mapping()]);
  assert.deepEqual(plain(preserved.base.progressByEdition[newKey]), current);
  assert.equal(preserved.pending.some((item) => item.id === "stale-progress"), false);
  assert.equal(functions.cachedRetiredEditions(archived, [{ id: "seven-habits", editionId: target }]).length, 1);
  assert.equal(functions.cachedRetiredEditions(archived, [{ id: "seven-habits", editionId: source }]).length, 0);
  assert.equal(functions.cachedRetiredEditions('{"savedIds":[]}', [{ id: "seven-habits", editionId: target }]).length, 0);
});

test("the offset-only endpoint requires the exact source and current edition and never caches failures", async () => {
  let manifests = [mapping()];
  const api = loadTypeScript("src/app/api/edition-migrations/route.ts", { stubs: {
    "@/lib/edition-migration-store": { maximumMigrationBytes: 4 * 1024 * 1024, getEditionMigrations: async () => manifests },
  }, globals: { Buffer } });
  const get = (query) => api.GET(new Request(`https://readlay.test/api/edition-migrations?${query}`));
  const good = await get(`bookId=seven-habits&from=${source}&to=${target}`);
  assert.equal(good.status, 200); assert.match(good.headers.get("cache-control"), /immutable/);
  assert.equal((await good.json()).paragraphs["0:0"].words.length, 2);
  for (const query of ["", `bookId=unknown&from=${source}&to=${target}`, `bookId=seven-habits&from=${source}&to=old`]) {
    const bad = await get(query); assert.equal(bad.status, 404); assert.equal(bad.headers.get("cache-control"), "no-store");
  }
  manifests = [{ ...mapping(), extra: "x".repeat(4 * 1024 * 1024) }];
  assert.equal((await get(`bookId=seven-habits&from=${source}&to=${target}`)).status, 503);
});

test("the private loader binds its map to the active canonical edition, bounds bytes and caches only validated production data", async () => {
  let input = { ...mapping(), passage: "This private text must never reach the endpoint." }, reads = 0;
  const loader = loadTypeScript("src/lib/edition-migration-store.ts", { stubs: {
    "server-only": {}, "node:fs/promises": { readFile: async (filename) => { reads++; assert.match(filename, /edition-migrations[\\/]seven-habits\.json$/); return Buffer.from(typeof input === "string" ? input : JSON.stringify(input)); } },
    "@/data/books": { books: [{ id: "seven-habits", editionId: target }] },
    "./book-content": { getBookContent: async () => ({ editionId: target, chapters }) },
  }, globals: { process: { env: { VERCEL: "1" }, cwd: () => "C:/test-project" } } });
  input = { ...mapping(), toEditionId: "abcdef1234567890" };
  await assert.rejects(loader.getEditionMigrations(), /does not match/);
  input = " ".repeat(4 * 1024 * 1024 + 1);
  await assert.rejects(loader.getEditionMigrations(), /size limit/);
  input = { ...mapping(), passage: "This private text must never reach the endpoint." };
  const loaded = await loader.getEditionMigrations();
  assert.equal(loaded.length, 1); assert.equal(Object.hasOwn(loaded[0], "passage"), false);
  await loader.getEditionMigrations();
  assert.equal(reads, 3, "failed maps must be retryable and the validated immutable map is read only once");
});
