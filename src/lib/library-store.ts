import "server-only";
import { neon } from "@neondatabase/serverless";
import { books } from "@/data/books";
import { getBookContent, type BookContent } from "@/lib/book-content";
import type { LibraryAction, LibraryRequest, LibraryState, ReadingProgress, SavedPassage } from "@/lib/library-types";

export class LibraryError extends Error {
  constructor(public readonly status: 400 | 401 | 503, message: string) {
    super(message);
    this.name = "LibraryError";
  }
}

function database() {
  const connectionString = process.env.DATABASE_URL?.trim();
  if (!connectionString) throw new LibraryError(503, "Cloud storage is not configured.");
  return neon(connectionString, { fetchOptions: { cache: "no-store" } });
}

const bookById = new Map(books.map((book) => [book.id, book]));
const locationKey = (bookId: string, editionId: string) => `${bookId}:${editionId}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPosition(value: unknown): value is ReadingProgress & Record<string, unknown> {
  if (!isRecord(value)) return false;
  return Number.isSafeInteger(value.chapterIndex) && Number(value.chapterIndex) >= 0 &&
    Number.isSafeInteger(value.paragraphIndex) && Number(value.paragraphIndex) >= 0;
}

export function parseLibraryAction(value: unknown): LibraryRequest {
  if (!isRecord(value) || typeof value.bookId !== "string" || !bookById.has(value.bookId) ||
    typeof value.expectedUserId !== "string" || !value.expectedUserId || value.expectedUserId.length > 128) {
    throw new LibraryError(400, "Invalid library action.");
  }
  const shared = { bookId: value.bookId, expectedUserId: value.expectedUserId };
  if (value.type === "save-book" && typeof value.saved === "boolean") {
    return { ...shared, type: "save-book", saved: value.saved };
  }
  const book = bookById.get(value.bookId);
  if (!book?.editionId || value.editionId !== book.editionId || !isPosition(value)) {
    throw new LibraryError(400, "Invalid reading location.");
  }
  const location = {
    ...shared,
    editionId: book.editionId,
    chapterIndex: value.chapterIndex,
    paragraphIndex: value.paragraphIndex,
  };
  if (value.type === "progress") return { ...location, type: "progress" };
  if (value.type === "bookmark" && typeof value.saved === "boolean") {
    return { ...location, type: "bookmark", saved: value.saved };
  }
  throw new LibraryError(400, "Invalid library action.");
}

function currentEdition(bookId: unknown, editionId: unknown): bookId is string {
  return typeof bookId === "string" && typeof editionId === "string" &&
    bookById.get(bookId)?.editionId === editionId;
}

function positionExists(content: BookContent, position: ReadingProgress): boolean {
  return isPosition(position) && typeof content.chapters[position.chapterIndex]?.paragraphs[position.paragraphIndex] === "string";
}

async function requireContent(bookId: string): Promise<BookContent> {
  const content = await getBookContent(bookId);
  if (!content) throw new LibraryError(503, "This book is unavailable.");
  return content;
}

export async function getLibraryState(userId: string): Promise<LibraryState> {
  const sql = database();
  const [progressRows, savedRows, bookmarkRows] = await sql.transaction([
    sql`SELECT book_id, edition_id, chapter_index, paragraph_index
        FROM readlay_progress WHERE user_id = ${userId}
        ORDER BY updated_at DESC, book_id, edition_id`,
    sql`SELECT book_id FROM readlay_saved_books WHERE user_id = ${userId}
        ORDER BY book_id`,
    sql`SELECT book_id, edition_id, chapter_index, paragraph_index
        FROM readlay_bookmarks WHERE user_id = ${userId}
        ORDER BY created_at DESC, book_id, chapter_index, paragraph_index`,
  ], { isolationLevel: "RepeatableRead", readOnly: true });

  const currentProgress = progressRows.filter((row) => currentEdition(row.book_id, row.edition_id));
  const currentBookmarks = bookmarkRows.filter((row) => currentEdition(row.book_id, row.edition_id));
  const neededBooks = [...new Set<string>([...currentProgress, ...currentBookmarks].map((row) => row.book_id as string))];
  const contents = new Map(await Promise.all(neededBooks.map(async (bookId) =>
    [bookId, await requireContent(bookId)] as const,
  )));

  const progressByEdition: LibraryState["progressByEdition"] = {};
  let lastReadBookId: string | null = null;
  for (const row of currentProgress) {
    const bookId = row.book_id as string;
    const content = contents.get(bookId);
    const position = { chapterIndex: row.chapter_index, paragraphIndex: row.paragraph_index };
    if (!content || !positionExists(content, position)) continue;
    progressByEdition[locationKey(bookId, content.editionId)] = position;
    lastReadBookId ??= bookId;
  }

  const bookmarks: SavedPassage[] = [];
  for (const row of currentBookmarks) {
    const bookId = row.book_id as string;
    const content = contents.get(bookId);
    const position = { chapterIndex: row.chapter_index, paragraphIndex: row.paragraph_index };
    if (!content || !positionExists(content, position)) continue;
    const chapter = content.chapters[position.chapterIndex];
    bookmarks.push({
      id: `${locationKey(bookId, content.editionId)}:${position.chapterIndex}:${position.paragraphIndex}`,
      bookId,
      editionId: content.editionId,
      ...position,
      chapterTitle: chapter.title,
      text: chapter.paragraphs[position.paragraphIndex],
    });
  }

  return {
    savedIds: savedRows.flatMap((row) => typeof row.book_id === "string" && bookById.has(row.book_id) ? [row.book_id] : []),
    progressByEdition,
    bookmarks,
    lastReadBookId,
  };
}

export async function applyLibraryAction(userId: string, action: LibraryAction): Promise<void> {
  const sql = database();
  if (action.type === "save-book") {
    if (action.saved) {
      await sql`INSERT INTO readlay_saved_books (user_id, book_id)
          VALUES (${userId}, ${action.bookId}) ON CONFLICT (user_id, book_id) DO NOTHING`;
    } else {
      await sql`DELETE FROM readlay_saved_books WHERE user_id = ${userId} AND book_id = ${action.bookId}`;
    }
    return;
  }

  const content = await requireContent(action.bookId);
  if (content.editionId !== action.editionId || !positionExists(content, action)) {
    throw new LibraryError(400, "Invalid reading location.");
  }

  if (action.type === "progress") {
    await sql`INSERT INTO readlay_progress
        (user_id, book_id, edition_id, chapter_index, paragraph_index, updated_at)
        VALUES (${userId}, ${action.bookId}, ${action.editionId}, ${action.chapterIndex}, ${action.paragraphIndex}, CURRENT_TIMESTAMP)
        ON CONFLICT (user_id, book_id, edition_id) DO UPDATE SET
          chapter_index = EXCLUDED.chapter_index,
          paragraph_index = EXCLUDED.paragraph_index,
          updated_at = CURRENT_TIMESTAMP`;
    return;
  }

  if (action.saved) {
    await sql`INSERT INTO readlay_bookmarks
        (user_id, book_id, edition_id, chapter_index, paragraph_index)
        VALUES (${userId}, ${action.bookId}, ${action.editionId}, ${action.chapterIndex}, ${action.paragraphIndex})
        ON CONFLICT (user_id, book_id, edition_id, chapter_index, paragraph_index) DO NOTHING`;
  } else {
    await sql`DELETE FROM readlay_bookmarks
        WHERE user_id = ${userId} AND book_id = ${action.bookId} AND edition_id = ${action.editionId}
          AND chapter_index = ${action.chapterIndex} AND paragraph_index = ${action.paragraphIndex}`;
  }
}
