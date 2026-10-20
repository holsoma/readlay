import assert from "node:assert/strict";
import test from "node:test";
import { loadTypeScript } from "./helpers/load-typescript.mjs";

const locations = loadTypeScript("src/lib/epub-location.ts");
const chapters = [{ id: "one", title: "One", paragraphs: ["Start halfway through this paragraph. In 1930s, count 1,000.", "Read another sentence."] }];
const book = { id: "book", title: "Book", author: "Author", format: "EPUB" };
function find(tree, predicate) {
  if (Array.isArray(tree)) return tree.map((item) => find(item, predicate)).find(Boolean);
  if (!tree || typeof tree !== "object") return null;
  if (predicate(tree)) return tree;
  return find(tree.props?.children, predicate);
}
function readerHarness(progress = null, { search = "", vocabulary = [] } = {}) {
  let cursor = 0, dirty = true, tree, selection = null;
  const slots = [], effects = [], saves = [], scrolled = [], focused = [];
  const deferred = new Map(), listeners = new Map();
  const unchanged = (old, deps) => old && deps && deps.length === old.deps?.length && deps.every((item, index) => Object.is(item, old.deps[index]));
  const react = {
    memo: (fn) => fn,
    useState(initial) { const i = cursor++; slots[i] ??= { value: typeof initial === "function" ? initial() : initial }; return [slots[i].value, (value) => { const next = typeof value === "function" ? value(slots[i].value) : value; if (!Object.is(next, slots[i].value)) { slots[i].value = next; dirty = true; } }]; },
    useRef(initial) { const i = cursor++; slots[i] ??= { current: initial }; return slots[i]; },
    useCallback(fn, deps) { const i = cursor++; if (!unchanged(slots[i], deps)) slots[i] = { value: fn, deps }; return slots[i].value; },
    useMemo(fn, deps) { const i = cursor++; if (!unchanged(slots[i], deps)) slots[i] = { value: fn(), deps }; return slots[i].value; },
    useEffect(fn, deps) { const i = cursor++; if (!unchanged(slots[i], deps)) { const cleanup = slots[i]?.cleanup; slots[i] = { deps }; effects.push(() => { cleanup?.(); slots[i].cleanup = fn(); }); } },
  };
  const paragraphElements = chapters[0].paragraphs.map((text, index) => {
    const p = { contains: () => true, textContent: text };
    const passage = { dataset: { paragraph: String(index) }, p, querySelector: (selector) => selector === "p" ? p : { scrollIntoView: () => scrolled.push({ paragraph: index, selector }), focus: () => focused.push({ paragraph: index, selector }) }, scrollIntoView: () => scrolled.push({ paragraph: index }) };
    p.closest = () => passage;
    return passage;
  });
  const article = { contains: () => true, querySelector: (selector) => { const passage = paragraphElements[Number(/data-paragraph="(\d+)"/.exec(selector)[1])]; return selector.includes("data-word-start") ? passage.querySelector(selector) : passage; } };
  const document = {
    visibilityState: "visible", activeElement: null, getSelection: () => selection,
    addEventListener: (name, fn) => listeners.set(name, fn), removeEventListener: (name) => listeners.delete(name),
    createRange: () => { let end; return { selectNodeContents() {}, setEnd(node, offset) { end = node.prefix + offset; }, toString: () => " ".repeat(end) }; },
  };
  article.ownerDocument = document;
  const context = { ready: true, bookmarks: [], isSignedIn: true, syncStatus: "synced", getProgress: () => progress, saveProgress: (...args) => saves.push(args), toggleBookmark() {}, openAuth() {}, notify() {} };
  const Reader = loadTypeScript("src/components/Reader.tsx", {
    extra: "\nexports.ReaderContentForTest = ReaderContent;",
    stubs: { react, "next/link": "link", "react/jsx-runtime": { jsx: (type, props) => ({ type, props }), jsxs: (type, props) => ({ type, props }), Fragment: "fragment" }, "lucide-react": Object.fromEntries(["ArrowLeft", "ArrowRight", "BookOpen", "Bookmark", "BookmarkCheck", "Check", "ChevronLeft", "List", "Minus", "Plus", "Type", "X"].map((icon) => [icon, "icon"])), "./ReadlayProvider": { useReadlay: () => context }, "./WordBankProvider": { useWordBank: () => ({ words: vocabulary }) }, "./DictionaryPopup": "dictionary", "./AudiobookPlayer": "player", "@/lib/epub-location": locations, "./reader.css": {} },
    globals: {
      window: { setTimeout, clearTimeout, location: { search }, getSelection: () => selection, addEventListener() {}, removeEventListener() {}, scrollTo() {} }, document, Node: { ELEMENT_NODE: 1 }, localStorage: { getItem: () => null, setItem() {} }, URLSearchParams,
      setTimeout: (fn, delay) => { const id = Symbol(); deferred.set(id, { fn, delay }); return id; }, clearTimeout: (id) => deferred.delete(id),
    },
  }).ReaderContentForTest;
  function render() {
    cursor = 0; dirty = false; tree = Reader({ book, chapters, editionId: "edition" });
    const articleNode = find(tree, (node) => node.type === "article");
    if (articleNode) articleNode.props.ref.current = article;
    effects.splice(0).forEach((effect) => effect());
  }
  async function settle() { for (let i = 0; i < 8; i++) { if (dirty) render(); await new Promise((resolve) => setTimeout(resolve, 1)); } if (dirty) render(); }
  const app = {
    saves, scrolled, focused, deferred, settle,
    updateProgress(next, syncStatus = "synced") { progress = next; context.syncStatus = syncStatus; dirty = true; },
    player: () => find(tree, (node) => node.type === "player").props,
    paragraph: (index) => { const node = find(tree, (item) => typeof item.type === "function" && item.type.name === "WordParagraph" && item.props.index === index); return node.type(node.props).props; },
    dictionary: () => find(tree, (node) => node.type === "dictionary")?.props,
    tapWord(index, offset) { const word = locations.wordsInText(chapters[0].paragraphs[index]).find((item) => item.charStart === offset); app.paragraph(index).onClick({ target: { closest: () => ({ dataset: { wordStart: String(offset), wordEnd: String(word.charEnd) }, getBoundingClientRect: () => ({ left: 50, top: 200, right: 120, bottom: 225, width: 70, height: 25 }) }) } }); },
    placeWord(index, offset) { app.tapWord(index, offset); if (dirty) render(); app.dictionary().onUsePosition(); },
    selectRange(index, prefix, offset) {
      const passage = paragraphElements[index];
      const node = { nodeType: 3, prefix, parentElement: { closest: (selector) => selector === ".reader-passage p" ? passage.p : passage } };
      selection = { isCollapsed: false, rangeCount: 1, anchorNode: node, focusNode: node, focusOffset: offset, getRangeAt: () => ({ startContainer: node, startOffset: 0, endContainer: node, endOffset: offset, getBoundingClientRect: () => ({ left: 50, top: 200, right: 120, bottom: 225, width: 70, height: 25 }) }), removeAllRanges() { selection = null; } };
    },
    selectionChanged() { listeners.get("selectionchange")?.(); },
    hide() { document.visibilityState = "hidden"; listeners.get("visibilitychange")(); },
    flushTimers(delay) { for (const [id, item] of deferred) { if (delay !== undefined && item.delay !== delay) continue; deferred.delete(id); item.fn(); } },
    cleanup() { for (const slot of slots) slot?.cleanup?.(); },
  };
  render(); return app;
}

test("setting a place from the word popup preserves the UTF-16 offset and shares it with Listen", async (t) => {
  const app = readerHarness(); t.after(() => app.cleanup()); await app.settle();
  const word = locations.wordsInText(chapters[0].paragraphs[0])[3];
  app.placeWord(0, word.charStart); await app.settle();
  assert.equal(app.player().location.charOffset, word.charStart);
  assert.equal(app.player().location.cfi, locations.cfiForPosition(0, 0, word.charStart));
  assert.deepEqual(app.saves.at(-1), [0, 0, "book", "edition", word.charStart]);
});

test("a selection spanning text nodes survives the Listen toolbar action", async (t) => {
  const app = readerHarness(); t.after(() => app.cleanup()); await app.settle();
  const word = locations.wordsInText(chapters[0].paragraphs[0])[3];
  app.selectRange(0, word.charStart - 1, 2);
  const position = app.player().getReadingPosition(); await app.settle();
  assert.equal(position.charOffset, word.charStart);
  assert.equal(app.player().location.charOffset, word.charStart);
});

test("selecting a complete word resumes at that word rather than the following word", async (t) => {
  const app = readerHarness(); t.after(() => app.cleanup()); await app.settle();
  const word = locations.wordsInText(chapters[0].paragraphs[0])[2];
  app.selectRange(0, word.charStart, word.charEnd - word.charStart);
  assert.equal(app.player().getReadingPosition().charOffset, word.charStart);
});

test("returning from audio focuses and scrolls the exact narrated word", async (t) => {
  const app = readerHarness(); t.after(() => app.cleanup()); await app.settle();
  const word = locations.wordsInText(chapters[0].paragraphs[1])[2];
  app.player().onModeChange("listening"); await app.settle();
  app.player().onReturnToReading({ chapterIndex: 0, paragraphIndex: 1, charOffset: word.charStart, cfi: locations.cfiForPosition(0, 1, word.charStart) }); await app.settle();
  assert.equal(app.player().location.charOffset, word.charStart);
  assert.ok(app.scrolled.some((item) => item.paragraph === 1 && item.selector === `[data-word-start="${word.charStart}"]`));
  assert.ok(app.focused.some((item) => item.paragraph === 1));
});

test("audio word changes are batched for persistence and visibility flushes the latest word", async (t) => {
  const app = readerHarness(); t.after(() => app.cleanup()); await app.settle();
  const words = locations.wordsInText(chapters[0].paragraphs[0]);
  for (const word of words.slice(1, 4)) { app.player().onPositionChange({ chapterIndex: 0, paragraphIndex: 0, charOffset: word.charStart }, false); await app.settle(); }
  assert.equal(app.saves.length, 0);
  assert.equal(app.deferred.size, 1, "rapid word changes share one persistence timer");
  app.hide();
  assert.deepEqual(app.saves.at(-1), [0, 0, "book", "edition", words[3].charStart]);
  assert.equal(app.deferred.size, 0);
});

test("arrow keys choose words and saved word progress is restored", async (t) => {
  const words = locations.wordsInText(chapters[0].paragraphs[0]);
  const app = readerHarness({ chapterIndex: 0, paragraphIndex: 0, charOffset: words[2].charStart }); t.after(() => app.cleanup()); await app.settle();
  assert.equal(app.player().location.charOffset, words[2].charStart);
  let prevented = false;
  app.paragraph(0).onKeyDown({ key: "ArrowRight", preventDefault() { prevented = true; } }); await app.settle();
  assert.equal(prevented, true);
  assert.equal(app.player().location.charOffset, words[3].charStart);
});

test("an already-open idle reader adopts fresh cloud progress and Listen uses that exact word", async (t) => {
  const words = locations.wordsInText(chapters[0].paragraphs[0]);
  const app = readerHarness({ chapterIndex: 0, paragraphIndex: 0, charOffset: words[1].charStart }); t.after(() => app.cleanup()); await app.settle();
  app.updateProgress({ chapterIndex: 0, paragraphIndex: 0, charOffset: words[4].charStart }, "syncing"); await app.settle();
  assert.equal(app.player().location.charOffset, words[1].charStart, "a pull is not authoritative until synchronisation completes");
  app.updateProgress({ chapterIndex: 0, paragraphIndex: 0, charOffset: words[4].charStart }); await app.settle();
  assert.equal(app.player().location.charOffset, words[4].charStart);
  assert.equal(app.player().getReadingPosition().charOffset, words[4].charStart);
  assert.equal(app.saves.length, 0, "adopting a remote position does not send an older position back");
});

test("a late cloud pull cannot undo a local word click before Provider acknowledges it", async (t) => {
  const words = locations.wordsInText(chapters[0].paragraphs[0]);
  const app = readerHarness({ chapterIndex: 0, paragraphIndex: 0, charOffset: words[0].charStart }); t.after(() => app.cleanup()); await app.settle();
  app.placeWord(0, words[3].charStart); await app.settle();
  app.updateProgress({ chapterIndex: 0, paragraphIndex: 0, charOffset: words[1].charStart }); await app.settle();
  assert.equal(app.player().location.charOffset, words[3].charStart);
  app.updateProgress({ chapterIndex: 0, paragraphIndex: 0, charOffset: words[3].charStart }, "syncing"); await app.settle();
  app.updateProgress({ chapterIndex: 0, paragraphIndex: 0, charOffset: words[4].charStart }); await app.settle();
  assert.equal(app.player().location.charOffset, words[4].charStart, "fresh later progress is accepted after the local edit is acknowledged");
});

test("remote progress does not move an active audiobook or an unflushed local word", async (t) => {
  const words = locations.wordsInText(chapters[0].paragraphs[0]);
  const app = readerHarness({ chapterIndex: 0, paragraphIndex: 0, charOffset: words[0].charStart }); t.after(() => app.cleanup()); await app.settle();
  app.player().onModeChange("listening"); await app.settle();
  app.updateProgress({ chapterIndex: 0, paragraphIndex: 0, charOffset: words[4].charStart }); await app.settle();
  assert.equal(app.player().location.charOffset, words[0].charStart);
  app.player().onModeChange("reading"); await app.settle();
  assert.equal(app.player().location.charOffset, words[0].charStart, "an ignored playback-time snapshot is not applied when Read is selected");
  app.player().onPositionChange({ chapterIndex: 0, paragraphIndex: 0, charOffset: words[2].charStart }, false); await app.settle();
  app.updateProgress({ chapterIndex: 0, paragraphIndex: 1, charOffset: 0 }); await app.settle();
  assert.equal(app.player().location.charOffset, words[2].charStart);
  assert.equal(app.player().location.paragraphIndex, 0);
});

test("the initial cloud snapshot does not override an explicitly opened bookmark position", async (t) => {
  const app = readerHarness({ chapterIndex: 0, paragraphIndex: 0, charOffset: 0 }, { search: "?chapter=0&paragraph=1&offset=5" }); t.after(() => app.cleanup()); await app.settle();
  assert.equal(app.player().location.paragraphIndex, 1);
  assert.equal(app.player().location.charOffset, 5);
  app.updateProgress({ chapterIndex: 0, paragraphIndex: 0, charOffset: 0 }); await app.settle();
  assert.equal(app.player().location.paragraphIndex, 1);
  app.updateProgress({ chapterIndex: 0, paragraphIndex: 0, charOffset: 6 }); await app.settle();
  assert.equal(app.player().location.paragraphIndex, 0);
  assert.equal(app.player().location.charOffset, 6);
});

test("clicking the cloud's existing position from a bookmark does not block later remote progress", async (t) => {
  const app = readerHarness({ chapterIndex: 0, paragraphIndex: 0, charOffset: 0 }, { search: "?chapter=0&paragraph=1&offset=5" }); t.after(() => app.cleanup()); await app.settle();
  app.placeWord(0, 0); await app.settle();
  assert.equal(app.player().location.paragraphIndex, 0);
  assert.equal(app.player().location.charOffset, 0);
  // Provider deduplicates this save because its current projection is already P.
  // No Provider object update occurs before the later external snapshot R.
  app.updateProgress({ chapterIndex: 0, paragraphIndex: 0, charOffset: 6 }); await app.settle();
  assert.equal(app.player().location.charOffset, 6);
});

test("tapping then double-clicking a word never automatically changes reading or audio progress", async (t) => {
  const words = locations.wordsInText(chapters[0].paragraphs[0]);
  const app = readerHarness({ chapterIndex: 0, paragraphIndex: 0, charOffset: words[0].charStart }); t.after(() => app.cleanup()); await app.settle();
  app.tapWord(0, words[3].charStart); await app.settle();
  assert.equal(app.saves.length, 0);
  app.selectRange(0, words[3].charStart, words[3].charEnd - words[3].charStart);
  app.paragraph(0).onDoubleClick(); await app.settle();
  const lookup = app.dictionary();
  assert.equal(lookup.selection.word, words[3].text.toLowerCase());
  assert.equal(lookup.selection.cfiRange, locations.cfiForRange(0, 0, words[3].charStart, words[3].charEnd));
  assert.equal(app.player().location.charOffset, words[0].charStart);
  assert.equal(app.player().seekRequest, null);
  app.flushTimers();
  assert.equal(app.saves.length, 0);
});

test("mobile selectionchange opens a dictionary without waiting for pointerup or changing an audiobook", async (t) => {
  const words = locations.wordsInText(chapters[0].paragraphs[0]);
  const app = readerHarness({ chapterIndex: 0, paragraphIndex: 0, charOffset: words[0].charStart }); t.after(() => app.cleanup()); await app.settle();
  app.player().onModeChange("listening"); await app.settle();
  app.selectRange(0, words[2].charStart, words[2].charEnd - words[2].charStart);
  app.selectionChanged(); app.flushTimers(150); await app.settle();
  assert.equal(app.dictionary().selection.selectedText, words[2].text);
  assert.equal(app.player().mode, "listening");
  assert.equal(app.player().location.charOffset, words[0].charStart);
  assert.equal(app.player().seekRequest, null);
  app.dictionary().onClose(); await app.settle();
  assert.equal(app.dictionary(), undefined);
  assert.equal(app.player().getReadingPosition().charOffset, words[0].charStart, "a lingering dictionary selection does not become a listening seek after dismissal");
  assert.equal(app.saves.length, 0);
});

test("keyboard selection opens a focusable lookup and explicit Listen intentionally commits the selected word", async (t) => {
  const words = locations.wordsInText(chapters[0].paragraphs[0]);
  const app = readerHarness(); t.after(() => app.cleanup()); await app.settle();
  app.selectRange(0, words[1].charStart, words[1].charEnd - words[1].charStart);
  app.paragraph(0).onKeyUp({ shiftKey: true }); await app.settle();
  assert.equal(app.dictionary().selection.keyboard, true);
  assert.equal(app.saves.length, 0);
  app.dictionary().onClose(); await app.settle();
  // A collapsed native selection allows the normal tap behaviour again.
  app.player().onReturnToReading({ chapterIndex: 0, paragraphIndex: 0, charOffset: 0 }); await app.settle();
  app.saves.length = 0;
  app.tapWord(0, words[4].charStart); await app.settle();
  assert.equal(app.saves.length, 0);
  assert.equal(app.player().getReadingPosition().charOffset, words[4].charStart);
  assert.equal(app.saves.at(-1)[4], words[4].charStart);
});

test("saved vocabulary highlights only its exact source occurrence and survives font-size-independent rendering", async (t) => {
  const word = locations.wordsInText(chapters[0].paragraphs[0])[3];
  const occurrence = { bookId: "book", editionId: "edition", chapterIndex: 0, paragraphIndex: 0, charStart: word.charStart, charEnd: word.charEnd, selectedText: word.text };
  const app = readerHarness(null, { vocabulary: [{ occurrences: [occurrence, { ...occurrence, editionId: "another", charStart: 0, charEnd: 5, selectedText: "Start" }] }] }); t.after(() => app.cleanup()); await app.settle();
  const saved = find({ props: app.paragraph(0) }, (node) => node.props?.["data-word-start"] === word.charStart);
  assert.ok(saved.props.className.includes("is-saved-vocabulary"));
  const first = find({ props: app.paragraph(0) }, (node) => node.props?.["data-word-start"] === 0);
  assert.ok(!first.props.className.includes("is-saved-vocabulary"), "a different edition cannot add a highlight");
});

test("numeric and mixed source tokens keep exact reading and listening locations without changing place during lookup", async (t) => {
  const words = locations.wordsInText(chapters[0].paragraphs[0]);
  const app = readerHarness({ chapterIndex: 0, paragraphIndex: 0, charOffset: 0 }); t.after(() => app.cleanup()); await app.settle();
  for (const token of ["1930s", "1,000"]) {
    const word = words.find((item) => item.text === token);
    app.tapWord(0, word.charStart); await app.settle();
    assert.equal(app.dictionary().selection.selectedText, token);
    assert.equal(app.dictionary().selection.cfiStart, locations.cfiForPosition(0, 0, word.charStart));
    assert.equal(app.saves.length, token === "1930s" ? 0 : 1, "lookup itself does not persist another position");
    assert.equal(app.player().getReadingPosition().charOffset, word.charStart, "explicit Listen can target a non-dictionary source token");
    await app.settle();
    assert.equal(app.saves.at(-1)[4], word.charStart);
  }
});
