/** Stored audio is prepared locally. These types contain no storage credentials. */
export type AudioNarratorSummary = { id: string; name: string; language: string };

export type AudioNarrator = AudioNarratorSummary & {
  engine: string;
  voice: string;
};

export type AudioSegment = {
  paragraphIndex: number;
  startSeconds: number;
  endSeconds: number;
  textHash: string;
};

export type AudioChapter = {
  chapterIndex: number;
  chapterId: string;
  title: string;
  /** Private storage object path. The browser always uses the authenticated stream route. */
  audioPath: string;
  durationSeconds: number;
  segments: AudioSegment[];
};

export type AudioManifest = {
  schemaVersion: 1;
  bookId: string;
  editionId: string;
  generationId: string;
  narrator: AudioNarrator;
  alignment: "paragraph";
  sampleRate: 24000;
  coverage: { complete: boolean; totalChapters: number; chapterIndices: number[] };
  chapters: AudioChapter[];
};

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, limit = 300): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= limit;
const index = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const seconds = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const identifier = (value: unknown): value is string => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(value);

function narratorSummary(value: unknown): value is AudioNarratorSummary {
  return record(value) && identifier(value.id) && text(value.name, 120) && text(value.language, 35);
}

export function parseAudioNarrators(value: unknown): AudioNarratorSummary[] | null {
  if (!record(value) || !Array.isArray(value.narrators) || value.narrators.length > 100) return null;
  if (!value.narrators.every(narratorSummary)) return null;
  if (new Set(value.narrators.map((item) => item.id)).size !== value.narrators.length) return null;
  return value.narrators.map(({ id, name, language }) => ({ id, name, language }));
}

/** Reject malformed and overlapping cues before either a server or player uses them. */
export function parseAudioManifest(value: unknown): AudioManifest | null {
  if (!record(value) || value.schemaVersion !== 1 || value.alignment !== "paragraph" || value.sampleRate !== 24000) return null;
  if (!identifier(value.bookId) || !identifier(value.editionId) || !identifier(value.generationId)) return null;
  if (!record(value.narrator) || !text(value.narrator.engine, 80) || !text(value.narrator.voice, 120) || !narratorSummary(value.narrator)) return null;
  if (!record(value.coverage) || typeof value.coverage.complete !== "boolean" || !index(value.coverage.totalChapters) || value.coverage.totalChapters < 1) return null;
  if (!Array.isArray(value.chapters) || value.chapters.length < 1 || value.chapters.length > 10000) return null;
  if (!Array.isArray(value.coverage.chapterIndices) || value.coverage.chapterIndices.length !== value.chapters.length) return null;
  let previousChapter = -1;
  for (const [offset, chapter] of value.chapters.entries()) {
    if (!record(chapter) || !index(chapter.chapterIndex) || chapter.chapterIndex <= previousChapter || chapter.chapterIndex >= value.coverage.totalChapters) return null;
    if (value.coverage.chapterIndices[offset] !== chapter.chapterIndex || !text(chapter.chapterId, 300) || !text(chapter.title, 1000) || !text(chapter.audioPath, 2048)) return null;
    if (!seconds(chapter.durationSeconds) || chapter.durationSeconds <= 0 || !Array.isArray(chapter.segments) || chapter.segments.length < 1 || chapter.segments.length > 100000) return null;
    let previousParagraph = -1;
    let previousEnd = 0;
    for (const segment of chapter.segments) {
      if (!record(segment) || !index(segment.paragraphIndex) || segment.paragraphIndex <= previousParagraph) return null;
      if (!seconds(segment.startSeconds) || !seconds(segment.endSeconds) || segment.endSeconds <= segment.startSeconds || segment.startSeconds < previousEnd || segment.endSeconds > chapter.durationSeconds + 0.05) return null;
      if (typeof segment.textHash !== "string" || !/^[a-f0-9]{64}$/i.test(segment.textHash)) return null;
      previousParagraph = segment.paragraphIndex;
      previousEnd = segment.endSeconds;
    }
    previousChapter = chapter.chapterIndex;
  }
  if (value.coverage.complete && value.chapters.length !== value.coverage.totalChapters) return null;
  return value as AudioManifest;
}
