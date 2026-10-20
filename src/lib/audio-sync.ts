import type { AudioChapter, AudioManifest, AudioSegment, AudioWord } from "./audio-types";

export type AudioPosition = { chapterIndex: number; paragraphIndex: number; charOffset?: number; cfi?: string };

/** Silence keeps the preceding word. Exact start boundaries select the next word. */
export function wordAtTime(words: readonly AudioWord[] | undefined, timeSeconds: number): AudioWord | null {
  if (!words?.length || !Number.isFinite(timeSeconds)) return null;
  let low = 0, high = words.length - 1, match = 0;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (words[middle].startSeconds <= timeSeconds) { match = middle; low = middle + 1; }
    else high = middle - 1;
  }
  return words[match];
}

export function wordForPosition(chapter: AudioChapter | undefined, position: AudioPosition): AudioWord | null {
  if (!chapter?.words?.length || chapter.chapterIndex !== position.chapterIndex || !Number.isSafeInteger(position.paragraphIndex) || position.paragraphIndex < 0) return null;
  const offset = position.charOffset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) return null;
  let low = 0, high = chapter.words.length - 1;
  // First word whose end lies after the requested offset in this paragraph.
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const word = chapter.words[middle];
    if (word.paragraphIndex < position.paragraphIndex || (word.paragraphIndex === position.paragraphIndex && word.charEnd <= offset)) low = middle + 1;
    else high = middle - 1;
  }
  const next = chapter.words[low];
  if (next?.paragraphIndex === position.paragraphIndex) return next;
  const previous = chapter.words[low - 1];
  return previous?.paragraphIndex === position.paragraphIndex ? previous : null;
}

export function positionAtTime(chapter: AudioChapter, timeSeconds: number): AudioPosition | null {
  const word = wordAtTime(chapter.words, timeSeconds);
  if (word) return { chapterIndex: chapter.chapterIndex, paragraphIndex: word.paragraphIndex, charOffset: word.charStart, cfi: word.cfi };
  const segment = segmentAtTime(chapter.segments, timeSeconds);
  return segment ? { chapterIndex: chapter.chapterIndex, paragraphIndex: segment.paragraphIndex } : null;
}

export function seekTimeForPosition(manifest: AudioManifest, position: AudioPosition): number | null {
  const chapter = manifest.chapters.find((item) => item.chapterIndex === position.chapterIndex);
  return manifest.alignment === "word" ? wordForPosition(chapter, position)?.startSeconds ?? null : segmentForParagraph(chapter, position.paragraphIndex)?.startSeconds ?? null;
}

/** At a cue boundary the following paragraph wins. Pauses retain the preceding paragraph. */
export function segmentAtTime(segments: readonly AudioSegment[], timeSeconds: number): AudioSegment | null {
  if (!segments.length || !Number.isFinite(timeSeconds)) return null;
  let low = 0;
  let high = segments.length - 1;
  let match = 0;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    if (segments[middle].startSeconds <= timeSeconds) {
      match = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return segments[match];
}

export function segmentForParagraph(chapter: AudioChapter | undefined, paragraphIndex: number): AudioSegment | null {
  if (!chapter || !Number.isSafeInteger(paragraphIndex) || paragraphIndex < 0) return null;
  let low = 0;
  let high = chapter.segments.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const segment = chapter.segments[middle];
    if (segment.paragraphIndex === paragraphIndex) return segment;
    if (segment.paragraphIndex < paragraphIndex) low = middle + 1;
    else high = middle - 1;
  }
  return null;
}

export function seekTimeForParagraph(manifest: AudioManifest, position: AudioPosition): number | null {
  const chapter = manifest.chapters.find((item) => item.chapterIndex === position.chapterIndex);
  return segmentForParagraph(chapter, position.paragraphIndex)?.startSeconds ?? null;
}

/** Edition IDs and coordinates must match the text currently open in the reader. */
export function isManifestForEdition(manifest: AudioManifest, bookId: string, editionId: string, chapters: readonly { id: string; paragraphs: readonly string[] }[]): boolean {
  if (manifest.bookId !== bookId || manifest.editionId !== editionId || manifest.coverage.totalChapters !== chapters.length) return false;
  return manifest.chapters.every((audioChapter) => {
    const textChapter = chapters[audioChapter.chapterIndex];
    return !!textChapter && textChapter.id === audioChapter.chapterId && audioChapter.segments.every((segment) => segment.paragraphIndex < textChapter.paragraphs.length);
  });
}
