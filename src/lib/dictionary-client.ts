import type { DictionaryEntry, DictionaryLookup } from "./dictionary-types";
import { DictionaryError, parseDictionaryProviderEntry, parseFallbackDictionaryEntry, readDictionaryJson } from "./dictionary-response";
import { inflectionCandidates, normaliseDictionaryWord } from "./dictionary-word";

type CachedEntry = { entry: DictionaryEntry | null; expires: number };
const cache = new Map<string, CachedEntry>();
const pending = new Map<string, Promise<DictionaryLookup>>();
const maximumEntries = 100;
const maximumInFlight = 16;
const unavailable = () => new DictionaryError(503, "The dictionary is unavailable. Try again shortly.");
const missing = () => new DictionaryError(404, "No definition was found for this word.");
const warnings = new Map<string, number>();
const safeErrorNames = new Set(["AbortError", "TimeoutError", "TypeError", "SyntaxError", "Error"]);
const safeCauseCodes = new Set(["ABORT_ERR", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"]);

function warn(stage: "upstream-status" | "transport" | "timeout" | "invalid-response", status: number | null, error?: unknown) {
  let errorName: string | null = null;
  let causeCode: string | null = null;
  try {
    if (error && typeof error === "object") {
      const failure = error as { name?: unknown; cause?: { code?: unknown } };
      errorName = typeof failure.name === "string" && safeErrorNames.has(failure.name) ? failure.name : "Other";
      if (failure.cause?.code) causeCode = typeof failure.cause.code === "string" && safeCauseCodes.has(failure.cause.code) ? failure.cause.code : "Other";
    }
  } catch { errorName = "Other"; }
  const key = `${stage}:${status}:${errorName}:${causeCode}`;
  const previous = warnings.get(key);
  if (previous !== undefined && Date.now() - previous < 60_000) return;
  warnings.set(key, Date.now());
  while (warnings.size > 12) warnings.delete(warnings.keys().next().value!);
  // Fixed labels only. No selected word, request URL, error message or book/session data.
  console.warn("Readlay browser dictionary request failed.", { stage, status, errorName, causeCode });
}

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

let primaryUnavailableUntil = 0;

type Provider = "primary" | "fallback";
async function fromProvider(word: string, provider: Provider, signal: AbortSignal): Promise<DictionaryEntry | null> {
  const request = new AbortController();
  let timedOut = false;
  let upstreamStatus: number | null = null;
  const timeout = provider === "primary" ? setTimeout(() => { timedOut = true; request.abort(); }, 3000) : null;
  try {
    const base = provider === "primary" ? "https://api.dictionaryapi.dev/api/v2" : "https://freedictionaryapi.com/api/v1";
    const response = await fetch(`${base}/entries/en/${encodeURIComponent(word)}`, {
      mode: "cors", credentials: "omit", referrerPolicy: "no-referrer", redirect: "error",
      signal: AbortSignal.any([signal, request.signal]), headers: { Accept: "application/json" },
    });
    upstreamStatus = response.status;
    if (!response.ok) warn("upstream-status", response.status);
    if (provider === "primary" && response.status === 404) {
      const body = await readDictionaryJson(response);
      if (!body || typeof body !== "object" || !("title" in body) || typeof body.title !== "string" || !("message" in body) || typeof body.message !== "string") {
        throw new DictionaryError(502, "The dictionary returned an unreadable response. Try again.");
      }
      return null;
    }
    if (response.status === 429) { await response.body?.cancel(); throw new DictionaryError(429, "The dictionary is busy. Wait a moment, then try again."); }
    if (!response.ok) { await response.body?.cancel(); throw unavailable(); }
    const body = await readDictionaryJson(response);
    return provider === "primary" ? parseDictionaryProviderEntry(body, word) : parseFallbackDictionaryEntry(body, word);
  } catch (error) {
    if (error instanceof DictionaryError) { if (error.status === 502) warn("invalid-response", upstreamStatus); throw error; }
    warn(timedOut || signal.aborted ? "timeout" : "transport", upstreamStatus, error);
    throw unavailable();
  } finally { if (timeout !== null) clearTimeout(timeout); }
}

function inflectionReference(entry: DictionaryEntry, query: string): string | null {
  const candidates = inflectionCandidates(query);
  const references = entry.meanings.flatMap((meaning) => meaning.definitions).map((item) => {
    const match = /^(?:plural|third-person singular simple present indicative|simple past(?: tense)?(?: and past participle)?|past tense|past participle|present participle) of (.+?)\.?$/i.exec(item.definition);
    return match ? normaliseDictionaryWord(match[1]) : null;
  });
  const lemma = references[0];
  return lemma && lemma !== query && candidates.includes(lemma) && references.every((item) => item === lemma) ? lemma : null;
}

async function resolveInflection(entry: DictionaryEntry, query: string, signal: AbortSignal): Promise<DictionaryEntry> {
  const lemma = inflectionReference(entry, query);
  if (!lemma || signal.aborted) return entry;
  const existing = cached(lemma);
  if (existing !== undefined) return existing ?? entry;
  try {
    const resolved = await fromProvider(lemma, "fallback", signal);
    remember(lemma, resolved);
    return resolved ?? entry;
  } catch { return entry; }
}

async function lookup(query: string): Promise<DictionaryLookup> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  let fallback = Date.now() < primaryUnavailableUntil;
  try {
    for (const candidate of inflectionCandidates(query)) {
      if (controller.signal.aborted) throw unavailable();
      const existing = cached(candidate);
      if (existing !== undefined) {
        if (!existing) continue;
        remember(query, existing);
        return { query, entry: existing };
      }
      let entry: DictionaryEntry | null = null;
      if (!fallback) {
        try { entry = await fromProvider(candidate, "primary", controller.signal); }
        catch (error) {
          if (!(error instanceof DictionaryError) || ![429, 502, 503].includes(error.status)) throw error;
          primaryUnavailableUntil = Date.now() + 120_000;
          fallback = true;
        }
      }
      if (fallback) {
        if (controller.signal.aborted) throw unavailable();
        entry = await fromProvider(candidate, "fallback", controller.signal);
        if (entry) entry = await resolveInflection(entry, query, controller.signal);
      }
      remember(candidate, entry);
      if (entry) { remember(query, entry); return { query, entry }; }
    }
    remember(query, null);
    throw missing();
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
