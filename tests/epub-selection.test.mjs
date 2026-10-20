import assert from "node:assert/strict";
import test from "node:test";
import { loadTypeScript, plain } from "./helpers/load-typescript.mjs";

const { wordSelectionAtOffsets, sentenceAround, captureEpubWordSelection } = loadTypeScript("src/lib/epub-selection.ts");

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
