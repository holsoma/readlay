"use client";

import { Headphones, Pause, Play, RotateCcw, Volume2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { Chapter } from "@/data/books";
import { parseAudioManifest, parseAudioNarrators, type AudioManifest, type AudioNarratorSummary } from "@/lib/audio-types";
import { isManifestForEdition, seekTimeForParagraph, segmentAtTime, type AudioPosition } from "@/lib/audio-sync";

export type ReaderMode = "reading" | "listening";
export type AudioSeekRequest = AudioPosition & { revision: number };
type AudioTarget = { manifest: AudioManifest; chapterIndex: number; startSeconds: number; serial: number; refresh: number };
type PlayerProps = {
  bookId: string;
  editionId: string;
  bookTitle: string;
  author: string;
  chapters: Chapter[];
  location: AudioPosition;
  seekRequest: AudioSeekRequest | null;
  mode: ReaderMode;
  onModeChange: (mode: ReaderMode) => void;
  onPositionChange: (position: AudioPosition) => void;
  onReturnToReading: (position: AudioPosition) => void;
};

const rates = [0.75, 1, 1.25, 1.5, 1.75, 2] as const;
const preferenceKey = "readlay-audio-preferences";
const clock = (seconds: number) => {
  const whole = Math.max(0, Math.floor(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
};
const sourceKey = (target: AudioTarget) => `${target.manifest.generationId}:${target.manifest.narrator.id}:${target.chapterIndex}:${target.refresh}`;

export default function AudiobookPlayer({ bookId, editionId, bookTitle, author, chapters, location, seekRequest, mode, onModeChange, onPositionChange, onReturnToReading }: PlayerProps) {
  const audio = useRef<HTMLAudioElement>(null);
  const [narrators, setNarrators] = useState<AudioNarratorSummary[] | null>(null);
  const [narratorId, setNarratorId] = useState("");
  const [manifest, setManifest] = useState<AudioManifest | null>(null);
  const [loadingManifest, setLoadingManifest] = useState(false);
  const [target, setTarget] = useState<AudioTarget | null>(null);
  const [playing, setPlaying] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [rate, setRate] = useState<number>(1);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [retry, setRetry] = useState(0);
  const callbacks = useRef({ onModeChange, onPositionChange, onReturnToReading });
  const locationRef = useRef(location);
  const modeRef = useRef(mode);
  const rateRef = useRef(rate);
  const activeTarget = useRef<AudioTarget | null>(null);
  const loadedSource = useRef("");
  const pendingSeek = useRef<{ time: number; autoplay: boolean; serial: number } | null>(null);
  const serial = useRef(0);
  const refresh = useRef(0);
  const lastReported = useRef("");
  const handledSeek = useRef(-1);

  useEffect(() => { callbacks.current = { onModeChange, onPositionChange, onReturnToReading }; }, [onModeChange, onPositionChange, onReturnToReading]);
  useEffect(() => { locationRef.current = location; }, [location]);
  useEffect(() => { modeRef.current = mode; if (mode === "reading") audio.current?.pause(); }, [mode]);
  useEffect(() => { rateRef.current = rate; if (audio.current) audio.current.playbackRate = rate; }, [rate]);

  const reportTime = useCallback((): AudioPosition | null => {
    const current = activeTarget.current;
    const element = audio.current;
    if (!current || !element || pendingSeek.current) return null;
    const chapter = current.manifest.chapters.find((item) => item.chapterIndex === current.chapterIndex);
    const segment = chapter && segmentAtTime(chapter.segments, element.currentTime);
    if (!segment) return null;
    const next = { chapterIndex: current.chapterIndex, paragraphIndex: segment.paragraphIndex };
    const key = `${next.chapterIndex}:${next.paragraphIndex}`;
    if (key !== lastReported.current) {
      lastReported.current = key;
      callbacks.current.onPositionChange(next);
    }
    return next;
  }, []);

  const reportSeek = useCallback(() => {
    const element = audio.current;
    if (!element) return;
    setTime(element.currentTime);
    if (element.currentTime < element.duration) setMessage("");
    reportTime();
  }, [reportTime]);

  const seek = useCallback((seconds: number) => {
    const element = audio.current;
    if (!element || !Number.isFinite(seconds) || !Number.isFinite(element.duration) || pendingSeek.current) return;
    element.currentTime = Math.max(0, Math.min(element.duration, seconds));
    reportSeek();
  }, [reportSeek]);

  const queuePosition = useCallback((nextManifest: AudioManifest, position: AudioPosition, autoplay: boolean, reload = false) => {
    audio.current?.pause();
    const start = seekTimeForParagraph(nextManifest, position);
    if (start === null) {
      pendingSeek.current = null;
      callbacks.current.onModeChange("reading");
      setError("Audio is not available for this paragraph. You can keep reading.");
      setWaiting(false);
      return;
    }
    const nextSerial = ++serial.current;
    if (reload) refresh.current += 1;
    const next = { manifest: nextManifest, chapterIndex: position.chapterIndex, startSeconds: start, serial: nextSerial, refresh: refresh.current };
    pendingSeek.current = { time: start, autoplay, serial: nextSerial };
    activeTarget.current = next;
    setTime(start);
    setDuration(nextManifest.chapters.find((item) => item.chapterIndex === position.chapterIndex)?.durationSeconds ?? 0);
    setError("");
    setMessage("");
    setWaiting(true);
    setTarget(next);
  }, []);

  const applyPendingSeek = useCallback(() => {
    const element = audio.current;
    const pending = pendingSeek.current;
    if (!element || !pending || element.readyState < 1) return;
    try {
      element.currentTime = Math.min(pending.time, Number.isFinite(element.duration) ? element.duration : pending.time);
      element.playbackRate = rateRef.current;
      setTime(element.currentTime);
      setDuration(Number.isFinite(element.duration) ? element.duration : 0);
      pendingSeek.current = null;
      setWaiting(false);
      reportTime();
      if (pending.autoplay) {
        void element.play().catch((failure: unknown) => {
          if (activeTarget.current?.serial !== pending.serial || (failure instanceof DOMException && failure.name === "AbortError")) return;
          setWaiting(false);
          setMessage("Press play to start the audio.");
        });
      }
    } catch {
      setWaiting(false);
      setError("This audio position could not be opened. Retry playback.");
    }
  }, [reportTime]);

  useEffect(() => {
    const controller = new AbortController();
    void fetch(`/api/audio/${encodeURIComponent(bookId)}`, { credentials: "same-origin", cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(response.status === 401 ? "Sign in again to listen." : "Audio availability could not be checked.");
        const parsed = parseAudioNarrators(await response.json());
        if (!parsed) throw new Error("Audio availability could not be checked.");
        if (controller.signal.aborted) return;
        setNarrators(parsed);
        if (parsed.length) {
          let preferred = "";
          try {
            const stored = JSON.parse(localStorage.getItem(preferenceKey) || "null");
            if (typeof stored?.narratorId === "string") preferred = stored.narratorId;
            if (rates.includes(stored?.rate)) setRate(stored.rate);
          } catch { /* Audio remains usable when preferences cannot be read. */ }
          setLoadingManifest(true);
          setNarratorId(parsed.find((item) => item.id === preferred)?.id ?? parsed[0].id);
        }
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        setNarrators([]);
        setError(failure instanceof Error ? failure.message : "Audio availability could not be checked.");
      });
    return () => controller.abort();
  }, [bookId, retry]);

  useEffect(() => {
    if (!narratorId) return;
    const controller = new AbortController();
    void fetch(`/api/audio/${encodeURIComponent(bookId)}?narrator=${encodeURIComponent(narratorId)}`, { credentials: "same-origin", cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error(response.status === 401 ? "Sign in again to listen." : "This narrator could not be loaded.");
        const parsed = parseAudioManifest(await response.json());
        if (!parsed || parsed.narrator.id !== narratorId || !isManifestForEdition(parsed, bookId, editionId, chapters)) throw new Error("This recording does not match the open edition.");
        if (controller.signal.aborted) return;
        setManifest(parsed);
        setLoadingManifest(false);
        setError("");
        if (modeRef.current === "listening") queuePosition(parsed, locationRef.current, false);
      })
      .catch((failure: unknown) => {
        if (controller.signal.aborted) return;
        setManifest(null);
        setLoadingManifest(false);
        setError(failure instanceof Error ? failure.message : "This narrator could not be loaded.");
      });
    return () => controller.abort();
  }, [bookId, editionId, narratorId, chapters, retry, queuePosition]);

  useEffect(() => {
    if (!target || !audio.current) return;
    if (loadedSource.current === sourceKey(target) && audio.current.readyState >= 1 && !audio.current.error) applyPendingSeek();
    else audio.current.load();
  }, [target, applyPendingSeek]);

  useEffect(() => {
    if (!seekRequest || handledSeek.current === seekRequest.revision) return;
    handledSeek.current = seekRequest.revision;
    if (mode !== "listening" || !manifest) { audio.current?.pause(); return; }
    const timer = window.setTimeout(() => queuePosition(manifest, seekRequest, false), 0);
    return () => window.clearTimeout(timer);
  }, [seekRequest, mode, manifest, queuePosition]);

  useEffect(() => {
    const element = audio.current;
    return () => { element?.pause(); };
  }, []);

  useEffect(() => {
    if (!("mediaSession" in navigator) || !target) return;
    const mediaSession = navigator.mediaSession;
    const audioChapter = target.manifest.chapters.find((item) => item.chapterIndex === target.chapterIndex);
    if (typeof MediaMetadata !== "undefined") mediaSession.metadata = new MediaMetadata({ title: audioChapter?.title ?? bookTitle, artist: author, album: bookTitle });
    const handlers: Partial<Record<MediaSessionAction, MediaSessionActionHandler>> = {
      play: () => {
        callbacks.current.onModeChange("listening");
        const current = activeTarget.current;
        if (modeRef.current === "reading" && current) queuePosition(current.manifest, locationRef.current, true);
        else void audio.current?.play().catch(() => setMessage("Press play to start the audio."));
      },
      pause: () => { audio.current?.pause(); reportTime(); },
      seekbackward: ({ seekOffset }) => { if (audio.current) seek(audio.current.currentTime - (seekOffset ?? 15)); },
      seekforward: ({ seekOffset }) => { if (audio.current) seek(audio.current.currentTime + (seekOffset ?? 15)); },
      seekto: ({ seekTime }) => { if (typeof seekTime === "number") seek(seekTime); },
    };
    const registered: MediaSessionAction[] = [];
    for (const [action, handler] of Object.entries(handlers)) {
      try { mediaSession.setActionHandler(action as MediaSessionAction, handler!); registered.push(action as MediaSessionAction); } catch { /* Some browsers support only part of Media Session. */ }
    }
    return () => {
      for (const action of registered) mediaSession.setActionHandler(action, null);
      mediaSession.metadata = null;
    };
  }, [target, bookTitle, author, reportTime, queuePosition, seek]);

  function savePreferences(nextNarrator: string, nextRate: number) {
    try { localStorage.setItem(preferenceKey, JSON.stringify({ narratorId: nextNarrator, rate: nextRate })); } catch { /* This session still keeps the selection. */ }
  }

  function changeNarrator(id: string) {
    reportTime();
    audio.current?.pause();
    pendingSeek.current = null;
    activeTarget.current = null;
    loadedSource.current = "";
    setTarget(null);
    setManifest(null);
    setError("");
    setMessage("");
    setLoadingManifest(true);
    setNarratorId(id);
    savePreferences(id, rate);
  }

  function listenFromHere() {
    if (!manifest) return;
    onModeChange("listening");
    queuePosition(manifest, location, true);
  }

  function returnToReading() {
    if (mode === "reading") return;
    const position = reportTime() ?? location;
    if (pendingSeek.current) pendingSeek.current.autoplay = false;
    audio.current?.pause();
    onReturnToReading(position);
  }

  function togglePlaying() {
    const element = audio.current;
    if (!element || !manifest) return;
    if (!element.paused) { element.pause(); reportTime(); return; }
    if (!target) { listenFromHere(); return; }
    if (element.error) { queuePosition(manifest, location, true, true); return; }
    if (pendingSeek.current) { pendingSeek.current.autoplay = true; applyPendingSeek(); return; }
    if (element.ended) { listenFromHere(); return; }
    setMessage("");
    void element.play().catch(() => setMessage("Press play again to start the audio."));
  }

  function ended() {
    reportTime();
    setPlaying(false);
    const current = activeTarget.current;
    if (!current || modeRef.current !== "listening") return;
    const next = current.manifest.chapters.find((item) => item.chapterIndex === current.chapterIndex + 1);
    if (next?.segments[0]?.paragraphIndex === 0) {
      const position = { chapterIndex: next.chapterIndex, paragraphIndex: 0 };
      callbacks.current.onPositionChange(position);
      queuePosition(current.manifest, position, true);
    } else setMessage("End of available audio.");
  }

  function retryAudio() {
    setError("");
    if (manifest && target) { queuePosition(manifest, location, true, true); return; }
    setLoadingManifest(!!narratorId);
    setRetry((value) => value + 1);
  }

  const currentChapter = target?.manifest.chapters.find((item) => item.chapterIndex === target.chapterIndex);
  const selectedCue = manifest && seekTimeForParagraph(manifest, location);
  const canListen = !!manifest && selectedCue !== null;
  const maxTime = duration || currentChapter?.durationSeconds || 0;
  const src = target ? `/api/audio/${encodeURIComponent(bookId)}/stream?narrator=${encodeURIComponent(target.manifest.narrator.id)}&chapter=${target.chapterIndex}&v=${encodeURIComponent(target.manifest.generationId)}&retry=${target.refresh}` : undefined;

  return <section className={`reader-audio ${mode === "listening" ? "is-listening" : ""}`} aria-label="Reading and listening">
    <div className="reader-audio-heading">
      <div className="reader-mode-controls" role="group" aria-label="Reading mode">
        <button aria-pressed={mode === "reading"} onClick={returnToReading}>Read</button>
        <button aria-pressed={mode === "listening"} disabled={!canListen || loadingManifest} onClick={listenFromHere}><Headphones size={16} aria-hidden="true" />Listen from here</button>
      </div>
      {narrators && narrators.length > 1 ? <label className="reader-narrator"><span>Narrator</span><select value={narratorId} onChange={(event) => changeNarrator(event.target.value)}>{narrators.map((narrator) => <option key={narrator.id} value={narrator.id}>{narrator.name}</option>)}</select></label> : manifest && <span className="reader-narrator-name">{manifest.narrator.name}</span>}
    </div>
    {mode === "listening" && manifest && <div className="reader-audio-controls">
      <div className="reader-audio-transport">
        <button className="reader-audio-play" onClick={togglePlaying} aria-label={playing ? "Pause audiobook" : "Play audiobook"}>{playing ? <Pause size={20} aria-hidden="true" /> : <Play size={20} aria-hidden="true" />}</button>
        <button className="reader-icon-button" aria-label="Rewind 15 seconds" onClick={() => seek(time - 15)} disabled={!target || waiting}><RotateCcw size={18} aria-hidden="true" /><span className="reader-rewind-number">15</span></button>
        <div className="reader-audio-position"><span>{currentChapter?.title ?? chapters[location.chapterIndex]?.title}</span><span aria-live="off">{clock(time)} / {clock(maxTime)}</span></div>
        <label className="reader-audio-speed"><span>Speed</span><select aria-label="Audiobook playback speed" value={rate} onChange={(event) => { const next = Number(event.target.value); if (rates.some((value) => value === next)) { setRate(next); if (audio.current) audio.current.playbackRate = next; savePreferences(narratorId, next); } }}>{rates.map((value) => <option key={value} value={value}>{value === 1 || value === 2 ? value.toFixed(1) : value}x</option>)}</select></label>
      </div>
      <label className="reader-audio-seek"><span className="sr-only">Audio position in current chapter</span><input type="range" min={0} max={maxTime || 1} step={0.1} value={Math.min(time, maxTime || 1)} disabled={!target || maxTime <= 0 || waiting} aria-valuetext={`${clock(time)} of ${clock(maxTime)}`} onChange={(event) => seek(Number(event.target.value))} /></label>
    </div>}
    {!error && <p className="reader-audio-status" role="status">{message || (narrators === null || loadingManifest ? "Checking audio…" : !narrators.length ? "Audio is not available for this edition." : !canListen ? "Audio is not available for this paragraph." : mode === "listening" ? waiting ? "Loading audio…" : <><Volume2 size={13} aria-hidden="true" />Paragraph {location.paragraphIndex + 1}. Switch to Read to return to this passage.</> : "Select a paragraph, then listen from that point.")}</p>}
    {error && <div className="reader-audio-error"><p role="alert">{error}</p><button onClick={retryAudio}>Retry audio</button></div>}
    <audio ref={audio} preload="metadata" src={src}
      onLoadedMetadata={() => { if (target) loadedSource.current = sourceKey(target); applyPendingSeek(); }}
      onCanPlay={() => { setWaiting(false); applyPendingSeek(); }}
      onPlaying={() => { setPlaying(true); setWaiting(false); setError(""); }}
      onPause={() => { setPlaying(false); reportTime(); }}
      onWaiting={() => setWaiting(true)}
      onTimeUpdate={() => { if (audio.current && !pendingSeek.current) { setTime(audio.current.currentTime); reportTime(); } }}
      onSeeked={reportSeek}
      onDurationChange={() => { if (audio.current && Number.isFinite(audio.current.duration)) setDuration(audio.current.duration); }}
      onEnded={ended}
      onError={() => { if (!activeTarget.current) return; pendingSeek.current = null; setWaiting(false); setPlaying(false); setError("Audio could not be loaded. Check your connection and retry."); }} />
  </section>;
}
