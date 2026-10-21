"use client";

import { useEffect, useRef, useState } from "react";
import { Pause, Volume2 } from "lucide-react";

type DevicePronunciation = { owner: symbol; utterance: SpeechSynthesisUtterance; synthesis: SpeechSynthesis; stopped: () => void };
let devicePronunciation: DevicePronunciation | null = null;

function stopDevicePronunciation(owner: symbol) {
  const active = devicePronunciation;
  if (!active || active.owner !== owner) return;
  // The browser has no per-utterance cancel method. Never cancel after ownership
  // has moved to another word, or after our utterance has already finished.
  devicePronunciation = null;
  active.synthesis.cancel();
  active.stopped();
}

function localEnglishVoice(synthesis: SpeechSynthesis): SpeechSynthesisVoice | null {
  const rank = (voice: SpeechSynthesisVoice) => {
    const language = voice.lang.toLowerCase().replaceAll("_", "-");
    return language === "en-gb" ? 0 : language === "en-sg" ? 1 : 2;
  };
  return synthesis.getVoices().filter((voice) => voice.localService === true && /^en(?:[-_]|$)/i.test(voice.lang))
    .sort((left, right) => rank(left) - rank(right) || Number(right.default) - Number(left.default) || left.name.localeCompare(right.name))[0] ?? null;
}

export function PronunciationButton({ word, audioUrl }: { word: string; audioUrl: string | null }) {
  return <PronunciationControl key={`${word}:${audioUrl ?? ""}`} word={word} audioUrl={audioUrl} />;
}

function PronunciationControl({ word, audioUrl }: { word: string; audioUrl: string | null }) {
  const audio = useRef<HTMLAudioElement>(null);
  const owner = useRef(Symbol("readlay-pronunciation"));
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  const [voice, setVoice] = useState<SpeechSynthesisVoice | null>(null);
  const [devicePlaying, setDevicePlaying] = useState(false);
  const [deviceFailed, setDeviceFailed] = useState(false);
  const live = useRef(false);

  useEffect(() => {
    live.current = true;
    const player = audio.current;
    const token = owner.current;
    const synthesis = window.speechSynthesis;
    function updateVoices() {
      if (live.current && synthesis && typeof window.SpeechSynthesisUtterance === "function") setVoice(localEnglishVoice(synthesis));
    }
    synthesis?.addEventListener("voiceschanged", updateVoices);
    // Some browsers populate voices after the first render. This also keeps the
    // server and first client render identical when a local voice is available.
    void Promise.resolve().then(updateVoices);
    return () => {
      live.current = false;
      synthesis?.removeEventListener("voiceschanged", updateVoices);
      player?.pause();
      stopDevicePronunciation(token);
    };
  }, []);

  async function toggle() {
    const player = audio.current;
    if (!player) return;
    if (!player.paused) { player.pause(); return; }
    if (devicePronunciation) stopDevicePronunciation(devicePronunciation.owner);
    setFailed(false);
    try { player.currentTime = 0; await player.play(); }
    catch { if (live.current) { setFailed(true); setPlaying(false); } }
  }

  function toggleDevice() {
    const token = owner.current;
    if (devicePronunciation?.owner === token) { stopDevicePronunciation(token); return; }
    const synthesis = window.speechSynthesis;
    if (!synthesis || typeof window.SpeechSynthesisUtterance !== "function") return;
    const available = localEnglishVoice(synthesis);
    if (!available) { setVoice(null); return; }
    audio.current?.pause();
    if (devicePronunciation) stopDevicePronunciation(devicePronunciation.owner);
    const utterance = new window.SpeechSynthesisUtterance(word);
    utterance.voice = available;
    utterance.lang = available.lang;
    utterance.rate = 1;
    const stopped = () => { if (live.current) setDevicePlaying(false); };
    devicePronunciation = { owner: token, utterance, synthesis, stopped };
    utterance.onend = () => {
      if (devicePronunciation?.utterance !== utterance) return;
      devicePronunciation = null;
      stopped();
    };
    utterance.onerror = () => {
      if (devicePronunciation?.utterance !== utterance) return;
      devicePronunciation = null;
      stopped();
      if (live.current) setDeviceFailed(true);
    };
    setDeviceFailed(false);
    setDevicePlaying(true);
    try { synthesis.speak(utterance); }
    catch {
      if (devicePronunciation?.utterance === utterance) devicePronunciation = null;
      stopped();
      setDeviceFailed(true);
    }
  }

  const deviceAvailable = (!audioUrl || failed) && voice;
  const recordedLabel = `${playing ? "Stop" : "Play"} pronunciation of ${word}`;
  const deviceLabel = `${devicePlaying ? "Stop" : "Play"} device pronunciation of ${word}`;
  if (!audioUrl && !deviceAvailable) return <span className="pronunciation-unavailable">Pronunciation audio unavailable on this device.</span>;
  return <div className="pronunciation-control">
    {audioUrl && <><audio ref={audio} src={audioUrl} preload="none" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onError={() => { setFailed(true); setPlaying(false); }} />
    <button type="button" className="pronunciation-button" onClick={toggle} aria-label={recordedLabel} title={recordedLabel}>
      {playing ? <Pause size={17} aria-hidden="true" /> : <Volume2 size={17} aria-hidden="true" />}
    </button></>}
    {deviceAvailable && <button type="button" className="pronunciation-button" onClick={toggleDevice} aria-label={deviceLabel} title={deviceLabel}>
      {devicePlaying ? <Pause size={17} aria-hidden="true" /> : <Volume2 size={17} aria-hidden="true" />}
    </button>}
    {failed && <span className="pronunciation-error" role="status">Pronunciation could not play. Try again.</span>}
    {deviceFailed && <span className="pronunciation-error" role="status">Device pronunciation could not play. Try again.</span>}
  </div>;
}
