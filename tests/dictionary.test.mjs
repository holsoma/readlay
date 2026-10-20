import assert from "node:assert/strict";
import test from "node:test";
import { loadTypeScript, plain } from "./helpers/load-typescript.mjs";

const words = loadTypeScript("src/lib/dictionary-word.ts");
const snapshots = loadTypeScript("src/lib/dictionary-types.ts");
const sample = (word = "hello") => [{
  word,
  phonetics: [
    { text: "/US/", audio: `https://api.dictionaryapi.dev/media/pronunciations/en/${word}-us.mp3` },
    { text: "/UK/", audio: `https://api.dictionaryapi.dev/media/pronunciations/en/${word}-uk.mp3`, sourceUrl: "https://commons.wikimedia.org/example", license: { name: "CC BY 4.0", url: "https://creativecommons.org/licenses/by/4.0/" } },
  ],
  meanings: [{ partOfSpeech: "noun", definitions: [{ definition: "A greeting.", example: "Hello there." }, { definition: "An acknowledgement." }] }],
  license: { name: "CC BY-SA 3.0", url: "https://creativecommons.org/licenses/by-sa/3.0/" },
  sourceUrls: [`https://en.wiktionary.org/wiki/${word}`],
}];
const response = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...headers } });

function service(fetcher, overrides = {}) {
  let clock = 1000;
  const calls = [];
  const dictionaryModule = loadTypeScript("src/lib/dictionary.ts", {
    stubs: { "server-only": {} },
    globals: {
      fetch: async (url, options) => { calls.push({ url, options }); return fetcher(url, options, calls.length); },
      Date: { now: () => clock },
      ...overrides,
    },
  });
  return { ...dictionaryModule, calls, advance: (milliseconds) => { clock += milliseconds; } };
}

test("word normalisation preserves one lexical word and rejects phrases, markup and other scripts", () => {
  assert.equal(words.normaliseDictionaryWord("  ‘Reader’s,’  "), "reader's");
  assert.equal(words.normaliseDictionaryWord("self‑control"), "self-control");
  assert.equal(words.normaliseDictionaryWord("DOGS’"), "dogs");
  assert.equal(words.normaliseDictionaryWord("‘NAÏVE,’"), "naïve");
  assert.equal(words.normaliseDictionaryWord("cafe\u0301"), "café");
  assert.equal(words.normaliseDictionaryWord("façade"), "façade");
  for (const invalid of ["two words", "hello\nworld", "<script>", "word123", "hеllo", "λόγος", "\u0301cafe", "café\u0000", "a".repeat(81), null, ""]) assert.equal(words.normaliseDictionaryWord(invalid), null, String(invalid));
  assert.deepEqual(plain(words.inflectionCandidates("running")), ["running", "run", "runne", "runn"]);
  assert.deepEqual(plain(words.inflectionCandidates("reader’s")), ["reader's", "reader"]);
  assert.deepEqual(plain(words.inflectionCandidates("hoped")), ["hoped", "hope", "hop"]);
  assert.equal(words.inflectionCandidates("children")[1], "child");
  assert.equal(words.inflectionCandidates("stories")[1], "story");
});

test("pronunciation URLs permit only known HTTPS dictionary media paths", () => {
  assert.equal(words.safePronunciationUrl("//ssl.gstatic.com/dictionary/static/sounds/20200429/hello--_gb_1.mp3"), "https://ssl.gstatic.com/dictionary/static/sounds/20200429/hello--_gb_1.mp3");
  assert.equal(words.safePronunciationUrl("https://api.dictionaryapi.dev/media/pronunciations/en/na%C3%AFve-uk.mp3"), "https://api.dictionaryapi.dev/media/pronunciations/en/na%C3%AFve-uk.mp3");
  assert.equal(words.safePronunciationUrl("https://api.dictionaryapi.dev/media/pronunciations/en/word%2Fevil.mp3"), null);
  for (const unsafe of ["http://api.dictionaryapi.dev/media/pronunciations/en/hello.mp3", "https://evil.example/hello.mp3", "https://api.dictionaryapi.dev.evil.example/media/pronunciations/en/hello.mp3", "https://user@api.dictionaryapi.dev/media/pronunciations/en/hello.mp3", "https://api.dictionaryapi.dev/media/pronunciations/en/hello.mp3?redirect=evil", "https://api.dictionaryapi.dev/other/hello.mp3", "javascript:alert(1)"]) assert.equal(words.safePronunciationUrl(unsafe), null);
});

test("lookup keeps alternative meanings, UK pronunciation and both sets of attribution, then caches", async () => {
  const fixture = sample();
  fixture.push({ ...sample()[0], meanings: [{ partOfSpeech: "verb", definitions: [{ definition: "To greet." }] }] });
  const dictionary = service(async () => response(fixture));
  const result = plain(await dictionary.getDictionaryLookup("“HELLO!”"));
  assert.equal(result.query, "hello");
  assert.equal(result.entry.phonetic, "/UK/");
  assert.match(result.entry.audioUrl, /hello-uk\.mp3$/);
  assert.equal(result.entry.meanings.length, 2);
  assert.equal(result.entry.meanings[0].definitions.length, 2);
  assert.equal(result.entry.licence.name, "CC BY-SA 3.0");
  assert.equal(result.entry.pronunciationLicence.name, "CC BY 4.0");
  assert.equal(result.entry.pronunciationSourceUrl, "https://commons.wikimedia.org/example");
  assert.deepEqual(plain(snapshots.parseDictionaryEntry(result.entry)), result.entry);
  await dictionary.getDictionaryLookup("hello");
  assert.equal(dictionary.calls.length, 1);
  assert.equal(dictionary.calls[0].url, "https://api.dictionaryapi.dev/api/v2/entries/en/hello");
  assert.equal(dictionary.calls[0].options.redirect, "error");
  assert.equal(dictionary.calls[0].options.next.revalidate, 86400);
  assert.equal(dictionary.calls[0].options.headers.Cookie, undefined);
  dictionary.advance(86400001);
  await dictionary.getDictionaryLookup("hello");
  assert.equal(dictionary.calls.length, 2);
});

test("exact inflections win, fallback runs only after 404, and missing results have a short cache", async () => {
  const exact = service(async () => response(sample("running")));
  assert.equal((await exact.getDictionaryLookup("running")).entry.word, "running");
  assert.equal(exact.calls.length, 1);
  const fallback = service(async (url) => url.endsWith("children") ? response({}, 404) : response(sample("child")));
  const result = await fallback.getDictionaryLookup("children");
  assert.equal(result.query, "children");
  assert.equal(result.entry.word, "child");
  assert.equal(fallback.calls.length, 2);
  await fallback.getDictionaryLookup("children");
  assert.equal(fallback.calls.length, 2);
  const missing = service(async () => response({}, 404));
  await assert.rejects(missing.getDictionaryLookup("quizzacious"), (error) => error.status === 404);
  await assert.rejects(missing.getDictionaryLookup("quizzacious"), (error) => error.status === 404);
  assert.equal(missing.calls.length, 1);
  missing.advance(300001);
  await assert.rejects(missing.getDictionaryLookup("quizzacious"), (error) => error.status === 404);
  assert.equal(missing.calls.length, 2);
  const busy = service(async () => response({}, 429));
  await assert.rejects(busy.getDictionaryLookup("children"), (error) => error.status === 429);
  assert.equal(busy.calls.length, 1);
});

test("concurrent lookups share one request, including while inflection fallback is pending", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const dictionary = service(async (url) => {
    if (url.endsWith("children")) return response({}, 404);
    await gate;
    return response(sample("child"));
  });
  const first = dictionary.getDictionaryLookup("children");
  await new Promise((resolve) => setTimeout(resolve, 5));
  const second = dictionary.getDictionaryLookup("children");
  release();
  const result = await Promise.all([first, second]);
  assert.equal(result[0].entry.word, "child");
  assert.equal(result[1].entry.word, "child");
  assert.equal(dictionary.calls.length, 2);
});

test("cache eviction bounds retained entries and failed requests can be retried", async () => {
  const dictionary = service(async (url) => response(sample(decodeURIComponent(url.split("/").at(-1)))));
  const name = (index) => `word${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + index % 26)}`;
  for (let index = 0; index < 257; index++) await dictionary.getDictionaryLookup(name(index));
  await dictionary.getDictionaryLookup(name(0));
  assert.equal(dictionary.calls.length, 258);
  const retry = service(async (_url, _options, count) => count === 1 ? response({}, 500) : response(sample()));
  await assert.rejects(retry.getDictionaryLookup("hello"), (error) => error.status === 503);
  assert.equal((await retry.getDictionaryLookup("hello")).entry.word, "hello");
  assert.equal(retry.calls.length, 2);
});

test("too many distinct simultaneous lookups are rejected before making more API requests", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const dictionary = service(async (url) => { await gate; return response(sample(url.split("/").at(-1))); });
  const jobs = Array.from({ length: 32 }, (_, index) => dictionary.getDictionaryLookup(`entry${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + index % 26)}`));
  await assert.rejects(dictionary.getDictionaryLookup("overflow"), (error) => error.status === 503);
  assert.equal(dictionary.calls.length, 32);
  release();
  await Promise.all(jobs);
});

test("malformed and oversized responses fail closed; unsafe media remains an unavailable optional field", async () => {
  for (const fixture of [{}, [], [{ word: "other", meanings: sample()[0].meanings }], [{ word: "hello", meanings: [] }]]) {
    const dictionary = service(async () => response(fixture));
    await assert.rejects(dictionary.getDictionaryLookup("hello"), (error) => error.status === 502);
  }
  const oversized = service(async () => response(sample(), 200, { "Content-Length": String(512 * 1024 + 1) }));
  await assert.rejects(oversized.getDictionaryLookup("hello"), (error) => error.status === 502);
  const chunkedOversize = service(async () => response("x".repeat(512 * 1024 + 1)));
  await assert.rejects(chunkedOversize.getDictionaryLookup("hello"), (error) => error.status === 502);
  const invalidJson = service(async () => new Response("{", { headers: { "Content-Type": "application/json" } }));
  await assert.rejects(invalidJson.getDictionaryLookup("hello"), (error) => error.status === 502);
  const html = service(async () => new Response("<html>Error</html>", { headers: { "Content-Type": "text/html" } }));
  await assert.rejects(html.getDictionaryLookup("hello"), (error) => error.status === 502);
  const fixture = sample();
  fixture[0].phonetics = [{ text: "/hello/", audio: "https://evil.example/tracker.mp3" }];
  fixture[0].meanings[0].definitions[0].definition = "A <b>greeting</b>.";
  const safe = service(async () => response(fixture));
  const entry = (await safe.getDictionaryLookup("hello")).entry;
  assert.equal(entry.audioUrl, null);
  assert.equal(entry.phonetic, "/hello/");
  assert.equal(entry.meanings[0].definitions[0].definition, "A greeting.");
  assert.equal(snapshots.parseDictionaryEntry({ ...plain(entry), meanings: [{ partOfSpeech: "noun", definitions: [{ definition: "<script>" }] }] }), null);
});

test("timeouts stop the request and do not try alternative words", async () => {
  const dictionary = service(async (_url, options) => {
    assert.equal(options.signal.aborted, true);
    throw new DOMException("Aborted", "AbortError");
  }, { setTimeout: (callback) => { callback(); return 0; }, clearTimeout: () => {} });
  await assert.rejects(dictionary.getDictionaryLookup("children"), (error) => error.status === 503);
  assert.equal(dictionary.calls.length, 1);
});

test("dictionary API requires the current GitHub session and returns private responses", async () => {
  let lookups = 0;
  let session = null;
  const dictionary = service(async () => response(sample()));
  const route = loadTypeScript("src/app/api/dictionary/route.ts", { stubs: {
    "@/auth": { authConfigured: true, auth: async () => session },
    "@/lib/dictionary": { ...dictionary, getDictionaryLookup: async (word) => { lookups++; return dictionary.getDictionaryLookup(word); } },
  } });
  let result = await route.GET(new Request("https://readlay.example/api/dictionary?word=hello"));
  assert.equal(result.status, 401);
  assert.equal(lookups, 0);
  assert.match(result.headers.get("cache-control"), /private, no-store/);
  assert.equal(result.headers.get("vary"), "Cookie");
  session = { user: { id: "123" } };
  result = await route.GET(new Request("https://readlay.example/api/dictionary?word=hello"));
  assert.equal(result.status, 200);
  assert.equal((await result.json()).entry.word, "hello");
  result = await route.GET(new Request("https://readlay.example/api/dictionary?word=hello&word=world"));
  assert.equal(result.status, 400);
  result = await route.GET(new Request("https://readlay.example/api/dictionary?word=two%20words"));
  assert.equal(result.status, 400);
});
