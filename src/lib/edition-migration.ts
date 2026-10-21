import { cfiForPosition, cfiForRange, isTextBoundary, parseEpubCfi, wordsInText } from "./epub-location";
import type { ReadingProgress } from "./library-types";
import type { WordOccurrence } from "./wordbank-types";

export type MigrationWord = [number, number, number, number, number, number];
export type ParagraphMigration = { sourceLength: number; target: Required<Pick<ReadingProgress, "chapterIndex" | "paragraphIndex" | "charOffset">>; words: MigrationWord[] };
export type EditionMigration = { schemaVersion: 1; bookId: string; fromEditionId: string; toEditionId: string; paragraphs: Record<string, ParagraphMigration> };
type Chapters = { paragraphs: string[] }[];
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const coordinate = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 2_147_483_647;
const edition = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{16}$/u.test(value);

/** Only coordinates leave the server. Unknown fields, including source text, are discarded. */
export function parseEditionMigration(value: unknown, chapters?: Chapters): EditionMigration | null {
  if (!record(value) || value.schemaVersion !== 1 || value.bookId !== "seven-habits" || !edition(value.fromEditionId) || !edition(value.toEditionId) ||
    value.fromEditionId === value.toEditionId || !record(value.paragraphs) || Object.keys(value.paragraphs).length > 100_000) return null;
  const paragraphs: Record<string, ParagraphMigration> = {};
  const boundaries = new Map<string, Set<string>>();
  function targetExists(ci: number, pi: number, start: number, end?: number) {
    if (!chapters) return true;
    const text = chapters[ci]?.paragraphs[pi];
    if (typeof text !== "string" || !isTextBoundary(text, start) || (end !== undefined && !isTextBoundary(text, end))) return false;
    if (end === undefined) return true;
    const key = `${ci}:${pi}`;
    let tokens = boundaries.get(key);
    if (!tokens) { tokens = new Set(wordsInText(text).map((word) => `${word.charStart}:${word.charEnd}`)); boundaries.set(key, tokens); }
    return tokens.has(`${start}:${end}`);
  }
  let count = 0;
  for (const [key, input] of Object.entries(value.paragraphs)) {
    if (!/^(?:0|[1-9]\d*):(?:0|[1-9]\d*)$/u.test(key) || key.split(":").some((part) => !coordinate(Number(part))) || !record(input) || !coordinate(input.sourceLength) ||
      !record(input.target) || !coordinate(input.target.chapterIndex) || !coordinate(input.target.paragraphIndex) || !coordinate(input.target.charOffset) || !Array.isArray(input.words) ||
      !targetExists(input.target.chapterIndex, input.target.paragraphIndex, input.target.charOffset)) return null;
    const words: MigrationWord[] = [];
    let previousEnd = 0;
    for (const word of input.words) {
      if (++count > 1_000_000 || !Array.isArray(word) || word.length !== 6 || !word.every(coordinate)) return null;
      const [start, end, ci, pi, toStart, toEnd] = word as MigrationWord;
      if (start < previousEnd || end <= start || end > input.sourceLength || toEnd <= toStart || !targetExists(ci, pi, toStart, toEnd)) return null;
      words.push([start, end, ci, pi, toStart, toEnd]); previousEnd = end;
    }
    paragraphs[key] = { sourceLength: input.sourceLength, target: { chapterIndex: input.target.chapterIndex, paragraphIndex: input.target.paragraphIndex, charOffset: input.target.charOffset }, words };
  }
  return { schemaVersion: 1, bookId: value.bookId, fromEditionId: value.fromEditionId, toEditionId: value.toEditionId, paragraphs };
}

export function migrateReadingPosition(migration: EditionMigration, position: ReadingProgress): ReadingProgress | null {
  const offset = position.charOffset ?? 0;
  if (![position.chapterIndex, position.paragraphIndex, offset].every(coordinate)) return null;
  if (position.cfi !== undefined) {
    const cfi = parseEpubCfi(position.cfi);
    if (!cfi || cfi.chapterIndex !== position.chapterIndex || cfi.paragraphIndex !== position.paragraphIndex || cfi.charOffset !== offset) return null;
  }
  const paragraph = migration.paragraphs[`${position.chapterIndex}:${position.paragraphIndex}`];
  if (!paragraph || offset > paragraph.sourceLength) return null;
  const word = paragraph.words.find(([start, end]) => start <= offset && offset < end);
  // An unmatched source word can use only the reviewed passage anchor, never an invented offset.
  const target = word ? { chapterIndex: word[2], paragraphIndex: word[3], charOffset: word[4] } : paragraph.target;
  return { ...target, cfi: cfiForPosition(target.chapterIndex, target.paragraphIndex, target.charOffset) };
}

export function migrateWordOccurrence(migration: EditionMigration, occurrence: WordOccurrence): WordOccurrence | null {
  if (occurrence.bookId !== migration.bookId || occurrence.editionId !== migration.fromEditionId) return null;
  const word = migration.paragraphs[`${occurrence.chapterIndex}:${occurrence.paragraphIndex}`]?.words.find(([start, end]) => start === occurrence.charStart && end === occurrence.charEnd);
  if (!word) return null;
  const [, , chapterIndex, paragraphIndex, charStart, charEnd] = word;
  return { ...occurrence, editionId: migration.toEditionId, chapterIndex, paragraphIndex, charStart, charEnd,
    cfiStart: cfiForPosition(chapterIndex, paragraphIndex, charStart), cfiEnd: cfiForPosition(chapterIndex, paragraphIndex, charEnd), cfiRange: cfiForRange(chapterIndex, paragraphIndex, charStart, charEnd) };
}

/** Inspect the original cache before its normal parser discards retired editions. */
export function cachedRetiredEditions(raw: string | null, books: { id: string; editionId?: string }[]): { bookId: string; fromEditionId: string; toEditionId: string }[] {
  const current = books.find((book) => book.id === "seven-habits")?.editionId;
  const retired = "b17d5f5bc348f3d6";
  return raw && current && current !== retired && raw.includes(retired) && raw.includes("seven-habits") ? [{ bookId: "seven-habits", fromEditionId: retired, toEditionId: current }] : [];
}

/** The caller archives the untouched raw cache before persisting this projection. */
export function migrateCachedLibrary(value: unknown, migrations: EditionMigration[]): unknown {
  if (!record(value)) return value;
  const output: Record<string, unknown> = { ...value };
  const wrapped = record(value.base);
  let base: Record<string, unknown> = { ...(wrapped ? value.base as Record<string, unknown> : value) };
  let pending: unknown[] = Array.isArray(value.pending) ? [...value.pending] : [];
  for (const migration of migrations) {
    const oldKey = `${migration.bookId}:${migration.fromEditionId}`, newKey = `${migration.bookId}:${migration.toEditionId}`;
    const progress = record(base.progressByEdition) ? { ...base.progressByEdition } : {};
    const currentWins = Object.hasOwn(progress, newKey);
    const old = progress[oldKey];
    if (!currentWins && record(old)) { const position = migrateReadingPosition(migration, old as ReadingProgress); if (position) progress[newKey] = position; }
    delete progress[oldKey];
    function mapPassage(item: unknown) {
      if (!record(item) || item.bookId !== migration.bookId || item.editionId !== migration.fromEditionId) return item;
      if (!migrateReadingPosition(migration, item as ReadingProgress)) return null;
      const anchor = migration.paragraphs[`${item.chapterIndex}:${item.paragraphIndex}`]?.target;
      if (!anchor) return null;
      return { ...item, ...anchor, cfi: cfiForPosition(anchor.chapterIndex, anchor.paragraphIndex, anchor.charOffset), editionId: migration.toEditionId, id: `${newKey}:${anchor.chapterIndex}:${anchor.paragraphIndex}` };
    }
    const oldBookmarks = Array.isArray(base.bookmarks) ? base.bookmarks : [];
    const currentBookmarkIds = new Set(oldBookmarks.filter((item) => record(item) && item.editionId === migration.toEditionId && item.bookId === migration.bookId).map((item) => (item as Record<string, unknown>).id));
    const seen = new Set<unknown>();
    const bookmarks = oldBookmarks.flatMap((item) => {
      const mapped = mapPassage(item);
      if (!record(mapped) || (record(item) && item.editionId === migration.fromEditionId && currentBookmarkIds.has(mapped.id)) || seen.has(mapped.id)) return [];
      seen.add(mapped.id); return [mapped];
    });
    const currentActions = pending.filter((item) => record(item) && record(item.action) && item.action.bookId === migration.bookId && item.action.editionId === migration.toEditionId).map((item) => (item as { action: Record<string, unknown> }).action);
    pending = pending.flatMap((item) => {
      if (!record(item) || !record(item.action) || item.action.bookId !== migration.bookId || item.action.editionId !== migration.fromEditionId) return [item];
      const action = item.action;
      if (action.type === "progress") {
        if (currentWins || currentActions.some((entry) => entry.type === "progress")) return [];
        const position = migrateReadingPosition(migration, action as ReadingProgress);
        return position ? [{ ...item, action: { ...action, ...position, editionId: migration.toEditionId } }] : [];
      }
      if (action.type !== "bookmark") return [];
      if (!migrateReadingPosition(migration, action as ReadingProgress)) return [];
      const anchor = migration.paragraphs[`${action.chapterIndex}:${action.paragraphIndex}`]?.target;
      if (!anchor || currentActions.some((entry) => entry.type === "bookmark" && entry.chapterIndex === anchor.chapterIndex && entry.paragraphIndex === anchor.paragraphIndex)) return [];
      const bookmark = mapPassage(item.bookmark);
      return [{ ...item, action: { ...action, ...anchor, cfi: cfiForPosition(anchor.chapterIndex, anchor.paragraphIndex, anchor.charOffset), editionId: migration.toEditionId }, ...(bookmark ? { bookmark } : {}) }];
    });
    base = { ...base, progressByEdition: progress, bookmarks };
  }
  return wrapped ? { ...output, base, pending } : base;
}
