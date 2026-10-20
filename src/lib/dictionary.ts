import "server-only";
import type { DictionaryEntry, DictionaryLicence, DictionaryLookup, DictionaryMeaning } from "./dictionary-types";
import { inflectionCandidates, normaliseDictionaryWord, safePronunciationUrl } from "./dictionary-word";

export class DictionaryError extends Error {
  constructor(public readonly status: 400 | 404 | 429 | 502 | 503, message: string) { super(message); this.name = "DictionaryError"; }
}

const maximumCacheEntries = 256;
const maximumInFlight = 32;
const maximumResponseBytes = 512 * 1024;
const positiveLifetime = 24 * 60 * 60 * 1000;
const negativeLifetime = 5 * 60 * 1000;
type CacheEntry = { expires: number; entry: DictionaryEntry | null };
const cache = new Map<string, CacheEntry>();
const pending = new Map<string, Promise<DictionaryEntry | null>>();
const remotePending = new Map<string, Promise<DictionaryEntry | null>>();
const unavailable = () => new DictionaryError(503, "The dictionary is unavailable. Try again shortly.");
const invalidResponse = () => new DictionaryError(502, "The dictionary returned an unreadable response. Try again.");

function cached(word: string): DictionaryEntry | null | undefined {
  const value = cache.get(word);
  if (!value) return undefined;
  cache.delete(word);
  if (value.expires <= Date.now()) return undefined;
  cache.set(word, value);
  return value.entry;
}

function remember(word: string, entry: DictionaryEntry | null): void {
  cache.delete(word);
  cache.set(word, { entry, expires: Date.now() + (entry ? positiveLifetime : negativeLifetime) });
  while (cache.size > maximumCacheEntries) cache.delete(cache.keys().next().value!);
}

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

function parseEntry(value: unknown, requestedWord: string): DictionaryEntry {
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
  };
}

async function readJson(response: Response): Promise<unknown> {
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

async function fetchEntry(word: string, deadline: number): Promise<DictionaryEntry | null> {
  const cachedEntry = cached(word);
  if (cachedEntry !== undefined) return cachedEntry;
  const waiting = remotePending.get(word);
  if (waiting) return waiting;
  if (remotePending.size >= maximumInFlight) throw unavailable();
  const job = (async () => {
    const controller = new AbortController();
    const remaining = Math.min(6000, deadline - Date.now());
    if (remaining <= 0) throw unavailable();
    const timeout = setTimeout(() => controller.abort(), remaining);
    try {
      const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`, {
        signal: controller.signal, redirect: "error", headers: { Accept: "application/json" }, next: { revalidate: positiveLifetime / 1000 },
      });
      if (response.status === 404) { await response.body?.cancel(); remember(word, null); return null; }
      if (response.status === 429) { await response.body?.cancel(); throw new DictionaryError(429, "The dictionary is busy. Wait a moment, then try again."); }
      if (!response.ok) { await response.body?.cancel(); throw unavailable(); }
      const entry = parseEntry(await readJson(response), word);
      remember(word, entry);
      return entry;
    } catch (error) {
      if (error instanceof DictionaryError) throw error;
      throw unavailable();
    } finally { clearTimeout(timeout); }
  })();
  remotePending.set(word, job);
  try { return await job; } finally { remotePending.delete(word); }
}

export async function getDictionaryLookup(rawWord: string): Promise<DictionaryLookup> {
  const query = normaliseDictionaryWord(rawWord);
  if (!query) throw new DictionaryError(400, "Select one English word to look it up.");
  let job = pending.get(query);
  if (!job) {
    const existing = cached(query);
    if (existing !== undefined) {
      if (!existing) throw new DictionaryError(404, "No definition was found for this word.");
      return { query, entry: existing };
    }
    if (pending.size >= maximumInFlight) throw unavailable();
    job = (async () => {
      const deadline = Date.now() + 8000;
      for (const candidate of inflectionCandidates(query)) {
        const entry = await fetchEntry(candidate, deadline);
        if (entry) { remember(query, entry); return entry; }
      }
      remember(query, null);
      return null;
    })();
    pending.set(query, job);
  }
  let entry: DictionaryEntry | null;
  try { entry = await job; } finally { if (pending.get(query) === job) pending.delete(query); }
  if (!entry) throw new DictionaryError(404, "No definition was found for this word.");
  return { query, entry };
}
