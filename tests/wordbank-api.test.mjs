import assert from "node:assert/strict";
import test from "node:test";
import { loadTypeScript, plain, testBooks } from "./helpers/load-typescript.mjs";

const entry = {
  word: "habit", phonetic: "/ˈhæbɪt/", audioUrl: "https://api.dictionaryapi.dev/media/pronunciations/en/habit-us.mp3",
  meanings: [{ partOfSpeech: "noun", definitions: [{ definition: "An action performed regularly." }] }],
  sourceUrl: "https://en.wiktionary.org/wiki/habit", licence: { name: "CC BY-SA 3.0", url: "https://creativecommons.org/licenses/by-sa/3.0/" },
};
const date = "2026-10-22T00:00:00.000Z";
const wordId = "bbf181d8-9f2d-4c29-a63e-202510220001";
const occurrenceId = "bbf181d8-9f2d-4c29-a63e-202510220002";
const input = { word: "habit", bookId: "atomic-habits", editionId: "edition-a", chapterIndex: 0, paragraphIndex: 0, charStart: 2, charEnd: 7 };
const action = { ...input, action: "save", expectedUserId: "A" };
const locations = loadTypeScript("src/lib/epub-location.ts");
const errorIs = (status) => (error) => error.status === status;

function harness({ migrations = [], bookContent } = {}) {
  const queries = [];
  let rows = [[], []];
  let lookupWord = "habit";
  let lookupError;
  const contentRequests = [];
  const sql = (parts, ...values) => {
    queries.push({ text: parts.join("?"), values });
    return Promise.resolve([]);
  };
  sql.transaction = async () => rows;
  class DictionaryError extends Error { constructor(status, message) { super(message); this.status = status; } }
  const store = loadTypeScript("src/lib/wordbank-store.ts", {
    stubs: {
      "server-only": {}, "@neondatabase/serverless": { neon: () => sql },
      "@/lib/edition-migration-store": { getEditionMigrations: async () => migrations },
      "@/data/books": { books: testBooks },
      "@/lib/book-content": { getBookContent: async (bookId) => { contentRequests.push(bookId); return bookContent ?? ({ editionId: "edition-a", chapters: [
        { paragraphs: ["A habit grows. Another habit stays.", "😀 We build habits.", "A subdecongenial word appears."] },
      ] }); } },
      "@/lib/dictionary": { DictionaryError, getDictionaryLookup: async () => {
        if (lookupError) throw lookupError;
        return { query: "habits", entry: { ...entry, word: lookupWord } };
      } },
    }, env: { DATABASE_URL: "test-only-connection" },
  });
  return { store, queries, contentRequests, DictionaryError, setRows(value) { rows = value; }, setLookupWord(value) { lookupWord = value; }, setLookupError(value) { lookupError = value; } };
}

test("Word Bank rejects invalid actions, stale editions, fractional offsets and arbitrary IDs", () => {
  const { store } = harness();
  for (const value of [null, {}, { ...action, expectedUserId: "" }, { ...action, editionId: "old" },
    { ...action, chapterIndex: 0.5 }, { ...action, charEnd: -1 }, { ...action, charStart: 7 },
    { ...action, charEnd: 900 }, { ...action, word: "two words" }, { ...action, bookId: "../../secret" },
    { action: "remove", expectedUserId: "A", id: "' OR TRUE--" },
    { action: "status", expectedUserId: "A", id: wordId, status: "expert" },
  ]) assert.throws(() => store.parseWordBankAction(value), errorIs(400));
  assert.equal(store.parseWordBankAction(action).charEnd, 7);
  assert.equal(store.parseWordBankAction({ action: "status", expectedUserId: "A", id: wordId, status: "learning" }).status, "learning");
});

test("source context and canonical CFI range are derived from exact complete lexical bounds", async () => {
  const { store, queries } = harness();
  const source = await store.sourceForWord(input);
  assert.equal(source.selectedText, "habit");
  assert.equal(source.sentence, "A habit grows.");
  assert.equal(source.cfiRange, "epubcfi(/6/2[chapter-1]!/4/2,/1:2,/1:7)");
  assert.equal(source.cfiStart, locations.cfiForPosition(0, 0, 2));
  for (const invalid of [{ charEnd: 6 }, { charStart: 0 }, { paragraphIndex: 90 }, { editionId: "old" }, { word: "growth" },
    { paragraphIndex: 1, charStart: 1, charEnd: 2, word: "we" }]) {
    await assert.rejects(store.sourceForWord({ ...input, ...invalid }), errorIs(400));
  }
  assert.equal(queries.length, 0, "invalid source locations must never access the database");
});

test("save without a browser snapshot uses the server lookup and an atomic upsert without changing reading progress", async () => {
  const app = harness();
  await app.store.applyWordBankAction("A", { ...input, action: "save", sentence: "injected client sentence" });
  assert.equal(app.queries.length, 1);
  const query = app.queries[0];
  assert.match(query.text, /WITH saved_word AS/);
  assert.match(query.text, /ON CONFLICT \(user_id, word\) DO UPDATE SET entry/);
  assert.doesNotMatch(query.text, /readlay_progress|readlay_bookmarks|status\s*=/);
  assert.ok(query.values.includes("A habit grows."));
  assert.ok(!query.values.includes("injected client sentence"));
  const snapshot = JSON.parse(query.values.find((value) => typeof value === "string" && value.startsWith('{"word"')));
  assert.equal(snapshot.meanings[0].definitions[0].definition, entry.meanings[0].definitions[0].definition);
  assert.equal(snapshot.audioUrl, entry.audioUrl);
  assert.equal(query.values.filter((value) => value === "A").length, 2);
  app.setLookupError(new app.DictionaryError(404, "No definition found."));
  await assert.rejects(app.store.applyWordBankAction("A", { ...input, action: "save" }), errorIs(404));
  assert.equal(app.queries.length, 1, "failed lookups must not leave an empty saved word");
});

test("validated browser snapshots bypass blocked server lookups while keeping exact source and safe pronunciation URLs", async () => {
  const app = harness();
  app.setLookupError(new app.DictionaryError(503, "Provider blocked this server."));
  const parsed = app.store.parseWordBankAction({ ...action, word: "habits", paragraphIndex: 1, charStart: 12, charEnd: 18,
    sentence: "Do not trust client context", cfiRange: "forged", entry: { ...entry, audioUrl: "https://attacker.test/track.mp3" } });
  assert.equal(parsed.entry.word, "habit", "a real inflection can resolve to its base headword");
  assert.equal(parsed.entry.audioUrl, null, "unapproved pronunciation origins must not be stored");
  await app.store.applyWordBankAction("A", parsed);
  assert.equal(app.queries.length, 1);
  const query = app.queries[0];
  assert.ok(query.values.includes("😀 We build habits."));
  assert.ok(query.values.includes("habits"));
  assert.ok(query.values.includes(locations.cfiForRange(0, 1, 12, 18)));
  assert.ok(!query.values.includes("forged"));
  const snapshot = JSON.parse(query.values.find((value) => typeof value === "string" && value.startsWith('{"word"')));
  assert.equal(snapshot.word, "habit");
  assert.equal(snapshot.audioUrl, null);
  assert.equal(snapshot.licence.name, entry.licence.name);
  await assert.rejects(app.store.applyWordBankAction("A", { ...input, action: "save", word: "grows", entry }), errorIs(400));
  assert.equal(app.queries.length, 1, "a browser entry cannot override the source word validation");
});

test("snapshot input rejects unrelated headwords, malformed definitions and oversized bodies", () => {
  const { store } = harness();
  for (const snapshot of [null, {}, { ...entry, word: "power" }, { ...entry, meanings: [] },
    { ...entry, meanings: [{ partOfSpeech: "noun", definitions: [{ definition: "<script>alert(1)</script>" }] }] },
    { ...entry, meanings: [{ partOfSpeech: "noun", definitions: [{ definition: "x".repeat(2001) }] }] },
    { ...entry, extra: "x".repeat(480 * 1024) },
  ]) assert.throws(() => store.parseWordBankAction({ ...action, entry: snapshot }), errorIs(400));
  const safe = store.parseWordBankAction({ ...action, entry: { ...entry, sourceUrl: "javascript:alert(1)", pronunciationSourceUrl: "data:text/html,bad" } });
  assert.equal(safe.entry.sourceUrl, null);
  assert.equal(safe.entry.pronunciationSourceUrl, null);
});

test("an explicit spelling correction saves its meaning against the unchanged original source word and CFI range", async () => {
  const app = harness();
  app.setLookupError(new app.DictionaryError(503, "No server lookup is available."));
  const correctedEntry = { ...entry, word: "congenial", meanings: [{ partOfSpeech: "adjective", definitions: [{ definition: "Pleasant and agreeable." }] }] };
  const original = { ...action, word: "subdecongenial", paragraphIndex: 2, charStart: 2, charEnd: 16 };
  const parsed = app.store.parseWordBankAction({ ...original, lookupWord: "  Congenial  ", entry: correctedEntry });
  assert.equal(parsed.word, "subdecongenial");
  assert.equal(parsed.lookupWord, "congenial");
  await app.store.applyWordBankAction("A", parsed);
  const query = app.queries[0];
  assert.ok(query.values.includes("congenial"), "the dictionary headword identifies the saved vocabulary");
  assert.ok(query.values.includes("subdecongenial"), "the occurrence preserves the exact source spelling");
  assert.ok(query.values.includes("A subdecongenial word appears."));
  assert.ok(query.values.includes(locations.cfiForRange(0, 2, 2, 16)));
  assert.ok(query.values.includes(16), "source length must not be replaced by the correction's length");
  await assert.rejects(app.store.applyWordBankAction("A", { ...parsed, word: "congenial" }), errorIs(400));
  await assert.rejects(app.store.applyWordBankAction("A", { ...parsed, charEnd: 11 }), errorIs(400));
  assert.equal(app.queries.length, 1, "a spelling correction must not bypass source validation");
});

test("corrected lookups require one bounded word, a matching snapshot and the original source identity", async () => {
  const { store } = harness();
  for (const lookupWord of [null, {}, "", "two words", "<script>", "word\u0000", "a".repeat(257)]) {
    assert.throws(() => store.parseWordBankAction({ ...action, lookupWord, entry }), errorIs(400));
  }
  assert.throws(() => store.parseWordBankAction({ ...action, lookupWord: "habit" }), errorIs(400));
  assert.throws(() => store.parseWordBankAction({ ...action, lookupWord: "agreeable", entry }), errorIs(400));
  assert.equal(store.parseWordBankAction(action).lookupWord, undefined, "older clients retain their existing server lookup behaviour");
  const selected = store.parseWordBankAction({ ...action, lookupWord: "habits", entry });
  assert.equal(selected.entry.word, "habit", "ordinary inflections are still accepted for an explicit lookup");
  await assert.rejects(store.applyWordBankAction("A", { ...action, lookupWord: "habit" }), errorIs(400));
});

test("Word Bank reads all occurrences and scopes every read/write to the authenticated user", async () => {
  const app = harness();
  const occurrence = (id, start) => ({ id, word_id: wordId, book_id: "atomic-habits", edition_id: "edition-a", chapter_index: 0,
    paragraph_index: 0, char_start: start, char_end: start + 5, cfi_start: locations.cfiForPosition(0, 0, start),
    cfi_end: locations.cfiForPosition(0, 0, start + 5), cfi_range: locations.cfiForRange(0, 0, start, start + 5),
    sentence: start === 2 ? "A habit grows." : "Another habit stays.", selected_text: "habit", saved_at: date });
  app.setRows([[{ id: wordId, word: "habit", entry, status: "learning", saved_at: date, updated_at: date }],
    [occurrence(occurrenceId, 2), occurrence("bbf181d8-9f2d-4c29-a63e-202510220003", 23)]]);
  const words = await app.store.getWordBank("A");
  assert.equal(words.length, 1);
  assert.equal(words[0].occurrences.length, 2);
  assert.equal(words[0].status, "learning");
  await app.store.applyWordBankAction("A", { action: "remove", id: wordId });
  await assert.rejects(app.store.applyWordBankAction("A", { action: "status", id: wordId, status: "learned" }), errorIs(404));
  for (const query of app.queries) {
    assert.match(query.text, /WHERE user_id = \?/);
    assert.ok(query.values.includes("A"));
    assert.ok(!query.text.includes(wordId), "IDs must remain SQL parameters");
  }
  const types = loadTypeScript("src/lib/wordbank-types.ts");
  assert.equal(types.parseWordBank({ words: [{ ...plain(words[0]), occurrences: [{ ...plain(words[0].occurrences[0]), cfiRange: "epubcfi(/6/2!)" }] }] }), null);
});

test("Word Bank projects exact retired-edition occurrences without rewriting saved definitions, context or unmatched source links", async () => {
  const from = "b17d5f5bc348f3d6", to = "1234567890abcdef";
  const migration = { schemaVersion: 1, bookId: "seven-habits", fromEditionId: from, toEditionId: to, paragraphs: {
    "0:0": { sourceLength: 32, target: { chapterIndex: 2, paragraphIndex: 4, charOffset: 10 }, words: [[2, 7, 2, 4, 10, 15]] },
  } };
  const app = harness({ migrations: [migration], bookContent: { editionId: to, chapters: [{ paragraphs: [] }, { paragraphs: [] }, { paragraphs: ["", "", "", "", "An active habit grows."] }] } });
  const occurrence = { id: occurrenceId, word_id: wordId, book_id: "seven-habits", edition_id: from, chapter_index: 0, paragraph_index: 0,
    char_start: 2, char_end: 7, cfi_start: locations.cfiForPosition(0, 0, 2), cfi_end: locations.cfiForPosition(0, 0, 7),
    cfi_range: locations.cfiForRange(0, 0, 2, 7), sentence: "A habit from the original edition.", selected_text: "habit", saved_at: date };
  const unmatched = { ...occurrence, id: "bbf181d8-9f2d-4c29-a63e-202510220003", char_start: 20, char_end: 25,
    cfi_start: locations.cfiForPosition(0, 0, 20), cfi_end: locations.cfiForPosition(0, 0, 25), cfi_range: locations.cfiForRange(0, 0, 20, 25) };
  const rows = [[{ id: wordId, word: "habit", entry, status: "learning", saved_at: date, updated_at: date }], [occurrence, unmatched]];
  const before = JSON.stringify(rows); app.setRows(rows);
  const words = await app.store.getWordBank("A");
  assert.equal(words[0].status, "learning"); assert.equal(words[0].entry.meanings[0].definitions[0].definition, entry.meanings[0].definitions[0].definition);
  assert.equal(words[0].occurrences[0].editionId, to);
  assert.equal(words[0].occurrences[0].cfiRange, locations.cfiForRange(2, 4, 10, 15));
  assert.equal(words[0].occurrences[0].sentence, occurrence.sentence);
  assert.equal(words[0].occurrences[0].id, occurrenceId);
  assert.equal(words[0].occurrences[1].editionId, from, "unmatched vocabulary must keep its original edition rather than invent a link");
  assert.equal(JSON.stringify(rows), before, "the stored snapshots must be untouched");
  assert.equal(app.queries.every((query) => /^SELECT/.test(query.text)), true, "projection must not write or duplicate stored occurrences");
  const views = loadTypeScript("src/lib/wordbank-view.ts");
  assert.equal(views.wordOccurrenceHref(words[0].occurrences[0], { slug: "seven-habits", editionId: to }), "/read/seven-habits?chapter=2&paragraph=4&offset=10");
  assert.equal(views.wordOccurrenceHref(words[0].occurrences[1], { slug: "seven-habits", editionId: to }), null);
});

test("projected vocabulary highlights use exact new case and apostrophes while retaining original saved contexts", async () => {
  const from = "b17d5f5bc348f3d6", to = "1234567890abcdef";
  const targetText = "Band-Aids don’t";
  const migration = { schemaVersion: 1, bookId: "seven-habits", fromEditionId: from, toEditionId: to, paragraphs: {
    "0:0": { sourceLength: 15, target: { chapterIndex: 0, paragraphIndex: 0, charOffset: 0 }, words: [[0, 9, 0, 0, 0, 9], [10, 15, 0, 0, 10, 15]] },
  } };
  const app = harness({ migrations: [migration], bookContent: { editionId: to, chapters: [{ paragraphs: [targetText] }] } });
  const heads = ["band-aids", "don't"], ids = [wordId, "bbf181d8-9f2d-4c29-a63e-202510220009"];
  const rows = [heads.map((head, index) => ({ id: ids[index], word: head, entry: { ...entry, word: head }, status: "learning", saved_at: date, updated_at: date })),
    heads.map((head, index) => {
      const start = index ? 10 : 0, end = index ? 15 : 9;
      return { id: `${occurrenceId}-${index}`, word_id: ids[index], book_id: "seven-habits", edition_id: from, chapter_index: 0, paragraph_index: 0,
        char_start: start, char_end: end, cfi_start: locations.cfiForPosition(0, 0, start), cfi_end: locations.cfiForPosition(0, 0, end),
        cfi_range: locations.cfiForRange(0, 0, start, end), sentence: "Original band-aids don't context.", selected_text: head, saved_at: date };
    })];
  const stored = JSON.stringify(rows); app.setRows(rows);
  const projected = await app.store.getWordBank("A");
  assert.deepEqual(plain(projected.map((word) => word.occurrences[0].selectedText)), ["Band-Aids", "don’t"]);
  for (const [index, word] of projected.entries()) {
    const occurrence = word.occurrences[0];
    assert.equal(targetText.slice(occurrence.charStart, occurrence.charEnd), occurrence.selectedText, "Reader's exact saved-highlight check must pass");
    assert.equal(occurrence.sentence, rows[1][index].sentence);
    assert.equal(occurrence.id, rows[1][index].id);
    assert.equal(word.status, "learning");
    assert.equal(word.entry.word, heads[index]);
    assert.deepEqual(plain(word.entry.meanings), entry.meanings, "the saved definitions must be unchanged");
    assert.equal(word.entry.phonetic, entry.phonetic);
    assert.equal(word.entry.audioUrl, entry.audioUrl);
  }
  assert.equal(JSON.stringify(rows), stored, "original selected spellings and all stored records must be unchanged");
  assert.deepEqual(app.contentRequests, ["seven-habits"], "fetch the current book once even when two headwords need projection");
  assert.equal(app.queries.every((query) => /^SELECT/.test(query.text)), true);
  app.contentRequests.length = 0;
  app.setRows([rows[0], rows[1].map((row) => ({ ...row, paragraph_index: 9, cfi_start: locations.cfiForPosition(0, 9, row.char_start), cfi_end: locations.cfiForPosition(0, 9, row.char_end), cfi_range: locations.cfiForRange(0, 9, row.char_start, row.char_end) }))]);
  await app.store.getWordBank("A");
  assert.deepEqual(app.contentRequests, [], "unmatched legacy occurrences must not load any current book");
});

test("Word Bank API enforces authentication, account guards, same origin, no-store and streamed body limits", async () => {
  const app = harness();
  let activeUser = "A";
  let configured = true;
  const calls = [];
  const api = loadTypeScript("src/app/api/word-bank/route.ts", { stubs: {
    "@/auth": { get authConfigured() { return configured; }, auth: async () => activeUser ? { user: { id: activeUser } } : null },
    "@/lib/wordbank-store": { ...app.store,
      getWordBank: async (userId) => { calls.push(["get", userId]); return []; },
      applyWordBankAction: async (userId, action) => { calls.push(["write", userId, plain(action)]); },
    },
  } });
  const post = (body, origin = "https://readlay.test", type = "application/json") => api.POST(new Request("https://readlay.test/api/word-bank", {
    method: "POST", headers: { origin, "Content-Type": type }, body: typeof body === "string" ? body : JSON.stringify(body),
  }));
  assert.equal((await post({ ...action, expectedUserId: "B" })).status, 401);
  assert.equal((await post(action, "https://evil.test")).status, 400);
  assert.equal((await post(" ".repeat(512 * 1024 + 1))).status, 400);
  assert.equal((await post("not json")).status, 400);
  assert.equal((await post(action, "https://readlay.test", "text/plain")).status, 400);
  assert.equal((await api.GET(new Request("https://readlay.test/api/word-bank?expectedUserId=B"))).status, 401);
  assert.equal(calls.length, 0);
  const response = await post(action);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /private, no-store/);
  assert.equal(response.headers.get("vary"), "Cookie");
  assert.deepEqual(await response.json(), { words: [] });
  assert.equal(calls[0][1], "A");
  activeUser = null;
  assert.equal((await post(action)).status, 401);
  configured = false;
  assert.equal((await api.GET(new Request("https://readlay.test/api/word-bank"))).status, 401);
});
