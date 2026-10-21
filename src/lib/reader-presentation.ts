import type { Chapter } from "@/data/books";
import { isTextBoundary, wordsInText } from "./epub-location";
import { normaliseDictionaryWord } from "./dictionary-word";

export type ReaderCorrection = { charStart: number; charEnd: number; sourceText: string; replacementText: string };
export type ParagraphPresentation = {
  kind?: "body" | "heading" | "subheading" | "quote" | "list-item" | "caption";
  hidden?: boolean;
  corrections?: ReaderCorrection[];
};
export type ReaderImage = {
  id: string; filename: string; mediaType: "image/jpeg" | "image/png" | "image/webp";
  beforeParagraph: number; width: number; height: number; alt: string; caption?: string;
};
export type ChapterPresentation = { title?: string; paragraphs: Record<string, ParagraphPresentation>; images: ReaderImage[] };
export type ReaderPresentation = { version: 1; bookId: string; editionId: string; chapters: ChapterPresentation[] };
export type ReaderRun = { type: "text"; text: string } | {
  type: "word"; text: string; charStart: number; charEnd: number; displayKey: string; lookupWord?: string;
};

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const coordinate = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const text = (value: unknown, limit: number): value is string => typeof value === "string" && value.length <= limit && !/[<>\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value);
const kinds = new Set(["body", "heading", "subheading", "quote", "list-item", "caption"]);
const formats = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp" } as const;

export function readerSectionHeading(title: string, index: number): { label: string; title: string } {
  const grouped = /^(.+?)\s*\/\s*(\d+)\s*:\s*(.+)$/u.exec(title);
  if (grouped) return { label: `${grouped[1]} / Chapter ${grouped[2]}`, title: grouped[3] };
  const named = /^(Chapter|Law|Habit|Part)\s+([\w]+)\s*[:/.]\s*(.+)$/iu.exec(title);
  if (named) return { label: `${named[1]} ${named[2]}`, title: named[3] };
  const numbered = /^(\d+)\.\s+(.+)$/u.exec(title);
  if (numbered) return { label: `Chapter ${numbered[1]}`, title: numbered[2] };
  const front = /^(preface|introduction|foreword|dedication|acknowledg(?:e)?ments)$/iu.exec(title);
  if (front) return { label: "Front matter", title: title[0].toUpperCase() + title.slice(1).toLowerCase() };
  return { label: `Reading section ${index + 1}`, title };
}

export function validReaderCorrections(value: unknown, source: string): ReaderCorrection[] {
  if (!Array.isArray(value) || !value.length) return [];
  const words = wordsInText(source);
  const seen = new Set<number>();
  const corrections: ReaderCorrection[] = [];
  for (const item of value.slice(0, 1000)) {
    if (!record(item) || !coordinate(item.charStart) || !coordinate(item.charEnd) || item.charEnd <= item.charStart ||
      !text(item.sourceText, 200) || !text(item.replacementText, 200) || !item.replacementText.trim() ||
      !isTextBoundary(source, item.charStart) || !isTextBoundary(source, item.charEnd) ||
      source.slice(item.charStart, item.charEnd) !== item.sourceText || seen.has(item.charStart)) continue;
    if (!words.some((word) => word.charStart === item.charStart && word.charEnd === item.charEnd)) continue;
    const replacementWords = wordsInText(item.replacementText);
    if (!replacementWords.length || replacementWords.length > 6) continue;
    seen.add(item.charStart);
    corrections.push({ charStart: item.charStart, charEnd: item.charEnd, sourceText: item.sourceText, replacementText: item.replacementText });
  }
  return corrections;
}

/** Readability metadata never replaces the source text used for progress and audio. */
export function parseReaderPresentation(value: unknown, bookId: string, editionId: string, chapters: Chapter[]): ReaderPresentation | null {
  if (!record(value) || value.version !== 1 || value.bookId !== bookId || value.editionId !== editionId ||
    !Array.isArray(value.chapters) || value.chapters.length !== chapters.length) return null;
  const parsed: ChapterPresentation[] = [];
  for (const [index, input] of value.chapters.entries()) {
    if (!record(input) || !record(input.paragraphs) || !Array.isArray(input.images)) return null;
    const paragraphs: Record<string, ParagraphPresentation> = {};
    for (const [key, settings] of Object.entries(input.paragraphs)) {
      if (!/^(?:0|[1-9]\d*)$/u.test(key) || !record(settings) || !chapters[index].paragraphs[Number(key)]) continue;
      const source = chapters[index].paragraphs[Number(key)];
      const kind = typeof settings.kind === "string" && kinds.has(settings.kind) ? settings.kind as ParagraphPresentation["kind"] : undefined;
      const corrections = validReaderCorrections(settings.corrections, source);
      paragraphs[key] = { ...(kind ? { kind } : {}), ...(settings.hidden === true ? { hidden: true } : {}), ...(corrections.length ? { corrections } : {}) };
    }
    const images: ReaderImage[] = [];
    for (const image of input.images.slice(0, 1000)) {
      if (!record(image) || typeof image.id !== "string" || !/^[a-f0-9]{16,64}$/u.test(image.id) ||
        typeof image.mediaType !== "string" || !Object.hasOwn(formats, image.mediaType) ||
        image.filename !== image.id + formats[image.mediaType as keyof typeof formats] ||
        !coordinate(image.beforeParagraph) || image.beforeParagraph > chapters[index].paragraphs.length ||
        !coordinate(image.width) || !coordinate(image.height) || image.width < 1 || image.height < 1 || image.width * image.height > 40_000_000 ||
        !text(image.alt, 1000)) continue;
      images.push({ id: image.id, filename: image.filename as string, mediaType: image.mediaType as ReaderImage["mediaType"],
        beforeParagraph: image.beforeParagraph, width: image.width, height: image.height, alt: image.alt,
        ...(text(image.caption, 2000) && image.caption ? { caption: image.caption } : {}) });
    }
    parsed.push({ ...(text(input.title, 250) && input.title.trim() ? { title: input.title } : {}), paragraphs, images });
  }
  return { version: 1, bookId, editionId, chapters: parsed };
}

/** Every displayed word retains the complete original token's UTF-16 range. */
export function readerRuns(source: string, corrections: ReaderCorrection[] = []): ReaderRun[] {
  const changes = new Map(validReaderCorrections(corrections, source).map((item) => [item.charStart, item]));
  const runs: ReaderRun[] = [];
  let previous = 0;
  for (const word of wordsInText(source)) {
    if (previous < word.charStart) runs.push({ type: "text", text: source.slice(previous, word.charStart) });
    const correction = changes.get(word.charStart);
    const display = correction?.replacementText ?? word.text;
    let end = 0;
    for (const [part, shown] of wordsInText(display).entries()) {
      if (end < shown.charStart) runs.push({ type: "text", text: display.slice(end, shown.charStart) });
      const lookupWord = correction ? normaliseDictionaryWord(shown.text) : null;
      runs.push({ type: "word", text: shown.text, charStart: word.charStart, charEnd: word.charEnd,
        displayKey: `${word.charStart}:${part}`, ...(lookupWord ? { lookupWord } : {}) });
      end = shown.charEnd;
    }
    if (end < display.length) runs.push({ type: "text", text: display.slice(end) });
    previous = word.charEnd;
  }
  if (previous < source.length) runs.push({ type: "text", text: source.slice(previous) });
  return runs;
}
