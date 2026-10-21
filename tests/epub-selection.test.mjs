import assert from "node:assert/strict";
import test from "node:test";
import { loadTypeScript, plain } from "./helpers/load-typescript.mjs";

const { wordSelectionAtOffsets, wordSelectionFromElement, sentenceAround, captureEpubWordSelection } = loadTypeScript("src/lib/epub-selection.ts");

test("single-word and partial selections use exact UTF-16 source positions, punctuation and canonical CFI ranges", () => {
  const text = "😀 Read ‘habit’ slowly. Another sentence.";
  const start = text.indexOf("habit");
  const selected = wordSelectionAtOffsets(text, 2, 7, start + 1, start + 3);
  assert.equal(selected.word, "habit");
  assert.equal(selected.charStart, start);
  assert.equal(selected.charEnd, start + 5);
  assert.equal(selected.sentence, "😀 Read ‘habit’ slowly.");
  assert.equal(selected.cfiStart, `epubcfi(/6/6[chapter-3]!/4/16/1:${start})`);
  assert.equal(selected.cfiRange, `epubcfi(/6/6[chapter-3]!/4/16,/1:${start},/1:${start + 5})`);
  assert.equal(wordSelectionAtOffsets(text, 2, 7, start - 1, start + 6).word, "habit");
});

test("multi-word, empty, invalid chapter and broken surrogate selections cannot become source annotations", () => {
  const text = "😀 Good habits cost 10 dollars.";
  for (const [start, end] of [[0, 1], [3, 14], [3, 3], [-1, 3], [99, 100]]) assert.equal(wordSelectionAtOffsets(text, 0, 0, start, end), null);
  assert.equal(wordSelectionAtOffsets(text, -1, 0, 3, 7), null);
  assert.equal(wordSelectionAtOffsets(text, 0, 0, 19, 21).selectedText, "10", "numeric source positions remain available independently of the dictionary");
});

test("sentence context follows sentence boundaries while retaining the source text", () => {
  const text = "First sentence. This is the unfamiliar word! Last sentence.";
  const start = text.indexOf("unfamiliar");
  assert.equal(sentenceAround(text, start, start + 10), "This is the unfamiliar word!");
});

test("DOM selection captures cross-span offsets from the owner document, and rejects foreign or multi-paragraph ranges", () => {
  const text = "Read an unfamiliar word.";
  const start = text.indexOf("unfamiliar");
  let endParagraph, foreign = false, sourceText = text;
  const passage = { dataset: { paragraph: "0" } };
  const paragraph = { get textContent() { return sourceText; }, closest: () => passage };
  endParagraph = paragraph;
  const startNode = { nodeType: 3, parentElement: { closest: () => paragraph }, prefix: 0 };
  const endNode = { nodeType: 3, parentElement: { closest: () => endParagraph }, prefix: start };
  const article = { contains: () => !foreign, ownerDocument: {
    getSelection: () => ({ isCollapsed: false, rangeCount: 1, getRangeAt: () => ({ startContainer: startNode, startOffset: start, endContainer: endNode, endOffset: 10, getBoundingClientRect: () => ({ left: 10, top: 50, right: 80, bottom: 70, width: 70, height: 20 }) }) }),
    createRange: () => { let length = 0; return { selectNodeContents() {}, setEnd(node, offset) { length = node.prefix + offset; }, toString: () => " ".repeat(length) }; },
  } };
  const selected = captureEpubWordSelection(article, [text], 1);
  assert.equal(selected.selectedText, "unfamiliar");
  assert.deepEqual(plain(selected.anchor), { left: 10, top: 50, right: 80, bottom: 70, width: 70, height: 20 });
  endParagraph = {};
  assert.equal(captureEpubWordSelection(article, [text], 1), null);
  endParagraph = paragraph; foreign = true;
  assert.equal(captureEpubWordSelection(article, [text], 1), null);
  foreign = false; sourceText = "Different edition text";
  assert.equal(captureEpubWordSelection(article, [text], 1), null);
});

test("reviewed display words share an unchanged source range while lookup and display identities remain distinct", () => {
  const source = "Choose subdecongenial today.";
  const first = wordSelectionFromElement({ dataset: { wordStart: "7", wordEnd: "21", displayKey: "7:0", lookupWord: "subtle" }, textContent: "subtle" }, source, 0, 0);
  const second = wordSelectionFromElement({ dataset: { wordStart: "7", wordEnd: "21", displayKey: "7:1", lookupWord: "congenial" }, textContent: "congenial" }, source, 0, 0);
  for (const selection of [first, second]) {
    assert.equal(selection.word, "subdecongenial");
    assert.equal(selection.selectedText, "subdecongenial");
    assert.equal(selection.sentence, source);
    assert.equal(selection.cfiRange, "epubcfi(/6/2[chapter-1]!/4/2,/1:7,/1:21)");
  }
  assert.equal(first.displayText, "subtle");
  assert.equal(first.lookupWord, "subtle");
  assert.equal(second.displayText, "congenial");
  assert.equal(second.lookupWord, "congenial");
  assert.notEqual(first.displayKey, second.displayKey);
});

test("rendered word validation rejects partial source ranges, incorrect display queries and malformed identities", () => {
  const source = "Choose subdecongenial today.";
  const valid = { wordStart: "7", wordEnd: "21", displayKey: "7:0", lookupWord: "subtle" };
  for (const dataset of [{ ...valid, wordStart: "8" }, { ...valid, wordEnd: "20" }, { ...valid, wordStart: "" }, { ...valid, displayKey: "7:bogus" }, { ...valid, displayKey: "8:0" }, { ...valid, lookupWord: "congenial" }, { ...valid, lookupWord: "two words" }]) {
    assert.equal(wordSelectionFromElement({ dataset, textContent: "subtle" }, source, 0, 0), null);
  }
  assert.equal(wordSelectionFromElement({ dataset: { wordStart: "7", wordEnd: "21", displayKey: "7:0" }, textContent: "subtle" }, source, 0, 0), null);
  assert.equal(wordSelectionFromElement({ dataset: valid, textContent: "subtle congenial" }, source, 0, 0), null);
  assert.equal(wordSelectionFromElement({ dataset: { wordStart: "22", wordEnd: "27", displayKey: "22:0" }, textContent: "today" }, source, 0, 0).word, "today");
});

test("native corrected selection maps display offsets to canonical words and rejects two displayed words sharing one range", () => {
  const source = "Choose subdecongenial today.";
  const display = "Choose subtle, congenial today.";
  const passage = { dataset: { paragraph: "0" } };
  const renderedWords = [
    { prefix: 0, dataset: { wordStart: "0", wordEnd: "6", displayKey: "0:0" }, textContent: "Choose" },
    { prefix: 7, dataset: { wordStart: "7", wordEnd: "21", displayKey: "7:0", lookupWord: "subtle" }, textContent: "subtle" },
    { prefix: 15, dataset: { wordStart: "7", wordEnd: "21", displayKey: "7:1", lookupWord: "congenial" }, textContent: "congenial" },
    { prefix: 25, dataset: { wordStart: "22", wordEnd: "27", displayKey: "22:0" }, textContent: "today" },
  ];
  const paragraph = { textContent: display, closest: () => passage, querySelectorAll: () => renderedWords };
  const node = { nodeType: 3, prefix: 0, parentElement: { closest: () => paragraph } };
  let start = 15, end = 24;
  const article = { contains: () => true, ownerDocument: {
    getSelection: () => ({ isCollapsed: false, rangeCount: 1, getRangeAt: () => ({ startContainer: node, startOffset: start, endContainer: node, endOffset: end, intersectsNode: () => true, getBoundingClientRect: () => ({ left: 10, top: 50, right: 80, bottom: 70, width: 70, height: 20 }) }) }),
    createRange: () => { let length = 0; return { selectNodeContents() {}, setEnd(target, offset) { length = target.prefix + offset; }, toString: () => " ".repeat(length) }; },
  } };
  const selected = captureEpubWordSelection(article, [source], 0);
  assert.equal(selected.lookupWord, "congenial");
  assert.equal(selected.charStart, 7);
  assert.equal(selected.charEnd, 21);
  start = 7; end = 24;
  assert.equal(captureEpubWordSelection(article, [source], 0), null, "two displayed words never collapse into one canonical-token lookup");
  start = 25; end = 30;
  const later = captureEpubWordSelection(article, [source], 0);
  assert.equal(later.word, "today");
  assert.equal(later.charStart, 22, "earlier display insertions do not shift later source positions");
  start = 13; end = 15;
  assert.equal(captureEpubWordSelection(article, [source], 0), null, "punctuation between display words has no independent source word");
});
