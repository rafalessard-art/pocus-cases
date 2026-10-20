import { useEffect, useState } from 'react';
import { invalidate, signedUrls } from '../lib/media';
import { UltrasoundPlayer } from './UltrasoundPlayer';

export type MediaRef = {
  path: string;
  kind: 'video' | 'image';
  mime?: string;
  width?: number | null;
  height?: number | null;
  frame_rate?: number | null;
  caption?: string;
};

/** Resolves signed URLs (RLS-checked by Storage) and renders one player per clip. */
export function MediaView({ media, label }: { media: MediaRef[]; label?: string }) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [n, setN] = useState(0);
  const key = media.map((m) => m.path).join('|');
  useEffect(() => {
    let alive = true;
    if (!media.length) return;
    signedUrls(media.map((m) => m.path))
      .then((u) => alive && setUrls(u))
      .catch(() => alive && setUrls({}));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, n]);
  if (!media.length) return null;
  return (
    <div className={`media-list ${media.length > 1 ? 'multi' : ''}`}>
      {media.map((m, i) => (
        <UltrasoundPlayer
          key={m.path}
          src={urls[m.path]}
          kind={m.kind}
          width={m.width}
          height={m.height}
          frameRate={m.frame_rate}
          caption={m.caption || (media.length > 1 ? `${m.kind === 'video' ? 'Clip' : 'Image'} ${i + 1}` : undefined)}
          label={`${label ?? 'Question'} — ${m.kind === 'video' ? 'clip' : 'image'} ${i + 1} of ${media.length}`}
          onError={() => {
            invalidate(m.path);
            setTimeout(() => setN((x) => x + 1), 1500);
          }}
        />
      ))}
    </div>
  );
}
