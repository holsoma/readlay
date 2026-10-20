/** Locations refer to the canonical EPUB exported from Readlay's cleaned edition.
 * They deliberately do not claim to address the unmodified publisher EPUB. */
export type EpubTextPosition = { chapterIndex: number; paragraphIndex: number; charOffset: number };
const coordinate = (value: number) => Number.isSafeInteger(value) && value >= 0;

export function cfiForPosition(chapterIndex: number, paragraphIndex: number, charOffset: number): string {
  if (![chapterIndex, paragraphIndex, charOffset].every(coordinate)) throw new RangeError("Invalid EPUB text position.");
  return `epubcfi(/6/${2 * (chapterIndex + 1)}[chapter-${chapterIndex + 1}]!/4/${2 * (paragraphIndex + 1)}/1:${charOffset})`;
}

export function parseEpubCfi(value: unknown): EpubTextPosition | null {
  if (typeof value !== "string" || value.length > 200) return null;
  const match = /^epubcfi\(\/6\/(\d+)\[chapter-(\d+)\]!\/4\/(\d+)\/1:(\d+)\)$/.exec(value);
  if (!match) return null;
  const spine = Number(match[1]);
  const chapter = Number(match[2]);
  const paragraph = Number(match[3]);
  const charOffset = Number(match[4]);
  if (![spine, chapter, paragraph, charOffset].every(coordinate) || spine < 2 || spine % 2 || paragraph < 2 || paragraph % 2 || chapter !== spine / 2) return null;
  const position = { chapterIndex: chapter - 1, paragraphIndex: paragraph / 2 - 1, charOffset };
  return cfiForPosition(position.chapterIndex, position.paragraphIndex, charOffset) === value ? position : null;
}

export function isTextBoundary(text: string, offset: number): boolean {
  if (!coordinate(offset) || offset > text.length) return false;
  if (offset === 0 || offset === text.length) return true;
  const previous = text.charCodeAt(offset - 1);
  const next = text.charCodeAt(offset);
  return !(previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff);
}

export function wordsInText(text: string): { text: string; charStart: number; charEnd: number }[] {
  return Array.from(text.matchAll(/(?:\p{N}+(?:[,.]\p{N}+)+|[\p{L}\p{N}]+(?:['’\-‐‑][\p{L}\p{N}]+)*)/gu), (match) => ({
    text: match[0], charStart: match.index!, charEnd: match.index! + match[0].length,
  }));
}
