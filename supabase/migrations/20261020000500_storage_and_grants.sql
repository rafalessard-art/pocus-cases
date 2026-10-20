-- =============================================================================
-- POCUS Exam Platform — 05 storage bucket + policies, final privilege sweep.
-- =============================================================================

-- Private bucket for exam media. Not public: every read needs a signed URL,
-- and signing is only allowed by the SELECT policy below.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('exam-media', 'exam-media', false, 209715200,  -- 200 MB per file
        array['video/mp4', 'video/webm', 'image/png', 'image/jpeg', 'image/gif', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

-- May the current user read this object? Staff: yes. Learners: only media
-- attached to a question in an attempt they have open, or in a released
-- full-review attempt.
create or replace function public.can_read_exam_media(p_path text)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_staff() or exists (
    select 1
      from public.media_versions mv
      join public.question_version_media qvm on qvm.media_version_id = mv.id
      join public.exam_items ei on ei.question_version_id = qvm.question_version_id
      join public.attempts a on a.exam_version_id = ei.exam_version_id
      join public.exam_versions ev on ev.id = a.exam_version_id
     where mv.storage_path = p_path
       and a.user_id = auth.uid()
       and (a.status = 'in_progress'
            or (a.released_at is not null and ev.feedback_policy = 'full_review'))
  )
$$;

create policy "exam-media read" on storage.objects for select to authenticated
  using (bucket_id = 'exam-media' and public.can_read_exam_media(name));
create policy "exam-media admin insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'exam-media' and public.is_admin()
              and exists (select 1 from public.media_versions mv where mv.storage_path = name and mv.upload_status = 'pending'));
create policy "exam-media admin update" on storage.objects for update to authenticated
  using (bucket_id = 'exam-media' and public.is_admin()
         and exists (select 1 from public.media_versions mv where mv.storage_path = name and mv.upload_status = 'pending'));
-- No delete policy: uploaded media is never removed through the API.

-- ---------------------------------------------------------------------------
-- Privilege sweep
-- ---------------------------------------------------------------------------
revoke all on all tables in schema public from anon;
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated;

-- internal helpers stay private even to signed-in users
revoke execute on function
  public.log_event(text, text, text, jsonb),
  public.audit_trigger(),
  public.handle_new_auth_user(),
  public.invitation_sync_existing(),
  public.guard_profile_update(),
  public.hook_before_user_created(jsonb),
  public._accommodation(uuid, uuid),
  public._my_assignment_ids(uuid),
  public._grade_attempt(uuid),
  public._recompute_attempt(uuid),
  public._finalize(uuid, text),
  public._finalize_overdue(uuid, uuid),
  public._require_view_attempt(uuid),
  public.attempt_breakdown(uuid),
  public.guard_evaluation()
from authenticated;
grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;

-- Future functions created by migrations are not executable by anon by default.
alter default privileges in schema public revoke execute on functions from public, anon;
