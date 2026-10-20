"use client";

import Link from "next/link";
import { ArrowLeft, ArrowRight, Bookmark, BookmarkCheck, Check, ChevronLeft, List, Minus, Plus, Type, X } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Book, Chapter } from "@/data/books";
import { useReadlay } from "./ReadlayProvider";
import AudiobookPlayer, { type AudioSeekRequest, type ReaderMode } from "./AudiobookPlayer";
import type { AudioPosition } from "@/lib/audio-sync";
import "./reader.css";

type ReaderTheme = "light" | "sepia" | "dark";
type Panel = "contents" | "settings" | null;
const preferencesKey = "readlay-reader-preferences";

function validLocation(chapters: Chapter[], chapter: number, paragraph: number) {
  return Number.isInteger(chapter) && chapter >= 0 && chapter < chapters.length &&
    Number.isInteger(paragraph) && paragraph >= 0 && paragraph < chapters[chapter].paragraphs.length;
}

type ReaderProps = { book: Book; chapters: Chapter[]; editionId: string };

export default function Reader({ book, chapters, editionId }: ReaderProps) {
  return <ReaderContent key={`${book.id}:${editionId}`} book={book} chapters={chapters} editionId={editionId} />;
}

function ReaderContent({ book, chapters, editionId }: ReaderProps) {
  const { ready, getProgress, saveProgress, bookmarks, toggleBookmark, openAuth, notify, isSignedIn, syncStatus } = useReadlay();
  const progress = getProgress(book.id, editionId);
  const [chapterIndex, setChapterIndex] = useState(0);
  const [paragraphIndex, setParagraphIndex] = useState(0);
  const [fontSize, setFontSize] = useState(23);
  const [theme, setTheme] = useState<ReaderTheme>("light");
  const [panel, setPanel] = useState<Panel>(null);
  const [resumeReady, setResumeReady] = useState(false);
  const [mode, setMode] = useState<ReaderMode>("reading");
  const [audioSeek, setAudioSeek] = useState<AudioSeekRequest | null>(null);
  const initialised = useRef(false);
  const userHasActed = useRef(false);
  const pendingScroll = useRef<number | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const article = useRef<HTMLElement | null>(null);
  const lastSavedPosition = useRef("");
  const chapter = chapters[chapterIndex];
  const selectedText = chapter?.paragraphs[paragraphIndex] || "";
  const bookBookmarks = bookmarks.filter((entry) => entry.bookId === book.id && entry.editionId === editionId);
  const selectedBookmarked = bookBookmarks.some((entry) => entry.chapterIndex === chapterIndex && entry.paragraphIndex === paragraphIndex);
  const allParagraphs = chapters.reduce((total, item) => total + item.paragraphs.length, 0);
  const position = chapters.slice(0, chapterIndex).reduce((total, item) => total + item.paragraphs.length, 0) + paragraphIndex + 1;
  const overallProgress = allParagraphs ? Math.round(position / allParagraphs * 100) : 0;
  const syncCopy = !isSignedIn || syncStatus === "local" ? "Your place is saved on this device."
    : syncStatus === "syncing" ? "Saving your place…"
    : syncStatus === "error" ? "Saved on this device. Progress could not be synchronised."
    : "Your place is saved across devices.";

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const stored = JSON.parse(localStorage.getItem(preferencesKey) || "null");
        if (["light", "sepia", "dark"].includes(stored?.theme)) setTheme(stored.theme);
        if (Number.isInteger(stored?.fontSize) && stored.fontSize >= 18 && stored.fontSize <= 30) setFontSize(stored.fontSize);
      } catch { /* Reader preferences are optional when storage is unavailable. */ }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!ready || initialised.current) return;
    const timer = window.setTimeout(() => {
      initialised.current = true;
      if (userHasActed.current) { setResumeReady(true); return; }
      const params = new URLSearchParams(window.location.search);
      const queryChapter = Number(params.get("chapter"));
      const queryParagraph = Number(params.get("paragraph") ?? 0);
      const location = params.has("chapter") && validLocation(chapters, queryChapter, queryParagraph)
        ? { chapterIndex: queryChapter, paragraphIndex: queryParagraph }
        : progress;
      if (location && validLocation(chapters, location.chapterIndex, location.paragraphIndex)) {
        setChapterIndex(location.chapterIndex);
        setParagraphIndex(location.paragraphIndex);
        lastSavedPosition.current = `${location.chapterIndex}:${location.paragraphIndex}`;
        if (location.paragraphIndex > 0) pendingScroll.current = location.paragraphIndex;
      }
      setResumeReady(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [ready, progress, chapters]);

  useEffect(() => {
    if (!resumeReady || !article.current || pendingScroll.current === null) return;
    const paragraph = pendingScroll.current;
    pendingScroll.current = null;
    article.current?.querySelector(`[data-paragraph="${paragraph}"]`)?.scrollIntoView({ block: "center", behavior: "instant" });
  }, [chapterIndex, paragraphIndex, resumeReady, mode]);

  useEffect(() => {
    if (panel) {
      previousFocus.current = document.activeElement as HTMLElement;
      dialog.current?.showModal();
    } else if (dialog.current?.open) {
      dialog.current.close();
      previousFocus.current?.focus();
    }
  }, [panel]);

  function chooseParagraph(index: number) {
    if (!validLocation(chapters, chapterIndex, index)) return;
    userHasActed.current = true;
    setParagraphIndex(index);
    persistPosition(chapterIndex, index);
    setAudioSeek((current) => ({ chapterIndex, paragraphIndex: index, revision: (current?.revision ?? 0) + 1 }));
  }

  function chooseChapter(index: number) {
    if (!validLocation(chapters, index, 0)) return;
    userHasActed.current = true;
    setChapterIndex(index);
    setParagraphIndex(0);
    persistPosition(index, 0);
    setAudioSeek((current) => ({ chapterIndex: index, paragraphIndex: 0, revision: (current?.revision ?? 0) + 1 }));
    setPanel(null);
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  function persistPosition(nextChapter: number, nextParagraph: number) {
    const key = `${nextChapter}:${nextParagraph}`;
    if (lastSavedPosition.current === key) return;
    lastSavedPosition.current = key;
    saveProgress(nextChapter, nextParagraph, book.id, editionId);
  }

  function receiveAudioPosition(next: AudioPosition) {
    if (!validLocation(chapters, next.chapterIndex, next.paragraphIndex)) return;
    userHasActed.current = true;
    setChapterIndex(next.chapterIndex);
    setParagraphIndex(next.paragraphIndex);
    persistPosition(next.chapterIndex, next.paragraphIndex);
  }

  function returnToReading(next: AudioPosition) {
    if (!validLocation(chapters, next.chapterIndex, next.paragraphIndex)) return;
    pendingScroll.current = next.paragraphIndex;
    receiveAudioPosition(next);
    setMode("reading");
  }

  function updatePreferences(nextSize: number, nextTheme: ReaderTheme) {
    setFontSize(nextSize);
    setTheme(nextTheme);
    try { localStorage.setItem(preferencesKey, JSON.stringify({ fontSize: nextSize, theme: nextTheme })); } catch { /* Keep this session usable without storage. */ }
  }

  function bookmarkSelected() {
    userHasActed.current = true;
    toggleBookmark(chapterIndex, paragraphIndex, selectedText, book.id, editionId, chapter.title);
    persistPosition(chapterIndex, paragraphIndex);
    notify(selectedBookmarked ? "Bookmark removed." : "Passage bookmarked.");
  }

  if (!chapter || !allParagraphs) return <main id="main" className="reader-main"><h1>This book has no readable text.</h1><Link href="/">Back to library</Link></main>;
  if (!ready || !resumeReady) return <main id="main" className="reader-page reader-loading" aria-busy="true"><p role="status">Opening {book.title} at your saved place…</p></main>;

  return (
    <div className={`reader-page reader-theme-${theme} reader-is-${mode}`} style={{ "--reader-font-size": `${fontSize}px` } as CSSProperties}>
      <header className="reader-header">
        <Link className="reader-brand" href="/" aria-label="Readlay library">
          <span className="reader-brand-mark" aria-hidden="true"><i /><i /></span>
          <span>readlay<span className="reader-brand-dot">.</span></span>
        </Link>
        <div className="reader-book-name"><span>{book.title}</span><span>By {book.author}</span></div>
        <nav className="reader-tools" aria-label="Reading tools">
          <button className="reader-icon-button" aria-label="Open table of contents" aria-haspopup="dialog" onClick={() => setPanel("contents")}><List size={21} /></button>
          <button className="reader-icon-button reader-type-button" aria-label="Adjust reading appearance" aria-haspopup="dialog" onClick={() => setPanel("settings")}><Type size={21} /></button>
          <span className="reader-tools-divider" aria-hidden="true" />
          <button className={`reader-icon-button ${selectedBookmarked ? "is-bookmarked" : ""}`} aria-label={selectedBookmarked ? "Remove bookmark from current paragraph" : "Bookmark current paragraph"} aria-pressed={selectedBookmarked} onClick={bookmarkSelected}>{selectedBookmarked ? <BookmarkCheck size={21} /> : <Bookmark size={21} />}</button>
        </nav>
      </header>

      <main id="main" className="reader-main" tabIndex={-1} data-page>
        <div className="reader-topline"><Link href="/" className="reader-back"><ChevronLeft size={16} />Back to library</Link><span>{book.format}</span></div>
        {book.isComplete === false && <p className="reader-edition-warning"><strong>Incomplete edition.</strong> {book.availabilityNote}</p>}
        <AudiobookPlayer bookId={book.id} editionId={editionId} bookTitle={book.title} author={book.author} chapters={chapters} location={{ chapterIndex, paragraphIndex }} seekRequest={audioSeek} mode={mode} onModeChange={setMode} onPositionChange={receiveAudioPosition} onReturnToReading={returnToReading} />
        <div className="reader-layout">
          <aside className="reader-margin" aria-label="Current chapter"><span>{String(chapterIndex + 1).padStart(2, "0")}</span><span>of {String(chapters.length).padStart(2, "0")}</span><i aria-hidden="true" /></aside>
          <article ref={article} className="reader-article" aria-labelledby="reader-title">
            <div className="reader-chapter-label">Chapter {chapterIndex + 1}</div>
            <h1 id="reader-title" tabIndex={-1}>{chapter.title}</h1>
            <div className="reader-chapter-rule" aria-hidden="true"><i /><i /></div>
            <div className="reader-prose">
              {chapter.paragraphs.map((text, index) => {
                const isCurrent = index === paragraphIndex;
                const isBookmarked = bookBookmarks.some((entry) => entry.chapterIndex === chapterIndex && entry.paragraphIndex === index);
                return <div key={`${chapter.id}-${index}`} data-paragraph={index} className={`reader-passage ${isCurrent ? "is-current" : ""} ${isBookmarked ? "has-bookmark" : ""}`}>
                  <button className="reader-position-marker" onClick={() => chooseParagraph(index)} aria-label={`Save reading position at paragraph ${index + 1}`} aria-pressed={isCurrent} title="Save your place here">{isBookmarked ? <BookmarkCheck size={15} /> : <span />}</button>
                  <p className={index === 0 ? "reader-opening" : ""} onClick={() => chooseParagraph(index)}>{text}</p>
                </div>;
              })}
            </div>
            <div className="reader-place-note"><Check size={14} /><span>Paragraph {paragraphIndex + 1} of {chapter.paragraphs.length}. {syncCopy}</span></div>
          </article>
        </div>

        <footer className="reader-footer">
          <div className="reader-chapter-nav">
            <button className="reader-chapter-link" disabled={chapterIndex === 0} onClick={() => chooseChapter(chapterIndex - 1)}><ArrowLeft size={19} /><span><small>Previous chapter</small>{chapterIndex > 0 ? chapters[chapterIndex - 1].title : "The beginning"}</span></button>
            {chapterIndex < chapters.length - 1 ? <button className="reader-chapter-link reader-next" onClick={() => chooseChapter(chapterIndex + 1)}><span><small>Next chapter</small>{chapters[chapterIndex + 1].title}</span><ArrowRight size={19} /></button> : <Link className="reader-chapter-link reader-next" href="/"><span><small>{book.isComplete === false ? "End of available text" : "Book complete"}</small>Find your next read</span><ArrowRight size={19} /></Link>}
          </div>
          <div className="reader-progress-row"><span>{book.title}</span><span>{overallProgress}% through the book</span></div>
          <div className="reader-progress-track" role="progressbar" aria-label={`Reading position through ${book.title}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={overallProgress}><span style={{ scale: `${position / allParagraphs} 1` }} /></div>
          <div className="reader-save-row"><span>Select a paragraph to save your place.</span>{!isSignedIn && <button onClick={openAuth}>Sign in to read across devices<ArrowRight size={14} /></button>}</div>
        </footer>
      </main>

      <dialog ref={dialog} className="reader-dialog" aria-labelledby="reader-panel-title" onCancel={() => setPanel(null)} onClose={() => { setPanel(null); previousFocus.current?.focus(); }} onClick={(event) => { if (event.target === dialog.current) setPanel(null); }}>
        <div className="reader-panel-heading"><h2 id="reader-panel-title">{panel === "contents" ? "Contents" : "Reading appearance"}</h2><button className="reader-icon-button" aria-label={panel === "contents" ? "Close table of contents" : "Close reading settings"} onClick={() => setPanel(null)}><X size={20} /></button></div>
        {panel === "contents" ? <div className="reader-contents"><p className="reader-panel-caption">{book.title} <span>{chapters.length} reading sections</span></p><ol>{chapters.map((item, index) => <li key={item.id}><button className={index === chapterIndex ? "is-active" : ""} onClick={() => chooseChapter(index)} aria-current={index === chapterIndex ? "location" : undefined}><span>{String(index + 1).padStart(2, "0")}</span><span>{item.title}</span>{index === chapterIndex ? <Check size={17} /> : <ArrowRight size={17} />}</button></li>)}</ol><p className="reader-panel-help">Select a section to open it. Your current reading position will update.</p></div> : <div className="reader-settings"><div className="reader-setting-label">Text size <span>{fontSize}px</span></div><div className="reader-size-control"><button className="reader-icon-button" aria-label="Decrease text size" disabled={fontSize <= 18} onClick={() => updatePreferences(Math.max(18, fontSize - 1), theme)}><Minus size={19} /></button><span aria-hidden="true">Aa</span><button className="reader-icon-button" aria-label="Increase text size" disabled={fontSize >= 30} onClick={() => updatePreferences(Math.min(30, fontSize + 1), theme)}><Plus size={19} /></button></div><fieldset><legend>Page colour</legend><div className="reader-theme-options">{(["light", "sepia", "dark"] as const).map((item) => <button key={item} className={`reader-theme-option reader-swatch-${item}`} onClick={() => updatePreferences(fontSize, item)} aria-pressed={theme === item}><span>Aa</span><span>{item[0].toUpperCase() + item.slice(1)}</span>{theme === item && <Check size={15} />}</button>)}</div></fieldset><p className="reader-panel-help">Your reading preferences are saved on this device.</p></div>}
      </dialog>
    </div>
  );
}
