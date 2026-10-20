import type { DictionaryEntry, DictionaryLookup } from "./dictionary-types";
import { DictionaryError, parseDictionaryProviderEntry, readDictionaryJson } from "./dictionary-response";
import { inflectionCandidates, normaliseDictionaryWord } from "./dictionary-word";

type CachedEntry = { entry: DictionaryEntry | null; expires: number };
const cache = new Map<string, CachedEntry>();
const pending = new Map<string, Promise<DictionaryLookup>>();
const maximumEntries = 100;
const maximumInFlight = 16;
const unavailable = () => new DictionaryError(503, "The dictionary is unavailable. Try again shortly.");
const missing = () => new DictionaryError(404, "No definition was found for this word.");

function cached(word: string): DictionaryEntry | null | undefined {
  const item = cache.get(word);
  if (!item) return undefined;
  cache.delete(word);
  if (item.expires <= Date.now()) return undefined;
  cache.set(word, item);
  return item.entry;
}

function remember(word: string, entry: DictionaryEntry | null) {
  cache.delete(word);
  cache.set(word, { entry, expires: Date.now() + (entry ? 24 * 60 * 60 * 1000 : 5 * 60 * 1000) });
  while (cache.size > maximumEntries) cache.delete(cache.keys().next().value!);
}

async function lookup(query: string): Promise<DictionaryLookup> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    for (const candidate of inflectionCandidates(query)) {
      const existing = cached(candidate);
      if (existing !== undefined) {
        if (!existing) continue;
        remember(query, existing);
        return { query, entry: existing };
      }
      // This public API permits browser CORS. Send the selected word only.
      const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(candidate)}`, {
        mode: "cors", credentials: "omit", referrerPolicy: "no-referrer", redirect: "error",
        signal: controller.signal, headers: { Accept: "application/json" },
      });
      if (response.status === 404) {
        const body = await readDictionaryJson(response);
        if (!body || typeof body !== "object" || !("title" in body) || typeof body.title !== "string" || !("message" in body) || typeof body.message !== "string") {
          throw new DictionaryError(502, "The dictionary returned an unreadable response. Try again.");
        }
        remember(candidate, null);
        continue;
      }
      if (response.status === 429) { await response.body?.cancel(); throw new DictionaryError(429, "The dictionary is busy. Wait a moment, then try again."); }
      if (!response.ok) { await response.body?.cancel(); throw unavailable(); }
      const entry = parseDictionaryProviderEntry(await readDictionaryJson(response), candidate);
      remember(candidate, entry);
      remember(query, entry);
      return { query, entry };
    }
    remember(query, null);
    throw missing();
  } catch (error) {
    if (error instanceof DictionaryError) throw error;
    throw unavailable();
  } finally { clearTimeout(timeout); }
}

function withSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  const cancelled = () => new DOMException("Dictionary lookup cancelled.", "AbortError");
  if (signal.aborted) return Promise.reject(cancelled());
  return new Promise<T>((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(cancelled()); };
    signal.addEventListener("abort", abort, { once: true });
    promise.then((value) => { signal.removeEventListener("abort", abort); resolve(value); }, (error) => { signal.removeEventListener("abort", abort); reject(error); });
  });
}

export function lookupDictionaryInBrowser(rawWord: string, signal?: AbortSignal): Promise<DictionaryLookup> {
  if (signal?.aborted) return Promise.reject(new DOMException("Dictionary lookup cancelled.", "AbortError"));
  const query = normaliseDictionaryWord(rawWord);
  if (!query) return Promise.reject(new DictionaryError(400, "Select one English word to look it up."));
  let job = pending.get(query);
  if (!job) {
    const existing = cached(query);
    if (existing !== undefined) return withSignal(existing ? Promise.resolve({ query, entry: existing }) : Promise.reject(missing()), signal);
    if (pending.size >= maximumInFlight) return Promise.reject(unavailable());
    job = lookup(query).finally(() => pending.delete(query));
    pending.set(query, job);
  }
  // Cancelling one popup does not cancel a request another popup is still using.
  return withSignal(job, signal);
}
