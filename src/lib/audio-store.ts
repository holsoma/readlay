import "server-only";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { readdir, readFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import path from "node:path";
import { books } from "@/data/books";
import { getBookContent } from "@/lib/book-content";
import { narratorGender, parseAudioManifest, type AudioManifest, type AudioNarratorSummary } from "@/lib/audio-types";
import { cfiForPosition, isTextBoundary, wordsInText } from "@/lib/epub-location";
import { AudioStorageError, audioStorageDestination, createSignedAudioUrl, publicationStorageDestination, type AudioStorageDestination } from "@/lib/audio-storage";

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
const publicationDestinations = new WeakMap<AudioManifest, AudioStorageDestination>();
export async function getAudioManifest(bookId: string, narratorId: string): Promise<AudioManifest> {
  if (process.env.VERCEL !== "1") return loadAudioManifest(bookId, narratorId);
  const key = JSON.stringify([bookId, narratorId, process.env.SUPABASE_URL, process.env.AUDIO_STORAGE_BUCKET, process.env.R2_ACCOUNT_ID, process.env.R2_AUDIO_BUCKET]);
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
    try {
      const compressed = await readFile(path.join(directory, "manifest.json.gz"));
      manifestBytes = gunzipSync(compressed, { maxOutputLength: 64 * 1024 * 1024 }).toString("utf8");
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
      manifestBytes = await readFile(path.join(directory, "manifest.json"), "utf8");
      if (Buffer.byteLength(manifestBytes, "utf8") > 64 * 1024 * 1024) throw new Error("Manifest too large");
    }
    value = JSON.parse(manifestBytes);
  } catch {
    throw new AudioError(404, "This narration is unavailable.");
  }
  const manifest = parseAudioManifest(value);
  if (!manifest || manifest.bookId !== bookId || manifest.editionId !== editionId || manifest.narrator.id !== narratorId) {
    throw new AudioError(503, "This narration needs to be prepared again.");
  }
  let storageDestination: AudioStorageDestination | null = null;
  if (process.env.AUDIO_STORAGE_MODE !== "local" || process.env.VERCEL === "1") {
    try {
      const published = JSON.parse(await readFile(path.join(directory, "published.json"), "utf8"));
      storageDestination = publicationStorageDestination(published);
      if (!storageDestination ||
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
  if (storageDestination) publicationDestinations.set(manifest, storageDestination);
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
  const entries = await Promise.all(names.sort().map(async (name): Promise<AudioNarratorSummary | null> => {
    try {
      const { narrator, coverage } = await getAudioManifest(bookId, name);
      const gender = narratorGender(narrator);
      return { id: narrator.id, name: narrator.name, language: narrator.language, ...(gender ? { gender } : {}), chapterIndices: coverage.chapterIndices };
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

export function audioStorageForManifest(manifest: AudioManifest): AudioStorageDestination | null {
  return publicationDestinations.get(manifest) ?? null;
}

export async function signedAudioUrl(audioPath: string, durationSeconds: number, manifest?: AudioManifest): Promise<string> {
  try {
    const destination = manifest ? publicationDestinations.get(manifest) : audioStorageDestination("supabase");
    if (!destination) throw new AudioStorageError("This narration has not been uploaded.");
    return await createSignedAudioUrl(destination, audioPath, durationSeconds);
  } catch (error) { throw new AudioError(503, error instanceof AudioStorageError ? error.message : "The audio file could not be opened."); }
}
