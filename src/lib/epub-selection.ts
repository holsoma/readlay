import { cfiForPosition, cfiForRange, isTextBoundary, wordsInText } from "./epub-location";
import { normaliseDictionaryWord } from "./dictionary-word";

export type SelectionAnchor = { left: number; top: number; right: number; bottom: number; width: number; height: number };
export type EpubWordSelection = {
  word: string; selectedText: string; chapterIndex: number; paragraphIndex: number;
  charStart: number; charEnd: number; cfiStart: string; cfiEnd: string; cfiRange: string; sentence: string;
};
export type AnchoredWordSelection = EpubWordSelection & { anchor: SelectionAnchor; keyboard?: boolean };

export function sentenceAround(text: string, start: number, end: number): string {
  if (typeof Intl.Segmenter === "function") {
    for (const part of new Intl.Segmenter("en", { granularity: "sentence" }).segment(text)) {
      if (part.index <= start && part.index + part.segment.length >= end) return part.segment.trim();
    }
  }
  const before = text.slice(0, start).search(/[^.!?]*$/);
  const remaining = text.slice(end).search(/[.!?](?:\s|$)/);
  return text.slice(before, remaining < 0 ? text.length : end + remaining + 1).trim();
}

/** Expand a partial native selection to its source word, rejecting multiple words. */
export function wordSelectionAtOffsets(text: string, chapterIndex: number, paragraphIndex: number, start: number, end: number): EpubWordSelection | null {
  if (![chapterIndex, paragraphIndex].every((value) => Number.isSafeInteger(value) && value >= 0) || !isTextBoundary(text, start) || !isTextBoundary(text, end) || end <= start) return null;
  const matches = wordsInText(text).filter((word) => word.charEnd > start && word.charStart < end);
  if (matches.length !== 1) return null;
  const selected = matches[0];
  // Reading positions include numbers and mixed tokens. Dictionary eligibility
  // is checked separately before a request, so these locations remain usable.
  const word = normaliseDictionaryWord(selected.text) ?? selected.text.normalize("NFC").toLocaleLowerCase("en");
  return { word, selectedText: selected.text, chapterIndex, paragraphIndex, charStart: selected.charStart, charEnd: selected.charEnd,
    cfiStart: cfiForPosition(chapterIndex, paragraphIndex, selected.charStart), cfiEnd: cfiForPosition(chapterIndex, paragraphIndex, selected.charEnd),
    cfiRange: cfiForRange(chapterIndex, paragraphIndex, selected.charStart, selected.charEnd), sentence: sentenceAround(text, selected.charStart, selected.charEnd) };
}

/** The owner document also makes this adapter safe for a future iframe reader. */
export function captureEpubWordSelection(article: HTMLElement, paragraphs: string[], chapterIndex: number): AnchoredWordSelection | null {
  const doc = article.ownerDocument;
  const selection = doc.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount !== 1) return null;
  try {
    const range = selection.getRangeAt(0);
    const parent = (node: Node) => node.nodeType === 1 ? node as Element : node.parentElement;
    const startParagraph = parent(range.startContainer)?.closest<HTMLParagraphElement>(".reader-passage p");
    const endParagraph = parent(range.endContainer)?.closest<HTMLParagraphElement>(".reader-passage p");
    if (!startParagraph || startParagraph !== endParagraph || !article.contains(startParagraph)) return null;
    const passage = startParagraph.closest<HTMLElement>("[data-paragraph]");
    const paragraphIndex = Number(passage?.dataset.paragraph);
    const text = paragraphs[paragraphIndex];
    if (!Number.isInteger(paragraphIndex) || typeof text !== "string" || startParagraph.textContent !== text) return null;
    const prefix = doc.createRange();
    prefix.selectNodeContents(startParagraph);
    prefix.setEnd(range.startContainer, range.startOffset);
    const start = prefix.toString().length;
    prefix.setEnd(range.endContainer, range.endOffset);
    const end = prefix.toString().length;
    const result = wordSelectionAtOffsets(text, chapterIndex, paragraphIndex, start, end);
    if (!result) return null;
    const rect = range.getBoundingClientRect();
    return { ...result, anchor: { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height } };
  } catch { return null; }
}
