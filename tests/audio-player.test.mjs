import assert from "node:assert/strict";
import test from "node:test";
import { loadTypeScript } from "./helpers/load-typescript.mjs";

const epubLocation = loadTypeScript("src/lib/epub-location.ts");
const audioTypes = loadTypeScript("src/lib/audio-types.ts", { stubs: { "./epub-location": epubLocation } });
const audioSync = loadTypeScript("src/lib/audio-sync.ts");
const duration = 24.312;
const chapters = [{ id: "one", title: "One", paragraphs: ["First.", "Second.", "Third.", "Fourth."] }];
const manifest = {
  schemaVersion: 1, bookId: "book", editionId: "edition", generationId: "generation",
  narrator: { id: "heart", name: "Heart", language: "en-US", engine: "kokoro", voice: "af_heart" },
  alignment: "paragraph", sampleRate: 24000,
  coverage: { complete: true, totalChapters: 1, chapterIndices: [0] },
  chapters: [{ chapterIndex: 0, chapterId: "one", title: "One", audioPath: "book/edition/heart/generation/chapter-0001.mp3", durationSeconds: duration,
    segments: [0, 4, 8, 16].map((start, paragraphIndex) => ({ paragraphIndex, startSeconds: start, endSeconds: [4, 8, 16, duration][paragraphIndex], textHash: "a".repeat(64) })),
  }],
};
const wordChapters = [{ id: "one", title: "One", paragraphs: ["Start halfway through this paragraph.", "Read this next sentence."] }];
const wordManifest = {
  ...manifest, schemaVersion: 2, generationId: "word-generation", alignment: "word", format: "opus", locationScheme: "readlay-canonical-epub-v1",
  chapters: [{ ...manifest.chapters[0], audioPath: "book/edition/heart/word-generation/chapter-0001.opus", byteLength: 10,
    segments: [{ paragraphIndex: 0, startSeconds: 0, endSeconds: 10, textHash: "a".repeat(64) }, { paragraphIndex: 1, startSeconds: 10, endSeconds: duration, textHash: "b".repeat(64) }],
    words: wordChapters[0].paragraphs.flatMap((text, paragraphIndex) => epubLocation.wordsInText(text).map((word, index) => ({
      paragraphIndex, charStart: word.charStart, charEnd: word.charEnd, startSeconds: paragraphIndex * 10 + index * 1.2, endSeconds: paragraphIndex * 10 + index * 1.2 + 1,
      cfi: epubLocation.cfiForPosition(0, paragraphIndex, word.charStart),
    }))),
  }],
};

function find(tree, predicate) {
  if (Array.isArray(tree)) return tree.map((item) => find(item, predicate)).find(Boolean);
  if (!tree || typeof tree !== "object") return null;
  if (predicate(tree)) return tree;
  return find(tree.props?.children, predicate);
}
function content(tree) {
  if (Array.isArray(tree)) return tree.map(content).join("");
  if (typeof tree === "string" || typeof tree === "number") return String(tree);
  return tree && typeof tree === "object" ? content(tree.props?.children) : "";
}

// Execute the component's real effects and handlers with deterministic hooks and media.
// This checks state transitions, while the browser check covers actual audio playback.
function playerHarness({ source = manifest, textChapters = chapters, location = { chapterIndex: 0, paragraphIndex: 0 }, selectedPosition, saveData = false, mediaResponse, delayChapter, narratorSources = [source] } = {}) {
  const slots = [];
  const effects = [];
  const mediaHandlers = new Map();
  const requests = [];
  const positions = [];
  const blobUrls = { live: new Set(), created: [], revoked: [], peak: 0 };
  let unmounting = false;
  let cursor = 0;
  let dirty = true;
  let tree;
  const unchanged = (previous, deps) => previous && deps.length === previous.deps.length && deps.every((value, index) => Object.is(value, previous.deps[index]));
  const react = {
    useState(initial) {
      const index = cursor++;
      slots[index] ??= { value: typeof initial === "function" ? initial() : initial };
      return [slots[index].value, (value) => {
        const next = typeof value === "function" ? value(slots[index].value) : value;
        if (!Object.is(next, slots[index].value)) { slots[index].value = next; dirty = true; }
      }];
    },
    useRef(initial) { const index = cursor++; slots[index] ??= { current: initial }; return slots[index]; },
    useCallback(fn, deps) {
      const index = cursor++;
      if (!unchanged(slots[index], deps)) slots[index] = { deps, value: fn };
      return slots[index].value;
    },
    useEffect(fn, deps) {
      const index = cursor++;
      if (!unchanged(slots[index], deps)) {
        const cleanup = slots[index]?.cleanup;
        slots[index] = { deps };
        effects.push(() => { cleanup?.(); slots[index].cleanup = fn(); });
      }
    },
  };
  let currentTime = 0;
  const audio = {
    duration, readyState: 1, playbackRate: 1, paused: true, ended: false, error: null, src: "", currentSrc: "",
    get currentTime() { return currentTime; },
    set currentTime(value) { currentTime = value; if (value < duration) audio.ended = false; },
    load() { const src = audio.src; queueMicrotask(() => { audio.currentSrc = src; audio.error = null; audioProps().onLoadedMetadata(); audioProps().onCanPlay(); }); },
    play() { audio.paused = false; audio.ended = false; audioProps().onPlaying(); return Promise.resolve(); },
    pause() { if (!audio.paused) { audio.paused = true; audioProps().onPause(); } },
  };
  const props = {
    bookId: "book", editionId: "edition", bookTitle: "Book", author: "Author", chapters: textChapters,
    location, seekRequest: null, mode: "reading",
    onModeChange(mode) { if (props.mode !== mode) { props.mode = mode; dirty = true; } },
    onPositionChange(position, flush) { positions.push({ position, flush }); props.location = position; dirty = true; },
    onReturnToReading(position) { props.location = position; props.mode = "reading"; dirty = true; },
    ...(selectedPosition ? { getReadingPosition: () => selectedPosition } : {}),
  };
  const Player = loadTypeScript("src/components/AudiobookPlayer.tsx", {
    stubs: {
      react,
      "react/jsx-runtime": { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: "fragment" },
      "lucide-react": Object.fromEntries(["Headphones", "Pause", "Play", "RotateCcw", "RotateCw", "Volume2"].map((icon) => [icon, "icon"])),
      "@/lib/audio-types": audioTypes,
      "@/lib/audio-sync": audioSync,
    },
    globals: {
      window: { setTimeout, clearTimeout },
      navigator: { connection: { saveData }, mediaSession: { metadata: null, setActionHandler(action, handler) { if (handler) mediaHandlers.set(action, handler); else mediaHandlers.delete(action); } } },
      localStorage: { getItem: () => null, setItem() {} },
      Blob,
      URL: class extends URL {
        static createObjectURL() { const url = `blob:readlay-test-${blobUrls.created.length + 1}`; blobUrls.created.push(url); blobUrls.live.add(url); blobUrls.peak = Math.max(blobUrls.peak, blobUrls.live.size); return url; }
        static revokeObjectURL(url) { blobUrls.live.delete(url); blobUrls.revoked.push({ url, currentSrc: audio.currentSrc, unmounting }); }
      },
      fetch: async (url, options) => {
        requests.push({ url, options });
        if (url.includes("/stream?")) return mediaResponse ? mediaResponse(url, options) : new Response(new Uint8Array(10));
        const parsed = new URL(url, "https://readlay.test");
        const selected = narratorSources.find((item) => item.narrator.id === parsed.searchParams.get("narrator")) ?? source;
        if (parsed.searchParams.has("chapter")) { const chapterIndex = Number(parsed.searchParams.get("chapter")); if (delayChapter) await delayChapter(chapterIndex); return Response.json(selected.chapters.find((item) => item.chapterIndex === chapterIndex)); }
        return Response.json(parsed.searchParams.has("index") ? audioTypes.audioManifestIndex(selected) : { narrators: narratorSources.map((item) => item.narrator) });
      },
    },
  }).default;
  function audioProps() { return find(tree, (node) => node.type === "audio").props; }
  function render() {
    cursor = 0;
    dirty = false;
    tree = Player(props);
    audioProps().ref.current = audio;
    audio.src = audioProps().src ?? "";
    if (!audio.src && audio.currentSrc) { audio.currentSrc = ""; audioProps().onEmptied?.(); }
    effects.splice(0).forEach((effect) => effect());
  }
  async function settle() {
    for (let iteration = 0; iteration < 20; iteration++) {
      if (dirty) render();
      await new Promise(setImmediate);
    }
    if (dirty) render();
  }
  const app = {
    audio, props, mediaHandlers, requests, positions, blobUrls, settle,
    status: () => content(find(tree, (node) => node.props?.className === "reader-audio-status")),
    button: (label) => find(tree, (node) => node.type === "button" && node.props["aria-label"] === label).props,
    slider: () => find(tree, (node) => node.type === "input" && node.props.type === "range").props,
    select: (label) => find(tree, (node) => node.type === "select" && node.props["aria-label"] === label).props,
    read: () => find(tree, (node) => node.type === "button" && content(node) === "Read").props.onClick(),
    retry: () => find(tree, (node) => node.type === "button" && content(node) === "Retry audio").props.onClick(),
    audioProps,
    async start() {
      await settle();
      find(tree, (node) => node.type === "button" && content(node).includes("Listen from here")).props.onClick();
      await settle();
      assert.equal(audio.paused, false);
    },
    async finish() {
      audio.currentTime = duration;
      audio.paused = true;
      audio.ended = true;
      audioProps().onTimeUpdate();
      audioProps().onEnded();
      await settle();
      assert.equal(app.status(), "End of available audio.");
    },
    cleanup() { unmounting = true; for (const slot of slots) slot.cleanup?.(); },
  };
  render();
  return app;
}

test("rewind after the chapter ends clears the ended status and restores its paragraph", async (t) => {
  const app = playerHarness(); t.after(() => app.cleanup());
  await app.start(); await app.finish();
  app.button("Rewind 15 seconds").onClick(); await app.settle();
  assert.ok(Math.abs(app.audio.currentTime - 9.312) < 0.000001);
  assert.equal(app.props.location.paragraphIndex, 2);
  assert.match(app.status(), /Paragraph 3\./);
  assert.equal(app.audio.paused, true, "rewinding does not resume a paused recording");
});

test("slider seeking after the chapter ends clears the ended status", async (t) => {
  const app = playerHarness(); t.after(() => app.cleanup());
  await app.start(); await app.finish();
  app.slider().onChange({ target: { value: "5" } }); await app.settle();
  assert.equal(app.audio.currentTime, 5);
  assert.equal(app.props.location.paragraphIndex, 1);
  assert.match(app.status(), /Paragraph 2\./);
});

test("Media Session seeking shares status, time and paragraph updates", async (t) => {
  const app = playerHarness(); t.after(() => app.cleanup());
  await app.start(); await app.finish();
  app.mediaHandlers.get("seekbackward")({}); await app.settle();
  assert.match(app.status(), /Paragraph 3\./);
  assert.ok(Math.abs(app.slider().value - 9.312) < 0.000001);
  await app.finish();
  app.mediaHandlers.get("seekto")({ seekTime: 4 }); await app.settle();
  assert.equal(app.slider().value, 4);
  assert.match(app.status(), /Paragraph 2\./);
  app.mediaHandlers.get("seekforward")({ seekOffset: 4 }); await app.settle();
  assert.equal(app.slider().value, 8);
  assert.match(app.status(), /Paragraph 3\./);
});

test("a browser seeked event also clears stale ended status", async (t) => {
  const app = playerHarness(); t.after(() => app.cleanup());
  await app.start(); await app.finish();
  app.audio.currentTime = 0;
  app.audioProps().onSeeked(); await app.settle();
  assert.equal(app.slider().value, 0);
  assert.match(app.status(), /Paragraph 1\./);
});

test("Listen starts at a selected word inside a paragraph and downloads only that chapter's cues", async (t) => {
  const word = wordManifest.chapters[0].words[3];
  const app = playerHarness({ source: wordManifest, textChapters: wordChapters, location: { chapterIndex: 0, paragraphIndex: 0, charOffset: word.charStart } }); t.after(() => app.cleanup());
  await app.start();
  assert.equal(app.audio.currentTime, word.startSeconds);
  assert.equal(app.props.location.charOffset, word.charStart);
  assert.equal(app.props.location.cfi, word.cfi);
  const metadata = app.requests.filter(({ url }) => url.includes("?narrator="));
  assert.ok(metadata.some(({ url }) => url.includes("&index=1")));
  assert.equal(metadata.filter(({ url }) => url.includes("&chapter=0")).length, 1, "loaded chapter cues are reused by Listen");
  assert.ok(metadata.every(({ url }) => url.includes("&index=1") || url.includes("&chapter=")), "the full-book word manifest is never requested");
});

test("the latest browser selection wins over the last saved paragraph on Listen", async (t) => {
  const word = wordManifest.chapters[0].words[4];
  const selectedPosition = { chapterIndex: 0, paragraphIndex: 0, charOffset: word.charStart, cfi: word.cfi };
  const app = playerHarness({ source: wordManifest, textChapters: wordChapters, selectedPosition }); t.after(() => app.cleanup());
  await app.start();
  assert.equal(app.audio.currentTime, word.startSeconds);
  assert.equal(app.props.location.charOffset, word.charStart);
});

test("returning to reading uses the word at the actual media time, even between timeupdate events", async (t) => {
  const app = playerHarness({ source: wordManifest, textChapters: wordChapters }); t.after(() => app.cleanup());
  await app.start();
  const word = wordManifest.chapters[0].words[2];
  app.audio.currentTime = word.startSeconds + 0.25;
  app.read(); await app.settle();
  assert.equal(app.props.mode, "reading");
  assert.equal(app.audio.paused, true);
  assert.equal(app.props.location.charOffset, word.charStart);
  assert.equal(app.props.location.cfi, word.cfi);
  assert.ok(app.positions.some(({ position, flush }) => position.charOffset === word.charStart && flush === true));
});

test("six playback speeds use the same recording and retain the current word", async (t) => {
  const app = playerHarness({ source: wordManifest, textChapters: wordChapters }); t.after(() => app.cleanup());
  await app.start();
  const src = app.audioProps().src;
  const requestCount = app.requests.length;
  for (const rate of [0.75, 1, 1.25, 1.5, 1.75, 2]) {
    app.select("Audiobook playback speed").onChange({ target: { value: String(rate) } }); await app.settle();
    assert.equal(app.audio.playbackRate, rate);
    assert.equal(app.audioProps().src, src);
  }
  assert.equal(app.requests.length, requestCount, "speed changes do not regenerate or fetch another recording");
});

test("legacy recordings disclose paragraph precision and never invent a word offset", async (t) => {
  const app = playerHarness({ location: { chapterIndex: 0, paragraphIndex: 1, charOffset: 3 } }); t.after(() => app.cleanup());
  await app.settle();
  assert.match(app.status(), /Paragraph audio/);
  await app.start();
  assert.equal(app.audio.currentTime, 4);
  assert.equal(app.props.location.charOffset, undefined);
  assert.match(app.status(), /paragraph boundaries/);
});

function twoChapterSource(byteLength = 10) {
  const secondText = { id: "two", title: "Two", paragraphs: ["Continue from this word."] };
  const second = { ...wordManifest.chapters[0], chapterIndex: 1, chapterId: "two", title: "Two", audioPath: "book/edition/heart/word-generation/chapter-0002.opus", byteLength,
    segments: [{ paragraphIndex: 0, startSeconds: 0, endSeconds: duration, textHash: "c".repeat(64) }],
    words: epubLocation.wordsInText(secondText.paragraphs[0]).map((word, index) => ({ paragraphIndex: 0, charStart: word.charStart, charEnd: word.charEnd, startSeconds: index, endSeconds: index + 0.9, cfi: epubLocation.cfiForPosition(1, 0, word.charStart) })),
  };
  return { source: { ...wordManifest, coverage: { complete: true, totalChapters: 2, chapterIndices: [0, 1] }, chapters: [wordManifest.chapters[0], second] }, textChapters: [...wordChapters, secondText] };
}

test("next chapter cues and small audio are preloaded only while playing, and Data Saver prevents audio preloading", async (t) => {
  const config = twoChapterSource();
  const app = playerHarness(config); t.after(() => app.cleanup());
  await app.settle();
  assert.equal(app.requests.some(({ url }) => url.includes("&chapter=1")), false);
  await app.start();
  assert.ok(app.requests.some(({ url }) => url.includes("&chapter=1") && !url.includes("/stream?")));
  assert.ok(app.requests.some(({ url }) => url.includes("/stream?") && url.includes("&chapter=1")));
  app.button("Pause audiobook").onClick(); await app.settle();
  const dataSaving = playerHarness({ ...config, saveData: true }); t.after(() => dataSaving.cleanup());
  await dataSaving.start();
  assert.equal(dataSaving.requests.some(({ url }) => url.includes("/stream?")), false);
});

test("large next chapters are not fetched in full and chapter changes retain a paused state", async (t) => {
  const app = playerHarness(twoChapterSource(3 * 1024 * 1024)); t.after(() => app.cleanup());
  await app.start();
  assert.equal(app.requests.some(({ url }) => url.includes("/stream?")), false, "preload transfer is capped at 2 MiB");
  app.button("Pause audiobook").onClick(); await app.settle();
  app.select("Audiobook chapter").onChange({ target: { value: "1" } }); await app.settle();
  assert.equal(app.props.location.chapterIndex, 1);
  assert.equal(app.props.location.charOffset, 0);
  assert.equal(app.audio.paused, true);
});

test("chapter end continues with preloaded Opus and keeps a shared exact position", async (t) => {
  const app = playerHarness(twoChapterSource()); t.after(() => app.cleanup());
  await app.start();
  app.audio.currentTime = duration; app.audio.paused = true; app.audio.ended = true;
  app.audioProps().onEnded(); await app.settle();
  assert.equal(app.props.location.chapterIndex, 1);
  assert.equal(app.props.location.charOffset, 0);
  assert.equal(app.audio.paused, false);
  assert.match(app.audioProps().src, /^blob:/, "the next chapter reuses the complete bounded preload");
});

test("pausing while chapter cues load cancels the pending autoplay", async (t) => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const app = playerHarness({ ...twoChapterSource(), delayChapter: (chapterIndex) => chapterIndex === 1 ? gate : Promise.resolve() }); t.after(() => app.cleanup());
  await app.start();
  app.select("Audiobook chapter").onChange({ target: { value: "1" } }); await app.settle();
  app.button("Pause audiobook").onClick(); await app.settle();
  release(); await app.settle();
  assert.equal(app.props.location.chapterIndex, 1);
  assert.equal(app.audio.paused, true);
});

function severalChapterSource(count = 6) {
  const base = twoChapterSource();
  const textChapters = Array.from({ length: count }, (_, chapterIndex) => chapterIndex ? { ...base.textChapters[1], id: `chapter-${chapterIndex}`, title: `Chapter ${chapterIndex + 1}` } : base.textChapters[0]);
  const audioChapters = textChapters.map((text, chapterIndex) => {
    const original = base.source.chapters[chapterIndex ? 1 : 0];
    return { ...original, chapterIndex, chapterId: text.id, title: text.title, audioPath: `book/edition/heart/word-generation/chapter-${chapterIndex}.opus`,
      words: original.words.map((word) => ({ ...word, cfi: epubLocation.cfiForPosition(chapterIndex, word.paragraphIndex, word.charStart) })),
    };
  });
  return { source: { ...base.source, coverage: { complete: true, totalChapters: count, chapterIndices: audioChapters.map((item) => item.chapterIndex) }, chapters: audioChapters }, textChapters };
}

async function nextChapter(app) {
  app.audio.currentTime = duration; app.audio.paused = true; app.audio.ended = true;
  app.audioProps().onEnded(); await app.settle();
}

test("several chapter handovers retain only current and next Blob URLs, then release both on unmount", async (t) => {
  const app = playerHarness(severalChapterSource()); t.after(() => app.cleanup());
  await app.start();
  for (let chapterIndex = 1; chapterIndex < 6; chapterIndex++) {
    await nextChapter(app);
    assert.equal(app.props.location.chapterIndex, chapterIndex);
    assert.equal(app.audio.paused, false);
    assert.ok(app.blobUrls.live.size <= 2, "only the active recording and its successor remain allocated");
    assert.ok(app.blobUrls.live.has(app.audio.currentSrc), "the playing Blob is never released before handover");
  }
  assert.equal(app.blobUrls.created.length, 5);
  assert.ok(app.blobUrls.peak <= 2, "preload replacement releases unused Blobs before allocating another");
  assert.ok(app.blobUrls.revoked.every((item) => item.unmounting || item.url !== item.currentSrc));
  app.cleanup();
  assert.equal(app.blobUrls.live.size, 0);
});

test("narrator changes discard unused preload Blobs and release the old source after handover", async (t) => {
  const config = severalChapterSource(3);
  const other = { ...config.source, generationId: "other-generation", narrator: { ...config.source.narrator, id: "other", name: "Other" }, chapters: config.source.chapters.map((chapter) => ({ ...chapter, audioPath: chapter.audioPath.replace("/heart/", "/other/") })) };
  const app = playerHarness({ ...config, narratorSources: [config.source, other] }); t.after(() => app.cleanup());
  await app.start(); await nextChapter(app);
  assert.equal(app.blobUrls.live.size, 2);
  const oldUrls = [...app.blobUrls.live];
  app.select("Audiobook narrator").onChange({ target: { value: "other" } }); await app.settle();
  assert.equal(app.audio.paused, true);
  assert.ok(oldUrls.every((url) => !app.blobUrls.live.has(url)));
  assert.ok(app.blobUrls.revoked.every((item) => item.unmounting || item.url !== item.currentSrc));
  app.cleanup(); assert.equal(app.blobUrls.live.size, 0);
});

test("retry replaces a failed cached source without retaining its Blob or its obsolete preload", async (t) => {
  const app = playerHarness(severalChapterSource(3)); t.after(() => app.cleanup());
  await app.start(); await nextChapter(app);
  const oldUrls = [...app.blobUrls.live];
  assert.equal(oldUrls.length, 2);
  app.audio.error = { code: 4 }; app.audioProps().onError(); await app.settle();
  app.retry(); await app.settle();
  assert.equal(app.audio.paused, false);
  assert.ok(oldUrls.every((url) => !app.blobUrls.live.has(url)));
  assert.ok(app.blobUrls.live.size <= 2);
  assert.ok(app.blobUrls.revoked.every((item) => item.unmounting || item.url !== item.currentSrc));
  app.cleanup(); assert.equal(app.blobUrls.live.size, 0);
});
