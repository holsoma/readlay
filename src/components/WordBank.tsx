"use client";

import Link from "next/link";
import { useDeferredValue, useMemo, useState } from "react";
import { ArrowRight, ArrowUpRight, BookA, Search, Trash2, X } from "lucide-react";
import { books } from "@/data/books";
import type { DictionaryEntry, DictionaryMeaning } from "@/lib/dictionary-types";
import type { SavedWord, WordStatus } from "@/lib/wordbank-types";
import { inflectionCandidates } from "@/lib/dictionary-word";
import { pronunciationRespelling } from "@/lib/pronunciation-respelling";
import { visibleWords, wordOccurrenceHref, wordStatusLabels, type WordBankFilter, type WordBankSort } from "@/lib/wordbank-view";
import { AppShell } from "./AppShell";
import { PronunciationButton } from "./PronunciationButton";
import { useReadlay } from "./ReadlayProvider";
import { useWordBank } from "./WordBankProvider";

const bookById = new Map(books.map((book) => [book.id, book]));
const bookTitles = new Map(books.map((book) => [book.id, book.title]));
const dateFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric" });
const filters: WordBankFilter[] = ["all", "new", "learning", "learned"];

function Meanings({ meaning, from = 0, count }: { meaning: DictionaryMeaning; from?: number; count?: number }) {
  const definitions = meaning.definitions.slice(from, count === undefined ? undefined : from + count);
  if (!definitions.length) return null;
  return <div className="word-bank-meaning"><p className="word-bank-part-of-speech">{meaning.partOfSpeech}</p>
    <ol start={from + 1}>{definitions.map((item, index) => <li key={index}><p>{item.definition}</p>{item.example && <p className="word-bank-example">{item.example}</p>}</li>)}</ol>
  </div>;
}

function Attribution({ entry }: { entry: DictionaryEntry }) {
  if (!entry.sourceUrl && !entry.licence && !entry.pronunciationSourceUrl && !entry.pronunciationLicence) return null;
  return <details className="word-bank-credits"><summary>Credits</summary><div className="word-bank-attribution">
    {entry.sourceUrl && <a href={entry.sourceUrl} target="_blank" rel="noreferrer">Definition source<ArrowUpRight size={12} aria-hidden="true" /></a>}
    {entry.licence && <a href={entry.licence.url} target="_blank" rel="noreferrer">{entry.licence.name}</a>}
    {entry.pronunciationSourceUrl && <a href={entry.pronunciationSourceUrl} target="_blank" rel="noreferrer">Audio source</a>}
    {entry.pronunciationLicence && <a href={entry.pronunciationLicence.url} target="_blank" rel="noreferrer">Audio: {entry.pronunciationLicence.name}</a>}
  </div></details>;
}

function WordEntry({ word }: { word: SavedWord }) {
  const { removeWord, setWordStatus } = useWordBank();
  const { notify } = useReadlay();
  const [pending, setPending] = useState<"status" | "remove" | null>(null);
  const [error, setError] = useState<string | null>(null);
  async function update(status: WordStatus) {
    if (pending) return;
    setPending("status"); setError(null);
    try { await setWordStatus(word.id, status); notify(`${word.word}: ${wordStatusLabels[status]}.`); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "The status could not be saved. Try again."); }
    finally { setPending(null); }
  }
  async function remove() {
    if (pending) return;
    setPending("remove"); setError(null);
    try { await removeWord(word.id); notify(`${word.word} removed from your Word Bank.`); }
    catch (failure) { setError(failure instanceof Error ? failure.message : "The word could not be removed. Try again."); setPending(null); }
  }
  const firstMeaning = word.entry.meanings[0];
  const respelling = pronunciationRespelling(word.entry.phonetic);
  const moreMeanings = word.entry.meanings.length > 1 || firstMeaning.definitions.length > 2;
  return <article className="word-bank-entry" aria-labelledby={`word-${word.id}`}>
    <header className="word-bank-entry-heading">
      <div><div className="word-bank-word-line"><h2 id={`word-${word.id}`}>{word.word}</h2>{respelling && <span className="word-bank-phonetic" aria-label={`Approximate pronunciation: ${respelling}`} title="Approximate pronunciation. Capitals show the stressed syllable.">{respelling}</span>}</div>
        <div className="word-bank-word-meta"><PronunciationButton key={word.entry.audioUrl} word={word.word} audioUrl={word.entry.audioUrl} /><span>Saved <time dateTime={word.savedAt}>{dateFormat.format(new Date(word.savedAt))}</time></span></div>
      </div>
      <div className="word-bank-entry-actions"><label className={`word-bank-status is-${word.status}`}><span className="sr-only">Learning status for {word.word}</span>
        <select value={word.status} disabled={pending !== null} onChange={(event) => void update(event.target.value as WordStatus)}>{Object.entries(wordStatusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      </label><button type="button" className="word-bank-remove" disabled={pending !== null} aria-label={`Remove ${word.word} from Word Bank`} title="Remove this word and its saved locations" onClick={() => void remove()}><Trash2 size={17} aria-hidden="true" /></button></div>
    </header>
    {pending && <p className="word-bank-entry-feedback" role="status">{pending === "status" ? "Saving status…" : "Removing word…"}</p>}
    {error && <p className="word-bank-error" role="alert">{error}</p>}
    <Meanings meaning={firstMeaning} count={2} />
    {moreMeanings && <details className="word-bank-more"><summary>More meanings</summary><Meanings meaning={firstMeaning} from={2} />{word.entry.meanings.slice(1).map((meaning, index) => <Meanings key={index} meaning={meaning} />)}</details>}
    <details className="word-bank-context" open={word.occurrences.length === 1}>
      <summary>From your reading<span>{word.occurrences.length} saved {word.occurrences.length === 1 ? "location" : "locations"}</span></summary>
      <div className="word-bank-occurrences">{word.occurrences.map((occurrence) => {
        const book = bookById.get(occurrence.bookId);
        const href = wordOccurrenceHref(occurrence, book);
        return <div className="word-bank-occurrence" key={occurrence.id}>
          {!inflectionCandidates(occurrence.selectedText).includes(word.word) && <p className="word-bank-source-spelling">Selected text: <strong>{occurrence.selectedText}</strong></p>}
          <blockquote>{occurrence.sentence}</blockquote>
          {href ? <Link href={href} className="word-bank-source" aria-label={`Return to ${occurrence.selectedText} in ${book!.title}`}>{book!.title}<span>Section {occurrence.chapterIndex + 1}, paragraph {occurrence.paragraphIndex + 1}</span><ArrowUpRight size={15} aria-hidden="true" /></Link> : <p className="word-bank-old-edition">{book?.title ?? "Source book"}: this saved edition is unavailable.</p>}
        </div>;
      })}</div>
    </details>
    <Attribution entry={word.entry} />
  </article>;
}

export function WordBank() {
  const { words, ready, isSignedIn, error, refresh } = useWordBank();
  const { openAuth } = useReadlay();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<WordBankFilter>("all");
  const [sort, setSort] = useState<WordBankSort>("newest");
  const [retrying, setRetrying] = useState(false);
  const deferredQuery = useDeferredValue(query);
  const shown = useMemo(() => visibleWords(words, deferredQuery, status, sort, bookTitles), [words, deferredQuery, status, sort]);
  async function retry() { setRetrying(true); try { await refresh(); } catch { /* Provider displays the response error. */ } finally { setRetrying(false); } }
  return <AppShell title="Word Bank"><div className="word-bank-page">
    <header className="word-bank-heading"><p>Words from your reading</p><h1>Word Bank<span>{words.length}</span></h1><p>Select a word in a book to look it up and save it here.</p></header>
    {!ready ? <p className="word-bank-loading" role="status">Opening your Word Bank…</p> : !isSignedIn ? <section className="word-bank-empty"><BookA size={30} strokeWidth={1.3} aria-hidden="true" /><h2>Keep the words you discover.</h2><p>Sign in with GitHub to save vocabulary and revisit it across devices.</p><button className="button primary" onClick={openAuth}>Sign in with GitHub<ArrowRight size={17} aria-hidden="true" /></button></section> : <>
      {error && <div className="word-bank-error-banner" role="alert"><p>{error}</p><button className="text-link" disabled={retrying} onClick={() => void retry()}>{retrying ? "Retrying…" : "Retry"}</button></div>}
      {(words.length > 0 || !error) && <>
        <div className="word-bank-toolbar"><label className="word-bank-search"><Search size={18} aria-hidden="true" /><span className="sr-only">Search your Word Bank</span><input type="search" placeholder="Search words, definitions or books" value={query} onChange={(event) => setQuery(event.target.value)} />{query && <button type="button" aria-label="Clear Word Bank search" onClick={() => setQuery("")}><X size={16} aria-hidden="true" /></button>}</label>
          <label className="word-bank-sort"><span>Sort</span><select aria-label="Word Bank sort order" value={sort} onChange={(event) => setSort(event.target.value as WordBankSort)}><option value="newest">Newest saved</option><option value="alphabetical">Word A to Z</option><option value="updated">Recently updated</option></select></label>
        </div>
        <div className="word-bank-filters" role="group" aria-label="Filter vocabulary by learning status">{filters.map((value) => <button type="button" key={value} aria-pressed={status === value} onClick={() => setStatus(value)}>{value === "all" ? "All words" : wordStatusLabels[value]}<span>{value === "all" ? words.length : words.filter((word) => word.status === value).length}</span></button>)}</div>
        <p className="word-bank-result-count" role="status" aria-live="polite">{shown.length} {shown.length === 1 ? "word" : "words"}{deferredQuery.trim() ? ` matching “${deferredQuery.trim()}”` : status !== "all" ? ` marked ${wordStatusLabels[status].toLowerCase()}` : " saved"}</p>
        {words.length === 0 ? <section className="word-bank-empty"><BookA size={30} strokeWidth={1.3} aria-hidden="true" /><h2>Your next word is in a book.</h2><p>Double-click a word, or press and hold it on your phone. Save its definition to start your collection.</p><Link href="/" className="text-link">Find a book<ArrowRight size={16} aria-hidden="true" /></Link></section> : shown.length ? <div className="word-bank-list" aria-busy={query !== deferredQuery}>{shown.map((word) => <WordEntry key={word.id} word={word} />)}</div> : <section className="word-bank-empty word-bank-no-results"><h2>No matching words.</h2><button className="text-link" onClick={() => { setQuery(""); setStatus("all"); }}>Clear search and filters</button></section>}
      </>}
    </>}
  </div></AppShell>;
}
