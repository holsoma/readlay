import test from "node:test";
import assert from "node:assert/strict";
import { loadTypeScript as load, plain } from "./helpers/load-typescript.mjs";
const loadTypeScript = (relative) => load(relative.replace("../", ""));

const { segmentAtTime, segmentForParagraph, seekTimeForParagraph, isManifestForEdition } = loadTypeScript("../src/lib/audio-sync.ts");
const { narratorGender, parseAudioManifest, parseAudioNarrators } = loadTypeScript("../src/lib/audio-types.ts");
const hash = "a".repeat(64);
const segments = [
  { paragraphIndex: 0, startSeconds: 0.1, endSeconds: 3.4, textHash: hash },
  { paragraphIndex: 1, startSeconds: 3.8, endSeconds: 7.1, textHash: hash },
  { paragraphIndex: 2, startSeconds: 7.5, endSeconds: 12, textHash: hash },
];
function manifest() {
  return {
    schemaVersion: 1, bookId: "book", editionId: "edition-v2", generationId: "run-123",
    narrator: { id: "heart", name: "Heart", language: "en-US", engine: "kokoro", voice: "af_heart" },
    alignment: "paragraph", sampleRate: 24000,
    coverage: { complete: true, totalChapters: 1, chapterIndices: [0] },
    chapters: [{ chapterIndex: 0, chapterId: "chapter-one", title: "One", audioPath: "book/edition-v2/heart/run-123/chapter-0001.mp3", durationSeconds: 12, segments: structuredClone(segments) }],
  };
}

test("timestamps retain the preceding paragraph in pauses and switch at the next cue", () => {
  for (const [time, expected] of [[-1, 0], [0, 0], [0.1, 0], [3.4, 0], [3.799999, 0], [3.8, 1], [7.499999, 1], [7.5, 2], [12, 2], [100, 2]]) {
    assert.equal(segmentAtTime(segments, time)?.paragraphIndex, expected, `time=${time}`);
  }
  assert.equal(segmentAtTime([], 0), null);
  assert.equal(segmentAtTime(segments, NaN), null);
  assert.equal(segmentAtTime(segments, Infinity), null);
});

test("reading seeks use exact paragraph cues and never substitute an unavailable paragraph", () => {
  const audio = manifest();
  assert.equal(seekTimeForParagraph(audio, { chapterIndex: 0, paragraphIndex: 1 }), 3.8);
  assert.equal(seekTimeForParagraph(audio, { chapterIndex: 0, paragraphIndex: 3 }), null);
  assert.equal(seekTimeForParagraph(audio, { chapterIndex: 1, paragraphIndex: 0 }), null);
  assert.equal(segmentForParagraph(undefined, 0), null);
  assert.equal(segmentForParagraph(audio.chapters[0], -1), null);
  assert.equal(segmentForParagraph(audio.chapters[0], 0.5), null);
  audio.chapters[0].segments.splice(1, 1);
  assert.equal(segmentForParagraph(audio.chapters[0], 1), null);
  assert.equal(segmentForParagraph(audio.chapters[0], 2)?.startSeconds, 7.5);
});

test("metadata from another edition or changed chapter layout cannot drive the reader", () => {
  const audio = manifest();
  const chapters = [{ id: "chapter-one", paragraphs: ["A", "B", "C"] }];
  assert.equal(isManifestForEdition(audio, "book", "edition-v2", chapters), true);
  assert.equal(isManifestForEdition(audio, "book", "edition-v1", chapters), false);
  assert.equal(isManifestForEdition(audio, "other-book", "edition-v2", chapters), false);
  assert.equal(isManifestForEdition(audio, "book", "edition-v2", [{ id: "changed", paragraphs: ["A", "B", "C"] }]), false);
  assert.equal(isManifestForEdition(audio, "book", "edition-v2", [{ id: "chapter-one", paragraphs: ["A", "B"] }]), false);
  assert.equal(isManifestForEdition(audio, "book", "edition-v2", [...chapters, { id: "two", paragraphs: ["D"] }]), false);
});

test("manifest parser accepts valid offsets and rejects malformed timing, indexes and coverage", () => {
  assert.ok(parseAudioManifest(manifest()));
  const mutations = [
    (value) => { value.schemaVersion = 2; },
    (value) => { value.alignment = "word"; },
    (value) => { value.sampleRate = 0; },
    (value) => { value.generationId = "../other"; },
    (value) => { value.chapters[0].segments[1].startSeconds = 3.3; },
    (value) => { value.chapters[0].segments[1].endSeconds = 3.8; },
    (value) => { value.chapters[0].segments[2].paragraphIndex = 1; },
    (value) => { value.chapters[0].segments[2].endSeconds = 13; },
    (value) => { value.chapters[0].segments[2].startSeconds = NaN; },
    (value) => { value.chapters[0].segments[2].textHash = "old text"; },
    (value) => { value.coverage.chapterIndices = [1]; },
    (value) => { value.coverage.totalChapters = 2; },
    (value) => { value.chapters.push(structuredClone(value.chapters[0])); value.coverage.chapterIndices.push(0); },
  ];
  for (const mutate of mutations) {
    const value = manifest();
    mutate(value);
    assert.equal(parseAudioManifest(value), null, mutate.toString());
  }
  const partial = manifest();
  partial.coverage.complete = false;
  partial.coverage.totalChapters = 3;
  assert.ok(parseAudioManifest(partial));
});

test("narrator list treats no prepared recording as unavailable and rejects duplicate voices", () => {
  assert.deepEqual(parseAudioNarrators({ narrators: [] }), []);
  const voice = { id: "heart", name: "Heart", language: "en-US" };
  assert.deepEqual(plain(parseAudioNarrators({ narrators: [voice] })), [voice]);
  assert.equal(parseAudioNarrators({ narrators: [voice, voice] }), null);
  assert.equal(parseAudioNarrators({ narrators: [{ ...voice, id: "../secret" }] }), null);
  assert.equal(parseAudioNarrators({}), null);
});

test("voice descriptions accept explicit gender and verified chapter coverage while retaining old Kokoro manifests", () => {
  const voice = { id: "kokoro-am_michael", name: "Michael", language: "en-US", gender: "male", chapterIndices: [0, 2, 4] };
  assert.deepEqual(plain(parseAudioNarrators({ narrators: [voice] })), [voice]);
  assert.equal(narratorGender(voice), "male");
  assert.equal(narratorGender({ id: "kokoro-af_heart", name: "Heart", language: "en-US" }), "female");
  assert.equal(narratorGender({ id: "custom", name: "Narrator", language: "en-GB", voice: "bm_george" }), "male");
  assert.equal(narratorGender({ id: "custom", name: "Narrator", language: "en-GB" }), undefined);
  for (const patch of [{ gender: "unknown" }, { chapterIndices: [0, 0] }, { chapterIndices: [2, 1] }, { chapterIndices: [-1] }, { chapterIndices: [0.5] }]) {
    assert.equal(parseAudioNarrators({ narrators: [{ ...voice, ...patch }] }), null);
  }
  const audio = manifest();
  audio.narrator.gender = "female";
  assert.ok(parseAudioManifest(audio));
  audio.narrator.gender = "invalid";
  assert.equal(parseAudioManifest(audio), null);
});
