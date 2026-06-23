'use client';
import { useRef, useState, useEffect } from 'react';
import { fmtDuration, downloadMedia } from '../lib/util';

export default function VoiceNote({ src, duration, name }) {
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [cur, setCur] = useState(0);
  const [total, setTotal] = useState(duration || 0);

  useEffect(() => {
    const a = audioRef.current;
    if (!a) return;
    const onTime = () => setCur(a.currentTime);
    const onMeta = () => {
      if (isFinite(a.duration) && a.duration > 0) setTotal(a.duration);
    };
    const onEnd = () => {
      setPlaying(false);
      setCur(0);
    };
    a.addEventListener('timeupdate', onTime);
    a.addEventListener('loadedmetadata', onMeta);
    a.addEventListener('durationchange', onMeta);
    a.addEventListener('ended', onEnd);
    return () => {
      a.removeEventListener('timeupdate', onTime);
      a.removeEventListener('loadedmetadata', onMeta);
      a.removeEventListener('durationchange', onMeta);
      a.removeEventListener('ended', onEnd);
    };
  }, []);

  const toggle = () => {
    const a = audioRef.current;
    if (!a) return;
    if (playing) {
      a.pause();
      setPlaying(false);
    } else {
      a.play().then(() => setPlaying(true)).catch(() => {});
    }
  };

  const seek = (e) => {
    const a = audioRef.current;
    if (!a || !total) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    a.currentTime = ratio * total;
    setCur(a.currentTime);
  };

  const pct = total ? Math.min(100, (cur / total) * 100) : 0;

  return (
    <div className="voice">
      <button className="play" onClick={toggle}>{playing ? '⏸' : '▶'}</button>
      <div className="track" onClick={seek}>
        <div className="fill" style={{ width: `${pct}%` }} />
      </div>
      <span className="dur">{fmtDuration(playing || cur ? cur : total)}</span>
      <button className="dl" title="Download voice note" onClick={() => downloadMedia(src, name || 'voice-note.webm')}>⬇</button>
      <audio ref={audioRef} src={src} preload="metadata" />
    </div>
  );
}
