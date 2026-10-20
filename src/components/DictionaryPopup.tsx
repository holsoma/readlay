"use client";

import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import Link from "next/link";
import { BookOpen, Check, Plus, X } from "lucide-react";
import type { DictionaryLookup } from "@/lib/dictionary-types";
import { normaliseDictionaryWord } from "@/lib/dictionary-word";
import type { AnchoredWordSelection, SelectionAnchor } from "@/lib/epub-selection";
import { useWordBank } from "./WordBankProvider";
import { useReadlay } from "./ReadlayProvider";
import { PronunciationButton } from "./PronunciationButton";

const lookups = new Map<string, { result: DictionaryLookup; at: number }>();
type LookupState = { kind: "loading" } | { kind: "ready"; lookup: DictionaryLookup } | { kind: "missing" | "error"; message: string };

export default function DictionaryPopup({ selection, bookId, editionId, getAnchor, onClose, onUsePosition }: {
  selection: AnchoredWordSelection; bookId: string; editionId: string;
  getAnchor: () => SelectionAnchor | null; onClose: () => void; onUsePosition: () => void;
}) {
  const { words, ready, isSignedIn, saveWord } = useWordBank();
  const { openAuth, notify } = useReadlay();
  const [state, setState] = useState<LookupState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [placement, setPlacement] = useState<CSSProperties>({ left: Math.max(12, selection.anchor.left), top: selection.anchor.bottom + 10, visibility: "hidden" });
  const popup = useRef<HTMLDivElement>(null);
  const closed = useRef(false);
  const entry = state.kind === "ready" ? state.lookup.entry : null;
  const lookupWord = normaliseDictionaryWord(selection.word);
  const savedWord = words.find((item) => item.word === selection.word || item.word === entry?.word);
  const savedHere = savedWord?.occurrences.some((item) => item.bookId === bookId && item.editionId === editionId && item.chapterIndex === selection.chapterIndex && item.paragraphIndex === selection.paragraphIndex && item.charStart === selection.charStart && item.charEnd === selection.charEnd);

  useEffect(() => {
    if (!lookupWord) {
      const timer = setTimeout(() => setState({ kind: "missing", message: "No dictionary entry for this selection." }), 0);
      return () => clearTimeout(timer);
    }
    const abort = new AbortController();
    const cached = lookups.get(lookupWord);
    if (cached && Date.now() - cached.at < 24 * 60 * 60 * 1000) {
      const timer = setTimeout(() => setState({ kind: "ready", lookup: cached.result }), 0);
      return () => clearTimeout(timer);
    }
    async function lookup() {
      try {
        const response = await fetch(`/api/dictionary?word=${encodeURIComponent(lookupWord!)}`, { signal: abort.signal });
        const body = await response.json();
        if (!response.ok) {
          if (!abort.signal.aborted) setState({ kind: response.status === 404 ? "missing" : "error", message: body.error || "The dictionary is unavailable. Please try again." });
          return;
        }
        const result = body as DictionaryLookup;
        if (abort.signal.aborted) return;
        lookups.set(lookupWord!, { result, at: Date.now() });
        if (lookups.size > 100) lookups.delete(lookups.keys().next().value!);
        setState({ kind: "ready", lookup: result });
      } catch {
        if (!abort.signal.aborted) setState({ kind: "error", message: "The dictionary could not connect. Check your connection and try again." });
      }
    }
    void lookup();
    return () => abort.abort();
  }, [lookupWord, attempt]);

  const position = useCallback(() => {
    const box = popup.current;
    if (!box) return;
    const anchor = getAnchor() ?? selection.anchor;
    const viewport = window.visualViewport;
    const leftEdge = viewport?.offsetLeft ?? 0;
    const topEdge = viewport?.offsetTop ?? 0;
    const width = viewport?.width ?? window.innerWidth;
    const height = viewport?.height ?? window.innerHeight;
    const margin = 12;
    const boxWidth = Math.min(360, width - margin * 2);
    const maximumHeight = Math.min(460, height - margin * 2);
    const naturalHeight = Math.min(box.getBoundingClientRect().height, maximumHeight);
    const below = topEdge + height - margin - anchor.bottom - 10;
    const above = anchor.top - topEdge - margin - 10;
    const placeBelow = below >= naturalHeight || (above < naturalHeight && below >= above);
    // Keep the source word uncovered, including between the two native clicks.
    const maxHeight = Math.min(maximumHeight, Math.max(80, placeBelow ? below : above));
    const boxHeight = Math.min(naturalHeight, maxHeight);
    const idealTop = placeBelow ? anchor.bottom + 10 : anchor.top - boxHeight - 10;
    setPlacement({ width: boxWidth, maxHeight, left: Math.max(leftEdge + margin, Math.min(anchor.left, leftEdge + width - boxWidth - margin)), top: Math.max(topEdge + margin, Math.min(idealTop, topEdge + height - boxHeight - margin)), visibility: "visible" });
  }, [getAnchor, selection.anchor]);

  useEffect(() => {
    const frame = window.requestAnimationFrame(position);
    window.addEventListener("resize", position);
    window.addEventListener("scroll", position, true);
    window.visualViewport?.addEventListener("resize", position);
    window.visualViewport?.addEventListener("scroll", position);
    return () => {
      window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", position);
      window.removeEventListener("scroll", position, true);
      window.visualViewport?.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("scroll", position);
    };
  }, [position, state, savedHere, saveError]);

  useEffect(() => {
    closed.current = false;
    if (selection.keyboard) popup.current?.focus({ preventScroll: true });
    const dismiss = (event: PointerEvent) => {
      // The player reads this active word during its click, after pointerdown.
      if ((event.target as Element).closest?.("[data-reader-listen]")) return;
      if (!popup.current?.contains(event.target as Node)) onClose();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); onClose(); } };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => { closed.current = true; document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape); };
  }, [onClose, selection.keyboard]);

  async function save() {
    if (!isSignedIn) { onClose(); openAuth(); return; }
    if (!entry || saving || savedHere) return;
    setSaving(true);
    setSaveError("");
    try {
      await saveWord({ word: selection.word, bookId, editionId, chapterIndex: selection.chapterIndex, paragraphIndex: selection.paragraphIndex, charStart: selection.charStart, charEnd: selection.charEnd });
      if (!closed.current) notify(savedWord ? "This occurrence is saved in your Word Bank." : "Word saved to your Word Bank.");
    } catch (error) {
      if (!closed.current) setSaveError(error instanceof Error ? error.message : "This word could not be saved. Please try again.");
    } finally { if (!closed.current) setSaving(false); }
  }

  return <div ref={popup} className="reader-dictionary" role="dialog" aria-modal="false" aria-labelledby="dictionary-word-title" tabIndex={-1} style={placement} onPointerDown={(event) => event.stopPropagation()}>
    <div className="reader-dictionary-heading"><span>Dictionary</span><button className="reader-icon-button" aria-label="Close dictionary" onClick={onClose}><X size={17} /></button></div>
    <div className="reader-dictionary-word"><h2 id="dictionary-word-title">{selection.selectedText}</h2>{entry?.audioUrl && <PronunciationButton word={entry.word} audioUrl={entry.audioUrl} />}</div>
    {entry?.phonetic && <p className="reader-dictionary-phonetic">{entry.phonetic}</p>}
    {entry && entry.word.toLocaleLowerCase("en") !== selection.word && <p className="reader-dictionary-base">Definition of <strong>{entry.word}</strong></p>}
    {state.kind === "loading" && <p className="reader-dictionary-message" role="status">Looking up this word…</p>}
    {(state.kind === "missing" || state.kind === "error") && <div className="reader-dictionary-message" role="status"><p>{state.message}</p>{lookupWord && <button className="reader-dictionary-retry" onClick={() => { setState({ kind: "loading" }); setAttempt((value) => value + 1); }}>Try again</button>}</div>}
    {entry && <>
      <div className="reader-dictionary-meanings">{entry.meanings.map((meaning, index) => <section key={`${meaning.partOfSpeech}-${index}`}><h3>{meaning.partOfSpeech}</h3><ol>{meaning.definitions.map((definition, meaningIndex) => <li key={meaningIndex}><p>{definition.definition}</p>{definition.example && <p className="reader-dictionary-example">“{definition.example}”</p>}</li>)}</ol></section>)}</div>
      {!entry.audioUrl && <p className="reader-dictionary-unavailable">Pronunciation audio is unavailable for this word.</p>}
      <div className="reader-dictionary-source">{entry.sourceUrl && <a href={entry.sourceUrl} target="_blank" rel="noreferrer">Dictionary source</a>}{entry.licence && <a href={entry.licence.url} target="_blank" rel="noreferrer">{entry.licence.name}</a>}{entry.pronunciationLicence && <a href={entry.pronunciationLicence.url} target="_blank" rel="noreferrer">Audio: {entry.pronunciationLicence.name}</a>}</div>
      <div className="reader-dictionary-actions"><button className="reader-dictionary-save" disabled={saving || savedHere || (isSignedIn && !ready)} onClick={() => void save()}>{savedHere ? <Check size={15} /> : <Plus size={15} />}{savedHere ? "Already in Word Bank" : saving ? "Saving…" : savedWord ? "Save this occurrence" : isSignedIn ? "Save to Word Bank" : "Sign in to save"}</button><Link href="/word-bank" aria-label="Open Word Bank"><BookOpen size={16} /></Link></div>
      {savedWord && !savedHere && <p className="reader-dictionary-saved-note">Already in Word Bank. Save this location too.</p>}
      {saveError && <p className="reader-dictionary-save-error" role="alert">{saveError}</p>}
    </>}
    <button className="reader-dictionary-position" onClick={onUsePosition}>Set reading place</button>
  </div>;
}
