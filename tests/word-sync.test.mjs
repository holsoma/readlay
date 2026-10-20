import assert from "node:assert/strict";
import test from "node:test";
import { loadTypeScript, plain } from "./helpers/load-typescript.mjs";
const { cfiForPosition, parseEpubCfi, wordsInText, isTextBoundary } = loadTypeScript("src/lib/epub-location.ts");
const { wordAtTime, wordForPosition, positionAtTime, seekTimeForPosition } = loadTypeScript("src/lib/audio-sync.ts");
const { parseAudioManifest, parseAudioManifestIndex, audioManifestIndex } = loadTypeScript("src/lib/audio-types.ts");

function example() {
  const paragraphs = ["A longer paragraph: stop halfway, then continue.", "😀 Don't lose café’s place."];
  let time = 0.1;
  const segments = [], words = [];
  for (const [paragraphIndex, text] of paragraphs.entries()) {
    const startSeconds = time;
    for (const word of wordsInText(text)) {
      words.push({ paragraphIndex, charStart: word.charStart, charEnd: word.charEnd, startSeconds: time, endSeconds: time + 0.3, cfi: cfiForPosition(0, paragraphIndex, word.charStart) });
      time += 0.4;
    }
    segments.push({ paragraphIndex, startSeconds, endSeconds: time, textHash: "a".repeat(64) });
  }
  return { schemaVersion: 2, alignment: "word", format: "opus", locationScheme: "readlay-canonical-epub-v1", sampleRate: 24000,
    bookId: "book", editionId: "edition", generationId: "generation", narrator: { id: "heart", name: "Heart", voice: "af_heart", engine: "kokoro", language: "en-US" },
    coverage: { complete: true, totalChapters: 1, chapterIndices: [0] },
    chapters: [{ chapterIndex: 0, chapterId: "one", title: "One", audioPath: "book/edition/heart/generation/chapter-0001.opus", durationSeconds: time, byteLength: 10000, segments, words }] };
}

test("canonical CFIs round-trip UTF-16 coordinates without accepting other paths or split surrogate pairs", () => {
  for (const position of [{ chapterIndex: 0, paragraphIndex: 0, charOffset: 0 }, { chapterIndex: 23, paragraphIndex: 18, charOffset: 1234 }]) {
    assert.deepEqual(plain(parseEpubCfi(cfiForPosition(position.chapterIndex, position.paragraphIndex, position.charOffset))), position);
  }
  for (const cfi of ["epubcfi(/6/2[chapter-2]!/4/2/1:0)", "epubcfi(/6/3[chapter-1]!/4/2/1:0)", "epubcfi(/6/2[chapter-1]!/4/02/1:0)", "javascript:alert(1)", "epubcfi(/6/2[chapter-1]!/4/2/1:-1)"]) assert.equal(parseEpubCfi(cfi), null);
  assert.equal(isTextBoundary("😀word", 1), false);
  assert.equal(isTextBoundary("😀word", 2), true);
  assert.equal(isTextBoundary("text", 5), false);
  assert.deepEqual(plain(wordsInText("😀 Don't lose café’s well-being.")), [
    { text: "Don't", charStart: 3, charEnd: 8 }, { text: "lose", charStart: 9, charEnd: 13 },
    { text: "café’s", charStart: 14, charEnd: 20 }, { text: "well-being", charStart: 21, charEnd: 31 },
  ]);
});

test("every character inside a word seeks to that word, including halfway through a paragraph", () => {
  const manifest = example();
  const chapter = manifest.chapters[0];
  for (const word of chapter.words) {
    for (let offset = word.charStart; offset < word.charEnd; offset++) {
      const position = { chapterIndex: 0, paragraphIndex: word.paragraphIndex, charOffset: offset };
      assert.equal(seekTimeForPosition(manifest, position), word.startSeconds);
      assert.equal(wordForPosition(chapter, position).cfi, word.cfi);
    }
  }
  const halfway = chapter.words[4];
  assert.ok(halfway.charStart > 0);
  assert.notEqual(halfway.startSeconds, chapter.segments[0].startSeconds);
  assert.equal(wordForPosition(chapter, { chapterIndex: 1, paragraphIndex: 0, charOffset: 1 }), null);
  assert.equal(seekTimeForPosition(manifest, { chapterIndex: 0, paragraphIndex: 6, charOffset: 0 }), null);
});

test("listening maps boundaries and pauses to exact words and returns the same CFI", () => {
  const chapter = example().chapters[0];
  for (const [index, word] of chapter.words.entries()) {
    assert.equal(wordAtTime(chapter.words, word.startSeconds).charStart, word.charStart);
    const position = positionAtTime(chapter, word.endSeconds - 0.001);
    assert.deepEqual(plain(position), { chapterIndex: 0, paragraphIndex: word.paragraphIndex, charOffset: word.charStart, cfi: word.cfi });
    const next = chapter.words[index + 1];
    if (next) assert.equal(wordAtTime(chapter.words, next.startSeconds - 0.0001).cfi, word.cfi);
  }
  assert.equal(wordAtTime(chapter.words, NaN), null);
  assert.equal(wordAtTime([], 1), null);
  const legacy = { ...chapter, words: undefined };
  assert.equal(positionAtTime(legacy, 0.2).charOffset, undefined);
});

test("v2 validation rejects inconsistent CFI, missing words, overlap and malformed UTF-16 ranges", () => {
  assert.ok(parseAudioManifest(example()));
  for (const mutate of [
    value => { value.chapters[0].words = []; },
    value => { value.chapters[0].words[1].cfi = cfiForPosition(1, 0, 2); },
    value => { value.chapters[0].words[1].startSeconds = 0.1; },
    value => { value.chapters[0].words[1].charEnd = -1; },
    value => { value.chapters[0].words[1].charStart = 0; },
    value => { value.locationScheme = "publisher-epub"; },
    value => { value.format = "mp3"; },
  ]) { const value = example(); mutate(value); assert.equal(parseAudioManifest(value), null); }
});

test("chapter index omits word and paragraph timings while preserving prepared coverage", () => {
  const manifest = example();
  manifest.chapters[0].sentences = [{ paragraphIndex: 0, startSeconds: 0, endSeconds: 10 }];
  manifest.operatorNotes = "Preparation-only details";
  const index = audioManifestIndex(manifest);
  assert.ok(parseAudioManifestIndex(index));
  assert.equal(index.chapters[0].words, undefined);
  assert.equal(index.chapters[0].segments, undefined);
  assert.equal(index.chapters[0].sentences, undefined);
  assert.equal(index.operatorNotes, undefined);
  assert.deepEqual(plain(index.coverage), manifest.coverage);
  assert.ok(JSON.stringify(index).length < JSON.stringify(manifest).length / 2);
});
