import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { books } from "@/data/books";
import { getBookContent } from "./book-content";
import { parseEditionMigration, type EditionMigration } from "./edition-migration";

export const maximumMigrationBytes = 4 * 1024 * 1024;
let cached: { editionId: string; promise: Promise<EditionMigration[]> } | undefined;

export async function getEditionMigrations(): Promise<EditionMigration[]> {
  const book = books.find((item) => item.id === "seven-habits");
  if (!book?.editionId || book.editionId === "b17d5f5bc348f3d6") return [];
  const immutable = process.env.NODE_ENV === "production" || process.env.VERCEL === "1";
  if (immutable && cached?.editionId === book.editionId) return cached.promise;
  const promise = (async () => {
    const bytes = await readFile(path.join(process.cwd(), ".local", "edition-migrations", "seven-habits.json"));
    if (bytes.byteLength > maximumMigrationBytes) throw new Error("The edition transition exceeds its size limit.");
    const content = await getBookContent(book.id);
    const migration = content && parseEditionMigration(JSON.parse(bytes.toString("utf8")), content.chapters);
    if (!migration || migration.bookId !== book.id || migration.fromEditionId !== "b17d5f5bc348f3d6" || migration.toEditionId !== book.editionId) throw new Error("The edition transition does not match this book.");
    return [migration];
  })();
  if (immutable) cached = { editionId: book.editionId, promise };
  try { return await promise; }
  catch (error) { if (cached?.promise === promise) cached = undefined; throw error; }
}
