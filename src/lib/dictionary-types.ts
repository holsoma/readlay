export type DictionaryDefinition = {
  definition: string;
  example?: string;
};

export type DictionaryMeaning = {
  partOfSpeech: string;
  definitions: DictionaryDefinition[];
};

export type DictionaryLicence = { name: string; url: string };

export type DictionaryEntry = {
  word: string;
  phonetic: string | null;
  audioUrl: string | null;
  meanings: DictionaryMeaning[];
  sourceUrl: string | null;
  licence: DictionaryLicence | null;
  pronunciationSourceUrl?: string | null;
  pronunciationLicence?: DictionaryLicence | null;
  providerName?: "Dictionary API" | "FreeDictionaryAPI.com" | null;
  providerUrl?: "https://dictionaryapi.dev/" | "https://freedictionaryapi.com/" | null;
};

export type DictionaryLookup = { query: string; entry: DictionaryEntry };
import { normaliseDictionaryWord, safeDictionarySourceUrl, safePronunciationUrl } from "./dictionary-word";


// Validate saved snapshots and API responses without importing the server lookup service.
export function parseDictionaryEntry(value: unknown): DictionaryEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Record<string, unknown>;
  const word = normaliseDictionaryWord(entry.word);
  const cleanText = (text: unknown, limit: number): text is string => typeof text === "string" && text.length > 0
    && text.length <= limit && !/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text);
  if (!word || entry.word !== word || !Array.isArray(entry.meanings) || !entry.meanings.length || entry.meanings.length > 12) return null;
  const meanings: DictionaryMeaning[] = [];
  for (const item of entry.meanings) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const meaning = item as Record<string, unknown>;
    if (!cleanText(meaning.partOfSpeech, 60) || !Array.isArray(meaning.definitions) || !meaning.definitions.length || meaning.definitions.length > 8) return null;
    const definitions: DictionaryDefinition[] = [];
    for (const item of meaning.definitions) {
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const definition = item as Record<string, unknown>;
      if (!cleanText(definition.definition, 2000) || (definition.example !== undefined && !cleanText(definition.example, 1500))) return null;
      definitions.push(definition.example === undefined ? { definition: definition.definition } : { definition: definition.definition, example: definition.example as string });
    }
    meanings.push({ partOfSpeech: meaning.partOfSpeech, definitions });
  }
  const parseLicence = (value: unknown): DictionaryLicence | null => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const data = value as Record<string, unknown>;
    const url = safeDictionarySourceUrl(data.url);
    return cleanText(data.name, 100) && url ? { name: data.name, url } : null;
  };
  const provider = entry.providerName === "Dictionary API" && entry.providerUrl === "https://dictionaryapi.dev/"
    ? { providerName: "Dictionary API", providerUrl: "https://dictionaryapi.dev/" } as const
    : entry.providerName === "FreeDictionaryAPI.com" && entry.providerUrl === "https://freedictionaryapi.com/"
      ? { providerName: "FreeDictionaryAPI.com", providerUrl: "https://freedictionaryapi.com/" } as const
      : entry.providerName == null && entry.providerUrl == null ? {} : null;
  if (!provider) return null;
  return {
    word, phonetic: cleanText(entry.phonetic, 200) ? entry.phonetic : null,
    audioUrl: safePronunciationUrl(entry.audioUrl), meanings,
    sourceUrl: safeDictionarySourceUrl(entry.sourceUrl), licence: parseLicence(entry.licence),
    pronunciationSourceUrl: safeDictionarySourceUrl(entry.pronunciationSourceUrl), pronunciationLicence: parseLicence(entry.pronunciationLicence),
    ...provider,
  };
}
