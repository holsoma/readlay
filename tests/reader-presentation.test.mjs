import test from "node:test";
import assert from "node:assert/strict";
import { loadTypeScript, plain } from "./helpers/load-typescript.mjs";

const presentation = loadTypeScript("src/lib/reader-presentation.ts");
const source = "😀 Be subdecongenial yet careful.";
const start = source.indexOf("subdecongenial");
const correction = { charStart: start, charEnd: start + 14, sourceText: "subdecongenial", replacementText: "subtle, congenial" };
const imageId = "a".repeat(64);
const image = { id: imageId, filename: `${imageId}.jpg`, mediaType: "image/jpeg", beforeParagraph: 1, width: 800, height: 600, alt: "A diagram" };
const chapters = [{ id: "one", title: "PREFACE", paragraphs: [source, "Ordinary text."] }];
const fixture = () => ({ version: 1, bookId: "book", editionId: "edition", chapters: [{ title: "Preface", paragraphs: { 0: { kind: "quote", corrections: [correction] } }, images: [image] }] });

test("reviewed display corrections preserve original UTF-16 coordinates for both shown words and later words", () => {
  const runs = presentation.readerRuns(source, [correction]);
  assert.equal(runs.map((run) => run.text).join(""), "😀 Be subtle, congenial yet careful.");
  const corrected = runs.filter((run) => run.type === "word" && run.charStart === start);
  assert.deepEqual(plain(corrected.map(({ text, charStart, charEnd, lookupWord, displayKey }) => ({ text, charStart, charEnd, lookupWord, displayKey }))), [
    { text: "subtle", charStart: start, charEnd: start + 14, lookupWord: "subtle", displayKey: `${start}:0` },
    { text: "congenial", charStart: start, charEnd: start + 14, lookupWord: "congenial", displayKey: `${start}:1` },
  ]);
  const later = runs.find((run) => run.type === "word" && run.text === "careful");
  assert.equal(later.charStart, source.indexOf("careful"));
  assert.equal(source.slice(later.charStart, later.charEnd), "careful");
});

test("invalid, partial, overlapping and stale-source edits cannot change rendered text", () => {
  for (const invalid of [
    { ...correction, charStart: start + 1 }, { ...correction, sourceText: "another" },
    { ...correction, replacementText: "<script>alert(1)</script>" },
    { ...correction, replacementText: "one two three four five six seven" },
    { ...correction, charStart: 1, charEnd: 2, sourceText: "\ude00" },
  ]) assert.equal(presentation.readerRuns(source, [invalid]).map((run) => run.text).join(""), source);
  assert.equal(presentation.validReaderCorrections([correction, correction], source).length, 1);
  assert.equal(presentation.readerRuns("No changes.").map((run) => run.text).join(""), "No changes.");
});

test("presentation is edition-bound and only accepts known image formats, safe filenames and real paragraph boundaries", () => {
  const result = presentation.parseReaderPresentation(fixture(), "book", "edition", chapters);
  assert.equal(result.chapters[0].paragraphs[0].corrections[0].charStart, start);
  assert.equal(result.chapters[0].images.length, 1);
  assert.equal(presentation.parseReaderPresentation(fixture(), "book", "old-edition", chapters), null);
  for (const invalid of [
    { ...image, filename: "../../secret.jpg" }, { ...image, mediaType: "image/svg+xml" },
    { ...image, beforeParagraph: 3 }, { ...image, width: 20000, height: 20000 }, { ...image, id: "../a" },
  ]) {
    const data = fixture(); data.chapters[0].images = [invalid];
    assert.equal(presentation.parseReaderPresentation(data, "book", "edition", chapters).chapters[0].images.length, 0);
  }
});

test("reader headings distinguish front matter and numbered chapters without changing chapter order", () => {
  assert.deepEqual(plain(presentation.readerSectionHeading("PREFACE", 0)), { label: "Front matter", title: "Preface" });
  assert.deepEqual(plain(presentation.readerSectionHeading("Law 1: Never outshine the master", 1)), { label: "Law 1", title: "Never outshine the master" });
  assert.deepEqual(plain(presentation.readerSectionHeading("4. A chapter title", 5)), { label: "Chapter 4", title: "A chapter title" });
  assert.deepEqual(plain(presentation.readerSectionHeading("PART ONE: Essential principles / 4: A useful chapter", 5)), { label: "PART ONE: Essential principles / Chapter 4", title: "A useful chapter" });
});

test("book illustrations require GitHub authentication and a manifest-listed asset before any file read", async () => {
  let user = null; let reads = 0;
  const route = loadTypeScript("src/app/api/book-assets/[bookId]/[assetId]/route.ts", { stubs: {
    "@/auth": { authConfigured: true, auth: async () => user ? { user: { id: user } } : null },
    "@/lib/book-content": { getBookContent: async (bookId) => bookId === "book" ? { editionId: "edition", chapters } : null },
    "@/lib/reader-presentation-store": { getReaderPresentation: async () => presentation.parseReaderPresentation(fixture(), "book", "edition", chapters) },
    "node:fs/promises": { stat: async () => ({ isFile: () => true, size: 3 }), readFile: async () => { reads++; return new Uint8Array([255, 216, 255]); } },
  }, globals: { process: { cwd: () => process.cwd() } } });
  const get = (bookId = "book", assetId = imageId) => route.GET(new Request("https://readlay.test/image"), { params: Promise.resolve({ bookId, assetId }) });
  assert.equal((await get()).status, 401); assert.equal(reads, 0);
  user = "A";
  assert.equal((await get("book", "../secret")).status, 404);
  assert.equal((await get("other")).status, 404);
  assert.equal((await get("book", "b".repeat(64))).status, 404); assert.equal(reads, 0);
  const result = await get();
  assert.equal(result.status, 200); assert.equal(reads, 1);
  assert.equal(result.headers.get("content-type"), "image/jpeg");
  assert.equal(result.headers.get("x-content-type-options"), "nosniff");
  assert.match(result.headers.get("cache-control"), /private/);
  assert.equal(result.headers.get("vary"), "Cookie");
});
