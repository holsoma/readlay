import { normaliseDictionaryWord } from "./dictionary-word";

/** Explicit lookup suggestions for a verified source error, never text changes. */
export function dictionarySpellingSuggestions(bookId: string, editionId: string, selectedWord: string): string[] {
  if (bookId !== "laws-of-power" || editionId !== "e43027f07c709097") return [];
  const word = normaliseDictionaryWord(selectedWord);
  if (word === "subdecongenial") return ["subtle", "congenial"];
  if (word === "subde") return ["subtle"];
  return [];
}
