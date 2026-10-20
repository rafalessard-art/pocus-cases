import * as tus from 'tus-js-client';
import { MEDIA_BUCKET, rpc, supabase, supabaseAnonKey, supabaseUrl } from './supabase';
import { mimeFor, probe, sha256 } from './media';

export type UploadMeta = {
  assetId?: string | null;
  mediaKey?: string;
  title?: string;
  description?: string;
  domainKey?: string | null;
  source?: string;
  attribution?: string;
  license?: string;
  tags?: string[];
  courseId?: string | null;
};

export type UploadResult = { assetId: string; versionId: string; storagePath: string };

const RESUMABLE_OVER = 6 * 1024 * 1024; // Supabase TUS chunk size is fixed at 6 MB

/**
 * Register → upload straight from the browser to private Storage (resumable
 * for larger files) → confirm. Files never pass through an app server.
 */
export async function uploadMedia(file: File, meta: UploadMeta, onProgress?: (pct: number) => void): Promise<UploadResult> {
  const p = await probe(file);
  if (!p.playable) throw new Error(p.error ?? 'This file cannot be played in the browser.');
  const hash = await sha256(file);
  const reg = await rpc<{ asset_id: string; version_id: string; storage_path: string }>('begin_media_upload', {
    p_asset_id: meta.assetId ?? null,
    p_asset: {
      media_key: meta.mediaKey,
      title: meta.title,
      description: meta.description ?? '',
      domain_key: meta.domainKey ?? null,
      source: meta.source ?? '',
      attribution: meta.attribution ?? '',
      license: meta.license ?? '',
      tags: meta.tags ?? [],
      course_id: meta.courseId ?? null,
    },
    p_file: {
      filename: file.name,
      mime_type: mimeFor(file),
      size_bytes: file.size,
      width: p.width ?? null,
      height: p.height ?? null,
      duration_seconds: p.duration && Number.isFinite(p.duration) ? Number(p.duration.toFixed(3)) : null,
      sha256: hash,
    },
  });
  try {
    if (file.size > RESUMABLE_OVER) await resumable(file, reg.storage_path, onProgress);
    else {
      onProgress?.(10);
      const { error } = await supabase.storage.from(MEDIA_BUCKET).upload(reg.storage_path, file, {
        contentType: mimeFor(file),
        upsert: false,
        cacheControl: '3600',
      });
      if (error) throw error;
      onProgress?.(100);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await rpc('complete_media_upload', { p_version_id: reg.version_id, p_ok: false, p_error: msg }).catch(() => {});
    throw new Error(`Upload failed: ${msg}`);
  }
  const done = await rpc<{ status: string; error?: string }>('complete_media_upload', { p_version_id: reg.version_id, p_ok: true });
  if (done.status !== 'uploaded') throw new Error(done.error ?? 'The server could not confirm the upload.');
  return { assetId: reg.asset_id, versionId: reg.version_id, storagePath: reg.storage_path };
}

async function resumable(file: File, objectName: string, onProgress?: (pct: number) => void) {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  await new Promise<void>((resolve, reject) => {
    const up = new tus.Upload(file, {
      endpoint: `${supabaseUrl}/storage/v1/upload/resumable`,
      retryDelays: [0, 1000, 3000, 5000, 10000],
      headers: { authorization: `Bearer ${token}`, apikey: supabaseAnonKey, 'x-upsert': 'false' },
      uploadDataDuringCreation: true,
      removeFingerprintOnSuccess: true,
      chunkSize: RESUMABLE_OVER,
      metadata: { bucketName: MEDIA_BUCKET, objectName, contentType: mimeFor(file), cacheControl: '3600' },
      onError: (err) => reject(err),
      onProgress: (sent, total) => onProgress?.(Math.round((sent / total) * 100)),
      onSuccess: () => resolve(),
    });
    up.findPreviousUploads().then((prev) => {
      if (prev.length) up.resumeFromPreviousUpload(prev[0]);
      up.start();
    });
  });
}
