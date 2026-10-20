import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { books, type Chapter } from "@/data/books";

export type BookContent = { editionId: string; chapters: Chapter[] };

// Resolve only known catalogue IDs. Book text stays outside public assets and bundles.
export async function getBookContent(bookId: string): Promise<BookContent | null> {
  const book = books.find((item) => item.id === bookId);
  if (!book?.editionId) return null;
  try {
    const content: unknown = JSON.parse(await readFile(path.join(process.cwd(), ".local", "books", `${book.id}.json`), "utf8"));
    if (!content || typeof content !== "object") return null;
    const data = content as BookContent;
    if (data.editionId !== book.editionId || !Array.isArray(data.chapters) || !data.chapters.length) return null;
    if (!data.chapters.every((chapter) => typeof chapter.id === "string" && typeof chapter.title === "string" && Array.isArray(chapter.paragraphs) && chapter.paragraphs.length > 0 && chapter.paragraphs.every((paragraph) => typeof paragraph === "string"))) return null;
    return data;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}
