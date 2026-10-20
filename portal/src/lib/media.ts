import { MEDIA_BUCKET, supabase } from './supabase';

/** Signed-URL cache. URLs are short-lived and only issued if Storage RLS allows. */
const cache = new Map<string, { url: string; exp: number }>();
const TTL = 3 * 60 * 60; // seconds — covers a long exam; refreshed on error

export async function signedUrls(paths: string[]): Promise<Record<string, string>> {
  const now = Date.now();
  const need = [...new Set(paths)].filter((p) => !cache.has(p) || cache.get(p)!.exp < now + 5 * 60e3);
  if (need.length) {
    const { data, error } = await supabase.storage.from(MEDIA_BUCKET).createSignedUrls(need, TTL);
    if (error) throw error;
    for (const d of data ?? []) {
      if (d.signedUrl && d.path) cache.set(d.path, { url: d.signedUrl, exp: now + TTL * 1000 });
    }
  }
  const out: Record<string, string> = {};
  for (const p of paths) if (cache.has(p)) out[p] = cache.get(p)!.url;
  return out;
}

export function invalidate(path: string) {
  cache.delete(path);
}

/** Warm the browser cache for upcoming clips so playback starts instantly. */
export function prefetch(urls: string[]) {
  for (const u of urls) {
    fetch(u, { mode: 'cors', credentials: 'omit' }).catch(() => {});
  }
}

export type Probe = { kind: 'video' | 'image'; width?: number; height?: number; duration?: number; playable: boolean; error?: string };

const VIDEO_OK = ['video/mp4', 'video/webm'];
const IMAGE_OK = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const ACCEPTED = [...VIDEO_OK, ...IMAGE_OK];
export const NEEDS_CONVERSION = /\.(mov|avi|wmv|mkv|m4v|mpg|mpeg|dcm|dicom)$/i;

export function mimeFor(file: File): string {
  if (file.type) return file.type.toLowerCase();
  const ext = file.name.split('.').pop()?.toLowerCase();
  return ({ mp4: 'video/mp4', webm: 'video/webm', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' } as Record<string, string>)[ext ?? ''] ?? 'application/octet-stream';
}

/** Read dimensions/duration in the browser and confirm the file actually plays here. */
export function probe(file: File): Promise<Probe> {
  const mime = mimeFor(file);
  const url = URL.createObjectURL(file);
  return new Promise((resolve) => {
    const done = (p: Probe) => {
      URL.revokeObjectURL(url);
      resolve(p);
    };
    if (IMAGE_OK.includes(mime)) {
      const img = new Image();
      img.onload = () => done({ kind: 'image', width: img.naturalWidth, height: img.naturalHeight, playable: true });
      img.onerror = () => done({ kind: 'image', playable: false, error: 'This image could not be decoded.' });
      img.src = url;
      return;
    }
    if (!VIDEO_OK.includes(mime)) {
      done({ kind: 'video', playable: false, error: `Unsupported format (${mime || file.name}). Convert to MP4 (H.264) first.` });
      return;
    }
    const v = document.createElement('video');
    v.preload = 'metadata';
    v.muted = true;
    const t = setTimeout(() => done({ kind: 'video', playable: false, error: 'Timed out reading the video.' }), 15000);
    v.onloadedmetadata = () => {
      clearTimeout(t);
      if (!v.videoWidth) done({ kind: 'video', playable: false, error: 'No video track this browser can decode. Re-encode as H.264 MP4.' });
      else done({ kind: 'video', width: v.videoWidth, height: v.videoHeight, duration: v.duration, playable: true });
    };
    v.onerror = () => {
      clearTimeout(t);
      done({ kind: 'video', playable: false, error: 'This browser cannot decode the video. Re-encode as H.264 MP4 (see the media guide).' });
    };
    v.src = url;
  });
}

export async function sha256(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** "LUNG 003 b-lines.mp4" → "LUNG-003-b-lines" */
export function keyFromFilename(name: string): string {
  return name.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'clip';
}

export const formatBytes = (n?: number | null) =>
  n == null ? '—' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1048576).toFixed(1)} MB`;
