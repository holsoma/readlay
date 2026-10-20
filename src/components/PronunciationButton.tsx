"use client";

import { useEffect, useRef, useState } from "react";
import { Pause, Volume2 } from "lucide-react";

export function PronunciationButton({ word, audioUrl }: { word: string; audioUrl: string | null }) {
  const audio = useRef<HTMLAudioElement>(null);
  const [playing, setPlaying] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const player = audio.current;
    return () => { player?.pause(); };
  }, [audioUrl]);

  async function toggle() {
    const player = audio.current;
    if (!player) return;
    if (!player.paused) { player.pause(); return; }
    setFailed(false);
    try { player.currentTime = 0; await player.play(); }
    catch { setFailed(true); setPlaying(false); }
  }

  if (!audioUrl) return <span className="pronunciation-unavailable">Pronunciation audio unavailable.</span>;
  return <div className="pronunciation-control">
    <audio ref={audio} src={audioUrl} preload="none" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onEnded={() => setPlaying(false)} onError={() => { setFailed(true); setPlaying(false); }} />
    <button type="button" className="pronunciation-button" onClick={toggle} aria-label={`${playing ? "Stop" : "Play"} pronunciation of ${word}`}>
      {playing ? <Pause size={17} aria-hidden="true" /> : <Volume2 size={17} aria-hidden="true" />}<span>{playing ? "Stop" : "Listen"}</span>
    </button>
    {failed && <span className="pronunciation-error" role="status">Pronunciation could not play. Try again.</span>}
  </div>;
}
