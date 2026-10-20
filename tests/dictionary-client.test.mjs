import assert from "node:assert/strict";
import test from "node:test";
import { loadTypeScript, plain } from "./helpers/load-typescript.mjs";

const fixture = (word) => [{ word, phonetics: [{ text: "/word/", audio: `https://api.dictionaryapi.dev/media/pronunciations/en/${word}-uk.mp3` }],
  meanings: [{ partOfSpeech: "noun", definitions: [{ definition: "A dictionary meaning." }, { definition: "An alternative meaning." }] }],
  license: { name: "CC BY-SA 3.0", url: "https://creativecommons.org/licenses/by-sa/3.0/" }, sourceUrls: [`https://en.wiktionary.org/wiki/${word}`] }];
const json = (body, status = 200) => Response.json(body, { status });
const missing = () => json({ title: "No Definitions Found", message: "No matching word." }, 404);

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

test("HTML error pages, forbidden responses, bad data and rate limits do not trigger inflection fallback", async () => {
  const cases = [
    [() => new Response("<html>Not found</html>", { status: 404, headers: { "Content-Type": "text/html" } }), 502],
    [() => json({}, 404), 502],
    [() => json({}, 403), 503],
    [() => json({}, 429), 429],
    [() => json(fixture("otherword")), 502],
    [() => new Response("x".repeat(512 * 1024 + 1), { headers: { "Content-Type": "application/json" } }), 502],
  ];
  for (const [respond, status] of cases) {
    const dictionary = client(async () => respond());
    await assert.rejects(dictionary.lookup("children"), (error) => error.status === status);
    assert.equal(dictionary.requests.length, 1);
  }
});

test("browser lookup timeout aborts the official request and retains no failed cache entry", async () => {
  const dictionary = client(async (_url, options) => {
    assert.equal(options.signal.aborted, true);
    throw new DOMException("Timed out", "AbortError");
  }, { setTimeout: (callback) => { callback(); return 0; }, clearTimeout() {} });
  await assert.rejects(dictionary.lookup("hello"), (error) => error.status === 503);
  await assert.rejects(dictionary.lookup("hello"), (error) => error.status === 503);
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
