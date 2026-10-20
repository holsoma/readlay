import assert from "node:assert/strict";
import test from "node:test";
import { loadTypeScript } from "./helpers/load-typescript.mjs";

function find(tree, predicate) {
  if (Array.isArray(tree)) return tree.map(node => find(node, predicate)).find(Boolean);
  if (!tree || typeof tree !== "object") return null;
  return predicate(tree) ? tree : find(tree.props?.children, predicate);
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join("");
  if (tree && typeof tree === "object") return text(tree.props?.children);
  return typeof tree === "string" ? tree : "";
}
const voice = (name, lang, localService = true) => ({ name, lang, localService, default: false });

function harness({ voices = [], supported = true } = {}) {
  let active;
  const listeners = new EventTarget();
  const synthesis = {
    voices, spoken: [], cancelled: 0, current: null,
    getVoices() { return synthesis.voices; },
    addEventListener: (...args) => listeners.addEventListener(...args),
    removeEventListener: (...args) => listeners.removeEventListener(...args),
    speak(utterance) { synthesis.spoken.push(utterance); synthesis.current = utterance; },
    cancel() { synthesis.cancelled++; const previous = synthesis.current; synthesis.current = null; previous?.onerror?.({ error: "canceled" }); },
  };
  class Utterance { constructor(word) { this.text = word; } }
  const react = {
    useState(initial) {
      const app = active, index = app.cursor++;
      app.slots[index] ??= { value: typeof initial === "function" ? initial() : initial };
      return [app.slots[index].value, value => { const next = typeof value === "function" ? value(app.slots[index].value) : value; if (!Object.is(next, app.slots[index].value)) { app.slots[index].value = next; app.dirty = true; } }];
    },
    useRef(initial) { const app = active, index = app.cursor++; app.slots[index] ??= { current: initial }; return app.slots[index]; },
    useEffect(fn, deps) {
      const app = active, index = app.cursor++, old = app.slots[index];
      if (!old || deps.some((value, i) => !Object.is(value, old.deps[i]))) {
        app.slots[index] = { deps }; app.effects.push(() => { old?.cleanup?.(); app.slots[index].cleanup = fn(); });
      }
    },
  };
  const componentModule = loadTypeScript("src/components/PronunciationButton.tsx", {
    extra: "\nexport const __test = { PronunciationControl };",
    stubs: { react, "react/jsx-runtime": { jsx: (type, props, key) => ({ type, props, key }), jsxs: (type, props, key) => ({ type, props, key }), Fragment: "fragment" }, "lucide-react": { Pause: "icon", Volume2: "icon" } },
    globals: { window: supported ? { speechSynthesis: synthesis, SpeechSynthesisUtterance: Utterance } : {} },
  });
  const apps = new Set();
  function mount({ word = "habit", audioUrl = null, failMedia = false } = {}) {
    const app = { slots: [], effects: [], cursor: 0, dirty: true, mounted: true, tree: null, mediaProps: null,
      media: { paused: true, currentTime: 8, plays: 0, pauses: 0,
        play() { app.media.plays++; if (failMedia) return Promise.reject(new Error("Clip unavailable")); app.media.paused = false; app.mediaProps.onPlay(); return Promise.resolve(); },
        pause() { app.media.pauses++; if (!app.media.paused) { app.media.paused = true; app.mediaProps.onPause(); } },
      },
      render() {
        app.cursor = 0; app.dirty = false; active = app;
        app.tree = componentModule.__test.PronunciationControl({ word, audioUrl }); active = null;
        const element = find(app.tree, node => node.type === "audio");
        if (element) { app.mediaProps = element.props; element.props.ref.current = app.media; }
        app.effects.splice(0).forEach(fn => fn());
      },
      button(label) { return find(app.tree, node => node.type === "button" && node.props["aria-label"] === label); },
      text() { return text(app.tree); },
      unmount() { app.mounted = false; for (const slot of app.slots) slot.cleanup?.(); apps.delete(app); },
    };
    apps.add(app); app.render(); return app;
  }
  return { mount, synthesis, componentModule,
    async settle() { for (let n = 0; n < 8; n++) { await new Promise(setImmediate); for (const app of apps) if (app.dirty && app.mounted) app.render(); } },
    voicesChanged(next) { synthesis.voices = next; listeners.dispatchEvent(new Event("voiceschanged")); },
    cleanup() { for (const app of apps) app.unmount(); },
  };
}

test("device pronunciation waits for local English voices, prefers British then Singaporean and never starts automatically", async t => {
  const app = harness(); t.after(() => app.cleanup()); const word = app.mount(); await app.settle();
  assert.match(word.text(), /unavailable/);
  app.voicesChanged([voice("Remote British", "en-GB", false), voice("French", "fr-FR")]); await app.settle();
  assert.ok(!word.button("Play device pronunciation of habit"));
  app.voicesChanged([voice("US", "en-US"), voice("Singapore", "en-SG"), voice("British", "en-GB")]); await app.settle();
  assert.equal(app.synthesis.spoken.length, 0);
  assert.ok(word.text().includes("Device voice"));
  word.button("Play device pronunciation of habit").props.onClick(); await app.settle();
  assert.equal(app.synthesis.spoken[0].voice.name, "British");
  assert.equal(app.synthesis.spoken[0].text, "habit");
  assert.equal(app.synthesis.spoken[0].rate, 1);
  word.button("Stop device pronunciation of habit").props.onClick(); await app.settle();
  app.voicesChanged([voice("US", "en-US"), voice("Singapore", "en-SG")]); await app.settle();
  word.button("Play device pronunciation of habit").props.onClick();
  assert.equal(app.synthesis.spoken.at(-1).voice.name, "Singapore");
});

test("recorded pronunciation remains preferred, playback failure offers an explicitly labelled local fallback", async t => {
  const app = harness({ voices: [voice("British", "en-GB")] }); t.after(() => app.cleanup());
  const word = app.mount({ audioUrl: "https://api.dictionaryapi.dev/media/pronunciations/en/habit-us.mp3", failMedia: true }); await app.settle();
  assert.ok(word.button("Play pronunciation of habit"));
  assert.ok(!word.button("Play device pronunciation of habit"));
  await word.button("Play pronunciation of habit").props.onClick(); await app.settle();
  assert.equal(word.media.plays, 1);
  assert.equal(word.media.currentTime, 0);
  assert.ok(word.button("Play device pronunciation of habit"));
  assert.match(word.text(), /could not play/);
  word.button("Play device pronunciation of habit").props.onClick(); await app.settle();
  assert.equal(app.synthesis.spoken.length, 1);
  assert.equal(word.media.paused, true);
  assert.ok(word.text().includes("Stop device voice"));
});

test("old row cleanup and late speech events cannot stop or clear a newer word", async t => {
  const app = harness({ voices: [voice("British", "en-GB")] }); t.after(() => app.cleanup());
  const first = app.mount(), second = app.mount({ word: "meaning" }); await app.settle();
  first.button("Play device pronunciation of habit").props.onClick(); await app.settle();
  const firstUtterance = app.synthesis.spoken[0];
  second.button("Play device pronunciation of meaning").props.onClick(); await app.settle();
  assert.equal(app.synthesis.cancelled, 1, "a new deliberate pronunciation replaces the previous owned utterance");
  assert.ok(first.button("Play device pronunciation of habit"));
  first.unmount();
  firstUtterance.onend(); firstUtterance.onerror(); await app.settle();
  assert.equal(app.synthesis.cancelled, 1, "old cleanup must not cancel the new owner");
  assert.ok(second.button("Stop device pronunciation of meaning"));
  second.unmount();
  assert.equal(app.synthesis.cancelled, 2, "the active owner's cleanup stops its own utterance");
});

test("completed or unsupported device pronunciation never cancels unrelated speech and word changes reset control state", async t => {
  const app = harness({ voices: [voice("British", "en-GB")] }); t.after(() => app.cleanup());
  const word = app.mount(); await app.settle();
  word.button("Play device pronunciation of habit").props.onClick();
  app.synthesis.spoken[0].onend(); await app.settle(); word.unmount();
  assert.equal(app.synthesis.cancelled, 0, "completed pronunciation must release cancellation ownership");
  const old = app.componentModule.PronunciationButton({ word: "habit", audioUrl: null });
  const next = app.componentModule.PronunciationButton({ word: "meaning", audioUrl: null });
  assert.notEqual(old.key, next.key, "a new word must not inherit playing or failure state");
  const unsupported = harness({ supported: false }); t.after(() => unsupported.cleanup());
  const unavailable = unsupported.mount(); await unsupported.settle();
  assert.match(unavailable.text(), /unavailable on this device/);
  assert.equal(unsupported.synthesis.spoken.length, 0);
});
