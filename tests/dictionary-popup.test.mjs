import assert from "node:assert/strict";
import test from "node:test";
import { loadTypeScript } from "./helpers/load-typescript.mjs";

function find(tree, predicate) {
  if (Array.isArray(tree)) return tree.map((item) => find(item, predicate)).find(Boolean);
  if (!tree || typeof tree !== "object") return null;
  return predicate(tree) ? tree : find(tree.props?.children, predicate);
}
function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join("");
  if (tree && typeof tree === "object") return text(tree.props?.children);
  return typeof tree === "string" ? tree : "";
}
const entry = { word: "habit", phonetic: "/ˈhæbɪt/", audioUrl: null, meanings: [{ partOfSpeech: "noun", definitions: [{ definition: "An action repeated regularly." }] }], sourceUrl: null, licence: null };
function harness({ signedIn = true, saved = [], save = async () => ({}), anchor = { left: 360, right: 380, top: 790, bottom: 815, width: 20, height: 25 }, popupHeight = 330, word = "habit" } = {}) {
  let cursor = 0, dirty = true, tree, mounted = true;
  const slots = [], effects = [], requests = [], notices = [], positions = [], listeners = new Map(), frames = [];
  let closed = 0, auth = 0, positionsUsed = 0;
  const unchanged = (old, deps) => old && deps && deps.length === old.deps?.length && deps.every((item, index) => Object.is(item, old.deps[index]));
  const react = {
    useState(initial) { const i = cursor++; slots[i] ??= { value: typeof initial === "function" ? initial() : initial }; return [slots[i].value, (value) => { const next = typeof value === "function" ? value(slots[i].value) : value; if (!Object.is(next, slots[i].value)) { slots[i].value = next; dirty = true; } }]; },
    useRef(initial) { const i = cursor++; slots[i] ??= { current: initial }; return slots[i]; },
    useCallback(fn, deps) { const i = cursor++; if (!unchanged(slots[i], deps)) slots[i] = { value: fn, deps }; return slots[i].value; },
    useEffect(fn, deps) { const i = cursor++; if (!unchanged(slots[i], deps)) { const cleanup = slots[i]?.cleanup; slots[i] = { deps }; effects.push(() => { cleanup?.(); slots[i].cleanup = fn(); }); } },
  };
  const selection = { word, selectedText: word, chapterIndex: 0, paragraphIndex: 2, charStart: 12, charEnd: 17, anchor };
  const props = { selection, bookId: "book", editionId: "edition", getAnchor: () => selection.anchor, onClose: () => closed++, onUsePosition: () => positionsUsed++ };
  const Popup = loadTypeScript("src/components/DictionaryPopup.tsx", {
    stubs: { react, "next/link": "link", "react/jsx-runtime": { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }, "lucide-react": { BookOpen: "icon", Check: "icon", Plus: "icon", X: "icon" }, "./WordBankProvider": { useWordBank: () => ({ words: saved, ready: true, isSignedIn: signedIn, saveWord: save }) }, "./ReadlayProvider": { useReadlay: () => ({ openAuth: () => auth++, notify: (message) => notices.push(message) }) }, "./PronunciationButton": { PronunciationButton: "pronunciation" }, "@/lib/dictionary-client": { lookupDictionaryInBrowser: (word, signal) => new Promise((resolve, reject) => requests.push({ word, options: { signal }, resolve, reject })) } },
    globals: { Error, fetch: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })), window: { innerWidth: 390, innerHeight: 844, requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; }, cancelAnimationFrame() {}, addEventListener() {}, removeEventListener() {} }, document: { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name) => listeners.delete(name) } },
  }).default;
  const element = { contains: (target) => target?.inside, getBoundingClientRect: () => ({ height: popupHeight }), focus() {} };
  function render() { cursor = 0; dirty = false; tree = Popup(props); tree.props.ref.current = element; effects.splice(0).forEach((effect) => effect()); frames.splice(0).forEach((frame) => frame()); if (tree.props.style.visibility === "visible") positions.push(tree.props.style); }
  async function settle() { for (let i = 0; i < 8; i++) { if (dirty && mounted) render(); await new Promise((resolve) => setTimeout(resolve, 1)); } }
  function response(status, body) { if (status >= 200 && status < 300) requests.at(-1).resolve(body); else requests.at(-1).reject(Object.assign(new Error(body.error), { status })); }
  render();
  return { requests, response, settle, notices, positions, text: () => text(tree), element: (predicate) => find(tree, predicate), button: (label) => find(tree, (node) => node.type === "button" && text(node).includes(label)), style: () => tree.props.style, closed: () => closed, auth: () => auth, positionsUsed: () => positionsUsed, dismiss: (target) => listeners.get("pointerdown")?.({ target }), escape: () => listeners.get("keydown")?.({ key: "Escape", preventDefault() {} }), cleanup() { mounted = false; for (const slot of slots) slot?.cleanup?.(); } };
}

test("popup shows loading, missing and retried definitions, and clamps to a small viewport", async (t) => {
  const app = harness(); t.after(() => app.cleanup()); await app.settle();
  assert.ok(app.text().includes("Looking up this word"));
  assert.equal(app.requests[0].word, "habit");
  assert.ok(app.style().left >= 12 && app.style().left + app.style().width <= 378);
  assert.ok(app.style().top >= 12 && app.style().top <= 502);
  app.response(404, { error: "No definition found." }); await app.settle();
  assert.ok(app.text().includes("No definition found."));
  assert.ok(!app.button("Save to Word Bank"));
  app.button("Try again").props.onClick(); await app.settle();
  assert.equal(app.requests.length, 2);
  app.response(200, { query: "habit", entry }); await app.settle();
  assert.ok(app.text().includes("An action repeated regularly."));
  assert.ok(app.text().includes("Pronunciation audio is unavailable"));
});

test("saving sends source coordinates and the displayed dictionary snapshot, reports failures and allows a retry", async (t) => {
  const inputs = [];
  const app = harness({ save: async (input) => { inputs.push(input); if (inputs.length === 1) throw new Error("Could not save this word."); return {}; } }); t.after(() => app.cleanup());
  app.response(200, { query: "habit", entry }); await app.settle();
  app.button("Save to Word Bank").props.onClick(); await app.settle();
  assert.ok(app.text().includes("Could not save this word."));
  assert.deepEqual(JSON.parse(JSON.stringify(inputs[0])), { word: "habit", bookId: "book", editionId: "edition", chapterIndex: 0, paragraphIndex: 2, charStart: 12, charEnd: 17, entry });
  app.button("Save to Word Bank").props.onClick(); await app.settle();
  assert.equal(app.notices.length, 1);
});

test("saved occurrences disable duplicate saves and outside click or Escape dismiss the nonmodal popup", async (t) => {
  const app = harness({ saved: [{ word: "habit", occurrences: [{ bookId: "book", editionId: "edition", chapterIndex: 0, paragraphIndex: 2, charStart: 12, charEnd: 17 }] }] }); t.after(() => app.cleanup());
  app.response(200, { query: "habit", entry }); await app.settle();
  assert.equal(app.button("Already in Word Bank").props.disabled, true);
  app.dismiss({ inside: true }); assert.equal(app.closed(), 0);
  app.dismiss({ inside: false, closest: () => ({}) }); assert.equal(app.closed(), 0, "Listen intentionally consumes the active word after pointerdown");
  app.dismiss({ inside: false }); assert.equal(app.closed(), 1);
  app.escape(); assert.equal(app.closed(), 2);
});

test("closing cancels a pending dictionary request and signed-out saves use existing authentication", async () => {
  const closed = harness();
  const request = closed.requests[0];
  closed.cleanup();
  assert.equal(request.options.signal.aborted, true);
  request.resolve({ query: "habit", entry });
  await closed.settle();
  const guest = harness({ signedIn: false });
  guest.response(200, { query: "habit", entry }); await guest.settle();
  guest.button("Sign in to save").props.onClick(); await guest.settle();
  assert.equal(guest.auth(), 1);
  guest.cleanup();
});

test("a tall popup scrolls on one side of a central word instead of covering native selection", async (t) => {
  const anchor = { left: 100, right: 160, top: 410, bottom: 435, width: 60, height: 25 };
  const app = harness({ anchor, popupHeight: 460 }); t.after(() => app.cleanup()); await app.settle();
  const style = app.style();
  assert.ok(style.maxHeight < 460);
  assert.ok(style.top + style.maxHeight <= anchor.top - 9 || style.top >= anchor.bottom + 9);
  assert.ok(style.top >= 12);
});

test("non-dictionary source tokens never call the API and keep the explicit position action", async (t) => {
  for (const word of ["1930s", "1,000"]) {
    const app = harness({ word }); t.after(() => app.cleanup()); await app.settle();
    assert.equal(app.requests.length, 0);
    assert.ok(app.text().includes("No dictionary entry for this selection."));
    assert.ok(!app.button("Try again"));
    app.button("Set reading place").props.onClick();
    assert.equal(app.positionsUsed(), 1);
  }
});

test("one concise primary definition keeps actions ahead of native More meanings with complete alternatives", async (t) => {
  const app = harness(); t.after(() => app.cleanup());
  const full = "An action repeated regularly with a longer explanation. ".repeat(8);
  const rich = { ...entry, meanings: [{ partOfSpeech: "noun", definitions: [{ definition: full }, { definition: "A customary practice." }] }, { partOfSpeech: "verb", definitions: [{ definition: "To become accustomed to something." }] }] };
  app.response(200, { query: "habit", entry: rich }); await app.settle();
  const primary = app.element((node) => node.props?.className === "reader-dictionary-meanings reader-dictionary-primary");
  assert.ok(text(primary).length < 190);
  assert.ok(!text(primary).includes("customary"));
  const details = app.element((node) => node.type === "details");
  assert.ok(!details.props.open, "native details starts collapsed");
  assert.equal(text(app.element((node) => node.type === "summary")), "More meanings");
  assert.ok(text(details).includes(full), "the unabridged primary definition remains available");
  assert.ok(text(details).includes("A customary practice."));
  assert.ok(text(details).includes("To become accustomed to something."));
  assert.ok(app.text().indexOf("Save to Word Bank") < app.text().indexOf("More meanings"));
  assert.ok(app.text().indexOf("Set reading place") < app.text().indexOf("More meanings"));
});
