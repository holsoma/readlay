"use client";

import { ChevronDown, ChevronUp, Headphones, Pause, Play, RotateCcw, RotateCw, Volume2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Chapter } from "@/data/books";
import { narratorGender, parseAudioChapter, parseAudioManifestIndex, parseAudioNarrators, type AudioManifest, type AudioManifestIndex, type AudioNarratorSummary } from "@/lib/audio-types";
import { isManifestForEdition, positionAtTime, seekTimeForPosition, type AudioPosition } from "@/lib/audio-sync";
import "./audio-dock.css";

export type ReaderMode = "reading" | "listening";
export type AudioSeekRequest = AudioPosition & { revision: number };
type AudioTarget = { manifest: AudioManifest; chapterIndex: number; serial: number; refresh: number; src: string };
type PlayerProps = {
  bookId: string; editionId: string; bookTitle: string; author: string; chapters: Chapter[];
  location: AudioPosition; seekRequest: AudioSeekRequest | null; mode: ReaderMode;
  onModeChange: (mode: ReaderMode) => void;
  onPositionChange: (position: AudioPosition, flush?: boolean) => void;
  onReturnToReading: (position: AudioPosition) => void;
  getReadingPosition?: () => AudioPosition;
};
const rates = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;
const preferenceKey = "readlay-audio-preferences";
const preloadLimit = 2 * 1024 * 1024;
const clock = (seconds: number) => { const whole = Math.max(0, Math.floor(seconds)); return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`; };
const sourceKey = (target: AudioTarget) => `${target.manifest.generationId}:${target.manifest.narrator.id}:${target.chapterIndex}:${target.refresh}`;
const chapterKey = (manifest: AudioManifestIndex, chapterIndex: number) => `${manifest.generationId}:${manifest.narrator.id}:${chapterIndex}`;
function dataSaver() { return typeof navigator !== "undefined" && !!(navigator as Navigator & { connection?: { saveData?: boolean } }).connection?.saveData; }

export default function AudiobookPlayer(props: PlayerProps) {
  const { bookId, editionId, bookTitle, author, chapters, location, seekRequest, mode, onModeChange, onPositionChange, onReturnToReading, getReadingPosition } = props;
  const audio = useRef<HTMLAudioElement>(null);
  const dock = useRef<HTMLElement>(null);
  const [narrators, setNarrators] = useState<AudioNarratorSummary[] | null>(null);
  const [narratorId, setNarratorId] = useState("");
  const [index, setIndex] = useState<AudioManifestIndex | null>(null);
  const [manifest, setManifest] = useState<AudioManifest | null>(null);
  const [loadingManifest, setLoadingManifest] = useState(false);
  const [target, setTarget] = useState<AudioTarget | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playbackRequested, setPlaybackRequested] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState<number>(1);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [retry, setRetry] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [voiceChapters, setVoiceChapters] = useState<Record<string, AudioManifest>>({});
  const [switchingVoice, setSwitchingVoice] = useState("");
  const callbacks = useRef({ onModeChange, onPositionChange, onReturnToReading, getReadingPosition });
  const locationRef = useRef(location);
  const modeRef = useRef(mode);
  const rateRef = useRef(rate);
  const activeTarget = useRef<AudioTarget | null>(null);
  const indexRef = useRef<AudioManifestIndex | null>(null);
  const loadedSource = useRef("");
  const pendingSeek = useRef<{ time: number; autoplay: boolean; serial: number; position: AudioPosition } | null>(null);
  const voiceSwitch = useRef<{ id: string; position: AudioPosition; controller: AbortController } | null>(null);
  const loadedIndexRetry = useRef(-1);
  const indexCache = useRef(new Map<string, Promise<AudioManifestIndex>>());
  const serial = useRef(0);
  const refresh = useRef(0);
  const playIntent = useRef(false);
  const lastReported = useRef("");
  const handledSeek = useRef(-1);
  const cueCache = useRef(new Map<string, Promise<AudioManifest>>());
  const preloaded = useRef<{ key: string; url: string } | null>(null);
  const preloading = useRef<AbortController | null>(null);
  const blobUrls = useRef(new Set<string>());
  const streamUrl = useCallback((source: AudioManifestIndex, chapterIndex: number, attempt = 0) => `/api/audio/${encodeURIComponent(bookId)}/stream?narrator=${encodeURIComponent(source.narrator.id)}&chapter=${chapterIndex}&v=${encodeURIComponent(source.generationId)}&retry=${attempt}`, [bookId]);
  const setPlaybackIntent = useCallback((value: boolean) => { playIntent.current = value; setPlaybackRequested(value); }, []);

  useEffect(() => { callbacks.current = { onModeChange, onPositionChange, onReturnToReading, getReadingPosition }; }, [onModeChange, onPositionChange, onReturnToReading, getReadingPosition]);
  useEffect(() => { locationRef.current = location; }, [location]);
  useEffect(() => { modeRef.current = mode; if (mode === "reading") { playIntent.current = false; audio.current?.pause(); } }, [mode]);
  useEffect(() => { rateRef.current = rate; if (audio.current) audio.current.playbackRate = rate; }, [rate]);

  useEffect(() => {
    const element = dock.current;
    const page = element?.closest<HTMLElement>(".reader-page");
    if (!element || !page) return;
    const property = "--reader-audio-dock-height";
    const previous = page.style.getPropertyValue(property);
    const update = () => page.style.setProperty(property, `${Math.ceil(element.getBoundingClientRect().height)}px`);
    update();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    observer?.observe(element);
    return () => {
      observer?.disconnect();
      if (previous) page.style.setProperty(property, previous);
      else page.style.removeProperty(property);
    };
  }, [expanded, mode, error, loadingManifest]);

  const releaseUnusedBlobs = useCallback(() => {
    const element = audio.current;
    // currentSrc can still name the previous recording while its successor loads.
    const current = element?.currentSrc || element?.src;
    const pending = activeTarget.current?.src;
    const next = preloaded.current?.url;
    for (const url of blobUrls.current) {
      if (url === current || url === pending || url === next) continue;
      URL.revokeObjectURL(url);
      blobUrls.current.delete(url);
    }
  }, []);

  const reportTime = useCallback((flush = false): AudioPosition | null => {
    const current = activeTarget.current;
    const element = audio.current;
    if (!current || !element || pendingSeek.current || voiceSwitch.current) return null;
    const chapter = current.manifest.chapters.find((item) => item.chapterIndex === current.chapterIndex);
    const next = chapter && positionAtTime(chapter, element.currentTime);
    if (!next) return null;
    const key = `${next.chapterIndex}:${next.paragraphIndex}:${next.charOffset ?? ""}`;
    if (flush || key !== lastReported.current) { lastReported.current = key; locationRef.current = next; callbacks.current.onPositionChange(next, flush); }
    return next;
  }, []);

  const reportSeek = useCallback(() => {
    const element = audio.current;
    if (!element) return;
    setTime(element.currentTime);
    if (element.currentTime < element.duration) setMessage("");
    if (modeRef.current === "listening") reportTime(true);
  }, [reportTime]);

  const seek = useCallback((seconds: number) => {
    const element = audio.current;
    if (!element || !Number.isFinite(seconds) || !Number.isFinite(element.duration) || pendingSeek.current) return;
    element.currentTime = Math.max(0, Math.min(element.duration, seconds));
    reportSeek();
  }, [reportSeek]);

  const loadChapter = useCallback((source: AudioManifestIndex, chapterIndex: number): Promise<AudioManifest> => {
    const key = chapterKey(source, chapterIndex);
    const cached = cueCache.current.get(key);
    if (cached) return cached;
    const promise = fetch(`/api/audio/${encodeURIComponent(bookId)}?narrator=${encodeURIComponent(source.narrator.id)}&chapter=${chapterIndex}&v=${encodeURIComponent(source.generationId)}`, { credentials: "same-origin", cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error(response.status === 401 ? "Sign in again to listen." : "This chapter could not be loaded.");
      const chapter = parseAudioChapter(await response.json(), source.alignment === "word");
      const summary = source.chapters.find((item) => item.chapterIndex === chapterIndex);
      const prepared = { ...source, coverage: { ...source.coverage, complete: false, chapterIndices: [chapterIndex] }, chapters: chapter ? [chapter] : [] } as AudioManifest;
      if (!chapter || !summary || chapter.audioPath !== summary.audioPath || chapter.durationSeconds !== summary.durationSeconds || chapter.byteLength !== summary.byteLength || chapter.chapterIndex !== chapterIndex || !isManifestForEdition(prepared, bookId, editionId, chapters)) throw new Error("This recording does not match the open edition.");
      return prepared;
    }).catch((failure: unknown) => { cueCache.current.delete(key); throw failure; });
    cueCache.current.set(key, promise);
    while (cueCache.current.size > 3) { const oldest = cueCache.current.keys().next().value; if (oldest) cueCache.current.delete(oldest); else break; }
    return promise;
  }, [bookId, editionId, chapters]);

  const loadNarratorIndex = useCallback((id: string): Promise<AudioManifestIndex> => {
    const key = `${bookId}:${editionId}:${id}:${retry}`;
    const cached = indexCache.current.get(key);
    if (cached) return cached;
    const promise = fetch(`/api/audio/${encodeURIComponent(bookId)}?narrator=${encodeURIComponent(id)}&index=1`, { credentials: "same-origin", cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error(response.status === 401 ? "Sign in again to listen." : "This voice could not be loaded.");
      const parsed = parseAudioManifestIndex(await response.json());
      if (!parsed || parsed.narrator.id !== id || parsed.bookId !== bookId || parsed.editionId !== editionId || parsed.coverage.totalChapters !== chapters.length || parsed.chapters.some((item) => chapters[item.chapterIndex]?.id !== item.chapterId)) throw new Error("This recording does not match the open edition.");
      return parsed;
    }).catch((failure: unknown) => { indexCache.current.delete(key); throw failure; });
    indexCache.current.set(key, promise);
    while (indexCache.current.size > 6) { const oldest = indexCache.current.keys().next().value; if (oldest) indexCache.current.delete(oldest); else break; }
    return promise;
  }, [bookId, editionId, chapters, retry]);

  const queuePosition = useCallback((nextManifest: AudioManifest, position: AudioPosition, autoplay: boolean, reload = false) => {
    audio.current?.pause();
    const start = seekTimeForPosition(nextManifest, position);
    if (start === null) { pendingSeek.current = null; callbacks.current.onModeChange("reading"); setError("Audio is not available at this position. You can keep reading."); setWaiting(false); return; }
    const nextSerial = ++serial.current;
    if (reload) { refresh.current += 1; preloading.current?.abort(); preloaded.current = null; }
    const warmed = !reload && preloaded.current?.key === chapterKey(nextManifest, position.chapterIndex) ? preloaded.current.url : undefined;
    const next = { manifest: nextManifest, chapterIndex: position.chapterIndex, serial: nextSerial, refresh: refresh.current, src: warmed ?? streamUrl(nextManifest, position.chapterIndex, refresh.current) };
    pendingSeek.current = { time: start, autoplay, serial: nextSerial, position };
    activeTarget.current = next;
    releaseUnusedBlobs();
    setManifest(nextManifest); setTime(start);
    setDuration(nextManifest.chapters.find((item) => item.chapterIndex === position.chapterIndex)?.durationSeconds ?? 0);
    setError(""); setMessage(""); setWaiting(true); setTarget(next);
  }, [streamUrl, releaseUnusedBlobs]);

  const openPosition = useCallback(async (position: AudioPosition, autoplay: boolean) => {
    if (voiceSwitch.current) { voiceSwitch.current.position = position; setPlaybackIntent(autoplay); return; }
    const source = indexRef.current;
    if (!source) return;
    const request = ++serial.current;
    setPlaybackIntent(autoplay);
    setWaiting(true);
    try {
      const prepared = await loadChapter(source, position.chapterIndex);
      if (source !== indexRef.current || request !== serial.current) return;
      queuePosition(prepared, position, playIntent.current && modeRef.current === "listening");
    } catch (failure: unknown) {
      if (source !== indexRef.current || request !== serial.current) return;
      setWaiting(false); setError(failure instanceof Error ? failure.message : "Audio could not be loaded.");
    }
  }, [loadChapter, queuePosition, setPlaybackIntent]);

  const applyPendingSeek = useCallback(() => {
    const element = audio.current;
    const pending = pendingSeek.current;
    if (!element || !pending || element.readyState < 1) return;
    try {
      element.currentTime = Math.min(pending.time, Number.isFinite(element.duration) ? element.duration : pending.time);
      element.playbackRate = rateRef.current;
      setTime(element.currentTime); setDuration(Number.isFinite(element.duration) ? element.duration : 0);
      pendingSeek.current = null; setWaiting(false);
      if (modeRef.current === "listening") reportTime(true);
      if (pending.autoplay && modeRef.current === "listening") void element.play().catch((failure: unknown) => {
        if (activeTarget.current?.serial !== pending.serial || (failure instanceof DOMException && failure.name === "AbortError")) return;
        setWaiting(false); setMessage("Press play to start the audio.");
      });
    } catch { setWaiting(false); setError("This audio position could not be opened. Retry playback."); }
  }, [reportTime]);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/audio/${encodeURIComponent(bookId)}`, { credentials: "same-origin", cache: "no-store", signal: controller.signal }).then(async (response) => {
      if (!response.ok) throw new Error(response.status === 401 ? "Sign in again to listen." : "Audio availability could not be checked.");
      const parsed = parseAudioNarrators(await response.json());
      if (!parsed) throw new Error("Audio availability could not be checked.");
      if (controller.signal.aborted) return;
      setNarrators(parsed);
      if (!parsed.length) return;
      let preferred = "";
      let preferredGender = "";
      try { const stored = JSON.parse(localStorage.getItem(preferenceKey) || "null"); if (typeof stored?.narratorId === "string") preferred = stored.narratorId; if (stored?.gender === "male" || stored?.gender === "female") preferredGender = stored.gender; if (rates.includes(stored?.rate)) setRate(stored.rate); } catch { /* Preferences are optional. */ }
      setLoadingManifest(true); setNarratorId(parsed.find((item) => item.id === preferred)?.id ?? parsed.find((item) => narratorGender(item) === preferredGender)?.id ?? parsed[0].id);
    }).catch((failure: unknown) => {
      if (controller.signal.aborted) return;
      setNarrators([]); setLoadingManifest(false); setError(failure instanceof Error ? failure.message : "Audio availability could not be checked.");
    });
    return () => controller.abort();
  }, [bookId, retry]);

  useEffect(() => {
    if (!narratorId) return;
    if (indexRef.current?.narrator.id === narratorId && loadedIndexRetry.current === retry) return;
    const controller = new AbortController();
    void loadNarratorIndex(narratorId).then((parsed) => {
      if (controller.signal.aborted) return;
      loadedIndexRetry.current = retry;
      indexRef.current = parsed; setIndex(parsed); setLoadingManifest(false); setError("");
    }).catch((failure: unknown) => {
      if (controller.signal.aborted) return;
      setManifest(null); setLoadingManifest(false); setError(failure instanceof Error ? failure.message : "This narrator could not be loaded.");
    });
    return () => controller.abort();
  }, [narratorId, loadNarratorIndex, retry]);

  useEffect(() => {
    if (!narrators?.length) return;
    let cancelled = false;
    // Only the open chapter is checked for each voice. A missing chapter or cue
    // never appears as an available choice, even when a book is partly prepared.
    for (const narrator of narrators) {
      if (narrator.chapterIndices && !narrator.chapterIndices.includes(location.chapterIndex)) continue;
      void loadNarratorIndex(narrator.id).then((source) => source.coverage.chapterIndices.includes(location.chapterIndex) ? loadChapter(source, location.chapterIndex) : null).then((prepared) => {
        if (!cancelled && prepared) setVoiceChapters((previous) => ({ ...previous, [narrator.id]: prepared }));
      }).catch(() => {});
    }
    return () => { cancelled = true; };
  }, [narrators, location.chapterIndex, loadNarratorIndex, loadChapter]);

  useEffect(() => {
    if (!index || !index.coverage.chapterIndices.includes(location.chapterIndex)) return;
    let cancelled = false;
    void loadChapter(index, location.chapterIndex).then((prepared) => {
      if (cancelled) return;
      setManifest(prepared);
      // Only this chapter's media metadata is fetched before the first Listen click.
      if (!activeTarget.current && !dataSaver()) queuePosition(prepared, locationRef.current, false);
    }).catch((failure: unknown) => { if (!cancelled) setError(failure instanceof Error ? failure.message : "This chapter could not be loaded."); });
    return () => { cancelled = true; };
  }, [index, location.chapterIndex, loadChapter, queuePosition]);

  useEffect(() => {
    if (!target || !audio.current) return;
    if (loadedSource.current === sourceKey(target) && audio.current.readyState >= 1 && !audio.current.error) applyPendingSeek();
    else audio.current.load();
  }, [target, applyPendingSeek]);

  useEffect(() => {
    if (!seekRequest || handledSeek.current === seekRequest.revision) return;
    handledSeek.current = seekRequest.revision;
    if (mode !== "listening") { audio.current?.pause(); return; }
    void openPosition(seekRequest, false);
  }, [seekRequest, mode, openPosition]);

  useEffect(() => {
    if (!playing || mode !== "listening" || typeof window.requestAnimationFrame !== "function") return;
    let frame = 0;
    const update = () => { reportTime(); frame = window.requestAnimationFrame(update); };
    frame = window.requestAnimationFrame(update);
    return () => window.cancelAnimationFrame(frame);
  }, [playing, mode, reportTime]);

  useEffect(() => {
    if (typeof document === "undefined") return;
    const flush = () => { if (document.visibilityState === "hidden" && modeRef.current === "listening") reportTime(true); };
    document.addEventListener("visibilitychange", flush);
    return () => document.removeEventListener("visibilitychange", flush);
  }, [reportTime]);

  useEffect(() => {
    if (!index || !target || !playing || mode !== "listening" || dataSaver()) return;
    const next = index.chapters.find((item) => item.chapterIndex === target.chapterIndex + 1);
    if (!next) return;
    const controller = new AbortController();
    preloading.current = controller;
    // Cue metadata is fetched one chapter ahead, never for the whole book.
    void loadChapter(index, next.chapterIndex).catch(() => {});
    const key = chapterKey(index, next.chapterIndex);
    if (preloaded.current?.key !== key && typeof next.byteLength === "number" && next.byteLength > 0 && next.byteLength <= preloadLimit) {
      void fetch(streamUrl(index, next.chapterIndex), { credentials: "same-origin", signal: controller.signal }).then(async (response) => {
        if (!response.ok || !response.body) return;
        const length = Number(response.headers.get("content-length"));
        if (length > preloadLimit) { await response.body.cancel(); return; }
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let size = 0;
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > preloadLimit || controller.signal.aborted) { await reader.cancel(); return; }
          chunks.push(value);
        }
        if (controller.signal.aborted || size !== next.byteLength) return;
        preloaded.current = null;
        releaseUnusedBlobs();
        const url = URL.createObjectURL(new Blob(chunks as BlobPart[], { type: index.format === "opus" ? "audio/ogg; codecs=opus" : "audio/mpeg" }));
        blobUrls.current.add(url);
        preloaded.current = { key, url };
        releaseUnusedBlobs();
      }).catch(() => {});
    }
    return () => { controller.abort(); if (preloading.current === controller) preloading.current = null; };
  }, [index, target, playing, mode, loadChapter, streamUrl, releaseUnusedBlobs]);

  useEffect(() => {
    const element = audio.current;
    const urls = blobUrls.current;
    return () => { voiceSwitch.current?.controller.abort(); voiceSwitch.current = null; if (modeRef.current === "listening") reportTime(true); element?.pause(); preloading.current?.abort(); preloaded.current = null; for (const url of urls) URL.revokeObjectURL(url); urls.clear(); };
  }, [reportTime]);

  useEffect(() => {
    if (!("mediaSession" in navigator) || !target) return;
    const mediaSession = navigator.mediaSession;
    const audioChapter = target.manifest.chapters.find((item) => item.chapterIndex === target.chapterIndex);
    if (typeof MediaMetadata !== "undefined") mediaSession.metadata = new MediaMetadata({ title: audioChapter?.title ?? bookTitle, artist: author, album: bookTitle });
    const handlers: Partial<Record<MediaSessionAction, MediaSessionActionHandler>> = {
      play: () => {
        setPlaybackIntent(true); modeRef.current = "listening"; callbacks.current.onModeChange("listening");
        if (mode === "reading") void openPosition(locationRef.current, true);
        else if (pendingSeek.current) { pendingSeek.current.autoplay = true; if (target && loadedSource.current === sourceKey(target)) applyPendingSeek(); }
        else if (!voiceSwitch.current) void audio.current?.play().catch(() => setMessage("Press play to start the audio."));
      },
      pause: () => { setPlaybackIntent(false); if (pendingSeek.current) pendingSeek.current.autoplay = false; audio.current?.pause(); reportTime(true); },
      seekbackward: ({ seekOffset }) => { if (audio.current) seek(audio.current.currentTime - (seekOffset ?? 15)); },
      seekforward: ({ seekOffset }) => { if (audio.current) seek(audio.current.currentTime + (seekOffset ?? 15)); },
      seekto: ({ seekTime }) => { if (typeof seekTime === "number") seek(seekTime); },
      nexttrack: () => { if (indexRef.current?.coverage.chapterIndices.includes(target.chapterIndex + 1)) void openPosition({ chapterIndex: target.chapterIndex + 1, paragraphIndex: 0, charOffset: 0 }, !audio.current?.paused); },
      previoustrack: () => { if (indexRef.current?.coverage.chapterIndices.includes(target.chapterIndex - 1)) void openPosition({ chapterIndex: target.chapterIndex - 1, paragraphIndex: 0, charOffset: 0 }, !audio.current?.paused); },
    };
    const registered: MediaSessionAction[] = [];
    for (const [action, handler] of Object.entries(handlers)) { try { mediaSession.setActionHandler(action as MediaSessionAction, handler!); registered.push(action as MediaSessionAction); } catch { /* Media Session support varies by browser. */ } }
    return () => { for (const action of registered) mediaSession.setActionHandler(action, null); mediaSession.metadata = null; };
  }, [target, bookTitle, author, mode, reportTime, openPosition, seek, setPlaybackIntent, applyPendingSeek]);

  function savePreferences(nextNarrator: string, nextRate: number) {
    const narrator = narrators?.find((item) => item.id === nextNarrator);
    const gender = narrator && narratorGender(narrator);
    try { localStorage.setItem(preferenceKey, JSON.stringify({ narratorId: nextNarrator, ...(gender ? { gender } : {}), rate: nextRate })); } catch { /* Keep the current session usable. */ }
  }
  async function changeNarrator(id: string) {
    if (id === narratorId || loadingManifest || !narrators?.some((item) => item.id === id)) return;
    const position = pendingSeek.current?.position ?? (modeRef.current === "listening" ? reportTime(true) : null) ?? locationRef.current;
    const prepared = voiceChapters[id];
    if (!prepared || seekTimeForPosition(prepared, position) === null) { setMessage("This voice is not available at this position."); return; }
    const autoplay = modeRef.current === "listening" && (!!pendingSeek.current?.autoplay || playIntent.current || !!audio.current && !audio.current.paused);
    audio.current?.pause(); serial.current += 1; pendingSeek.current = null;
    const request = { id, position, controller: new AbortController() };
    voiceSwitch.current?.controller.abort(); voiceSwitch.current = request;
    setPlaybackIntent(autoplay);
    preloading.current?.abort(); preloaded.current = null; releaseUnusedBlobs();
    setSwitchingVoice(id); setLoadingManifest(true); setWaiting(true); setError(""); setMessage(""); setPlaying(autoplay);
    try {
      const source = await loadNarratorIndex(id);
      let next = await loadChapter(source, request.position.chapterIndex);
      if (request.position.chapterIndex !== next.chapters[0]?.chapterIndex) next = await loadChapter(source, request.position.chapterIndex);
      if (request.controller.signal.aborted || voiceSwitch.current !== request) return;
      if (seekTimeForPosition(next, request.position) === null) throw new Error("This voice is not available at this position.");
      voiceSwitch.current = null;
      indexRef.current = source; loadedIndexRetry.current = retry;
      setIndex(source); setNarratorId(id); savePreferences(id, rate);
      queuePosition(next, request.position, playIntent.current && modeRef.current === "listening");
    } catch (failure: unknown) {
      if (request.controller.signal.aborted || voiceSwitch.current !== request) return;
      voiceSwitch.current = null;
      setWaiting(false); setPlaying(false); setError(failure instanceof Error ? failure.message : "This voice could not be loaded. Your place is unchanged.");
      if (playIntent.current && modeRef.current === "listening") void audio.current?.play().catch(() => setMessage("Press play to continue with the previous voice."));
    } finally {
      if (!request.controller.signal.aborted) { setSwitchingVoice(""); setLoadingManifest(false); }
    }
  }
  function listenFromHere() {
    if (!index) return;
    const position = callbacks.current.getReadingPosition?.() ?? locationRef.current;
    modeRef.current = "listening"; onModeChange("listening"); void openPosition(position, true);
  }
  function returnToReading() {
    if (mode === "reading") return;
    const position = voiceSwitch.current?.position ?? reportTime(true) ?? locationRef.current;
    if (pendingSeek.current) pendingSeek.current.autoplay = false;
    serial.current += 1; setPlaybackIntent(false); modeRef.current = "reading"; audio.current?.pause(); onReturnToReading(position);
  }
  function togglePlaying() {
    const element = audio.current;
    if (!element || !index) return;
    if (voiceSwitch.current) { setPlaybackIntent(!playIntent.current); setPlaying(playIntent.current); return; }
    if (pendingSeek.current) {
      const autoplay = !pendingSeek.current.autoplay;
      setPlaybackIntent(autoplay); pendingSeek.current.autoplay = autoplay; setPlaying(autoplay);
      if (autoplay && target && loadedSource.current === sourceKey(target)) applyPendingSeek();
      return;
    }
    if (!element.paused) { setPlaybackIntent(false); element.pause(); reportTime(true); return; }
    if (!target || element.ended) { listenFromHere(); return; }
    if (element.error) { if (manifest) queuePosition(manifest, locationRef.current, true, true); return; }
    setPlaybackIntent(true); setMessage(""); void element.play().catch(() => setMessage("Press play again to start the audio."));
  }
  function ended() {
    reportTime(true); setPlaying(false);
    const current = activeTarget.current;
    if (!current || modeRef.current !== "listening") return;
    const next = indexRef.current?.chapters.find((item) => item.chapterIndex === current.chapterIndex + 1);
    if (next) void openPosition({ chapterIndex: next.chapterIndex, paragraphIndex: 0, charOffset: 0 }, true);
    else setMessage("End of available audio.");
  }
  function retryAudio() { setError(""); if (manifest && target) { queuePosition(manifest, locationRef.current, true, true); return; } setLoadingManifest(!!narratorId); setRetry((value) => value + 1); }
  const currentChapter = target?.manifest.chapters.find((item) => item.chapterIndex === target.chapterIndex);
  const selectedCue = manifest && seekTimeForPosition(manifest, location);
  const chapterPrepared = !!index?.coverage.chapterIndices.includes(location.chapterIndex);
  const chapterLoaded = !!manifest?.chapters.some((item) => item.chapterIndex === location.chapterIndex);
  const canListen = chapterPrepared && selectedCue !== null && chapterLoaded;
  const maxTime = duration || currentChapter?.durationSeconds || 0;
  const src = target?.src;
  const exact = index?.alignment === "word";
  const controlsId = `reader-audio-controls-${bookId}`;
  const wantsPlayback = playing || (waiting && playbackRequested && mode === "listening");
  const voiceControls = narrators && narrators.length > 1 ? <div className="reader-voice-choice" role="group" aria-label="Audiobook voice"><span>Voice</span>{narrators.map((narrator) => {
    const gender = narratorGender(narrator);
    const label = gender === "female" ? "Female" : gender === "male" ? "Male" : narrator.name;
    const prepared = voiceChapters[narrator.id];
    const available = !!prepared && seekTimeForPosition(prepared, location) !== null;
    return <button key={narrator.id} type="button" aria-label={`${label} voice`} aria-pressed={narratorId === narrator.id} disabled={!available || loadingManifest} title={available ? narrator.name : `${label} voice is not available at this position`} onClick={() => void changeNarrator(narrator.id)}>{label}</button>;
  })}</div> : index && <span className="reader-narrator-name">{narratorGender(index.narrator) === "male" ? "Male voice" : narratorGender(index.narrator) === "female" ? "Female voice" : index.narrator.name}</span>;

  return <section ref={dock} className={`reader-audio reader-audio-dock ${mode === "listening" ? "is-listening" : ""}`} data-expanded={expanded} aria-label="Reading and listening">
    <div className="audio-dock-summary">
      <div className="audio-dock-context"><span>{bookTitle}</span><span>{mode === "listening" ? currentChapter?.title ?? chapters[location.chapterIndex]?.title : chapters[location.chapterIndex]?.title}</span></div>
      <div className="reader-mode-controls" role="group" aria-label="Reading mode">
        <button aria-pressed={mode === "reading"} onClick={returnToReading}>Read</button>
        <button data-reader-listen aria-label="Listen from here" aria-pressed={mode === "listening"} disabled={!canListen || loadingManifest} onPointerDown={(event) => { if (mode === "reading") event.preventDefault(); }} onClick={listenFromHere}><Headphones size={16} aria-hidden="true" />{mode === "listening" ? "Listening" : "Listen from here"}</button>
      </div>
      {mode === "listening" && index && <button className="reader-audio-play" onClick={togglePlaying} aria-label={wantsPlayback ? "Pause audiobook" : "Play audiobook"}>{wantsPlayback ? <Pause size={20} aria-hidden="true" /> : <Play size={20} aria-hidden="true" />}</button>}
      {!!narrators?.length && <button className="reader-icon-button audio-dock-expand" aria-label={expanded ? "Fewer audio controls" : "More audio controls"} aria-expanded={expanded} aria-controls={controlsId} onClick={() => setExpanded((value) => !value)}>{expanded ? <ChevronDown size={19} aria-hidden="true" /> : <ChevronUp size={19} aria-hidden="true" />}</button>}
    </div>
    {mode === "listening" && index && <div className="audio-dock-timeline">
      <span aria-live="off">{clock(time)}</span>
      <label className="reader-audio-seek"><span className="sr-only">Audio position in current chapter</span><input type="range" min={0} max={maxTime || 1} step={0.01} value={Math.min(time, maxTime || 1)} disabled={!target || maxTime <= 0 || waiting} aria-valuetext={`${clock(time)} of ${clock(maxTime)}`} onChange={(event) => seek(Number(event.target.value))} /></label>
      <span aria-live="off">{clock(maxTime)}</span>
    </div>}
    <div id={controlsId} className="audio-dock-details" hidden={!expanded}>
      {mode === "listening" && index && <>
        <div className="audio-dock-adjustments">
          <div className="audio-dock-skips"><button className="reader-icon-button" aria-label="Rewind 15 seconds" onClick={() => seek(time - 15)} disabled={!target || waiting}><RotateCcw size={18} aria-hidden="true" /><span className="reader-rewind-number">15</span></button><button className="reader-icon-button" aria-label="Forward 15 seconds" onClick={() => seek(time + 15)} disabled={!target || waiting}><RotateCw size={18} aria-hidden="true" /><span className="reader-rewind-number">15</span></button></div>
          <label className="reader-audio-speed"><span>Speed</span><select aria-label="Audiobook playback speed" value={rate} onChange={(event) => { const next = Number(event.target.value); if (rates.some((value) => value === next)) { setRate(next); if (audio.current) audio.current.playbackRate = next; savePreferences(narratorId, next); } }}>{rates.map((value) => <option key={value} value={value}>{value === 1 || value === 2 ? value.toFixed(1) : value}x</option>)}</select></label>
          {voiceControls}
        </div>
        <label className="reader-audio-chapters"><span>Chapter</span><select aria-label="Audiobook chapter" disabled={loadingManifest} value={target?.chapterIndex ?? location.chapterIndex} onChange={(event) => { reportTime(true); void openPosition({ chapterIndex: Number(event.target.value), paragraphIndex: 0, charOffset: 0 }, !!audio.current && !audio.current.paused); }}>{index.chapters.map((item) => <option key={item.chapterIndex} value={item.chapterIndex}>{item.chapterIndex + 1}. {item.title}</option>)}</select></label>
      </>}
      {mode === "reading" && voiceControls}
    </div>
    {!error && <p className="reader-audio-status" role="status">{message || (switchingVoice ? "Switching voice at your current word…" : narrators === null || loadingManifest ? "Checking audio…" : !narrators.length ? "Audio is not available for this edition." : chapterPrepared && !chapterLoaded ? "Loading audio positions…" : !canListen ? "Audio is not available at this position." : mode === "listening" ? waiting ? "Loading audio…" : <><Volume2 size={13} aria-hidden="true" />Paragraph {location.paragraphIndex + 1}. {exact ? "Switch to Read to return to this word." : "This recording resumes at paragraph boundaries."}</> : exact ? "Look up a word, then choose Listen from here to hear it." : "Paragraph audio. Listening starts at the beginning of the selected paragraph.")}</p>}
    {error && <div className="reader-audio-error"><p role="alert">{error}</p><button onClick={retryAudio}>Retry audio</button></div>}
    <audio ref={audio} preload="metadata" src={src}
      onLoadedMetadata={() => { if (target) loadedSource.current = sourceKey(target); applyPendingSeek(); releaseUnusedBlobs(); }} onCanPlay={() => { setWaiting(false); applyPendingSeek(); }} onEmptied={releaseUnusedBlobs}
      onPlaying={() => { setPlaying(true); setWaiting(false); setError(""); }} onPause={() => { setPlaying(false); if (modeRef.current === "listening") reportTime(true); }} onWaiting={() => setWaiting(true)}
      onTimeUpdate={() => { if (audio.current && !pendingSeek.current) { setTime(audio.current.currentTime); if (modeRef.current === "listening") reportTime(); } }} onSeeked={reportSeek}
      onDurationChange={() => { if (audio.current && Number.isFinite(audio.current.duration)) setDuration(audio.current.duration); }} onEnded={ended}
      onError={() => { if (!activeTarget.current) return; pendingSeek.current = null; setWaiting(false); setPlaying(false); setError("Audio could not be loaded. Check your connection and retry."); }} />
  </section>;
}
