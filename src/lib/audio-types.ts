import { parseEpubCfi } from "./epub-location";

export type AudioNarratorSummary = { id: string; name: string; language: string };
export type AudioNarrator = AudioNarratorSummary & { engine: string; voice: string };
export type AudioSegment = { paragraphIndex: number; startSeconds: number; endSeconds: number; textHash: string };
export type AudioWord = { paragraphIndex: number; charStart: number; charEnd: number; startSeconds: number; endSeconds: number; cfi: string };
export type AudioChapterSummary = {
  chapterIndex: number; chapterId: string; title: string;
  /** Private path. The browser uses the authenticated stream route. */
  audioPath: string; durationSeconds: number; byteLength?: number;
};
export type AudioChapter = AudioChapterSummary & { segments: AudioSegment[]; words?: AudioWord[] };
type AudioHeader = {
  schemaVersion: 1 | 2; bookId: string; editionId: string; generationId: string;
  narrator: AudioNarrator; alignment: "paragraph" | "word"; sampleRate: 24000;
  format?: "mp3" | "opus"; locationScheme?: "readlay-canonical-epub-v1";
  coverage: { complete: boolean; totalChapters: number; chapterIndices: number[] };
};
export type AudioManifest = AudioHeader & { chapters: AudioChapter[] };
export type AudioManifestIndex = AudioHeader & { chapters: AudioChapterSummary[] };

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, limit = 300): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= limit;
const index = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const seconds = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const identifier = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);

function narratorSummary(value: unknown): value is AudioNarratorSummary {
  return record(value) && identifier(value.id) && text(value.name, 120) && text(value.language, 35);
}
export function parseAudioNarrators(value: unknown): AudioNarratorSummary[] | null {
  if (!record(value) || !Array.isArray(value.narrators) || value.narrators.length > 100 || !value.narrators.every(narratorSummary)) return null;
  if (new Set(value.narrators.map((item) => item.id)).size !== value.narrators.length) return null;
  return value.narrators.map(({ id, name, language }) => ({ id, name, language }));
}
function validHeader(value: unknown): value is Record<string, unknown> & AudioManifestIndex {
  if (!record(value) || value.sampleRate !== 24000) return false;
  if (value.schemaVersion === 1) { if (value.alignment !== "paragraph") return false; }
  else if (value.schemaVersion === 2) {
    if (value.alignment !== "word" || value.format !== "opus" || value.locationScheme !== "readlay-canonical-epub-v1") return false;
  } else return false;
  if (!identifier(value.bookId) || !identifier(value.editionId) || !identifier(value.generationId)) return false;
  if (!record(value.narrator) || !text(value.narrator.engine, 80) || !text(value.narrator.voice, 120) || !narratorSummary(value.narrator)) return false;
  if (!record(value.coverage) || typeof value.coverage.complete !== "boolean" || !index(value.coverage.totalChapters) || value.coverage.totalChapters < 1) return false;
  if (!Array.isArray(value.chapters) || value.chapters.length < 1 || value.chapters.length > 10000) return false;
  if (!Array.isArray(value.coverage.chapterIndices) || value.coverage.chapterIndices.length !== value.chapters.length) return false;
  if (value.coverage.complete && value.chapters.length !== value.coverage.totalChapters) return false;
  let previousChapter = -1;
  for (const [offset, chapter] of value.chapters.entries()) {
    if (!record(chapter) || !index(chapter.chapterIndex) || chapter.chapterIndex <= previousChapter || chapter.chapterIndex >= value.coverage.totalChapters) return false;
    if (value.coverage.chapterIndices[offset] !== chapter.chapterIndex || !text(chapter.chapterId, 300) || !text(chapter.title, 1000) || !text(chapter.audioPath, 2048)) return false;
    if (!seconds(chapter.durationSeconds) || chapter.durationSeconds <= 0 || (chapter.byteLength !== undefined && (!index(chapter.byteLength) || chapter.byteLength < 1))) return false;
    previousChapter = chapter.chapterIndex;
  }
  return true;
}
export function parseAudioManifestIndex(value: unknown): AudioManifestIndex | null {
  return validHeader(value) ? value as AudioManifestIndex : null;
}
export function parseAudioChapter(value: unknown, wordAligned = false): AudioChapter | null {
  if (!record(value) || !index(value.chapterIndex) || !text(value.chapterId) || !text(value.title, 1000) || !text(value.audioPath, 2048) || !seconds(value.durationSeconds) || value.durationSeconds <= 0) return null;
  if (value.byteLength !== undefined && (!index(value.byteLength) || value.byteLength < 1)) return null;
  if (!Array.isArray(value.segments) || value.segments.length < 1 || value.segments.length > 100000) return null;
  let previousParagraph = -1;
  let previousEnd = 0;
  const segments = new Map<number, AudioSegment>();
  for (const segment of value.segments) {
    if (!record(segment) || !index(segment.paragraphIndex) || segment.paragraphIndex <= previousParagraph) return null;
    if (!seconds(segment.startSeconds) || !seconds(segment.endSeconds) || segment.endSeconds <= segment.startSeconds || segment.startSeconds < previousEnd || segment.endSeconds > value.durationSeconds + 0.05) return null;
    if (typeof segment.textHash !== "string" || !/^[a-f0-9]{64}$/i.test(segment.textHash)) return null;
    previousParagraph = segment.paragraphIndex;
    previousEnd = segment.endSeconds;
    segments.set(segment.paragraphIndex, segment as AudioSegment);
  }
  if (wordAligned) {
    if (!Array.isArray(value.words) || value.words.length < 1 || value.words.length > 300000) return null;
    let previousWordEnd = 0;
    let previousWordParagraph = -1;
    let previousCharEnd = 0;
    for (const word of value.words) {
      if (!record(word) || !index(word.paragraphIndex) || !index(word.charStart) || !index(word.charEnd) || word.charEnd <= word.charStart) return null;
      const segment = segments.get(word.paragraphIndex);
      if (!segment || word.paragraphIndex < previousWordParagraph || (word.paragraphIndex === previousWordParagraph && word.charStart < previousCharEnd)) return null;
      if (!seconds(word.startSeconds) || !seconds(word.endSeconds) || word.endSeconds <= word.startSeconds || word.startSeconds < previousWordEnd || word.startSeconds < segment.startSeconds || word.endSeconds > segment.endSeconds + 0.001) return null;
      const location = parseEpubCfi(word.cfi);
      if (!location || location.chapterIndex !== value.chapterIndex || location.paragraphIndex !== word.paragraphIndex || location.charOffset !== word.charStart) return null;
      previousWordEnd = word.endSeconds;
      previousWordParagraph = word.paragraphIndex;
      previousCharEnd = word.charEnd;
    }
  }
  return value as AudioChapter;
}
export function parseAudioManifest(value: unknown): AudioManifest | null {
  if (!validHeader(value) || !value.chapters.every((chapter) => parseAudioChapter(chapter, value.alignment === "word"))) return null;
  return value as AudioManifest;
}
export function audioManifestIndex(manifest: AudioManifest): AudioManifestIndex {
  return {
    schemaVersion: manifest.schemaVersion, bookId: manifest.bookId, editionId: manifest.editionId,
    generationId: manifest.generationId, narrator: manifest.narrator, alignment: manifest.alignment,
    sampleRate: manifest.sampleRate, coverage: manifest.coverage,
    ...(manifest.format ? { format: manifest.format } : {}),
    ...(manifest.locationScheme ? { locationScheme: manifest.locationScheme } : {}),
    chapters: manifest.chapters.map(({ chapterIndex, chapterId, title, audioPath, durationSeconds, byteLength }) => ({
      chapterIndex, chapterId, title, audioPath, durationSeconds, ...(byteLength === undefined ? {} : { byteLength }),
    })),
  };
}
