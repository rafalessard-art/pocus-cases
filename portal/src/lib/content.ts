import { supabase } from './supabase';

/** Small typed loaders for staff-visible reference data (RLS-filtered). */
export type Domain = { id: string; key: string; label: string; sort: number };
export type Objective = { id: string; code: string; title: string; domain_key: string | null };
export type Cohort = { id: string; name: string; academic_year: string | null; block_label: string | null; start_date: string | null; end_date: string | null; archived_at: string | null; course_id: string };

export async function pocusCourse() {
  const { data, error } = await supabase.from('courses').select('*').eq('slug', 'pocus').single();
  if (error) throw error;
  return data as { id: string; slug: string; title: string; description: string };
}

export async function domains(courseId: string): Promise<Domain[]> {
  const { data, error } = await supabase.from('domains').select('*').eq('course_id', courseId).order('sort');
  if (error) throw error;
  return data as Domain[];
}

export async function objectives(courseId: string): Promise<Objective[]> {
  const { data, error } = await supabase.from('learning_objectives').select('*').eq('course_id', courseId).order('sort');
  if (error) throw error;
  return data as Objective[];
}

export async function cohorts(): Promise<Cohort[]> {
  const { data, error } = await supabase.from('cohorts').select('*').order('start_date', { ascending: false, nullsFirst: false });
  if (error) throw error;
  return data as Cohort[];
}

export type MediaAsset = {
  id: string; media_key: string; title: string; description: string; domain_key: string | null; tags: string[]; kind: 'video' | 'image';
  source: string; attribution: string; license: string; authorization_status: 'pending' | 'authorized' | 'restricted' | 'rejected';
  deidentified: boolean; deidentified_at: string | null; current_version_id: string | null; archived_at: string | null; created_at: string;
  current?: MediaVersion | null;
};
export type MediaVersion = {
  id: string; asset_id: string; version: number; storage_path: string; original_filename: string; mime_type: string; size_bytes: number | null;
  width: number | null; height: number | null; duration_seconds: number | null; frame_rate: number | null; sha256: string | null;
  upload_status: 'pending' | 'uploaded' | 'failed'; error: string | null; created_at: string; uploaded_at: string | null;
};

export async function mediaLibrary(): Promise<MediaAsset[]> {
  const { data, error } = await supabase
    .from('media_assets')
    .select('*, current:media_versions!media_assets_current_version_fk(*)')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data as MediaAsset[];
}

export const AUTH_LABEL: Record<MediaAsset['authorization_status'], string> = {
  pending: 'Authorization pending',
  authorized: 'Authorized',
  restricted: 'Restricted',
  rejected: 'Rejected',
};

export function mediaReady(a: MediaAsset) {
  return a.authorization_status === 'authorized' && a.deidentified && a.current?.upload_status === 'uploaded' && !a.archived_at;
}
