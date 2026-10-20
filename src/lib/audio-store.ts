import "server-only";
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { books } from "@/data/books";
import { getBookContent } from "@/lib/book-content";
import { parseAudioManifest, type AudioManifest, type AudioNarratorSummary } from "@/lib/audio-types";
import { cfiForPosition, isTextBoundary, wordsInText } from "@/lib/epub-location";

const safeId = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;
const root = path.join(process.cwd(), ".local", "audiobooks");

export class AudioError extends Error {
  constructor(public readonly status: 400 | 401 | 404 | 503, message: string) {
    super(message);
    this.name = "AudioError";
  }
}

function editionFor(bookId: string) {
  const book = books.find(book => book.id === bookId);
  if (!book?.editionId || !safeId.test(bookId)) throw new AudioError(404, "Book unavailable.");
  return book.editionId;
}

// Vercel's traced preparation files are immutable for this deployment. Retain at
// most two validated manifests per process, rather than hashing a whole book on
// every seek. Local preparation remains uncached so operator edits are visible.
const validatedManifests = new Map<string, Promise<AudioManifest>>();
export async function getAudioManifest(bookId: string, narratorId: string): Promise<AudioManifest> {
  if (process.env.VERCEL !== "1") return loadAudioManifest(bookId, narratorId);
  const key = JSON.stringify([bookId, narratorId, process.env.SUPABASE_URL, process.env.AUDIO_STORAGE_BUCKET]);
  const existing = validatedManifests.get(key);
  if (existing) {
    validatedManifests.delete(key);
    validatedManifests.set(key, existing);
    return existing;
  }
  const result = loadAudioManifest(bookId, narratorId);
  validatedManifests.set(key, result);
  if (validatedManifests.size > 2) validatedManifests.delete(validatedManifests.keys().next().value!);
  try { return await result; }
  catch (error) { if (validatedManifests.get(key) === result) validatedManifests.delete(key); throw error; }
}

async function loadAudioManifest(bookId: string, narratorId: string): Promise<AudioManifest> {
  const editionId = editionFor(bookId);
  if (!safeId.test(narratorId)) throw new AudioError(400, "Invalid narrator.");
  let value: unknown;
  let manifestBytes: string;
  const directory = path.join(root, bookId, editionId, narratorId);
  try {
    manifestBytes = await readFile(path.join(directory, "manifest.json"), "utf8");
    value = JSON.parse(manifestBytes);
  } catch {
    throw new AudioError(404, "This narration is unavailable.");
  }
  const manifest = parseAudioManifest(value);
  if (!manifest || manifest.bookId !== bookId || manifest.editionId !== editionId || manifest.narrator.id !== narratorId) {
    throw new AudioError(503, "This narration needs to be prepared again.");
  }
  if (process.env.AUDIO_STORAGE_MODE !== "local" || process.env.VERCEL === "1") {
    try {
      const published = JSON.parse(await readFile(path.join(directory, "published.json"), "utf8"));
      const origin = process.env.SUPABASE_URL ? new URL(process.env.SUPABASE_URL).origin : null;
      if (!origin || published.storageOrigin !== origin || published.bucket !== (process.env.AUDIO_STORAGE_BUCKET || "readlay-audio") ||
        published.generationId !== manifest.generationId || published.manifestHash !== createHash("sha256").update(manifestBytes, "utf8").digest("hex")) throw new Error("Unpublished");
    } catch {
      throw new AudioError(404, "This narration has not been uploaded.");
    }
  }
  const content = await getBookContent(bookId);
  if (!content || content.chapters.length !== manifest.coverage.totalChapters) {
    throw new AudioError(503, "The narration does not match this edition.");
  }
  const prefix = `${bookId}/${editionId}/${narratorId}/${manifest.generationId}/`;
  for (const chapter of manifest.chapters) {
    const source = content.chapters[chapter.chapterIndex];
    if (!source || chapter.chapterId !== source.id || chapter.segments.length !== source.paragraphs.length ||
      !chapter.audioPath.startsWith(prefix) || !(manifest.schemaVersion === 2 ? /^chapter-\d{4,6}\.opus$/ : /^chapter-\d{4,6}\.mp3$/).test(chapter.audioPath.slice(prefix.length))) {
      throw new AudioError(503, "The narration does not match this edition.");
    }
    for (let index = 0; index < chapter.segments.length; index++) {
      const segment = chapter.segments[index];
      const textHash = createHash("sha256").update(source.paragraphs[index], "utf8").digest("hex");
      if (segment.paragraphIndex !== index || segment.textHash !== textHash) {
        throw new AudioError(503, "The narration does not match this edition.");
      }
    }
    if (manifest.alignment === "word") {
      let wordIndex = 0;
      for (const [paragraphIndex, paragraph] of source.paragraphs.entries()) {
        for (const expected of wordsInText(paragraph)) {
          const word = chapter.words?.[wordIndex++];
          if (!word || word.paragraphIndex !== paragraphIndex || word.charStart !== expected.charStart || word.charEnd !== expected.charEnd ||
            !isTextBoundary(paragraph, word.charStart) || !isTextBoundary(paragraph, word.charEnd) ||
            word.cfi !== cfiForPosition(chapter.chapterIndex, paragraphIndex, expected.charStart)) {
            throw new AudioError(503, "The word timings do not match this edition.");
          }
        }
      }
      if (wordIndex !== chapter.words?.length) throw new AudioError(503, "The word timings do not match this edition.");
    }
  }
  return manifest;
}

export async function listNarrators(bookId: string): Promise<AudioNarratorSummary[]> {
  const editionId = editionFor(bookId);
  let names: string[];
  try {
    names = (await readdir(path.join(root, bookId, editionId), { withFileTypes: true }))
      .filter(entry => entry.isDirectory() && safeId.test(entry.name)).map(entry => entry.name);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
  const entries = await Promise.all(names.sort().map(async name => {
    try {
      const { narrator } = await getAudioManifest(bookId, name);
      return { id: narrator.id, name: narrator.name, language: narrator.language };
    } catch {
      // Never offer stale or partly written metadata to a reader.
      return null;
    }
  }));
  return entries.filter((entry): entry is AudioNarratorSummary => entry !== null);
}

export function localAudioFile(audioPath: string): string | null {
  if (process.env.AUDIO_STORAGE_MODE !== "local" || process.env.VERCEL === "1") return null;
  const resolved = path.resolve(root, audioPath);
  if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`)) return null;
  return resolved;
}

export async function signedAudioUrl(audioPath: string, durationSeconds: number): Promise<string> {
  const projectUrl = process.env.SUPABASE_URL?.trim();
  const secret = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();
  const bucket = process.env.AUDIO_STORAGE_BUCKET?.trim() || "readlay-audio";
  if (!projectUrl || !secret || !safeId.test(bucket)) throw new AudioError(503, "Audio storage is not configured.");
  let base: URL;
  try { base = new URL(projectUrl); } catch { throw new AudioError(503, "Audio storage is not configured."); }
  if (base.protocol !== "https:" || base.username || base.password || base.pathname !== "/") {
    throw new AudioError(503, "Audio storage is not configured.");
  }
  const objectPath = `${encodeURIComponent(bucket)}/${audioPath.split("/").map(encodeURIComponent).join("/")}`;
  const headers: Record<string, string> = { apikey: secret, "Content-Type": "application/json" };
  // Supabase's opaque secret keys are API keys, not bearer JWTs.
  if (!secret.startsWith("sb_secret_")) headers.Authorization = `Bearer ${secret}`;
  const response = await fetch(new URL(`/storage/v1/object/sign/${objectPath}`, base), {
    method: "POST",
    headers,
    body: JSON.stringify({ expiresIn: Math.min(86400, Math.max(3600, Math.ceil(durationSeconds / 0.75) + 900)) }),
    cache: "no-store",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw new AudioError(503, "The audio file could not be opened. Try again.");
  const result: unknown = await response.json();
  const signed = result && typeof result === "object" && "signedURL" in result ? result.signedURL : null;
  if (typeof signed !== "string") throw new AudioError(503, "The audio file could not be opened.");
  const target = new URL(signed.startsWith("/object/") ? `/storage/v1${signed}` : signed, base);
  if (target.origin !== base.origin || target.pathname !== `/storage/v1/object/sign/${objectPath}` || !target.searchParams.get("token")) {
    throw new AudioError(503, "The audio file could not be opened.");
  }
  return target.href;
}
