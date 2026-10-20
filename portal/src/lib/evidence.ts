import { sha256 } from './media';
import { rpc, supabase } from './supabase';

/** Private bucket for resident-uploaded proof of completion (see migration 07). */
export const EVIDENCE_BUCKET = 'itar-evidence';
export const EVIDENCE_ACCEPT = 'application/pdf,image/png,image/jpeg,image/webp,.pdf,.png,.jpg,.jpeg,.webp';
export const EVIDENCE_MAX = 10 * 1024 * 1024;

export function evidenceMime(file: File): string | null {
  const t = (file.type || '').toLowerCase();
  if (['application/pdf', 'image/png', 'image/jpeg', 'image/webp'].includes(t)) return t;
  const ext = file.name.split('.').pop()?.toLowerCase();
  return ({ pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' } as Record<string, string>)[ext ?? ''] ?? null;
}

/** Register → upload straight to private Storage → server confirms the file exists. */
export async function uploadEvidence(file: File, requirementId: string, cohortId: string, note: string) {
  const mime = evidenceMime(file);
  if (!mime) throw new Error('Upload a PDF or an image (PNG, JPEG or WebP).');
  if (file.size > EVIDENCE_MAX) throw new Error('Files must be 10 MB or smaller.');
  if (file.size === 0) throw new Error('This file is empty.');
  const reg = await rpc<{ id: string; storage_path: string }>('begin_evidence_upload', {
    p_requirement: requirementId, p_cohort: cohortId, p_note: note,
    p_file: { filename: file.name, mime_type: mime, size_bytes: file.size, sha256: await sha256(file) },
  });
  const { error } = await supabase.storage.from(EVIDENCE_BUCKET).upload(reg.storage_path, file, { contentType: mime, upsert: false });
  if (error) {
    await rpc('complete_evidence_upload', { p_id: reg.id, p_ok: false, p_error: error.message }).catch(() => {});
    throw new Error(`Upload failed: ${error.message}`);
  }
  const done = await rpc<{ status: string; error?: string }>('complete_evidence_upload', { p_id: reg.id, p_ok: true });
  if (done.status !== 'uploaded') throw new Error(done.error ?? 'The server could not confirm the upload.');
  return reg.id;
}

/**
 * Admin: remove evidence files (retention policy or uploaded in error). The
 * records, their review history and file hashes are kept; every deletion is
 * audit-logged with its reason.
 */
export async function deleteEvidenceFiles(ids: string[], reason: string): Promise<number> {
  const paths = await rpc<string[]>('request_evidence_file_deletion', { p_ids: ids, p_reason: reason });
  if (paths.length) {
    const { error } = await supabase.storage.from(EVIDENCE_BUCKET).remove(paths);
    if (error) throw error;
  }
  return rpc<number>('confirm_evidence_file_deletion', { p_ids: ids });
}

/** Short-lived link; only issued when Storage RLS allows the caller to read the file. */
export async function evidenceUrl(path: string, download = false): Promise<string> {
  const { data, error } = await supabase.storage.from(EVIDENCE_BUCKET).createSignedUrl(path, 600, download ? { download: true } : undefined);
  if (error || !data?.signedUrl) throw error ?? new Error('Could not open the file');
  return data.signedUrl;
}
