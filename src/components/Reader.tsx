"use client";

import Link from "next/link";
import { ArrowLeft, ArrowRight, Bookmark, BookmarkCheck, Check, ChevronLeft, List, Minus, Plus, Type, X } from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type KeyboardEvent } from "react";
import type { Book, Chapter } from "@/data/books";
import { useReadlay } from "./ReadlayProvider";
import AudiobookPlayer, { type AudioSeekRequest, type ReaderMode } from "./AudiobookPlayer";
import type { AudioPosition } from "@/lib/audio-sync";
import { cfiForPosition, wordsInText } from "@/lib/epub-location";
import "./reader.css";

type ReaderTheme = "light" | "sepia" | "dark";
type Panel = "contents" | "settings" | null;
const preferencesKey = "readlay-reader-preferences";
const positionKey = (position: AudioPosition | null) => position ? `${position.chapterIndex}:${position.paragraphIndex}:${position.charOffset ?? 0}` : "";

function validLocation(chapters: Chapter[], chapter: number, paragraph: number) {
  return Number.isInteger(chapter) && chapter >= 0 && chapter < chapters.length &&
    Number.isInteger(paragraph) && paragraph >= 0 && paragraph < chapters[chapter].paragraphs.length;
}

type ReaderProps = { book: Book; chapters: Chapter[]; editionId: string };
const WordParagraph = memo(function WordParagraph({ text, words, index, offset, onSelect, onMove, onSelection }: {
  text: string; words: ReturnType<typeof wordsInText>; index: number; offset?: number;
  onSelect: (event: MouseEvent<HTMLParagraphElement>, index: number) => void;
  onMove: (event: KeyboardEvent<HTMLParagraphElement>, index: number) => void;
  onSelection: () => void;
}) {
  return <p className={index === 0 ? "reader-opening" : ""} tabIndex={0} aria-describedby="reader-word-help" onClick={(event) => onSelect(event, index)} onKeyDown={(event) => onMove(event, index)} onKeyUp={(event) => { if (event.shiftKey) onSelection(); }}>{words.length ? words.map((word, wordIndex) => <span key={word.charStart}>{text.slice(wordIndex ? words[wordIndex - 1].charEnd : 0, word.charStart)}<span className={`reader-word ${offset === word.charStart ? "is-current-word" : ""}`} data-word-start={word.charStart} data-word-end={word.charEnd} tabIndex={-1}>{text.slice(word.charStart, word.charEnd)}</span>{wordIndex === words.length - 1 ? text.slice(word.charEnd) : ""}</span>) : text}</p>;
});

export default function Reader({ book, chapters, editionId }: ReaderProps) {
  return <ReaderContent key={`${book.id}:${editionId}`} book={book} chapters={chapters} editionId={editionId} />;
}

function ReaderContent({ book, chapters, editionId }: ReaderProps) {
  const { ready, getProgress, saveProgress, bookmarks, toggleBookmark, openAuth, notify, isSignedIn, syncStatus } = useReadlay();
  const progress = getProgress(book.id, editionId);
  const [chapterIndex, setChapterIndex] = useState(0);
  const [paragraphIndex, setParagraphIndex] = useState(0);
  const [charOffset, setCharOffset] = useState<number | undefined>(undefined);
  const [liveHighlight, setLiveHighlight] = useState(true);
  const [fontSize, setFontSize] = useState(23);
  const [theme, setTheme] = useState<ReaderTheme>("light");
  const [panel, setPanel] = useState<Panel>(null);
  const [resumeReady, setResumeReady] = useState(false);
  const [mode, setMode] = useState<ReaderMode>("reading");
  const [audioSeek, setAudioSeek] = useState<AudioSeekRequest | null>(null);
  const initialised = useRef(false);
  const userHasActed = useRef(false);
  const pendingScroll = useRef<AudioPosition | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const article = useRef<HTMLElement | null>(null);
  const lastSavedPosition = useRef("");
  const observedProgress = useRef("");
  const awaitingProgress = useRef<string | null>(null);
  const localRevision = useRef(0);
  const positionRef = useRef<AudioPosition>({ chapterIndex: 0, paragraphIndex: 0 });
  const pendingSave = useRef<AudioPosition | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveProgressRef = useRef(saveProgress);
  const wordHandlers = useRef({ selectWord, moveWord, selectRange: () => { const selected = selectionPosition(); if (selected) receiveAudioPosition(selected, true); } });
  useEffect(() => { wordHandlers.current = { selectWord, moveWord, selectRange: () => { const selected = selectionPosition(); if (selected) receiveAudioPosition(selected, true); } }; });
  const handleWordSelect = useCallback((event: MouseEvent<HTMLParagraphElement>, index: number) => wordHandlers.current.selectWord(event, index), []);
  const handleWordMove = useCallback((event: KeyboardEvent<HTMLParagraphElement>, index: number) => wordHandlers.current.moveWord(event, index), []);
  const handleRangeSelect = useCallback(() => wordHandlers.current.selectRange(), []);
  const chapter = chapters[chapterIndex];
  const chapterWords = useMemo(() => chapter?.paragraphs.map((text) => wordsInText(text)) ?? [], [chapter]);
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

  useEffect(() => { saveProgressRef.current = saveProgress; }, [saveProgress]);
  const flushProgress = useCallback(() => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    const next = pendingSave.current;
    if (!next) return;
    pendingSave.current = null;
    const key = `${next.chapterIndex}:${next.paragraphIndex}:${next.charOffset ?? ""}`;
    if (lastSavedPosition.current === key) return;
    lastSavedPosition.current = key;
    awaitingProgress.current = positionKey(next);
    saveProgressRef.current(next.chapterIndex, next.paragraphIndex, book.id, editionId, next.charOffset);
  }, [book.id, editionId]);

  useEffect(() => {
    const flush = () => { if (document.visibilityState === "hidden") flushProgress(); };
    document.addEventListener("visibilitychange", flush);
    window.addEventListener("pagehide", flushProgress);
    return () => { flushProgress(); document.removeEventListener("visibilitychange", flush); window.removeEventListener("pagehide", flushProgress); };
  }, [flushProgress]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      try {
        const stored = JSON.parse(localStorage.getItem(preferencesKey) || "null");
        if (["light", "sepia", "dark"].includes(stored?.theme)) setTheme(stored.theme);
        if (Number.isInteger(stored?.fontSize) && stored.fontSize >= 18 && stored.fontSize <= 30) setFontSize(stored.fontSize);
        if (typeof stored?.liveHighlight === "boolean") setLiveHighlight(stored.liveHighlight);
      } catch { /* Reader preferences are optional when storage is unavailable. */ }
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!ready || initialised.current) return;
    const timer = window.setTimeout(() => {
      initialised.current = true;
      observedProgress.current = positionKey(progress);
      if (userHasActed.current) { setResumeReady(true); return; }
      const params = new URLSearchParams(window.location.search);
      const queryChapter = Number(params.get("chapter"));
      const queryParagraph = Number(params.get("paragraph") ?? 0);
      const queryOffset = Number(params.get("offset"));
      const location = params.has("chapter") && validLocation(chapters, queryChapter, queryParagraph)
        ? { chapterIndex: queryChapter, paragraphIndex: queryParagraph, ...(params.has("offset") && Number.isSafeInteger(queryOffset) && queryOffset >= 0 ? { charOffset: queryOffset } : {}) }
        : progress;
      if (location && validLocation(chapters, location.chapterIndex, location.paragraphIndex)) {
        setChapterIndex(location.chapterIndex);
        setParagraphIndex(location.paragraphIndex);
        const offset = typeof location.charOffset === "number" && location.charOffset <= chapters[location.chapterIndex].paragraphs[location.paragraphIndex].length ? location.charOffset : undefined;
        setCharOffset(offset);
        positionRef.current = { chapterIndex: location.chapterIndex, paragraphIndex: location.paragraphIndex, ...(offset !== undefined ? { charOffset: offset, cfi: cfiForPosition(location.chapterIndex, location.paragraphIndex, offset) } : {}) };
        lastSavedPosition.current = `${location.chapterIndex}:${location.paragraphIndex}:${offset ?? ""}`;
        if (location.paragraphIndex > 0 || offset !== undefined) pendingScroll.current = positionRef.current;
      }
      setResumeReady(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [ready, progress, chapters]);

  useEffect(() => {
    if (!ready || !resumeReady) return;
    const key = positionKey(progress);
    // A local flush reaches Provider asynchronously. An older pull must not win
    // before that local position appears in Provider's projected state.
    if (awaitingProgress.current === key) awaitingProgress.current = null;
    if (!isSignedIn || syncStatus !== "synced" || awaitingProgress.current) return;
    if (observedProgress.current === key) return;
    if (mode !== "reading" || pendingSave.current || !progress || !validLocation(chapters, progress.chapterIndex, progress.paragraphIndex)) { observedProgress.current = key; return; }
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed && selection.focusNode && article.current?.contains(selection.focusNode)) { observedProgress.current = key; return; }
    if (positionKey(positionRef.current) === key) { observedProgress.current = key; return; }
    const offset = typeof progress.charOffset === "number" && progress.charOffset <= chapters[progress.chapterIndex].paragraphs[progress.paragraphIndex].length ? progress.charOffset : undefined;
    const next: AudioPosition = { chapterIndex: progress.chapterIndex, paragraphIndex: progress.paragraphIndex, ...(offset !== undefined ? { charOffset: offset, cfi: cfiForPosition(progress.chapterIndex, progress.paragraphIndex, offset) } : {}) };
    const revision = localRevision.current;
    const timer = window.setTimeout(() => {
      observedProgress.current = key;
      if (localRevision.current !== revision || pendingSave.current || awaitingProgress.current) return;
      positionRef.current = next;
      lastSavedPosition.current = `${next.chapterIndex}:${next.paragraphIndex}:${next.charOffset ?? ""}`;
      pendingScroll.current = next;
      setChapterIndex(next.chapterIndex);
      setParagraphIndex(next.paragraphIndex);
      setCharOffset(next.charOffset);
    }, 0);
    return () => window.clearTimeout(timer);
  // Local coordinates also acknowledge saves that Provider deduplicates because
  // its projected position already matches, without publishing a new snapshot.
  }, [ready, resumeReady, isSignedIn, syncStatus, mode, progress, chapters, chapterIndex, paragraphIndex, charOffset]);

  useEffect(() => {
    if (!resumeReady || !article.current || pendingScroll.current === null) return;
    const position = pendingScroll.current;
    pendingScroll.current = null;
    const passage = article.current.querySelector(`[data-paragraph="${position.paragraphIndex}"]`);
    const word = typeof position.charOffset === "number" ? passage?.querySelector<HTMLElement>(`[data-word-start="${position.charOffset}"]`) : null;
    (word ?? passage)?.scrollIntoView({ block: "center", behavior: "instant" });
    if (word && mode === "reading") word.focus({ preventScroll: true });
  }, [chapterIndex, paragraphIndex, charOffset, resumeReady, mode]);

  useEffect(() => {
    if (panel) {
      previousFocus.current = document.activeElement as HTMLElement;
      dialog.current?.showModal();
    } else if (dialog.current?.open) {
      dialog.current.close();
      previousFocus.current?.focus();
    }
  }, [panel]);

  function chooseParagraph(index: number, offset = 0) {
    if (!validLocation(chapters, chapterIndex, index)) return;
    userHasActed.current = true;
    setParagraphIndex(index);
    const next = { chapterIndex, paragraphIndex: index, charOffset: offset, cfi: cfiForPosition(chapterIndex, index, offset) };
    setCharOffset(offset);
    positionRef.current = next;
    persistPosition(next);
    setAudioSeek((current) => ({ ...next, revision: (current?.revision ?? 0) + 1 }));
  }

  function chooseChapter(index: number) {
    if (!validLocation(chapters, index, 0)) return;
    userHasActed.current = true;
    setChapterIndex(index);
    setParagraphIndex(0);
    setCharOffset(0);
    const next = { chapterIndex: index, paragraphIndex: 0, charOffset: 0, cfi: cfiForPosition(index, 0, 0) };
    positionRef.current = next;
    persistPosition(next);
    setAudioSeek((current) => ({ ...next, revision: (current?.revision ?? 0) + 1 }));
    setPanel(null);
    window.scrollTo({ top: 0, behavior: "instant" });
  }

  function persistPosition(next: AudioPosition, immediate = true) {
    localRevision.current += 1;
    pendingSave.current = next;
    if (immediate) flushProgress();
    else if (!saveTimer.current) saveTimer.current = setTimeout(flushProgress, 1000);
  }

  function receiveAudioPosition(next: AudioPosition, immediate = false) {
    if (!validLocation(chapters, next.chapterIndex, next.paragraphIndex)) return;
    userHasActed.current = true;
    setChapterIndex(next.chapterIndex);
    setParagraphIndex(next.paragraphIndex);
    setCharOffset(next.charOffset);
    positionRef.current = next;
    persistPosition(next, immediate);
  }

  function returnToReading(next: AudioPosition) {
    if (!validLocation(chapters, next.chapterIndex, next.paragraphIndex)) return;
    pendingScroll.current = next;
    receiveAudioPosition(next, true);
    window.getSelection()?.removeAllRanges();
    setMode("reading");
  }

  function selectionPosition(): AudioPosition | null {
    const selection = window.getSelection();
    if (!selection?.focusNode || selection.isCollapsed || !article.current?.contains(selection.focusNode)) return null;
    const node = selection.focusNode.nodeType === Node.ELEMENT_NODE ? selection.focusNode as Element : selection.focusNode.parentElement;
    const passage = node?.closest<HTMLElement>("[data-paragraph]");
    const paragraph = passage?.querySelector("p");
    if (!passage || !paragraph?.contains(selection.focusNode)) return null;
    const index = Number(passage.dataset.paragraph);
    if (!validLocation(chapters, chapterIndex, index)) return null;
    try {
      const range = document.createRange();
      range.selectNodeContents(paragraph);
      range.setEnd(selection.focusNode, selection.focusOffset);
      const offset = Math.min(range.toString().length, chapters[chapterIndex].paragraphs[index].length);
      const words = chapterWords[index];
      const word = words.find((item) => item.charEnd >= offset) ?? words.at(-1);
      if (!word) return null;
      return { chapterIndex, paragraphIndex: index, charOffset: word.charStart, cfi: cfiForPosition(chapterIndex, index, word.charStart) };
    } catch { return null; }
  }

  function readCurrentPosition() {
    const selected = selectionPosition();
    if (selected) { receiveAudioPosition(selected, true); return selected; }
    flushProgress();
    return positionRef.current;
  }

  function selectWord(event: MouseEvent<HTMLParagraphElement>, index: number) {
    const selection = window.getSelection();
    if (selection && !selection.isCollapsed) {
      const selected = selectionPosition();
      if (selected) chooseParagraph(selected.paragraphIndex, selected.charOffset);
      return;
    }
    const word = (event.target as Element).closest<HTMLElement>("[data-word-start]");
    if (word) chooseParagraph(index, Number(word.dataset.wordStart));
  }

  function moveWord(event: KeyboardEvent<HTMLParagraphElement>, index: number) {
    if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return;
    const words = chapterWords[index];
    if (!words.length) return;
    const current = index === paragraphIndex ? Math.max(0, words.findIndex((word) => word.charStart === charOffset)) : 0;
    const target = event.key === "ArrowRight" ? Math.min(current + 1, words.length - 1) : event.key === "ArrowLeft" ? Math.max(current - 1, 0) : event.key === "Home" ? 0 : event.key === "End" ? words.length - 1 : event.key === "Enter" || event.key === " " ? current : null;
    if (target === null) return;
    event.preventDefault();
    chooseParagraph(index, words[target].charStart);
  }

  function updatePreferences(nextSize: number, nextTheme: ReaderTheme) {
    setFontSize(nextSize);
    setTheme(nextTheme);
    try { localStorage.setItem(preferencesKey, JSON.stringify({ fontSize: nextSize, theme: nextTheme, liveHighlight })); } catch { /* Keep this session usable without storage. */ }
  }

  function bookmarkSelected() {
    userHasActed.current = true;
    toggleBookmark(chapterIndex, paragraphIndex, selectedText, book.id, editionId, chapter.title);
    persistPosition(positionRef.current);
    notify(selectedBookmarked ? "Bookmark removed." : "Passage bookmarked.");
  }

  if (!chapter || !allParagraphs) return <main id="main" className="reader-main"><h1>This book has no readable text.</h1><Link href="/">Back to library</Link></main>;
  if (!ready || !resumeReady) return <main id="main" className="reader-page reader-loading" aria-busy="true"><p role="status">Opening {book.title} at your saved place…</p></main>;

  return (
    <div className={`reader-page reader-theme-${theme} reader-is-${mode} ${liveHighlight ? "reader-highlight-on" : ""}`} data-word-position={charOffset !== undefined ? "true" : undefined} style={{ "--reader-font-size": `${fontSize}px` } as CSSProperties} onPointerDownCapture={(event) => {
      if ((event.target as Element).closest("button,select,input,a")) {
        const selected = selectionPosition();
        if (selected) receiveAudioPosition(selected, true);
      }
    }}>
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
        <AudiobookPlayer bookId={book.id} editionId={editionId} bookTitle={book.title} author={book.author} chapters={chapters} location={{ chapterIndex, paragraphIndex, ...(charOffset !== undefined ? { charOffset, cfi: cfiForPosition(chapterIndex, paragraphIndex, charOffset) } : {}) }} seekRequest={audioSeek} mode={mode} onModeChange={setMode} onPositionChange={receiveAudioPosition} onReturnToReading={returnToReading} getReadingPosition={readCurrentPosition} />
        <div className="reader-layout">
          <aside className="reader-margin" aria-label="Current chapter"><span>{String(chapterIndex + 1).padStart(2, "0")}</span><span>of {String(chapters.length).padStart(2, "0")}</span><i aria-hidden="true" /></aside>
          <article ref={article} className="reader-article" aria-labelledby="reader-title">
            <div className="reader-chapter-label">Chapter {chapterIndex + 1}</div>
            <h1 id="reader-title" tabIndex={-1}>{chapter.title}</h1>
            <div className="reader-chapter-rule" aria-hidden="true"><i /><i /></div>
            <div className="reader-word-tools"><p id="reader-word-help">Tap a word to set your place. Use the left and right arrow keys when a paragraph has focus.</p><label><input type="checkbox" checked={liveHighlight} onChange={(event) => { const value = event.target.checked; setLiveHighlight(value); try { localStorage.setItem(preferencesKey, JSON.stringify({ fontSize, theme, liveHighlight: value })); } catch { /* The current session keeps this setting. */ } }} />Highlight narration</label></div>
            <div className="reader-prose">
              {chapter.paragraphs.map((text, index) => {
                const isCurrent = index === paragraphIndex;
                const isBookmarked = bookBookmarks.some((entry) => entry.chapterIndex === chapterIndex && entry.paragraphIndex === index);
                return <div key={`${chapter.id}-${index}`} data-paragraph={index} className={`reader-passage ${isCurrent ? "is-current" : ""} ${isBookmarked ? "has-bookmark" : ""}`}>
                  <button className="reader-position-marker" onClick={() => chooseParagraph(index)} aria-label={`Save reading position at paragraph ${index + 1}`} aria-pressed={isCurrent} title="Save your place here">{isBookmarked ? <BookmarkCheck size={15} /> : <span />}</button>
                  <WordParagraph text={text} words={chapterWords[index]} index={index} offset={isCurrent ? charOffset : undefined} onSelect={handleWordSelect} onMove={handleWordMove} onSelection={handleRangeSelect} />
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
          <div className="reader-save-row"><span>Tap a word to save your place.</span>{!isSignedIn && <button onClick={openAuth}>Sign in to read across devices<ArrowRight size={14} /></button>}</div>
        </footer>
      </main>

      <dialog ref={dialog} className="reader-dialog" aria-labelledby="reader-panel-title" onCancel={() => setPanel(null)} onClose={() => { setPanel(null); previousFocus.current?.focus(); }} onClick={(event) => { if (event.target === dialog.current) setPanel(null); }}>
        <div className="reader-panel-heading"><h2 id="reader-panel-title">{panel === "contents" ? "Contents" : "Reading appearance"}</h2><button className="reader-icon-button" aria-label={panel === "contents" ? "Close table of contents" : "Close reading settings"} onClick={() => setPanel(null)}><X size={20} /></button></div>
        {panel === "contents" ? <div className="reader-contents"><p className="reader-panel-caption">{book.title} <span>{chapters.length} reading sections</span></p><ol>{chapters.map((item, index) => <li key={item.id}><button className={index === chapterIndex ? "is-active" : ""} onClick={() => chooseChapter(index)} aria-current={index === chapterIndex ? "location" : undefined}><span>{String(index + 1).padStart(2, "0")}</span><span>{item.title}</span>{index === chapterIndex ? <Check size={17} /> : <ArrowRight size={17} />}</button></li>)}</ol><p className="reader-panel-help">Select a section to open it. Your current reading position will update.</p></div> : <div className="reader-settings"><div className="reader-setting-label">Text size <span>{fontSize}px</span></div><div className="reader-size-control"><button className="reader-icon-button" aria-label="Decrease text size" disabled={fontSize <= 18} onClick={() => updatePreferences(Math.max(18, fontSize - 1), theme)}><Minus size={19} /></button><span aria-hidden="true">Aa</span><button className="reader-icon-button" aria-label="Increase text size" disabled={fontSize >= 30} onClick={() => updatePreferences(Math.min(30, fontSize + 1), theme)}><Plus size={19} /></button></div><fieldset><legend>Page colour</legend><div className="reader-theme-options">{(["light", "sepia", "dark"] as const).map((item) => <button key={item} className={`reader-theme-option reader-swatch-${item}`} onClick={() => updatePreferences(fontSize, item)} aria-pressed={theme === item}><span>Aa</span><span>{item[0].toUpperCase() + item.slice(1)}</span>{theme === item && <Check size={15} />}</button>)}</div></fieldset><p className="reader-panel-help">Your reading preferences are saved on this device.</p></div>}
      </dialog>
    </div>
  );
}
