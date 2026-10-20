import { parseDictionaryEntry, type DictionaryEntry } from "@/lib/dictionary-types";
import { cfiForPosition, cfiForRange } from "@/lib/epub-location";

export type WordStatus = "new" | "learning" | "learned";
export type WordOccurrence = {
  id: string;
  bookId: string;
  editionId: string;
  chapterIndex: number;
  paragraphIndex: number;
  charStart: number;
  charEnd: number;
  cfiStart: string;
  cfiEnd: string;
  cfiRange: string;
  sentence: string;
  selectedText: string;
  savedAt: string;
};
export type SavedWord = {
  id: string;
  word: string;
  entry: DictionaryEntry;
  status: WordStatus;
  savedAt: string;
  updatedAt: string;
  occurrences: WordOccurrence[];
};
export type SaveWordInput = Pick<WordOccurrence, "bookId" | "editionId" | "chapterIndex" | "paragraphIndex" | "charStart" | "charEnd"> & { word: string };
export type WordBankAction =
  | ({ action: "save" } & SaveWordInput)
  | { action: "remove"; id: string }
  | { action: "status"; id: string; status: WordStatus };
export type WordBankRequest = WordBankAction & { expectedUserId: string };

export const isWordStatus = (value: unknown): value is WordStatus => value === "new" || value === "learning" || value === "learned";
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const coordinate = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const date = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));
const string = (value: unknown): value is string => typeof value === "string" && value.length > 0;

// API data stays in memory. Reject malformed responses rather than storing untrusted annotations.
export function parseWordBank(value: unknown): SavedWord[] | null {
  if (!record(value) || !Array.isArray(value.words)) return null;
  const words: SavedWord[] = [];
  for (const item of value.words) {
    if (!record(item) || !string(item.id) || !string(item.word) || !isWordStatus(item.status) ||
      !date(item.savedAt) || !date(item.updatedAt) || !Array.isArray(item.occurrences)) return null;
    const entry = parseDictionaryEntry(item.entry);
    if (!entry || entry.word !== item.word) return null;
    const occurrences: WordOccurrence[] = [];
    for (const occurrence of item.occurrences) {
      if (!record(occurrence) || !string(occurrence.id) || !string(occurrence.bookId) || !string(occurrence.editionId) ||
        !coordinate(occurrence.chapterIndex) || !coordinate(occurrence.paragraphIndex) || !coordinate(occurrence.charStart) ||
        !coordinate(occurrence.charEnd) || occurrence.charEnd <= occurrence.charStart || !string(occurrence.cfiStart) ||
        !string(occurrence.cfiEnd) || !string(occurrence.cfiRange) || !string(occurrence.sentence) ||
        !string(occurrence.selectedText) || !date(occurrence.savedAt)) return null;
      if (occurrence.cfiStart !== cfiForPosition(occurrence.chapterIndex, occurrence.paragraphIndex, occurrence.charStart) ||
        occurrence.cfiEnd !== cfiForPosition(occurrence.chapterIndex, occurrence.paragraphIndex, occurrence.charEnd) ||
        occurrence.cfiRange !== cfiForRange(occurrence.chapterIndex, occurrence.paragraphIndex, occurrence.charStart, occurrence.charEnd)) return null;
      occurrences.push({
        id: occurrence.id, bookId: occurrence.bookId, editionId: occurrence.editionId,
        chapterIndex: occurrence.chapterIndex, paragraphIndex: occurrence.paragraphIndex,
        charStart: occurrence.charStart, charEnd: occurrence.charEnd,
        cfiStart: occurrence.cfiStart, cfiEnd: occurrence.cfiEnd, cfiRange: occurrence.cfiRange,
        sentence: occurrence.sentence, selectedText: occurrence.selectedText, savedAt: occurrence.savedAt,
      });
    }
    words.push({ id: item.id, word: item.word, entry, status: item.status, savedAt: item.savedAt, updatedAt: item.updatedAt, occurrences });
  }
  return words;
}
