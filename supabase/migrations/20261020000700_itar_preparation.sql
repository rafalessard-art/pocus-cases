-- =============================================================================
-- POCUS Exam Platform — 07 ITAR preparation workspace.
--
-- Brings together, per resident and rotation block (cohort):
--   A. examination results (existing attempts),
--   B. resident-uploaded proof of completion of required learning cases
--      (Brightspace) with faculty verification,
--   C. a faculty-entered EPA review (transcribed from Elentra),
--   D. categorised direct faculty observations (existing faculty_notes),
-- and an editable, faculty-approved ITAR draft (existing evaluations).
--
-- Principles (unchanged from 04_assessment):
--   * The portal prepares an ITAR; it does not replace the institution's
--     official evaluation platform and never assigns an overall rating.
--   * Nothing clinical is inferred from exam scores.
--   * Faculty see only residents in blocks where they are an evaluator.
--   * Learners never see EPA reviews, observations or ITAR drafts.
--
-- Generic: requirements belong to a course (rotation type), optionally to one
-- block, so other subspecialty rotations reuse the same tables.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Authorization helper: may the caller evaluate this resident in this block?
-- Admins: yes. Faculty: only as an evaluator of a block the resident is in.
-- ---------------------------------------------------------------------------
create or replace function public.can_evaluate(p_learner uuid, p_cohort uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_admin() or (
    public.my_role() = 'faculty'
    and exists (select 1 from public.cohort_members m
                 where m.cohort_id = p_cohort and m.user_id = auth.uid() and m.member_role = 'evaluator')
    and exists (select 1 from public.cohort_members m
                 where m.cohort_id = p_cohort and m.user_id = p_learner and m.member_role = 'learner'))
$$;

-- ---------------------------------------------------------------------------
-- Required learning cases (or other completion evidence) per rotation/block
-- ---------------------------------------------------------------------------
create table public.evidence_requirements (
  id                 uuid primary key default gen_random_uuid(),
  course_id          uuid not null references public.courses (id) on delete cascade,
  cohort_id          uuid references public.cohorts (id) on delete cascade,   -- null ⇒ every block of this rotation
  kind               text not null default 'learning_case' check (kind in ('learning_case', 'module', 'certificate', 'other')),
  source             text not null default 'brightspace' check (source in ('brightspace', 'other')),
  title              text not null check (length(btrim(title)) between 1 and 300),
  description        text not null default '' check (length(description) <= 4000),
  external_ref       text check (length(external_ref) <= 500),   -- e.g. Brightspace module or URL; reserved for a future official integration
  curriculum_item_id uuid references public.curriculum_items (id) on delete set null,
  required           boolean not null default true,
  sort               int not null default 0,
  archived_at        timestamptz,
  created_at         timestamptz not null default now()
);
create index on public.evidence_requirements (course_id);
comment on table public.evidence_requirements is 'What residents must prove they completed (e.g. Brightspace learning cases). Any number per rotation or block.';

create trigger evidence_requirements_audit after insert or update or delete on public.evidence_requirements
  for each row execute function public.audit_trigger();

-- ---------------------------------------------------------------------------
-- Resident-uploaded evidence (private storage) and faculty verification
-- ---------------------------------------------------------------------------
create type public.evidence_status as enum ('submitted', 'verified', 'clarification_requested', 'rejected');

create table public.evidence_submissions (
  id                  uuid primary key default gen_random_uuid(),
  requirement_id      uuid not null references public.evidence_requirements (id) on delete restrict,
  learner_id          uuid not null references public.profiles (id) on delete restrict,
  cohort_id           uuid not null references public.cohorts (id) on delete restrict,
  source              text not null default 'learner_upload' check (source in ('learner_upload', 'brightspace_import')),
  storage_path        text not null unique,
  original_filename   text not null,
  mime_type           text not null check (mime_type in ('application/pdf', 'image/png', 'image/jpeg', 'image/webp')),
  size_bytes          bigint check (size_bytes between 1 and 10485760),
  sha256              text,
  learner_note        text not null default '' check (length(learner_note) <= 2000),
  upload_status       text not null default 'pending' check (upload_status in ('pending', 'uploaded', 'failed')),
  uploaded_at         timestamptz,
  status              public.evidence_status not null default 'submitted',
  reviewer_message    text not null default '' check (length(reviewer_message) <= 2000),  -- shown to the resident
  reviewed_by         uuid references public.profiles (id) on delete set null,
  reviewed_at         timestamptz,
  delete_requested_at timestamptz,
  file_deleted_at     timestamptz,       -- the file is gone; this record (and its sha256) is kept
  file_deleted_reason text,
  created_at          timestamptz not null default now()
);
create index on public.evidence_submissions (learner_id, cohort_id);
create index on public.evidence_submissions (requirement_id);
comment on table public.evidence_submissions is 'Proof of completion uploaded by residents. Rows are never deleted; files may be removed under the retention policy.';

-- ---------------------------------------------------------------------------
-- Retention settings (institution-configurable)
-- ---------------------------------------------------------------------------
create table public.retention_settings (
  key         text primary key check (key ~ '^[a-z_]+$'),
  retain_days int check (retain_days is null or retain_days between 0 and 36500),
  note        text not null default '',
  updated_by  uuid references public.profiles (id) on delete set null,
  updated_at  timestamptz not null default now()
);
insert into public.retention_settings (key, retain_days, note) values
  ('itar_evidence_files', null,
   'Days to keep uploaded evidence files after the block end date. Empty = keep until an administrator deletes them. Set according to the institutional records-retention policy.')
on conflict (key) do nothing;

create or replace function public.stamp_retention()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;
create trigger retention_stamp before update on public.retention_settings for each row execute function public.stamp_retention();
create trigger retention_audit after insert or update or delete on public.retention_settings for each row execute function public.audit_trigger();

-- ---------------------------------------------------------------------------
-- EPA review (faculty-entered, transcribed from Elentra)
-- ---------------------------------------------------------------------------
create table public.epa_reviews (
  id                    uuid primary key default gen_random_uuid(),
  course_id             uuid not null references public.courses (id) on delete restrict,
  learner_id            uuid not null references public.profiles (id) on delete restrict,
  cohort_id             uuid not null references public.cohorts (id) on delete restrict,
  source                text not null default 'elentra_manual' check (source in ('elentra_manual', 'elentra_import')),
  -- [{ "epa": "ANE-C3", "title": "...", "n_assessments": 2, "entrustment": "...", "comment": "..." }]
  entries               jsonb not null default '[]' check (jsonb_typeof(entries) = 'array'),
  strengths             text not null default '' check (length(strengths) <= 10000),
  areas_for_improvement text not null default '' check (length(areas_for_improvement) <= 10000),
  review_date           date,
  status                text not null default 'pending' check (status in ('pending', 'complete')),
  created_by            uuid references public.profiles (id) on delete set null default auth.uid(),
  updated_by            uuid references public.profiles (id) on delete set null,
  completed_by          uuid references public.profiles (id) on delete set null,
  completed_at          timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),
  unique (learner_id, cohort_id)
);

create or replace function public.guard_epa_review()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  new.course_id := (select course_id from public.cohorts where id = new.cohort_id);
  if tg_op = 'UPDATE' then
    new.created_by := old.created_by;
    if old.status = 'complete' and new.status = 'complete'
       and (to_jsonb(new) - 'updated_at' - 'updated_by') <> (to_jsonb(old) - 'updated_at' - 'updated_by') then
      raise exception 'Re-open the EPA review before editing it' using errcode = '42501';
    end if;
  end if;
  if new.status = 'complete' and (tg_op = 'INSERT' or old.status <> 'complete') then
    if new.review_date is null then
      raise exception 'Enter the review date before marking the EPA review complete' using errcode = '22023';
    end if;
    if jsonb_array_length(new.entries) = 0 and btrim(new.strengths) = '' and btrim(new.areas_for_improvement) = '' then
      raise exception 'Record at least one EPA or comment before marking the review complete' using errcode = '22023';
    end if;
    new.completed_by := auth.uid();
    new.completed_at := now();
    perform public.log_event('epa_review_completed', 'epa_reviews', new.id::text,
      jsonb_build_object('learner', new.learner_id, 'cohort', new.cohort_id));
  elsif new.status = 'pending' then
    new.completed_by := null;
    new.completed_at := null;
    if tg_op = 'UPDATE' and old.status = 'complete' then
      perform public.log_event('epa_review_reopened', 'epa_reviews', new.id::text,
        jsonb_build_object('learner', new.learner_id, 'cohort', new.cohort_id));
    end if;
  end if;
  return new;
end $$;
create trigger epa_reviews_guard before insert or update on public.epa_reviews for each row execute function public.guard_epa_review();
create trigger epa_reviews_audit after insert or update or delete on public.epa_reviews for each row execute function public.audit_trigger();

-- ---------------------------------------------------------------------------
-- Direct faculty observations: extend the existing faculty_notes
-- ---------------------------------------------------------------------------
alter table public.faculty_notes
  add column cohort_id   uuid references public.cohorts (id) on delete set null,
  add column category    text not null default 'general'
    check (category in ('general', 'scanning', 'clinical_judgement', 'technical', 'professionalism', 'communication')),
  add column observed_on date,
  add column context     text not null default '' check (length(context) <= 500);
create index on public.faculty_notes (cohort_id);
create trigger faculty_notes_audit after insert or update or delete on public.faculty_notes
  for each row execute function public.audit_trigger();

drop policy notes_read on public.faculty_notes;
drop policy notes_insert on public.faculty_notes;
drop policy notes_delete on public.faculty_notes;
create policy notes_read on public.faculty_notes for select to authenticated
  using (public.is_staff() and public.can_view_learner(learner_id)
         and (cohort_id is null or public.can_evaluate(learner_id, cohort_id)));
create policy notes_insert on public.faculty_notes for insert to authenticated
  with check (public.is_staff() and public.can_view_learner(learner_id) and author_id = auth.uid()
              and (cohort_id is null or public.can_evaluate(learner_id, cohort_id)));
-- an observation that may have fed an approved ITAR stays on record
create policy notes_delete on public.faculty_notes for delete to authenticated
  using ((author_id = auth.uid() or public.is_admin())
         and not exists (select 1 from public.evaluations e
                          where e.learner_id = faculty_notes.learner_id and e.status = 'approved'
                            and e.cohort_id is not distinct from faculty_notes.cohort_id));

-- ---------------------------------------------------------------------------
-- ITAR draft: extend the existing evaluations
-- ---------------------------------------------------------------------------
alter table public.evaluations
  add column itar_sections     jsonb not null default '[]' check (jsonb_typeof(itar_sections) = 'array'),
  add column evidence_snapshot jsonb not null default '{}',
  add column attempt_rule      text not null default 'latest_submitted' check (attempt_rule in ('latest_submitted', 'faculty_selected', 'none')),
  add column generated_at      timestamptz;
create unique index evaluations_one_per_block on public.evaluations (learner_id, cohort_id) where cohort_id is not null;

create or replace function public.guard_evaluation()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  if tg_op = 'INSERT' and auth.uid() is not null then
    new.evaluator_id := auth.uid();
  elsif tg_op = 'UPDATE' then
    new.evaluator_id := old.evaluator_id;
  end if;
  if tg_op = 'UPDATE' and old.status = 'approved' then
    if new.status = 'approved' then
      raise exception 'Approved evaluations are locked. Re-open the evaluation to edit it.' using errcode = '42501';
    end if;
    -- re-opening: only content-neutral transition allowed in the same statement
    if (to_jsonb(new) - 'status' - 'approved_by' - 'approved_at' - 'updated_at')
       <> (to_jsonb(old) - 'status' - 'approved_by' - 'approved_at' - 'updated_at') then
      raise exception 'Re-open the evaluation before editing it' using errcode = '42501';
    end if;
    new.approved_by := null; new.approved_at := null;
    perform public.log_event('evaluation_reopened', 'evaluations', new.id::text, '{}');
  elsif new.status = 'approved' and (tg_op = 'INSERT' or old.status = 'draft') then
    if btrim(new.summary) = '' then
      raise exception 'Cannot approve an empty evaluation summary' using errcode = '22023';
    end if;
    if new.learner_id = auth.uid() then
      raise exception 'You cannot approve an evaluation about yourself' using errcode = '42501';
    end if;
    new.approved_by := auth.uid(); new.approved_at := now();
    perform public.log_event('evaluation_approved', 'evaluations', new.id::text,
      jsonb_build_object('learner', new.learner_id, 'cohort', new.cohort_id,
                         'summary_sha', encode(extensions.digest(new.summary, 'sha256'), 'hex')));
  end if;
  return new;
end $$;

-- block-scoped evaluations follow the block's evaluator list
drop policy evals_read on public.evaluations;
drop policy evals_insert on public.evaluations;
drop policy evals_update on public.evaluations;
drop policy evals_delete on public.evaluations;
create policy evals_read on public.evaluations for select to authenticated
  using (public.is_staff() and public.can_view_learner(learner_id) and (cohort_id is null or public.can_evaluate(learner_id, cohort_id)));
create policy evals_insert on public.evaluations for insert to authenticated
  with check (public.is_staff() and public.can_view_learner(learner_id) and (cohort_id is null or public.can_evaluate(learner_id, cohort_id)));
create policy evals_update on public.evaluations for update to authenticated
  using (public.is_staff() and public.can_view_learner(learner_id) and (cohort_id is null or public.can_evaluate(learner_id, cohort_id)))
  with check (public.is_staff() and public.can_view_learner(learner_id) and (cohort_id is null or public.can_evaluate(learner_id, cohort_id)));
create policy evals_delete on public.evaluations for delete to authenticated
  using (public.is_staff() and public.can_view_learner(learner_id) and (cohort_id is null or public.can_evaluate(learner_id, cohort_id)) and status = 'draft');

create or replace function public.log_itar_export(p_evaluation uuid, p_format text)
returns void language plpgsql security definer set search_path = public as $$
declare e public.evaluations;
begin
  select * into e from public.evaluations where id = p_evaluation;
  if not found or not public.is_staff() or not public.can_view_learner(e.learner_id)
     or (e.cohort_id is not null and not public.can_evaluate(e.learner_id, e.cohort_id)) then
    raise exception 'Evaluation not found' using errcode = '42501';
  end if;
  if p_format not in ('copy_all', 'copy_section', 'text', 'print', 'csv') then
    raise exception 'Unknown export format' using errcode = '22023';
  end if;
  perform public.log_event('itar_exported', 'evaluations', e.id::text,
    jsonb_build_object('format', p_format, 'status', e.status, 'learner', e.learner_id,
                       'summary_sha', encode(extensions.digest(e.summary, 'sha256'), 'hex')));
end $$;

-- ---------------------------------------------------------------------------
-- Evidence upload / review / deletion functions
-- ---------------------------------------------------------------------------
create or replace function public.begin_evidence_upload(p_requirement uuid, p_cohort uuid, p_file jsonb, p_note text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  c      public.cohorts;
  r      public.evidence_requirements;
  v_id   uuid := gen_random_uuid();
  v_mime text := lower(coalesce(p_file ->> 'mime_type', ''));
  v_size bigint := nullif(p_file ->> 'size_bytes', '')::bigint;
  v_ext  text;
  v_path text;
begin
  if not public.is_member() then raise exception 'Not signed in' using errcode = '42501'; end if;
  if not exists (select 1 from public.cohort_members
                  where cohort_id = p_cohort and user_id = auth.uid() and member_role = 'learner') then
    raise exception 'You are not a resident in this rotation block' using errcode = '42501';
  end if;
  select * into c from public.cohorts where id = p_cohort;
  select * into r from public.evidence_requirements
   where id = p_requirement and archived_at is null and course_id = c.course_id and (cohort_id is null or cohort_id = p_cohort);
  if not found then raise exception 'This requirement does not apply to this block' using errcode = 'P0002'; end if;
  v_ext := case v_mime when 'application/pdf' then 'pdf' when 'image/png' then 'png' when 'image/jpeg' then 'jpg' when 'image/webp' then 'webp' end;
  if v_ext is null then raise exception 'Upload a PDF, PNG, JPEG or WebP file' using errcode = '22023'; end if;
  if v_size is null or v_size < 1 or v_size > 10485760 then raise exception 'Files must be 10 MB or smaller' using errcode = '22023'; end if;
  v_path := auth.uid()::text || '/' || p_cohort::text || '/' || v_id::text || '.' || v_ext;
  insert into public.evidence_submissions (id, requirement_id, learner_id, cohort_id, storage_path, original_filename, mime_type, size_bytes, sha256, learner_note)
  values (v_id, r.id, auth.uid(), p_cohort, v_path, left(coalesce(nullif(btrim(p_file ->> 'filename'), ''), 'evidence.' || v_ext), 200),
          v_mime, v_size, p_file ->> 'sha256', left(coalesce(p_note, ''), 2000));
  return jsonb_build_object('id', v_id, 'storage_path', v_path);
end $$;

create or replace function public.complete_evidence_upload(p_id uuid, p_ok boolean, p_error text default null)
returns jsonb language plpgsql security definer set search_path = public, storage as $$
declare s public.evidence_submissions; v_size bigint;
begin
  select * into s from public.evidence_submissions where id = p_id and learner_id = auth.uid() for update;
  if not found then raise exception 'Upload not found' using errcode = 'P0002'; end if;
  if s.upload_status = 'uploaded' then return jsonb_build_object('status', 'uploaded'); end if;
  if not p_ok then
    update public.evidence_submissions set upload_status = 'failed' where id = s.id;
    return jsonb_build_object('status', 'failed');
  end if;
  select (o.metadata ->> 'size')::bigint into v_size from storage.objects o where o.bucket_id = 'itar-evidence' and o.name = s.storage_path;
  if not found then
    update public.evidence_submissions set upload_status = 'failed' where id = s.id;
    return jsonb_build_object('status', 'failed', 'error', 'File not found in storage after upload');
  end if;
  update public.evidence_submissions set upload_status = 'uploaded', uploaded_at = now(), size_bytes = coalesce(v_size, size_bytes) where id = s.id;
  perform public.log_event('evidence_uploaded', 'evidence_submissions', s.id::text,
    jsonb_build_object('learner', s.learner_id, 'cohort', s.cohort_id, 'requirement', s.requirement_id, 'sha256', s.sha256));
  return jsonb_build_object('status', 'uploaded');
end $$;

create or replace function public.review_evidence(p_id uuid, p_status text, p_message text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.evidence_submissions; v_prev public.evidence_status;
begin
  select * into s from public.evidence_submissions where id = p_id for update;
  if not found or not public.is_staff() or not public.can_evaluate(s.learner_id, s.cohort_id) then
    raise exception 'Evidence not found' using errcode = '42501';
  end if;
  if s.learner_id = auth.uid() then raise exception 'You cannot review your own evidence' using errcode = '42501'; end if;
  if s.upload_status <> 'uploaded' or s.file_deleted_at is not null then
    raise exception 'There is no file to review' using errcode = '22023';
  end if;
  if p_status not in ('verified', 'clarification_requested', 'rejected') then
    raise exception 'Unknown review decision' using errcode = '22023';
  end if;
  if p_status <> 'verified' and btrim(coalesce(p_message, '')) = '' then
    raise exception 'Add a message telling the resident what is needed' using errcode = '22023';
  end if;
  v_prev := s.status;
  update public.evidence_submissions
     set status = p_status::public.evidence_status, reviewer_message = left(coalesce(p_message, ''), 2000),
         reviewed_by = auth.uid(), reviewed_at = now()
   where id = s.id returning * into s;
  perform public.log_event('evidence_' || p_status, 'evidence_submissions', s.id::text,
    jsonb_build_object('learner', s.learner_id, 'cohort', s.cohort_id, 'requirement', s.requirement_id,
                       'previous_status', v_prev, 'message', s.reviewer_message, 'sha256', s.sha256));
  return to_jsonb(s);
end $$;

-- Files due under the retention policy (admin).
create or replace function public.evidence_due_for_deletion()
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_days int;
begin
  perform public.require_admin();
  select retain_days into v_days from public.retention_settings where key = 'itar_evidence_files';
  if v_days is null then return '[]'::jsonb; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('id', s.id, 'learner', coalesce(nullif(p.full_name, ''), p.email), 'block', c.name,
                     'block_end', c.end_date, 'requirement', r.title, 'filename', s.original_filename, 'status', s.status,
                     'uploaded_at', s.uploaded_at) order by c.end_date, p.full_name)
      from public.evidence_submissions s
      join public.cohorts c on c.id = s.cohort_id
      join public.profiles p on p.id = s.learner_id
      join public.evidence_requirements r on r.id = s.requirement_id
     where s.file_deleted_at is null and c.end_date is not null and c.end_date + v_days < current_date), '[]'::jsonb);
end $$;

-- Two-step file deletion: mark (this), remove through the Storage API (only
-- marked files are deletable, and only by admins), then confirm.
create or replace function public.request_evidence_file_deletion(p_ids uuid[], p_reason text)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform public.require_admin();
  if btrim(coalesce(p_reason, '')) = '' then raise exception 'Give a reason (e.g. retention policy, file uploaded in error)' using errcode = '22023'; end if;
  update public.evidence_submissions set delete_requested_at = now(), file_deleted_reason = left(p_reason, 500)
   where id = any (p_ids) and file_deleted_at is null;
  return coalesce((select jsonb_agg(storage_path) from public.evidence_submissions
                    where id = any (p_ids) and file_deleted_at is null), '[]'::jsonb);
end $$;

create or replace function public.confirm_evidence_file_deletion(p_ids uuid[])
returns int language plpgsql security definer set search_path = public, storage as $$
declare s record; n int := 0;
begin
  perform public.require_admin();
  for s in select * from public.evidence_submissions
            where id = any (p_ids) and delete_requested_at is not null and file_deleted_at is null for update loop
    if not exists (select 1 from storage.objects o where o.bucket_id = 'itar-evidence' and o.name = s.storage_path) then
      update public.evidence_submissions set file_deleted_at = now() where id = s.id;
      perform public.log_event('evidence_file_deleted', 'evidence_submissions', s.id::text,
        jsonb_build_object('learner', s.learner_id, 'cohort', s.cohort_id, 'reason', s.file_deleted_reason, 'sha256', s.sha256));
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- ---------------------------------------------------------------------------
-- Read models
-- ---------------------------------------------------------------------------
-- Resident: my blocks, their requirements and my own submissions (no faculty data).
create or replace function public.my_evidence()
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.is_member() then raise exception 'Not signed in' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'cohort', jsonb_build_object('id', c.id, 'name', c.name, 'block_label', c.block_label, 'academic_year', c.academic_year,
                                          'start_date', c.start_date, 'end_date', c.end_date,
                                          'course', (select title from public.courses where id = c.course_id)),
             'requirements', coalesce((
               select jsonb_agg(jsonb_build_object(
                        'id', r.id, 'title', r.title, 'description', r.description, 'external_ref', r.external_ref, 'required', r.required,
                        'submissions', coalesce((
                          select jsonb_agg(jsonb_build_object(
                                   'id', s.id, 'original_filename', s.original_filename, 'mime_type', s.mime_type, 'size_bytes', s.size_bytes,
                                   'storage_path', s.storage_path, 'status', s.status, 'reviewer_message', s.reviewer_message,
                                   'reviewed_at', s.reviewed_at, 'created_at', s.created_at, 'learner_note', s.learner_note,
                                   'file_deleted', s.file_deleted_at is not null) order by s.created_at desc)
                            from public.evidence_submissions s
                           where s.requirement_id = r.id and s.learner_id = auth.uid() and s.cohort_id = c.id and s.upload_status = 'uploaded'), '[]'))
                      order by r.sort, r.title)
                 from public.evidence_requirements r
                where r.course_id = c.course_id and (r.cohort_id is null or r.cohort_id = c.id) and r.archived_at is null), '[]'))
           order by c.start_date desc nulls last, c.name)
      from public.cohort_members m join public.cohorts c on c.id = m.cohort_id
     where m.user_id = auth.uid() and m.member_role = 'learner' and c.archived_at is null), '[]'::jsonb);
end $$;

-- Exam attempts that belong to a block: exams assigned to the block, or to the
-- resident individually, in the block's rotation.
create or replace function public._block_attempts(p_learner uuid, p_cohort uuid)
returns setof public.attempts language sql stable security definer set search_path = public as $$
  select a.* from public.attempts a
    join public.assignments asg on asg.id = a.assignment_id
    join public.exam_versions ev on ev.id = a.exam_version_id
    join public.exams e on e.id = ev.exam_id
    join public.cohorts c on c.id = p_cohort
   where a.user_id = p_learner and e.course_id = c.course_id
     and (asg.cohort_id = p_cohort or asg.user_id = p_learner)
$$;

create or replace function public.itar_workspace(p_learner uuid, p_cohort uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c public.cohorts; p public.profiles;
begin
  if not public.is_staff() or not public.can_evaluate(p_learner, p_cohort) then
    raise exception 'Resident not found in this block' using errcode = '42501';
  end if;
  select * into c from public.cohorts where id = p_cohort;
  select * into p from public.profiles where id = p_learner;
  if c.id is null or p.id is null then raise exception 'Resident not found in this block' using errcode = 'P0002'; end if;
  perform public._finalize_overdue(p_learner, null);
  return jsonb_build_object(
    'me', auth.uid(),
    'learner', jsonb_build_object('id', p.id, 'full_name', p.full_name, 'email', p.email, 'training_level', p.training_level, 'program', p.program),
    'cohort', to_jsonb(c) || jsonb_build_object('course', (select title from public.courses where id = c.course_id)),
    'requirements', coalesce((
      select jsonb_agg(to_jsonb(r) || jsonb_build_object('submissions', coalesce((
               select jsonb_agg(to_jsonb(s) || jsonb_build_object('reviewer_name', (select full_name from public.profiles where id = s.reviewed_by))
                                order by s.created_at desc)
                 from public.evidence_submissions s
                where s.requirement_id = r.id and s.learner_id = p_learner and s.cohort_id = p_cohort and s.upload_status = 'uploaded'), '[]'))
             order by r.sort, r.title)
        from public.evidence_requirements r
       where r.course_id = c.course_id and (r.cohort_id is null or r.cohort_id = p_cohort) and r.archived_at is null), '[]'),
    'exam_assigned', exists (
      select 1 from public.assignments asg join public.exam_versions ev on ev.id = asg.exam_version_id join public.exams e on e.id = ev.exam_id
       where asg.archived_at is null and e.course_id = c.course_id and (asg.cohort_id = p_cohort or asg.user_id = p_learner)),
    'attempts', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', a.id, 'exam_title', ev.title, 'exam_version_id', ev.id, 'version', ev.version, 'attempt_no', a.attempt_no,
               'status', a.status, 'started_at', a.started_at, 'submitted_at', a.submitted_at, 'submit_reason', a.submit_reason,
               'score_points', a.score_points, 'max_points', a.max_points, 'score_pct', a.score_pct, 'passed', a.passed,
               'pass_threshold_pct', ev.pass_threshold_pct, 'grading_status', a.grading_status, 'released', a.released_at is not null,
               'breakdown', case when a.status = 'submitted' then public.attempt_breakdown(a.id) end)
             order by coalesce(a.submitted_at, a.started_at) desc)
        from public._block_attempts(p_learner, p_cohort) a join public.exam_versions ev on ev.id = a.exam_version_id), '[]'),
    'epa_review', (
      select to_jsonb(r) || jsonb_build_object('completed_by_name', (select full_name from public.profiles where id = r.completed_by),
                                               'updated_by_name', (select full_name from public.profiles where id = r.updated_by))
        from public.epa_reviews r where r.learner_id = p_learner and r.cohort_id = p_cohort),
    'observations', coalesce((
      select jsonb_agg(to_jsonb(n) || jsonb_build_object('author', (select full_name from public.profiles where id = n.author_id))
             order by coalesce(n.observed_on, n.created_at::date) desc, n.created_at desc)
        from public.faculty_notes n
       where n.learner_id = p_learner and (n.cohort_id = p_cohort or (n.cohort_id is null and n.course_id = c.course_id))), '[]'),
    'evaluation', (
      select to_jsonb(e) || jsonb_build_object('approved_by_name', (select full_name from public.profiles where id = e.approved_by))
        from public.evaluations e where e.learner_id = p_learner and e.cohort_id = p_cohort),
    'roster', coalesce((
      select jsonb_agg(jsonb_build_object('id', pr.id, 'name', coalesce(nullif(pr.full_name, ''), pr.email)) order by pr.full_name, pr.email)
        from public.cohort_members m join public.profiles pr on pr.id = m.user_id
       where m.cohort_id = p_cohort and m.member_role = 'learner' and pr.active), '[]'));
end $$;

-- Blocks the caller can prepare ITARs for.
create or replace function public.itar_blocks()
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  perform public.require_staff();
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', c.id, 'name', c.name, 'block_label', c.block_label, 'academic_year', c.academic_year,
             'start_date', c.start_date, 'end_date', c.end_date, 'archived', c.archived_at is not null,
             'course', (select title from public.courses where id = c.course_id),
             'n_residents', (select count(*) from public.cohort_members m join public.profiles p on p.id = m.user_id
                              where m.cohort_id = c.id and m.member_role = 'learner' and p.active),
             'n_approved', (select count(*) from public.evaluations e where e.cohort_id = c.id and e.status = 'approved'))
           order by c.archived_at nulls first, c.start_date desc nulls last, c.name)
      from public.cohorts c
     where public.is_admin()
        or exists (select 1 from public.cohort_members m where m.cohort_id = c.id and m.user_id = auth.uid() and m.member_role = 'evaluator')), '[]'::jsonb);
end $$;

create or replace function public.itar_block_overview(p_cohort uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c public.cohorts;
begin
  perform public.require_staff();
  if not public.is_admin() and not exists (select 1 from public.cohort_members m
                                            where m.cohort_id = p_cohort and m.user_id = auth.uid() and m.member_role = 'evaluator') then
    raise exception 'Block not found' using errcode = '42501';
  end if;
  select * into c from public.cohorts where id = p_cohort;
  if not found then raise exception 'Block not found' using errcode = 'P0002'; end if;
  perform public._finalize_overdue(null, null);
  return jsonb_build_object(
    'cohort', to_jsonb(c) || jsonb_build_object('course', (select title from public.courses where id = c.course_id)),
    'residents', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', pr.id, 'name', coalesce(nullif(pr.full_name, ''), pr.email), 'training_level', pr.training_level,
               'exam', jsonb_build_object(
                  'assigned', exists (select 1 from public.assignments asg join public.exam_versions ev on ev.id = asg.exam_version_id
                                        join public.exams e on e.id = ev.exam_id
                                       where asg.archived_at is null and e.course_id = c.course_id and (asg.cohort_id = p_cohort or asg.user_id = pr.id)),
                  'n_attempts', (select count(*) from public._block_attempts(pr.id, p_cohort)),
                  'in_progress', exists (select 1 from public._block_attempts(pr.id, p_cohort) a where a.status = 'in_progress'),
                  'latest', (select jsonb_build_object('id', a.id, 'attempt_no', a.attempt_no, 'score_pct', a.score_pct, 'passed', a.passed,
                                                       'grading_status', a.grading_status, 'submitted_at', a.submitted_at)
                               from public._block_attempts(pr.id, p_cohort) a where a.status = 'submitted'
                              order by a.submitted_at desc limit 1)),
               'evidence', (
                  with req as (
                    select r.id from public.evidence_requirements r
                     where r.course_id = c.course_id and (r.cohort_id is null or r.cohort_id = p_cohort) and r.archived_at is null and r.required),
                  latest as (
                    select distinct on (s.requirement_id) s.requirement_id, s.status
                      from public.evidence_submissions s
                     where s.learner_id = pr.id and s.cohort_id = p_cohort and s.upload_status = 'uploaded'
                       and s.requirement_id in (select id from req)
                     order by s.requirement_id, s.created_at desc)
                  select jsonb_build_object(
                           'required', (select count(*) from req),
                           'submitted', count(*),
                           'verified', count(*) filter (where status = 'verified'),
                           'awaiting_review', count(*) filter (where status = 'submitted'),
                           'clarification', count(*) filter (where status = 'clarification_requested'),
                           'rejected', count(*) filter (where status = 'rejected'))
                    from latest),
               'epa_status', coalesce((select r.status from public.epa_reviews r where r.learner_id = pr.id and r.cohort_id = p_cohort), 'not_started'),
               'n_observations', (select count(*) from public.faculty_notes n where n.learner_id = pr.id and n.cohort_id = p_cohort),
               'itar', (select jsonb_build_object('id', e.id, 'status', e.status, 'updated_at', e.updated_at, 'approved_at', e.approved_at,
                                                  'has_text', btrim(e.summary) <> '')
                          from public.evaluations e where e.learner_id = pr.id and e.cohort_id = p_cohort))
             order by pr.full_name, pr.email)
        from public.cohort_members m join public.profiles pr on pr.id = m.user_id
       where m.cohort_id = p_cohort and m.member_role = 'learner' and pr.active), '[]'));
end $$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.evidence_requirements enable row level security;
alter table public.evidence_submissions  enable row level security;
alter table public.retention_settings    enable row level security;
alter table public.epa_reviews           enable row level security;

create policy evreq_read on public.evidence_requirements for select to authenticated
  using (public.is_staff() or (public.is_member() and (cohort_id is null or exists (
           select 1 from public.cohort_members m where m.cohort_id = evidence_requirements.cohort_id and m.user_id = auth.uid()))));
create policy evreq_write on public.evidence_requirements for all to authenticated
  using (public.is_admin()) with check (public.is_admin());

create policy evsub_read on public.evidence_submissions for select to authenticated
  using (learner_id = auth.uid() or (public.is_staff() and public.can_evaluate(learner_id, cohort_id)));
-- writes only through the functions above
revoke insert, update, delete, truncate on public.evidence_submissions from authenticated;

create policy retention_read on public.retention_settings for select to authenticated using (public.is_staff());
create policy retention_write on public.retention_settings for update to authenticated using (public.is_admin()) with check (public.is_admin());

create policy epa_read on public.epa_reviews for select to authenticated
  using (public.is_staff() and public.can_evaluate(learner_id, cohort_id));
create policy epa_insert on public.epa_reviews for insert to authenticated
  with check (public.is_staff() and public.can_evaluate(learner_id, cohort_id));
create policy epa_update on public.epa_reviews for update to authenticated
  using (public.is_staff() and public.can_evaluate(learner_id, cohort_id))
  with check (public.is_staff() and public.can_evaluate(learner_id, cohort_id));
-- no delete policy: EPA reviews are assessment history

-- ---------------------------------------------------------------------------
-- Private storage for evidence
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('itar-evidence', 'itar-evidence', false, 10485760, array['application/pdf', 'image/png', 'image/jpeg', 'image/webp'])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

create or replace function public.can_read_evidence(p_path text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.evidence_submissions s
     where s.storage_path = p_path and s.file_deleted_at is null
       and (s.learner_id = auth.uid() or (public.is_staff() and public.can_evaluate(s.learner_id, s.cohort_id))))
$$;

create policy "itar-evidence read" on storage.objects for select to authenticated
  using (bucket_id = 'itar-evidence' and public.can_read_evidence(name));
create policy "itar-evidence resident insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'itar-evidence' and exists (
    select 1 from public.evidence_submissions s where s.storage_path = name and s.learner_id = auth.uid() and s.upload_status = 'pending'));
create policy "itar-evidence admin delete" on storage.objects for delete to authenticated
  using (bucket_id = 'itar-evidence' and public.is_admin() and exists (
    select 1 from public.evidence_submissions s where s.storage_path = name and s.delete_requested_at is not null and s.file_deleted_at is null));
-- no update policy: an uploaded file is never replaced in place (a new upload is a new record)

-- ---------------------------------------------------------------------------
-- POCUS: draft requirements from the required teaching cases. Admins confirm
-- them against the Brightspace course (Admin → ITAR setup).
-- ---------------------------------------------------------------------------
insert into public.evidence_requirements (course_id, kind, source, title, description, curriculum_item_id, required, sort)
select ci.course_id, 'learning_case', 'brightspace', ci.title,
       'Upload a screenshot or PDF from Brightspace showing that you completed this case (completion page, certificate or grade). [Draft requirement — confirm against the Brightspace course.]',
       ci.id, true, ci.sort
  from public.curriculum_items ci join public.courses co on co.id = ci.course_id
 where co.slug = 'pocus' and ci.required and ci.kind = 'case'
   and not exists (select 1 from public.evidence_requirements r where r.curriculum_item_id = ci.id);

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke all on public.evidence_requirements, public.evidence_submissions, public.retention_settings, public.epa_reviews from anon;
revoke execute on function
  public.guard_epa_review(),
  public.stamp_retention(),
  public._block_attempts(uuid, uuid)
from public, anon, authenticated;
revoke execute on function
  public.can_evaluate(uuid, uuid), public.can_read_evidence(text), public.begin_evidence_upload(uuid, uuid, jsonb, text),
  public.complete_evidence_upload(uuid, boolean, text), public.review_evidence(uuid, text, text), public.evidence_due_for_deletion(),
  public.request_evidence_file_deletion(uuid[], text), public.confirm_evidence_file_deletion(uuid[]), public.my_evidence(),
  public.itar_workspace(uuid, uuid), public.itar_blocks(), public.itar_block_overview(uuid), public.log_itar_export(uuid, text)
from public, anon;
grant execute on function
  public.can_evaluate(uuid, uuid), public.can_read_evidence(text), public.begin_evidence_upload(uuid, uuid, jsonb, text),
  public.complete_evidence_upload(uuid, boolean, text), public.review_evidence(uuid, text, text), public.evidence_due_for_deletion(),
  public.request_evidence_file_deletion(uuid[], text), public.confirm_evidence_file_deletion(uuid[]), public.my_evidence(),
  public.itar_workspace(uuid, uuid), public.itar_blocks(), public.itar_block_overview(uuid), public.log_itar_export(uuid, text)
to authenticated;
