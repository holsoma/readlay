import assert from "node:assert/strict";
import test from "node:test";
import { loadTypeScript, plain } from "./helpers/load-typescript.mjs";

const fixture = (word) => [{ word, phonetics: [{ text: "/word/", audio: `https://api.dictionaryapi.dev/media/pronunciations/en/${word}-uk.mp3` }],
  meanings: [{ partOfSpeech: "noun", definitions: [{ definition: "A dictionary meaning." }, { definition: "An alternative meaning." }] }],
  license: { name: "CC BY-SA 3.0", url: "https://creativecommons.org/licenses/by-sa/3.0/" }, sourceUrls: [`https://en.wiktionary.org/wiki/${word}`] }];
const json = (body, status = 200) => Response.json(body, { status });
const missing = () => json({ title: "No Definitions Found", message: "No matching word." }, 404);
const fallbackFixture = (word, definition = "A dictionary meaning.") => ({ word, entries: [
  { language: { code: "en", name: "English" }, partOfSpeech: "noun", pronunciations: [{ type: "ipa", text: "/US/", tags: ["General American"] }, { type: "ipa", text: "/UK/", tags: ["Received Pronunciation"] }],
    senses: [{ definition, examples: ["An example sentence."], subsenses: [] }] },
], source: { url: `https://en.wiktionary.org/wiki/${word}`, license: { name: "CC BY-SA 4.0", url: "https://creativecommons.org/licenses/by-sa/4.0/" } } });
const backupMissing = (word) => ({ ...fallbackFixture(word), entries: [] });

function client(fetcher, overrides = {}) {
  let clock = 1000;
  const requests = [];
  const dictionary = loadTypeScript("src/lib/dictionary-client.ts", { globals: {
    Date: { now: () => clock },
    fetch: async (url, options) => { requests.push({ url, options }); return fetcher(url, options, requests.length); },
    ...overrides,
  } });
  return { lookup: dictionary.lookupDictionaryInBrowser, requests, advance: (milliseconds) => { clock += milliseconds; } };
}

test("browser lookup sends only a normalised word to the official API, without cookies or referring book URL", async () => {
  const dictionary = client(async () => json(fixture("naïve")));
  const result = await dictionary.lookup("‘NAÏVE,’");
  assert.equal(result.query, "naïve");
  assert.equal(result.entry.word, "naïve");
  assert.equal(result.entry.meanings[0].definitions.length, 2);
  assert.equal(result.entry.licence.name, "CC BY-SA 3.0");
  const request = dictionary.requests[0];
  assert.equal(request.url, "https://api.dictionaryapi.dev/api/v2/entries/en/na%C3%AFve");
  assert.equal(request.options.mode, "cors");
  assert.equal(request.options.credentials, "omit");
  assert.equal(request.options.referrerPolicy, "no-referrer");
  assert.equal(request.options.redirect, "error");
  assert.deepEqual(plain(request.options.headers), { Accept: "application/json" });
  assert.equal(request.options.next, undefined);
});

test("browser cache is bounded, retains successful entries for a day and refreshes expired entries", async () => {
  const dictionary = client(async (url) => json(fixture(decodeURIComponent(url.split("/").at(-1)))));
  const word = (index) => `entry${String.fromCharCode(97 + Math.floor(index / 26))}${String.fromCharCode(97 + index % 26)}`;
  for (let index = 0; index < 101; index++) await dictionary.lookup(word(index));
  await dictionary.lookup(word(100));
  assert.equal(dictionary.requests.length, 101);
  await dictionary.lookup(word(0));
  assert.equal(dictionary.requests.length, 102, "the oldest entry was evicted at the 100-entry limit");
  dictionary.advance(86_400_001);
  await dictionary.lookup(word(0));
  assert.equal(dictionary.requests.length, 103);
});

test("real JSON missing responses allow conservative inflections and have a shorter cache", async () => {
  const dictionary = client(async (url) => url.endsWith("children") ? missing() : json(fixture("child")));
  const result = await dictionary.lookup("children");
  assert.equal(result.query, "children");
  assert.equal(result.entry.word, "child");
  assert.equal(dictionary.requests.length, 2);
  await dictionary.lookup("children");
  assert.equal(dictionary.requests.length, 2);
  const exact = client(async () => json(fixture("children")));
  assert.equal((await exact.lookup("children")).entry.word, "children");
  assert.equal(exact.requests.length, 1);
  const absent = client(async () => missing());
  await assert.rejects(absent.lookup("unknownword"), (error) => error.status === 404);
  await assert.rejects(absent.lookup("unknownword"), (error) => error.status === 404);
  assert.equal(absent.requests.length, 1);
  absent.advance(300_001);
  await assert.rejects(absent.lookup("unknownword"), (error) => error.status === 404);
  assert.equal(absent.requests.length, 2);
});

test("concurrent consumers share one request and cancelling one popup does not cancel another", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const dictionary = client(async (_url, options) => { await gate; assert.equal(options.signal.aborted, false); return json(fixture("hello")); });
  const controller = new AbortController();
  const first = dictionary.lookup("hello", controller.signal);
  const second = dictionary.lookup("HELLO");
  controller.abort();
  await assert.rejects(first, (error) => error.name === "AbortError");
  release();
  assert.equal((await second).entry.word, "hello");
  assert.equal(dictionary.requests.length, 1);
  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  await assert.rejects(dictionary.lookup("world", alreadyAborted.signal), (error) => error.name === "AbortError");
  assert.equal(dictionary.requests.length, 1);
});

test("service failures use the free backup without trying unrelated inflections", async () => {
  const cases = [
    [() => new Response("<html>Not found</html>", { status: 404, headers: { "Content-Type": "text/html" } }), 502],
    [() => json({}, 404), 502],
    [() => json({}, 403), 503],
    [() => json({}, 429), 429],
    [() => json(fixture("otherword")), 502],
    [() => new Response("x".repeat(512 * 1024 + 1), { headers: { "Content-Type": "application/json" } }), 502],
  ];
  for (const [respond] of cases) {
    const dictionary = client(async (url) => url.startsWith("https://freedictionaryapi.com/") ? json(fallbackFixture("children")) : respond());
    const result = await dictionary.lookup("children");
    assert.equal(result.entry.providerName, "FreeDictionaryAPI.com");
    assert.equal(result.entry.word, "children");
    assert.equal(dictionary.requests.length, 2);
  }
});

test("a three-second primary timeout leaves the total request budget available for backup", async () => {
  const dictionary = client(async (url, options) => {
    if (url.startsWith("https://api.dictionaryapi.dev/")) {
      assert.equal(options.signal.aborted, true);
      throw new DOMException("Timed out", "AbortError");
    }
    assert.equal(options.signal.aborted, false);
    return json(fallbackFixture("hello"));
  }, { setTimeout: (callback, delay) => { if (delay === 3000) callback(); return 0; }, clearTimeout() {} });
  assert.equal((await dictionary.lookup("hello")).entry.providerName, "FreeDictionaryAPI.com");
  assert.equal(dictionary.requests.length, 2);
});

test("browser lookup limits distinct in-flight words and rejects phrases before a request", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const dictionary = client(async (url) => { await gate; return json(fixture(url.split("/").at(-1))); });
  await assert.rejects(dictionary.lookup("two words"), (error) => error.status === 400);
  assert.equal(dictionary.requests.length, 0);
  const jobs = Array.from({ length: 16 }, (_, index) => dictionary.lookup(`word${String.fromCharCode(97 + index)}`));
  await assert.rejects(dictionary.lookup("overflow"), (error) => error.status === 503);
  assert.equal(dictionary.requests.length, 16);
  release();
  await Promise.all(jobs);
});

test("browser failure diagnostics contain only fixed categories and omit private input and messages", async () => {
  const logs = [];
  const dictionary = client(async () => { throw Object.assign(new TypeError("PRIVATE_MESSAGE"), { cause: { code: "ENOTFOUND", secret: "PRIVATE_SECRET" } }); }, { console: { warn: (...args) => logs.push(args) } });
  for (let index = 0; index < 3; index++) await assert.rejects(dictionary.lookup("confidential"), (error) => error.status === 503);
  assert.equal(logs.length, 1);
  assert.deepEqual(plain(logs[0][1]), { stage: "transport", status: null, errorName: "TypeError", causeCode: "ENOTFOUND" });
  assert.doesNotMatch(JSON.stringify(logs), /confidential|PRIVATE_|https?:/);
});

test("backup parsing preserves IPA, examples, nested meanings, licence and provider attribution", async () => {
  const data = fallbackFixture("hello");
  data.entries[0].senses[0].subsenses = [{ definition: "A narrower meaning.", examples: [], subsenses: [] }];
  data.entries.push({ ...data.entries[0], partOfSpeech: "verb", senses: [{ definition: "To greet.", examples: [], subsenses: [] }] });
  const dictionary = client(async (url) => url.startsWith("https://api.dictionaryapi.dev/") ? json({}, 503) : json(data));
  const entry = (await dictionary.lookup("hello")).entry;
  assert.equal(entry.phonetic, "/UK/");
  assert.equal(entry.audioUrl, null);
  assert.equal(entry.meanings.length, 2);
  assert.equal(entry.meanings[0].definitions[0].example, "An example sentence.");
  assert.equal(entry.meanings[0].definitions[1].definition, "A narrower meaning.");
  assert.equal(entry.sourceUrl, "https://en.wiktionary.org/wiki/hello");
  assert.equal(entry.licence.name, "CC BY-SA 4.0");
  const { parseDictionaryEntry } = loadTypeScript("src/lib/dictionary-types.ts");
  assert.deepEqual(plain(parseDictionaryEntry(plain(entry))), plain(entry));
  assert.equal(parseDictionaryEntry({ ...plain(entry), providerUrl: "https://evil.example/" }), null);
});

test("backup runs only after a primary service failure, and primary is retried after its two-minute recovery window", async () => {
  const dictionary = client(async (url) => {
    const word = decodeURIComponent(url.split("/").at(-1));
    if (url.startsWith("https://api.dictionaryapi.dev/")) return word === "hello" ? json({}, 503) : json(fixture(word));
    return json(fallbackFixture(word));
  });
  await dictionary.lookup("hello");
  await dictionary.lookup("world");
  assert.equal(dictionary.requests.filter((request) => request.url.startsWith("https://api.dictionaryapi.dev/")).length, 1);
  dictionary.advance(120_001);
  assert.equal((await dictionary.lookup("book")).entry.providerName, "Dictionary API");
  assert.equal(dictionary.requests.filter((request) => request.url.startsWith("https://api.dictionaryapi.dev/")).length, 2);
});

test("backup empty entries are real missing words and can try conservative inflection candidates", async () => {
  const dictionary = client(async (url) => {
    if (url.startsWith("https://api.dictionaryapi.dev/")) return json({}, 403);
    return url.endsWith("children") ? json(backupMissing("children")) : json(fallbackFixture("child"));
  });
  const result = await dictionary.lookup("children");
  assert.equal(result.query, "children");
  assert.equal(result.entry.word, "child");
  assert.equal(dictionary.requests.length, 3);
});

test("form-only backup definitions resolve a safe existing lemma without moving the selected source word", async () => {
  const habits = fallbackFixture("habits", "plural of habit");
  habits.entries.push({ ...habits.entries[0], partOfSpeech: "verb", senses: [{ definition: "third-person singular simple present indicative of habit", examples: [], subsenses: [] }] });
  const dictionary = client(async (url) => {
    if (url.startsWith("https://api.dictionaryapi.dev/")) return json({}, 503);
    return json(url.endsWith("habits") ? habits : fallbackFixture("habit", "An action repeated regularly."));
  });
  const result = await dictionary.lookup("habits");
  assert.equal(result.query, "habits");
  assert.equal(result.entry.word, "habit");
  assert.equal(result.entry.meanings[0].definitions[0].definition, "An action repeated regularly.");
  assert.equal(dictionary.requests.length, 3);
  await dictionary.lookup("habits");
  assert.equal(dictionary.requests.length, 3);
});
