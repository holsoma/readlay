import "server-only";
import { DictionaryError, parseDictionaryProviderEntry, readDictionaryJson } from "./dictionary-response";
import type { DictionaryEntry, DictionaryLookup } from "./dictionary-types";
import { inflectionCandidates, normaliseDictionaryWord } from "./dictionary-word";

export { DictionaryError };

const maximumCacheEntries = 256;
const maximumInFlight = 32;
const positiveLifetime = 24 * 60 * 60 * 1000;
const negativeLifetime = 5 * 60 * 1000;
type CacheEntry = { expires: number; entry: DictionaryEntry | null };
const cache = new Map<string, CacheEntry>();
const pending = new Map<string, Promise<DictionaryEntry | null>>();
const remotePending = new Map<string, Promise<DictionaryEntry | null>>();
const unavailable = () => new DictionaryError(503, "The dictionary is unavailable. Try again shortly.");
const invalidResponse = () => new DictionaryError(502, "The dictionary returned an unreadable response. Try again.");
const warnings = new Map<string, number>();
const safeErrorNames = new Set(["AbortError", "TimeoutError", "TypeError", "SyntaxError", "Error"]);
const safeCauseCodes = new Set(["ABORT_ERR", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET", "ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "SELF_SIGNED_CERT_IN_CHAIN"]);

function warn(stage: "upstream-status" | "transport" | "invalid-response", status: number | null, error?: unknown): void {
  let errorName: string | null = null;
  let causeCode: string | null = null;
  try {
    const failure = record(error);
    const cause = failure && record(failure.cause);
    if (failure) errorName = typeof failure.name === "string" && safeErrorNames.has(failure.name) ? failure.name : "Other";
    if (cause?.code) causeCode = typeof cause.code === "string" && safeCauseCodes.has(cause.code) ? cause.code : "Other";
  } catch { errorName = "Other"; }
  const key = `${stage}:${status}:${errorName}:${causeCode}`;
  const previous = warnings.get(key);
  if (previous !== undefined && Date.now() - previous < 60_000) return;
  warnings.set(key, Date.now());
  while (warnings.size > 16) warnings.delete(warnings.keys().next().value!);
  // Fixed labels only. Never log a word, URL, book text, session, headers or an error message.
  console.warn("Readlay dictionary request failed.", { stage, status, errorName, causeCode });
}

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
    let upstreamStatus: number | null = null;
    try {
      const response = await fetch(`https://api.dictionaryapi.dev/api/v2/entries/en/${encodeURIComponent(word)}`, {
        signal: controller.signal, redirect: "error", headers: { Accept: "application/json" }, next: { revalidate: positiveLifetime / 1000 },
      });
      upstreamStatus = response.status;
      if (!response.ok) warn("upstream-status", response.status);
      if (response.status === 404) {
        const missing = record(await readDictionaryJson(response));
        if (typeof missing?.title !== "string" || typeof missing.message !== "string") throw invalidResponse();
        remember(word, null);
        return null;
      }
      if (response.status === 429) { await response.body?.cancel(); throw new DictionaryError(429, "The dictionary is busy. Wait a moment, then try again."); }
      if (!response.ok) { await response.body?.cancel(); throw unavailable(); }
      const entry = parseDictionaryProviderEntry(await readDictionaryJson(response), word);
      remember(word, entry);
      return entry;
    } catch (error) {
      if (error instanceof DictionaryError) { if (error.status === 502) warn("invalid-response", upstreamStatus); throw error; }
      warn("transport", upstreamStatus, error);
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
