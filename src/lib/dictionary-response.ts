import type { DictionaryEntry, DictionaryLicence, DictionaryMeaning } from "./dictionary-types";
import { normaliseDictionaryWord, safePronunciationUrl } from "./dictionary-word";

export class DictionaryError extends Error {
  constructor(public readonly status: 400 | 404 | 429 | 502 | 503, message: string) { super(message); this.name = "DictionaryError"; }
}

const maximumResponseBytes = 512 * 1024;
const invalidResponse = () => new DictionaryError(502, "The dictionary returned an unreadable response. Try again.");

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

function text(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string" || value.length > maxLength) return null;
  const cleaned = value.replace(/<[^>]*>/g, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim();
  return cleaned || null;
}

function sourceUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.port ? url.href : null;
  } catch { return null; }
}

function licence(value: unknown): DictionaryLicence | null {
  const data = record(value);
  const name = data && text(data.name, 100);
  const url = data && sourceUrl(data.url);
  return name && url ? { name, url } : null;
}

export function parseDictionaryProviderEntry(value: unknown, requestedWord: string): DictionaryEntry {
  if (!Array.isArray(value) || !value.length) throw invalidResponse();
  const entries = value.slice(0, 6).map(record).filter((item): item is Record<string, unknown> => item !== null);
  // Homographs can be returned as separate entries. Keep their meanings together.
  const relevant = entries.filter((entry) => normaliseDictionaryWord(entry.word) === requestedWord);
  if (!relevant.length) throw invalidResponse();
  const meanings: DictionaryMeaning[] = [];
  let phonetic: string | null = null;
  let audioUrl: string | null = null;
  let pronunciationSourceUrl: string | null = null;
  let pronunciationLicence: DictionaryLicence | null = null;
  for (const entry of relevant) {
    const phonetics = Array.isArray(entry.phonetics) ? entry.phonetics.slice(0, 12).map(record).filter((item): item is Record<string, unknown> => item !== null) : [];
    const playable = phonetics.filter((item) => safePronunciationUrl(item.audio));
    const spoken = playable.find((item) => /(?:-uk|--_gb_)/i.test(String(item.audio))) || playable[0];
    if (!audioUrl && spoken) {
      audioUrl = safePronunciationUrl(spoken.audio);
      pronunciationSourceUrl = sourceUrl(spoken.sourceUrl);
      pronunciationLicence = licence(spoken.license);
      phonetic = text(spoken.text, 200);
    }
    phonetic ||= text(entry.phonetic, 200) || phonetics.map((item) => text(item.text, 200)).find(Boolean) || null;
    for (const meaningValue of Array.isArray(entry.meanings) ? entry.meanings.slice(0, 12) : []) {
      const meaning = record(meaningValue);
      const partOfSpeech = meaning && text(meaning.partOfSpeech, 60);
      if (!meaning || !partOfSpeech || !Array.isArray(meaning.definitions)) continue;
      const definitions: DictionaryMeaning["definitions"] = [];
      for (const definitionValue of meaning.definitions.slice(0, 8)) {
        const data = record(definitionValue);
        const definition = data && text(data.definition, 2000);
        if (!definition || definitions.some((item) => item.definition === definition)) continue;
        const example = text(data!.example, 1500);
        definitions.push(example ? { definition, example } : { definition });
      }
      if (definitions.length) meanings.push({ partOfSpeech, definitions });
      if (meanings.length >= 12) break;
    }
    if (meanings.length >= 12) break;
  }
  if (!meanings.length) throw invalidResponse();
  const first = relevant[0];
  return {
    word: requestedWord, phonetic, audioUrl, meanings,
    sourceUrl: Array.isArray(first.sourceUrls) ? first.sourceUrls.map(sourceUrl).find(Boolean) || null : null,
    licence: licence(first.license), pronunciationSourceUrl, pronunciationLicence,
    providerName: "Dictionary API", providerUrl: "https://dictionaryapi.dev/",
  };
}

export function parseFallbackDictionaryEntry(value: unknown, requestedWord: string): DictionaryEntry | null {
  const data = record(value);
  if (!data || normaliseDictionaryWord(data.word) !== requestedWord || !Array.isArray(data.entries)) throw invalidResponse();
  if (!data.entries.length) return null;
  const meanings: DictionaryMeaning[] = [];
  let phonetic: string | null = null;
  for (const entryValue of data.entries.slice(0, 12)) {
    const entry = record(entryValue);
    if (!entry || record(entry.language)?.code !== "en") continue;
    const partOfSpeech = text(entry.partOfSpeech, 60);
    if (!partOfSpeech || !Array.isArray(entry.senses)) continue;
    const pronunciations = Array.isArray(entry.pronunciations) ? entry.pronunciations.slice(0, 24).map(record).filter((item): item is Record<string, unknown> => item !== null && item.type === "ipa") : [];
    const british = pronunciations.find((item) => Array.isArray(item.tags) && item.tags.some((tag) => typeof tag === "string" && /^(?:UK|British|Received Pronunciation|England)$/i.test(tag)));
    phonetic ||= text(british?.text, 200) || pronunciations.map((item) => text(item.text, 200)).find(Boolean) || null;
    const definitions: DictionaryMeaning["definitions"] = [];
    let visited = 0;
    const collect = (senses: unknown[], depth: number) => {
      for (const senseValue of senses.slice(0, 12)) {
        if (++visited > 128 || definitions.length >= 8) return;
        const sense = record(senseValue);
        if (!sense) continue;
        const definition = text(sense.definition, 2000);
        // Wiktionary sometimes groups real definitions under a category gloss.
        // The heading itself is not a meaning; an empty group remains invalid.
        const categoryHeading = definition && /^Senses relating to [^\r\n.?!]+\.?$/i.test(definition);
        if (definition && !categoryHeading && !definitions.some((item) => item.definition === definition)) {
          const example = Array.isArray(sense.examples) ? sense.examples.slice(0, 4).map((item) => text(item, 1500)).find(Boolean) : null;
          definitions.push(example ? { definition, example } : { definition });
        }
        if (depth < 3 && Array.isArray(sense.subsenses)) collect(sense.subsenses, depth + 1);
      }
    };
    collect(entry.senses, 0);
    if (definitions.length) meanings.push({ partOfSpeech, definitions });
  }
  const source = record(data.source);
  const dictionarySource = sourceUrl(source?.url);
  const dictionaryLicence = licence(source?.license);
  if (!meanings.length || !dictionarySource || !dictionaryLicence) throw invalidResponse();
  return {
    word: requestedWord, phonetic, audioUrl: null, meanings, sourceUrl: dictionarySource, licence: dictionaryLicence,
    pronunciationSourceUrl: null, pronunciationLicence: null,
    providerName: "FreeDictionaryAPI.com", providerUrl: "https://freedictionaryapi.com/",
  };
}

export async function readDictionaryJson(response: Response): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximumResponseBytes)) {
    await response.body?.cancel();
    throw invalidResponse();
  }
  if (!/^application\/json(?:;|$)/i.test(response.headers.get("content-type") || "") || !response.body) {
    await response.body?.cancel();
    throw invalidResponse();
  }
  const reader = response.body.getReader();
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > maximumResponseBytes) { await reader.cancel(); throw invalidResponse(); }
      chunks.push(result.value);
    }
    const body = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch (error) {
    if (error instanceof DictionaryError) throw error;
    throw invalidResponse();
  } finally { reader.releaseLock(); }
}
