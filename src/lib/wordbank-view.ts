import { parseEpubCfi } from "./epub-location";
import type { SavedWord, WordOccurrence, WordStatus } from "./wordbank-types";

export type WordBankSort = "newest" | "alphabetical" | "updated";
export type WordBankFilter = "all" | WordStatus;
export const wordStatusLabels: Record<WordStatus, string> = { new: "New", learning: "Learning", learned: "Learned" };
const searchable = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").replaceAll("’", "'").toLocaleLowerCase("en-GB");
const alphabet = new Intl.Collator("en-GB", { sensitivity: "base" });

export function visibleWords(words: SavedWord[], query: string, status: WordBankFilter, sort: WordBankSort, bookTitles: ReadonlyMap<string, string>): SavedWord[] {
  const terms = searchable(query).trim().split(/\s+/).filter(Boolean);
  return words.filter((word) => {
    if (status !== "all" && word.status !== status) return false;
    if (!terms.length) return true;
    const text = searchable([word.word, ...word.entry.meanings.flatMap((meaning) => [meaning.partOfSpeech, ...meaning.definitions.map((item) => item.definition)]),
      ...word.occurrences.flatMap((item) => [item.selectedText, item.sentence, bookTitles.get(item.bookId) ?? ""])].join(" "));
    return terms.every((term) => text.includes(term));
  }).sort((left, right) => {
    const difference = sort === "alphabetical" ? alphabet.compare(left.word, right.word)
      : Date.parse(sort === "updated" ? right.updatedAt : right.savedAt) - Date.parse(sort === "updated" ? left.updatedAt : left.savedAt);
    return difference || alphabet.compare(left.word, right.word) || left.id.localeCompare(right.id);
  });
}

export function wordOccurrenceHref(occurrence: WordOccurrence, book: { slug: string; editionId?: string } | undefined): string | null {
  if (!book || book.editionId !== occurrence.editionId) return null;
  const position = parseEpubCfi(occurrence.cfiStart);
  if (!position || position.chapterIndex !== occurrence.chapterIndex || position.paragraphIndex !== occurrence.paragraphIndex || position.charOffset !== occurrence.charStart) return null;
  return `/read/${book.slug}?chapter=${position.chapterIndex}&paragraph=${position.paragraphIndex}&offset=${position.charOffset}`;
}
