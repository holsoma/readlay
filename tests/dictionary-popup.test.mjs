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
function harness({ signedIn = true, saved = [], save = async () => ({}), anchor = { left: 360, right: 380, top: 790, bottom: 815, width: 20, height: 25 }, popupHeight = 330, popupScrollHeight = popupHeight - 2, word = "habit", bookId = "book", editionId = "edition", sourcePosition = {}, dockRect = null } = {}) {
  let cursor = 0, dirty = true, tree, mounted = true;
  const slots = [], effects = [], requests = [], notices = [], positions = [], listeners = new Map(), frames = [], observers = [];
  let closed = 0, auth = 0, positionsUsed = 0;
  const unchanged = (old, deps) => old && deps && deps.length === old.deps?.length && deps.every((item, index) => Object.is(item, old.deps[index]));
  const react = {
    useState(initial) { const i = cursor++; slots[i] ??= { value: typeof initial === "function" ? initial() : initial }; return [slots[i].value, (value) => { const next = typeof value === "function" ? value(slots[i].value) : value; if (!Object.is(next, slots[i].value)) { slots[i].value = next; dirty = true; } }]; },
    useRef(initial) { const i = cursor++; slots[i] ??= { current: initial }; return slots[i]; },
    useCallback(fn, deps) { const i = cursor++; if (!unchanged(slots[i], deps)) slots[i] = { value: fn, deps }; return slots[i].value; },
    useEffect(fn, deps) { const i = cursor++; if (!unchanged(slots[i], deps)) { const cleanup = slots[i]?.cleanup; slots[i] = { deps }; effects.push(() => { cleanup?.(); slots[i].cleanup = fn(); }); } },
  };
  const selection = { word, selectedText: word, chapterIndex: 0, paragraphIndex: 2, charStart: 12, charEnd: 12 + word.length, ...sourcePosition, anchor };
  const props = { selection, bookId, editionId, getAnchor: () => selection.anchor, onClose: () => closed++, onUsePosition: () => positionsUsed++ };
  const Popup = loadTypeScript("src/components/DictionaryPopup.tsx", {
    stubs: { react, "next/link": "link", "react/jsx-runtime": { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }) }, "lucide-react": { BookOpen: "icon", Check: "icon", Plus: "icon", X: "icon" }, "./WordBankProvider": { useWordBank: () => ({ words: saved, ready: true, isSignedIn: signedIn, saveWord: save }) }, "./ReadlayProvider": { useReadlay: () => ({ openAuth: () => auth++, notify: (message) => notices.push(message) }) }, "./PronunciationButton": { PronunciationButton: "pronunciation" }, "@/lib/dictionary-client": { lookupDictionaryInBrowser: (word, signal) => new Promise((resolve, reject) => requests.push({ word, options: { signal }, resolve, reject })) } },
    globals: { Error, ResizeObserver: class { constructor(callback) { this.callback = callback; this.targets = []; observers.push(this); } observe(target) { this.targets.push(target); } disconnect() { this.disconnected = true; } }, fetch: (url, options) => new Promise((resolve, reject) => requests.push({ url, options, resolve, reject })), window: { innerWidth: 390, innerHeight: 844, requestAnimationFrame: (fn) => { frames.push(fn); return frames.length; }, cancelAnimationFrame() {}, addEventListener() {}, removeEventListener() {} }, document: { addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name) => listeners.delete(name) } },
  }).default;
  const dock = { getBoundingClientRect: () => dockRect };
  const element = { contains: (target) => target?.inside, closest: () => dockRect ? { querySelector: () => dock } : null, getBoundingClientRect: () => ({ height: popupHeight }), get scrollHeight() { return popupScrollHeight; }, get offsetHeight() { return popupHeight; }, get clientHeight() { return popupHeight - 2; }, focus() {} };
  function render() { cursor = 0; dirty = false; tree = Popup(props); tree.props.ref.current = element; effects.splice(0).forEach((effect) => effect()); frames.splice(0).forEach((frame) => frame()); if (tree.props.style.visibility === "visible") positions.push(tree.props.style); }
  async function settle() { for (let i = 0; i < 8; i++) { if (dirty && mounted) render(); await new Promise((resolve) => setTimeout(resolve, 1)); } }
  function response(status, body) { if (status >= 200 && status < 300) requests.at(-1).resolve(body); else requests.at(-1).reject(Object.assign(new Error(body.error), { status })); }
  render();
  return { requests, response, settle, notices, positions, observers, resize(height, scrollHeight = height - 2) { popupHeight = height; popupScrollHeight = scrollHeight; observers.findLast((observer) => !observer.disconnected)?.callback(); }, resizeDock(rect) { dockRect = rect; observers.findLast((observer) => !observer.disconnected)?.callback(); }, text: () => text(tree), element: (predicate) => find(tree, predicate), button: (label) => find(tree, (node) => node.type === "button" && text(node).includes(label)), style: () => tree.props.style, closed: () => closed, auth: () => auth, positionsUsed: () => positionsUsed, dismiss: (target) => listeners.get("pointerdown")?.({ target }), escape: () => listeners.get("keydown")?.({ key: "Escape", preventDefault() {} }), cleanup() { mounted = false; for (const slot of slots) slot?.cleanup?.(); } };
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
  const pronunciation = app.element((node) => node.type === "pronunciation");
  assert.equal(pronunciation.props.audioUrl, null, "the shared control can offer device pronunciation without recorded audio");
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
    assert.ok(!app.element((node) => node.type === "input"));
    assert.ok(!app.button("Change spelling"));
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

test("definitions omit the provider line and keep source and licence under collapsed Credits", async (t) => {
  const app = harness(); t.after(() => app.cleanup());
  const attributed = { ...entry, providerName: "FreeDictionaryAPI.com", providerUrl: "https://freedictionaryapi.com/", sourceUrl: "https://en.wiktionary.org/wiki/habit", licence: { name: "CC BY-SA 4.0", url: "https://creativecommons.org/licenses/by-sa/4.0/" } };
  app.response(200, { query: "habit", entry: attributed }); await app.settle();
  assert.ok(!app.element((node) => node.props?.className === "reader-dictionary-provider"));
  assert.ok(!app.text().includes("FreeDictionaryAPI.com"));
  assert.ok(!app.text().includes("Definitions:"));
  const credits = app.element((node) => node.props?.className === "reader-dictionary-credits");
  assert.equal(credits.type, "details");
  assert.ok(!credits.props.open);
  assert.ok(text(credits).startsWith("Credits"));
  assert.equal(app.element((node) => node.type === "a" && text(node) === "Dictionary source").props.href, attributed.sourceUrl);
  assert.equal(app.element((node) => node.type === "a" && text(node) === "CC BY-SA 4.0").props.href, attributed.licence.url);
});

test("pronunciation displays readable stress-marked spelling without exposing IPA or changing the saved entry", async (t) => {
  const app = harness(); t.after(() => app.cleanup());
  app.response(200, { query: "habit", entry }); await app.settle();
  const pronunciation = app.element((node) => node.props?.className === "reader-dictionary-phonetic");
  assert.equal(text(pronunciation), "HAB-it");
  assert.equal(pronunciation.props["aria-label"], "Approximate pronunciation: HAB-it");
  assert.ok(!app.text().includes(entry.phonetic));
  assert.equal(entry.phonetic, "/ˈhæbɪt/");
});

test("child pronunciation height changes reposition the popup and observers disconnect on unmount", async () => {
  const anchor = { left: 100, right: 160, top: 500, bottom: 525, width: 60, height: 25 };
  const app = harness({ anchor, popupHeight: 120 }); await app.settle();
  assert.ok(app.style().top > anchor.bottom);
  app.resize(400); await app.settle();
  assert.ok(app.style().top + Math.min(400, app.style().maxHeight) <= anchor.top - 9 || app.style().top >= anchor.bottom + 9);
  assert.ok(app.style().top >= 12);
  app.cleanup();
  assert.ok(app.observers.every((observer) => observer.disconnected));
});

test("content that grows beyond an earlier loading height cap moves above the word without oscillating", async (t) => {
  const anchor = { left: 50, right: 120, top: 570, bottom: 590, width: 70, height: 20 };
  const app = harness({ anchor, popupHeight: 120 }); t.after(() => app.cleanup()); await app.settle();
  assert.equal(app.style().top, 600);
  assert.equal(app.style().maxHeight, 232);
  // The visible box is still capped below, while its full content needs 430px.
  app.resize(232, 428); await app.settle();
  assert.equal(app.style().top, 130);
  assert.equal(app.style().maxHeight, 460);
  const above = { ...app.style() };
  // ResizeObserver fires again after the new space allows the complete box.
  app.resize(430, 428); await app.settle();
  assert.deepEqual({ ...app.style() }, above);
  app.resize(430, 428); await app.settle();
  assert.deepEqual({ ...app.style() }, above, "repeated measurements keep the same placement");
});

test("missing definitions offer explicit spelling recovery and save the corrected entry against the original source range", async (t) => {
  const inputs = [];
  const sourcePosition = { chapterIndex: 0, paragraphIndex: 0, charStart: 326, charEnd: 340, cfiRange: "epubcfi(/6/2[chapter-1]!/4/2,/1:326,/1:340)" };
  const app = harness({ word: "subdecongenial", bookId: "laws-of-power", editionId: "e43027f07c709097", sourcePosition, save: async (input) => { inputs.push(input); return {}; } }); t.after(() => app.cleanup());
  app.response(404, { error: "No definition was found." }); await app.settle();
  assert.ok(app.text().includes("This edition appears to contain a text error."));
  assert.equal(app.requests.length, 1, "suggestions do not trigger automatic lookups");
  app.button("Look up subtle").props.onClick(); await app.settle();
  assert.equal(app.requests[1].word, "subtle");
  assert.ok(!app.button("Save to Word Bank"), "loading never exposes a stale save action");
  const subtle = { ...entry, word: "subtle", meanings: [{ partOfSpeech: "adjective", definitions: [{ definition: "Not immediately obvious." }] }] };
  app.response(200, { query: "subtle", entry: subtle }); await app.settle();
  assert.equal(text(app.element((node) => node.type === "h2")), "subtle");
  assert.ok(app.text().includes("Selected text: subdecongenial"));
  app.button("Save to Word Bank").props.onClick(); await app.settle();
  assert.deepEqual(JSON.parse(JSON.stringify(inputs[0])), { word: "subdecongenial", lookupWord: "subtle", bookId: "laws-of-power", editionId: "e43027f07c709097", chapterIndex: 0, paragraphIndex: 0, charStart: 326, charEnd: 340, entry: subtle });
  app.button("Set reading place").props.onClick();
  assert.equal(app.positionsUsed(), 1, "the original source-position callback is unchanged");
});

test("manual spelling lookup validates one word and sends no requests while typing", async (t) => {
  const app = harness({ word: "notawordhere" }); t.after(() => app.cleanup());
  app.response(404, { error: "No definition was found." }); await app.settle();
  assert.ok(app.text().includes("Look up a corrected spelling"));
  const input = () => app.element((node) => node.type === "input");
  input().props.onChange({ target: { value: "two words" } }); await app.settle();
  assert.equal(app.requests.length, 1);
  app.element((node) => node.type === "form").props.onSubmit({ preventDefault() {} }); await app.settle();
  assert.ok(app.text().includes("Enter one English word."));
  assert.equal(app.requests.length, 1);
  input().props.onChange({ target: { value: " CONGENIAL! " } }); await app.settle();
  assert.equal(app.requests.length, 1);
  app.element((node) => node.type === "form").props.onSubmit({ preventDefault() {} }); await app.settle();
  assert.equal(app.requests[1].word, "congenial");
});

test("changing spelling cancels a pending lookup and a late response cannot replace the current definition", async (t) => {
  const app = harness(); t.after(() => app.cleanup());
  const original = app.requests[0];
  app.button("Change spelling").props.onClick(); await app.settle();
  app.element((node) => node.type === "input").props.onChange({ target: { value: "congenial" } }); await app.settle();
  app.element((node) => node.type === "form").props.onSubmit({ preventDefault() {} }); await app.settle();
  assert.equal(original.options.signal.aborted, true);
  const corrected = { ...entry, word: "congenial", meanings: [{ partOfSpeech: "adjective", definitions: [{ definition: "Pleasant and agreeable." }] }] };
  app.response(200, { query: "congenial", entry: corrected }); await app.settle();
  original.resolve({ query: "habit", entry }); await app.settle();
  assert.ok(app.text().includes("Pleasant and agreeable."));
  assert.ok(!app.text().includes("An action repeated regularly."));
  assert.equal(text(app.element((node) => node.type === "h2")), "congenial");
});

test("curated source-error suggestions are edition-scoped and generic missing words retain manual recovery", async (t) => {
  for (const [bookId, editionId] of [["book", "e43027f07c709097"], ["laws-of-power", "different-edition"]]) {
    const app = harness({ word: "subdecongenial", bookId, editionId }); t.after(() => app.cleanup());
    app.response(404, { error: "No definition was found." }); await app.settle();
    assert.ok(!app.button("Look up subtle"));
    assert.ok(!app.button("Look up congenial"));
    assert.ok(app.text().includes("Look up a corrected spelling"));
    assert.equal(app.requests.length, 1);
  }
});

test("a reviewed corrected display word looks up its visible spelling and saves the immutable source word and range", async (t) => {
  const inputs = [];
  const sourcePosition = { chapterIndex: 0, paragraphIndex: 0, charStart: 326, charEnd: 340, displayText: "congenial", lookupWord: "congenial", displayKey: "326:1" };
  const app = harness({ word: "subdecongenial", sourcePosition, save: async (input) => { inputs.push(input); return {}; } }); t.after(() => app.cleanup());
  assert.equal(app.requests[0].word, "congenial");
  const congenial = { ...entry, word: "congenial", meanings: [{ partOfSpeech: "adjective", definitions: [{ definition: "Pleasant and agreeable." }] }] };
  app.response(200, { query: "congenial", entry: congenial }); await app.settle();
  assert.equal(text(app.element((node) => node.type === "h2")), "congenial");
  assert.ok(app.text().includes("Selected text: subdecongenial"));
  app.button("Save to Word Bank").props.onClick(); await app.settle();
  assert.deepEqual(JSON.parse(JSON.stringify(inputs[0])), { word: "subdecongenial", lookupWord: "congenial", bookId: "book", editionId: "edition", chapterIndex: 0, paragraphIndex: 0, charStart: 326, charEnd: 340, entry: congenial });
  app.button("Set reading place").props.onClick();
  assert.equal(app.positionsUsed(), 1);
});

test("the dictionary stays above the fixed audio dock and observes dock size changes", async (t) => {
  const anchor = { left: 50, right: 120, top: 450, bottom: 475, width: 70, height: 25 };
  const app = harness({ anchor, popupHeight: 330, dockRect: { top: 640, bottom: 840, height: 200, width: 390 } }); t.after(() => app.cleanup()); await app.settle();
  const bottom = () => app.style().top + Math.min(330, app.style().maxHeight);
  assert.ok(bottom() <= 632);
  assert.ok(bottom() <= anchor.top - 9 || app.style().top >= anchor.bottom + 9);
  assert.equal(app.observers.findLast((observer) => !observer.disconnected).targets.length, 2, "the box and dock are both observed");
  app.resizeDock({ top: 400, bottom: 840, height: 440, width: 390 }); await app.settle();
  assert.ok(bottom() <= 392);
});
