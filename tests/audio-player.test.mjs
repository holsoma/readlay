import assert from "node:assert/strict";
import test from "node:test";
import { loadTypeScript } from "./helpers/load-typescript.mjs";

const audioTypes = loadTypeScript("src/lib/audio-types.ts");
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
function playerHarness() {
  const slots = [];
  const effects = [];
  const mediaHandlers = new Map();
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
    duration, readyState: 1, playbackRate: 1, paused: true, ended: false, error: null,
    get currentTime() { return currentTime; },
    set currentTime(value) { currentTime = value; if (value < duration) audio.ended = false; },
    load() { queueMicrotask(() => { audioProps().onLoadedMetadata(); audioProps().onCanPlay(); }); },
    play() { audio.paused = false; audio.ended = false; audioProps().onPlaying(); return Promise.resolve(); },
    pause() { if (!audio.paused) { audio.paused = true; audioProps().onPause(); } },
  };
  const props = {
    bookId: "book", editionId: "edition", bookTitle: "Book", author: "Author", chapters,
    location: { chapterIndex: 0, paragraphIndex: 0 }, seekRequest: null, mode: "reading",
    onModeChange(mode) { if (props.mode !== mode) { props.mode = mode; dirty = true; } },
    onPositionChange(position) { props.location = position; dirty = true; },
    onReturnToReading(position) { props.location = position; props.mode = "reading"; dirty = true; },
  };
  const Player = loadTypeScript("src/components/AudiobookPlayer.tsx", {
    stubs: {
      react,
      "react/jsx-runtime": { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: "fragment" },
      "lucide-react": Object.fromEntries(["Headphones", "Pause", "Play", "RotateCcw", "Volume2"].map((icon) => [icon, "icon"])),
      "@/lib/audio-types": audioTypes,
      "@/lib/audio-sync": audioSync,
    },
    globals: {
      window: { setTimeout, clearTimeout },
      navigator: { mediaSession: { metadata: null, setActionHandler(action, handler) { if (handler) mediaHandlers.set(action, handler); else mediaHandlers.delete(action); } } },
      localStorage: { getItem: () => null, setItem() {} },
      fetch: async (url) => Response.json(url.includes("?narrator=") ? manifest : { narrators: [manifest.narrator] }),
    },
  }).default;
  function audioProps() { return find(tree, (node) => node.type === "audio").props; }
  function render() {
    cursor = 0;
    dirty = false;
    tree = Player(props);
    audioProps().ref.current = audio;
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
    audio, props, mediaHandlers, settle,
    status: () => content(find(tree, (node) => node.props?.className === "reader-audio-status")),
    button: (label) => find(tree, (node) => node.type === "button" && node.props["aria-label"] === label).props,
    slider: () => find(tree, (node) => node.type === "input" && node.props.type === "range").props,
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
    cleanup() { for (const slot of slots) slot.cleanup?.(); },
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
