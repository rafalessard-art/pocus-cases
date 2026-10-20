import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';

/**
 * Loop player for ultrasound clips.
 *
 * Plain <video> with controls built for image interpretation: continuous loop,
 * play/pause, frame-accurate scrubbing and stepping, 0.5×/0.25× speed,
 * fullscreen, original aspect ratio (object-fit: contain, never stretched).
 * Keyboard: Space play/pause · ←/→ one frame · F fullscreen · S speed.
 *
 * Note: anything a browser can display can be captured; `nodownload` and the
 * context-menu block only discourage casual saving.
 */
type Props = {
  src?: string;
  kind: 'video' | 'image';
  width?: number | null;
  height?: number | null;
  frameRate?: number | null;
  caption?: string;
  label?: string;
  autoPlay?: boolean;
  onError?: () => void;
};

const SPEEDS = [1, 0.5, 0.25];

export function UltrasoundPlayer({ src, kind, width, height, frameRate, caption, label, autoPlay = true, onError }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const vid = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [t, setT] = useState(0);
  const [dur, setDur] = useState(0);
  const [speed, setSpeed] = useState(1);
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState(false);
  const fps = frameRate && frameRate > 0 ? Number(frameRate) : 30;
  const frame = 1 / fps;

  useEffect(() => {
    setReady(false);
    setErr(false);
  }, [src]);

  // Smooth time display while playing; requestVideoFrameCallback where available.
  useEffect(() => {
    const v = vid.current;
    if (!v || kind !== 'video') return;
    let raf = 0;
    let handle = 0;
    const anyV = v as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number; cancelVideoFrameCallback?: (h: number) => void };
    const tick = () => {
      setT(v.currentTime);
      if (anyV.requestVideoFrameCallback) handle = anyV.requestVideoFrameCallback(tick);
      else raf = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      if (anyV.cancelVideoFrameCallback && handle) anyV.cancelVideoFrameCallback(handle);
      cancelAnimationFrame(raf);
    };
  }, [kind, src]);

  useEffect(() => {
    if (vid.current) vid.current.playbackRate = speed;
  }, [speed]);

  const toggle = useCallback(() => {
    const v = vid.current;
    if (!v) return;
    if (v.paused) void v.play().catch(() => {});
    else v.pause();
  }, []);

  const step = useCallback(
    (dir: number) => {
      const v = vid.current;
      if (!v) return;
      v.pause();
      let next = v.currentTime + dir * frame;
      if (next < 0) next = Math.max(0, v.duration - frame);
      if (next > v.duration) next = 0;
      v.currentTime = next;
    },
    [frame],
  );

  const fullscreen = useCallback(() => {
    const el = box.current as (HTMLDivElement & { webkitRequestFullscreen?: () => void }) | null;
    const v = vid.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    if (document.fullscreenElement) {
      void document.exitFullscreen();
      return;
    }
    if (el?.requestFullscreen) void el.requestFullscreen().catch(() => v?.webkitEnterFullscreen?.());
    else if (el?.webkitRequestFullscreen) el.webkitRequestFullscreen();
    else v?.webkitEnterFullscreen?.(); // iOS Safari
  }, []);

  const onKey = (e: KeyboardEvent) => {
    if (kind !== 'video') {
      if (e.key === 'f' || e.key === 'F') fullscreen();
      return;
    }
    if (e.key === ' ' || e.key === 'k') {
      e.preventDefault();
      toggle();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      step(-1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      step(1);
    } else if (e.key === 'f' || e.key === 'F') fullscreen();
    else if (e.key === 's' || e.key === 'S') setSpeed((s) => SPEEDS[(SPEEDS.indexOf(s) + 1) % SPEEDS.length]);
  };

  const aspect = width && height ? `${width} / ${height}` : undefined;
  const failed = () => {
    setErr(true);
    onError?.();
  };

  return (
    <figure className="usplayer" ref={box} tabIndex={0} onKeyDown={onKey} aria-label={label ?? (kind === 'video' ? 'Ultrasound clip' : 'Ultrasound image')}
      onContextMenu={(e) => e.preventDefault()} style={{ margin: 0 }} data-testid="usplayer">
      <div className="stage" style={{ aspectRatio: !ready && aspect ? aspect : undefined, minHeight: ready ? undefined : 160 }}>
        {!src && !err && <div className="loading">Loading…</div>}
        {err && <div className="err">This clip could not be loaded. Check your connection; it will retry when you revisit the question.</div>}
        {src && !err && kind === 'video' && (
          <video
            ref={vid}
            src={src}
            muted
            loop
            playsInline
            autoPlay={autoPlay}
            preload="auto"
            controlsList="nodownload noremoteplayback"
            disablePictureInPicture
            onLoadedMetadata={(e) => {
              setDur(e.currentTarget.duration || 0);
              setReady(true);
              e.currentTarget.playbackRate = speed;
            }}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onError={failed}
            onClick={toggle}
            style={aspect ? { aspectRatio: aspect } : undefined}
          />
        )}
        {src && !err && kind === 'image' && (
          <img src={src} alt={caption || label || 'Ultrasound image'} onLoad={() => setReady(true)} onError={failed} draggable={false} />
        )}
      </div>
      {kind === 'video' && (
        <div className="controls">
          <button type="button" onClick={toggle} aria-label={playing ? 'Pause' : 'Play'} title="Play/pause (Space)">
            {playing ? '❚❚' : '▶'}
          </button>
          <button type="button" onClick={() => step(-1)} aria-label="Previous frame" title="Previous frame (←)">‹|</button>
          <button type="button" onClick={() => step(1)} aria-label="Next frame" title="Next frame (→)">|›</button>
          <input
            type="range"
            min={0}
            max={dur || 0}
            step={frame}
            value={Math.min(t, dur || 0)}
            aria-label="Scrub through clip"
            onPointerDown={() => vid.current?.pause()}
            onChange={(e) => {
              if (vid.current) vid.current.currentTime = Number(e.target.value);
              setT(Number(e.target.value));
            }}
          />
          <span className="time" aria-live="off">
            {t.toFixed(2)} / {dur.toFixed(2)}s
          </span>
          {SPEEDS.map((s) => (
            <button key={s} type="button" className={speed === s ? 'on' : ''} onClick={() => setSpeed(s)} aria-pressed={speed === s}
              aria-label={`Playback speed ${s}×`}>
              {s}×
            </button>
          ))}
          <button type="button" onClick={fullscreen} aria-label="Fullscreen" title="Fullscreen (F)">⛶</button>
        </div>
      )}
      {kind === 'image' && (
        <div className="controls">
          <span style={{ flex: 1 }} />
          <button type="button" onClick={fullscreen} aria-label="Fullscreen" title="Fullscreen (F)">⛶</button>
        </div>
      )}
      {caption && <figcaption className="caption">{caption}</figcaption>}
    </figure>
  );
}
