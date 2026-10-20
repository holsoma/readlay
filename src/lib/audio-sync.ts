import type { AudioChapter, AudioManifest, AudioSegment } from "./audio-types";

export type AudioPosition = { chapterIndex: number; paragraphIndex: number };

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
