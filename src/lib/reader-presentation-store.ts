import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { books, type Chapter } from "@/data/books";
import { parseReaderPresentation } from "./reader-presentation";

export async function getReaderPresentation(bookId: string, editionId: string, chapters: Chapter[]) {
  if (!books.some((book) => book.id === bookId && book.editionId === editionId)) return null;
  try {
    const bytes = await readFile(path.join(process.cwd(), ".local", "reader", `${bookId}.json`));
    if (bytes.byteLength > 8 * 1024 * 1024) return null;
    return parseReaderPresentation(JSON.parse(bytes.toString("utf8")), bookId, editionId, chapters);
  } catch (error) {
    if (error instanceof SyntaxError || (error instanceof Error && "code" in error && error.code === "ENOENT")) return null;
    throw error;
  }
}
