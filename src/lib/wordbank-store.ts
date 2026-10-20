import "server-only";
import { neon } from "@neondatabase/serverless";
import { books } from "@/data/books";
import { getBookContent } from "@/lib/book-content";
import { DictionaryError, getDictionaryLookup } from "@/lib/dictionary";
import { normaliseDictionaryWord } from "@/lib/dictionary-word";
import { cfiForPosition, cfiForRange, isTextBoundary, wordsInText } from "@/lib/epub-location";
import { isWordStatus, parseWordBank, type SavedWord, type SaveWordInput, type WordBankAction, type WordBankRequest } from "@/lib/wordbank-types";

export class WordBankError extends Error {
  constructor(public readonly status: 400 | 401 | 404 | 409 | 429 | 502 | 503, message: string) {
    super(message);
    this.name = "WordBankError";
  }
}

function database() {
  const connection = process.env.DATABASE_URL?.trim();
  if (!connection) throw new WordBankError(503, "Word Bank storage is not configured.");
  return neon(connection, { fetchOptions: { cache: "no-store" } });
}
const catalogue = new Map(books.map((book) => [book.id, book]));
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const coordinate = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 2_147_483_647;
const id = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);

export function parseWordBankAction(value: unknown): WordBankRequest {
  if (!record(value) || typeof value.expectedUserId !== "string" || !value.expectedUserId || value.expectedUserId.length > 128) {
    throw new WordBankError(400, "Invalid Word Bank action.");
  }
  const shared = { expectedUserId: value.expectedUserId };
  if (value.action === "remove" && id(value.id)) return { ...shared, action: "remove", id: value.id };
  if (value.action === "status" && id(value.id) && isWordStatus(value.status)) {
    return { ...shared, action: "status", id: value.id, status: value.status };
  }
  if (value.action !== "save" || typeof value.bookId !== "string" ||
    typeof value.editionId !== "string" || catalogue.get(value.bookId)?.editionId !== value.editionId ||
    !coordinate(value.chapterIndex) || !coordinate(value.paragraphIndex) || !coordinate(value.charStart) ||
    !coordinate(value.charEnd) || value.charEnd <= value.charStart || value.charEnd - value.charStart > 200 ||
    typeof value.word !== "string" || value.word.length > 200 || !normaliseDictionaryWord(value.word)) {
    throw new WordBankError(400, "Select one word in an available book.");
  }
  return {
    ...shared, action: "save", word: value.word, bookId: value.bookId, editionId: value.editionId,
    chapterIndex: value.chapterIndex, paragraphIndex: value.paragraphIndex, charStart: value.charStart, charEnd: value.charEnd,
  };
}

// Sentence boundaries come from the immutable source paragraph, never from client text.
export function sentenceForWord(paragraph: string, start: number, end: number): string {
  const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
  for (const segment of segmenter.segment(paragraph)) {
    if (segment.index <= start && segment.index + segment.segment.length >= end) return segment.segment.trim();
  }
  return paragraph.trim();
}

export async function sourceForWord(input: SaveWordInput) {
  const content = await getBookContent(input.bookId);
  if (!content) throw new WordBankError(503, "This book is unavailable.");
  if (content.editionId !== input.editionId) throw new WordBankError(400, "This book edition has changed. Reopen the book.");
  const paragraph = content.chapters[input.chapterIndex]?.paragraphs[input.paragraphIndex];
  if (typeof paragraph !== "string" || !isTextBoundary(paragraph, input.charStart) || !isTextBoundary(paragraph, input.charEnd)) {
    throw new WordBankError(400, "Invalid word location.");
  }
  const token = wordsInText(paragraph).find((word) => word.charStart === input.charStart && word.charEnd === input.charEnd);
  const selectedText = token?.text;
  if (!selectedText || normaliseDictionaryWord(selectedText) !== normaliseDictionaryWord(input.word)) {
    throw new WordBankError(400, "Select one complete word in the book.");
  }
  return {
    selectedText, sentence: sentenceForWord(paragraph, input.charStart, input.charEnd),
    cfiStart: cfiForPosition(input.chapterIndex, input.paragraphIndex, input.charStart),
    cfiEnd: cfiForPosition(input.chapterIndex, input.paragraphIndex, input.charEnd),
    cfiRange: cfiForRange(input.chapterIndex, input.paragraphIndex, input.charStart, input.charEnd),
  };
}

const iso = (value: unknown): string => value instanceof Date ? value.toISOString() : String(value);

export async function getWordBank(userId: string): Promise<SavedWord[]> {
  const sql = database();
  const [wordRows, occurrenceRows] = await sql.transaction([
    sql`SELECT id, word, entry, status, saved_at, updated_at FROM readlay_words
        WHERE user_id = ${userId} ORDER BY saved_at DESC, id`,
    sql`SELECT id, word_id, book_id, edition_id, chapter_index, paragraph_index, char_start, char_end,
          cfi_start, cfi_end, cfi_range, sentence, selected_text, saved_at
        FROM readlay_word_occurrences WHERE user_id = ${userId} ORDER BY saved_at DESC, id`,
  ], { isolationLevel: "RepeatableRead", readOnly: true });
  const occurrences = new Map<string, Record<string, unknown>[]>();
  for (const row of occurrenceRows) {
    const key = String(row.word_id);
    const list = occurrences.get(key) ?? [];
    list.push({
      id: row.id, bookId: row.book_id, editionId: row.edition_id, chapterIndex: row.chapter_index,
      paragraphIndex: row.paragraph_index, charStart: row.char_start, charEnd: row.char_end,
      cfiStart: row.cfi_start, cfiEnd: row.cfi_end, cfiRange: row.cfi_range,
      sentence: row.sentence, selectedText: row.selected_text, savedAt: iso(row.saved_at),
    });
    occurrences.set(key, list);
  }
  const words = parseWordBank({ words: wordRows.map((row) => ({
    id: row.id, word: row.word, entry: row.entry, status: row.status, savedAt: iso(row.saved_at),
    updatedAt: iso(row.updated_at), occurrences: occurrences.get(String(row.id)) ?? [],
  })) });
  if (!words) throw new WordBankError(503, "Your Word Bank could not be loaded. Try again.");
  return words;
}

export async function applyWordBankAction(userId: string, action: WordBankAction): Promise<void> {
  if (action.action === "save") {
    const source = await sourceForWord(action);
    let lookup;
    try { lookup = await getDictionaryLookup(action.word); }
    catch (error) {
      if (error instanceof DictionaryError) throw new WordBankError(error.status, error.message);
      throw error;
    }
    const word = normaliseDictionaryWord(lookup.entry.word);
    if (!word || word !== lookup.entry.word) throw new WordBankError(502, "This dictionary entry could not be saved.");
    const sql = database();
    // One statement keeps the headword and its occurrence atomic under concurrent saves.
    // The conflict key preserves an existing learning status and the original save date.
    await sql`WITH saved_word AS (
        INSERT INTO readlay_words (id, user_id, word, entry)
        VALUES (${crypto.randomUUID()}, ${userId}, ${word}, ${JSON.stringify(lookup.entry)}::jsonb)
        ON CONFLICT (user_id, word) DO UPDATE SET entry = EXCLUDED.entry, updated_at = CURRENT_TIMESTAMP
        RETURNING id
      )
      INSERT INTO readlay_word_occurrences
        (id, user_id, word_id, book_id, edition_id, chapter_index, paragraph_index, char_start, char_end,
          cfi_start, cfi_end, cfi_range, sentence, selected_text)
        SELECT ${crypto.randomUUID()}, ${userId}, id, ${action.bookId}, ${action.editionId}, ${action.chapterIndex},
          ${action.paragraphIndex}, ${action.charStart}, ${action.charEnd}, ${source.cfiStart}, ${source.cfiEnd},
          ${source.cfiRange}, ${source.sentence}, ${source.selectedText} FROM saved_word
        ON CONFLICT (user_id, word_id, book_id, edition_id, chapter_index, paragraph_index, char_start, char_end) DO NOTHING`;
    return;
  }
  const sql = database();
  if (action.action === "remove") {
    // Cascading occurrences belong to this account through a composite foreign key.
    await sql`DELETE FROM readlay_words WHERE user_id = ${userId} AND id = ${action.id}`;
  } else {
    const rows = await sql`UPDATE readlay_words SET status = ${action.status}, updated_at = CURRENT_TIMESTAMP
        WHERE user_id = ${userId} AND id = ${action.id} RETURNING id`;
    if (!rows.length) throw new WordBankError(404, "This word is no longer in your Word Bank.");
  }
}
