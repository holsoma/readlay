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

function harness() {
  const queries = [];
  let rows = [[], []];
  let lookupWord = "habit";
  let lookupError;
  const sql = (parts, ...values) => {
    queries.push({ text: parts.join("?"), values });
    return Promise.resolve([]);
  };
  sql.transaction = async () => rows;
  class DictionaryError extends Error { constructor(status, message) { super(message); this.status = status; } }
  const store = loadTypeScript("src/lib/wordbank-store.ts", {
    stubs: {
      "server-only": {}, "@neondatabase/serverless": { neon: () => sql },
      "@/data/books": { books: testBooks },
      "@/lib/book-content": { getBookContent: async () => ({ editionId: "edition-a", chapters: [
        { paragraphs: ["A habit grows. Another habit stays.", "😀 We build habits."] },
      ] }) },
      "@/lib/dictionary": { DictionaryError, getDictionaryLookup: async () => {
        if (lookupError) throw lookupError;
        return { query: "habits", entry: { ...entry, word: lookupWord } };
      } },
    }, env: { DATABASE_URL: "test-only-connection" },
  });
  return { store, queries, DictionaryError, setRows(value) { rows = value; }, setLookupWord(value) { lookupWord = value; }, setLookupError(value) { lookupError = value; } };
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

test("save uses a trusted dictionary snapshot and one atomic upsert without changing reading progress", async () => {
  const app = harness();
  await app.store.applyWordBankAction("A", { ...input, action: "save", sentence: "injected client sentence", entry: { definition: "injected" } });
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
  assert.equal((await post(" ".repeat(4097))).status, 400);
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
