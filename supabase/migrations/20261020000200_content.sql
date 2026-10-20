-- =============================================================================
-- POCUS Exam Platform — 02 content: media library, versioned question bank,
-- versioned exams.
--
-- Versioning rules
--   * media_versions are immutable once uploaded. "Replacing" a clip creates a
--     new version; questions already published keep pointing at the old one.
--   * question_versions become `locked` the moment an exam version containing
--     them is published. Editing a locked question creates a new version.
--   * exam_versions are editable only while status = 'draft'. Publishing
--     freezes settings and items. Attempts reference an exam_version, so
--     later edits can never change a learner's historical result.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Media library
-- ---------------------------------------------------------------------------
create type public.media_kind as enum ('video', 'image');
create type public.media_authorization as enum ('pending', 'authorized', 'restricted', 'rejected');
create type public.upload_status as enum ('pending', 'uploaded', 'failed');

create table public.media_assets (
  id                   uuid primary key default gen_random_uuid(),
  course_id            uuid references public.courses (id) on delete restrict,
  media_key            text not null unique check (media_key ~ '^[A-Za-z0-9._-]+$'),
  title                text not null,
  description          text not null default '',
  domain_key           text,
  tags                 text[] not null default '{}',
  kind                 public.media_kind not null,
  source               text not null default '',   -- e.g. "TOH POCUS archive", "ExamBuilder export 2026-11"
  attribution          text not null default '',
  license              text not null default '',
  authorization_status public.media_authorization not null default 'pending',
  deidentified         boolean not null default false,  -- reviewer attests no burned-in PHI / identifying metadata
  deidentified_by      uuid references public.profiles (id) on delete set null,
  deidentified_at      timestamptz,
  current_version_id   uuid,
  archived_at          timestamptz,
  created_by           uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create index on public.media_assets (domain_key);

create table public.media_versions (
  id                uuid primary key default gen_random_uuid(),
  asset_id          uuid not null references public.media_assets (id) on delete restrict,
  version           int not null,
  storage_path      text not null unique,
  original_filename text not null default '',
  mime_type         text not null,
  size_bytes        bigint,
  width             int,
  height            int,
  duration_seconds  numeric(8, 3),
  frame_rate        numeric(6, 3),
  sha256            text,
  upload_status     public.upload_status not null default 'pending',
  error             text,
  created_by        uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at        timestamptz not null default now(),
  uploaded_at       timestamptz,
  unique (asset_id, version)
);
alter table public.media_assets
  add constraint media_assets_current_version_fk foreign key (current_version_id)
  references public.media_versions (id) on delete set null;

create or replace function public.guard_media_version()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.upload_status = 'uploaded' then
      raise exception 'Uploaded media versions are permanent records; archive the asset instead' using errcode = '42501';
    end if;
    return old;
  end if;
  if old.upload_status = 'uploaded' and (
       new.storage_path is distinct from old.storage_path or new.sha256 is distinct from old.sha256
       or new.asset_id is distinct from old.asset_id or new.upload_status is distinct from old.upload_status) then
    raise exception 'Uploaded media versions are immutable; upload a new version instead' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger media_versions_guard before update or delete on public.media_versions
  for each row execute function public.guard_media_version();
create trigger media_assets_touch before update on public.media_assets for each row execute function public.touch_updated_at();
-- Record who attested de-identification, and when (server-side, not client-supplied).
create or replace function public.stamp_deidentified()
returns trigger language plpgsql as $$
begin
  if new.deidentified and (tg_op = 'INSERT' or not old.deidentified) then
    new.deidentified_by := auth.uid(); new.deidentified_at := now();
  elsif not new.deidentified then
    new.deidentified_by := null; new.deidentified_at := null;
  end if;
  return new;
end $$;
create trigger media_assets_deid before insert or update on public.media_assets for each row execute function public.stamp_deidentified();

create trigger media_assets_audit after insert or update or delete on public.media_assets for each row execute function public.audit_trigger();

-- ---------------------------------------------------------------------------
-- Question bank
-- ---------------------------------------------------------------------------
create type public.question_type as enum ('single', 'multiple', 'short_answer', 'hotspot');

create table public.questions (
  id                 uuid primary key default gen_random_uuid(),
  course_id          uuid not null references public.courses (id) on delete restrict,
  question_key       text unique,          -- optional stable key used by imports, e.g. "LUNG-003"
  current_version_id uuid,
  archived_at        timestamptz,
  created_by         uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at         timestamptz not null default now()
);

create table public.question_versions (
  id              uuid primary key default gen_random_uuid(),
  question_id     uuid not null references public.questions (id) on delete restrict,
  version         int not null,
  type            public.question_type not null,
  stem            text not null,
  options         jsonb not null default '[]',      -- [{ "id": "a", "text": "…" }]
  scoring         jsonb not null default '{}',      -- { "mode": "all_or_nothing" | "partial" }
  explanation     text not null default '',
  points          numeric(6, 2) not null default 1 check (points >= 0),
  domain_key      text,
  objective_codes text[] not null default '{}',
  needs_review    boolean not null default false,  -- e.g. imported content that faculty must verify
  review_note     text not null default '',
  source          text not null default '',
  locked          boolean not null default false,
  created_by      uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at      timestamptz not null default now(),
  unique (question_id, version),
  check (jsonb_typeof(options) = 'array')
);
alter table public.questions
  add constraint questions_current_version_fk foreign key (current_version_id)
  references public.question_versions (id) on delete set null;

-- Answer keys live in their own table so that no learner-facing path can
-- select them by accident. Learners have no policy on this table at all.
create table public.question_keys (
  question_version_id uuid primary key references public.question_versions (id) on delete cascade,
  key                 jsonb not null
  -- single/multiple: { "correct": ["b"] }
  -- short_answer:    { "model_answer": "…", "rubric": "…" }
  -- hotspot:         { "regions": [{ "media": 0, "shape": "ellipse"|"rect", "x":…, "y":…, "w":…, "h":… }] } (normalised 0–1)
);

create table public.question_version_media (
  question_version_id uuid not null references public.question_versions (id) on delete cascade,
  position            int not null,
  media_version_id    uuid not null references public.media_versions (id) on delete restrict,
  caption             text not null default '',
  primary key (question_version_id, position)
);
create index on public.question_version_media (media_version_id);

create or replace function public.guard_locked_question()
returns trigger language plpgsql as $$
declare v_locked boolean;
begin
  if tg_table_name = 'question_versions' then
    if tg_op = 'UPDATE' and old.locked and not (new.locked and
         (to_jsonb(new) - 'locked' - 'created_by') = (to_jsonb(old) - 'locked' - 'created_by')) then
      raise exception 'Question version % is locked (used in a published exam); save a new version instead', old.id using errcode = '42501';
    end if;
    if tg_op = 'DELETE' and old.locked then
      raise exception 'Locked question versions cannot be deleted' using errcode = '42501';
    end if;
    return coalesce(new, old);
  end if;
  select locked into v_locked from public.question_versions
   where id = coalesce(new.question_version_id, old.question_version_id);
  if coalesce(v_locked, false) then
    raise exception 'Question version is locked (used in a published exam)' using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;
create trigger question_versions_guard before update or delete on public.question_versions
  for each row execute function public.guard_locked_question();
create trigger question_keys_guard before insert or update or delete on public.question_keys
  for each row execute function public.guard_locked_question();
create trigger question_media_guard before insert or update or delete on public.question_version_media
  for each row execute function public.guard_locked_question();

-- ---------------------------------------------------------------------------
-- Exams
-- ---------------------------------------------------------------------------
create type public.exam_status as enum ('draft', 'published', 'retired');
create type public.feedback_policy as enum ('none', 'score', 'score_domains', 'full_review');

create table public.exams (
  id          uuid primary key default gen_random_uuid(),
  course_id   uuid not null references public.courses (id) on delete restrict,
  title       text not null,
  description text not null default '',
  archived_at timestamptz,
  created_by  uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at  timestamptz not null default now()
);

create table public.exam_versions (
  id                 uuid primary key default gen_random_uuid(),
  exam_id            uuid not null references public.exams (id) on delete restrict,
  version            int not null,
  status             public.exam_status not null default 'draft',
  title              text not null,
  instructions       text not null default '',
  time_limit_minutes int check (time_limit_minutes is null or time_limit_minutes between 1 and 600),
  max_attempts       int not null default 1 check (max_attempts between 1 and 20),
  pass_threshold_pct numeric(5, 2) check (pass_threshold_pct is null or pass_threshold_pct between 0 and 100),
  allow_resume       boolean not null default true,
  shuffle_questions  boolean not null default false,
  shuffle_options    boolean not null default false,
  feedback_policy    public.feedback_policy not null default 'score_domains',
  release_mode       text not null default 'manual' check (release_mode in ('immediate', 'manual')),
  published_at       timestamptz,
  published_by       uuid references public.profiles (id) on delete set null,
  retired_at         timestamptz,
  created_by         uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at         timestamptz not null default now(),
  unique (exam_id, version)
);
create unique index exam_one_draft on public.exam_versions (exam_id) where status = 'draft';

create table public.exam_items (
  id                  uuid primary key default gen_random_uuid(),
  exam_version_id     uuid not null references public.exam_versions (id) on delete cascade,
  position            int not null,
  section             text not null default '',
  question_version_id uuid not null references public.question_versions (id) on delete restrict,
  points              numeric(6, 2) check (points is null or points >= 0),  -- null ⇒ use question points
  unique (exam_version_id, position) deferrable initially deferred,
  unique (exam_version_id, question_version_id)
);
create index on public.exam_items (question_version_id);

create or replace function public.guard_exam_version()
returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.status <> 'draft' then
      raise exception 'Published exam versions are permanent records' using errcode = '42501';
    end if;
    return old;
  end if;
  if old.status <> 'draft' then
    -- only allowed transition: published → retired
    if not (old.status = 'published' and new.status = 'retired'
            and (to_jsonb(new) - 'status' - 'retired_at') = (to_jsonb(old) - 'status' - 'retired_at')) then
      raise exception 'Exam version % is %; create a new draft to make changes', old.version, old.status using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
create trigger exam_versions_guard before update or delete on public.exam_versions
  for each row execute function public.guard_exam_version();

create or replace function public.guard_exam_items()
returns trigger language plpgsql as $$
declare v_status public.exam_status;
begin
  select status into v_status from public.exam_versions
   where id = coalesce(new.exam_version_id, old.exam_version_id);
  if v_status is distinct from 'draft' and v_status is not null then
    raise exception 'Items of a published exam version cannot be changed' using errcode = '42501';
  end if;
  return coalesce(new, old);
end $$;
create trigger exam_items_guard before insert or update or delete on public.exam_items
  for each row execute function public.guard_exam_items();

create trigger exam_versions_audit after insert or update or delete on public.exam_versions for each row execute function public.audit_trigger();

-- ---------------------------------------------------------------------------
-- Content RPCs (admin)
-- ---------------------------------------------------------------------------
create or replace function public.require_admin()
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() then
    raise exception 'Administrator access required' using errcode = '42501';
  end if;
end $$;

create or replace function public.require_staff()
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_staff() then
    raise exception 'Faculty access required' using errcode = '42501';
  end if;
end $$;

-- Register a new media version before the browser uploads the file directly to
-- Storage. Creates the asset if p_asset_id is null. Returns the storage path.
create or replace function public.begin_media_upload(p_asset_id uuid, p_asset jsonb, p_file jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_asset public.media_assets;
  v_ver   int;
  v_vid   uuid := gen_random_uuid();
  v_name  text;
  v_path  text;
  v_mime  text := lower(coalesce(p_file ->> 'mime_type', ''));
begin
  perform public.require_admin();
  if v_mime not in ('video/mp4', 'video/webm', 'image/png', 'image/jpeg', 'image/gif', 'image/webp') then
    raise exception 'Unsupported format %. Convert to MP4 (H.264) or PNG/JPEG first — see the media guide.', v_mime using errcode = '22023';
  end if;
  if p_asset_id is null then
    insert into public.media_assets (course_id, media_key, title, description, domain_key, tags, kind, source, attribution, license)
    values (
      nullif(p_asset ->> 'course_id', '')::uuid,
      p_asset ->> 'media_key',
      coalesce(nullif(p_asset ->> 'title', ''), p_asset ->> 'media_key'),
      coalesce(p_asset ->> 'description', ''),
      nullif(p_asset ->> 'domain_key', ''),
      coalesce((select array_agg(x) from jsonb_array_elements_text(p_asset -> 'tags') x), '{}'),
      case when v_mime like 'video/%' then 'video' else 'image' end::public.media_kind,
      coalesce(p_asset ->> 'source', ''),
      coalesce(p_asset ->> 'attribution', ''),
      coalesce(p_asset ->> 'license', ''))
    returning * into v_asset;
  else
    select * into v_asset from public.media_assets where id = p_asset_id for update;
    if not found then raise exception 'Media asset not found' using errcode = 'P0002'; end if;
    if (v_asset.kind = 'video') <> (v_mime like 'video/%') then
      raise exception 'A replacement must be the same kind (%) as the original', v_asset.kind using errcode = '22023';
    end if;
  end if;
  select coalesce(max(version), 0) + 1 into v_ver from public.media_versions where asset_id = v_asset.id;
  v_name := regexp_replace(lower(coalesce(p_file ->> 'filename', 'clip')), '[^a-z0-9._-]+', '-', 'g');
  v_path := format('media/%s/v%s-%s-%s', v_asset.id, v_ver, left(v_vid::text, 8), right(v_name, 80));
  insert into public.media_versions (id, asset_id, version, storage_path, original_filename, mime_type, size_bytes,
                                     width, height, duration_seconds, frame_rate, sha256)
  values (v_vid, v_asset.id, v_ver, v_path, coalesce(p_file ->> 'filename', ''), v_mime,
          nullif(p_file ->> 'size_bytes', '')::bigint, nullif(p_file ->> 'width', '')::int, nullif(p_file ->> 'height', '')::int,
          nullif(p_file ->> 'duration_seconds', '')::numeric, nullif(p_file ->> 'frame_rate', '')::numeric,
          nullif(p_file ->> 'sha256', ''));
  return jsonb_build_object('asset_id', v_asset.id, 'version_id', v_vid, 'version', v_ver, 'storage_path', v_path, 'bucket', 'exam-media');
end $$;

-- Called after the browser finishes the direct upload. Verifies the object
-- really exists in Storage before marking the version usable.
create or replace function public.complete_media_upload(p_version_id uuid, p_ok boolean, p_error text default null)
returns jsonb language plpgsql security definer set search_path = public, storage as $$
declare
  v public.media_versions;
  v_size bigint;
begin
  perform public.require_admin();
  select * into v from public.media_versions where id = p_version_id for update;
  if not found then raise exception 'Media version not found' using errcode = 'P0002'; end if;
  if v.upload_status = 'uploaded' then return jsonb_build_object('status', 'uploaded'); end if;
  if not p_ok then
    update public.media_versions set upload_status = 'failed', error = left(coalesce(p_error, 'Upload failed'), 500) where id = v.id;
    return jsonb_build_object('status', 'failed');
  end if;
  select (o.metadata ->> 'size')::bigint into v_size
    from storage.objects o where o.bucket_id = 'exam-media' and o.name = v.storage_path;
  if not found then
    update public.media_versions set upload_status = 'failed', error = 'File not found in storage after upload' where id = v.id;
    return jsonb_build_object('status', 'failed', 'error', 'File not found in storage after upload');
  end if;
  update public.media_versions
     set upload_status = 'uploaded', uploaded_at = now(), error = null, size_bytes = coalesce(v_size, size_bytes)
   where id = v.id;
  update public.media_assets set current_version_id = v.id where id = v.asset_id;
  perform public.log_event('media_uploaded', 'media_versions', v.id::text,
    jsonb_build_object('asset_id', v.asset_id, 'version', v.version, 'path', v.storage_path));
  return jsonb_build_object('status', 'uploaded');
end $$;

-- Validate a question version; returns a list of issues.
create or replace function public.question_issues(p_qv uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  q   public.question_versions;
  k   jsonb;
  ids text[];
  correct text[];
  issues jsonb := '[]';
  m record;
begin
  select * into q from public.question_versions where id = p_qv;
  if not found then return jsonb_build_array(jsonb_build_object('level', 'error', 'message', 'Question version not found')); end if;
  select key into k from public.question_keys where question_version_id = p_qv;
  if btrim(q.stem) = '' then issues := issues || jsonb_build_object('level', 'error', 'message', 'Question stem is empty'); end if;
  if q.needs_review then issues := issues || jsonb_build_object('level', 'error', 'message', 'Flagged for faculty review: ' || coalesce(nullif(q.review_note, ''), 'verify content')); end if;
  if q.type in ('single', 'multiple') then
    select array_agg(o ->> 'id') into ids from jsonb_array_elements(q.options) o;
    if coalesce(array_length(ids, 1), 0) < 2 then
      issues := issues || jsonb_build_object('level', 'error', 'message', 'Needs at least two answer options');
    elsif (select count(distinct x) from unnest(ids) x) <> array_length(ids, 1)
          or exists (select 1 from jsonb_array_elements(q.options) o where coalesce(btrim(o ->> 'text'), '') = '' or coalesce(o ->> 'id', '') = '') then
      issues := issues || jsonb_build_object('level', 'error', 'message', 'Answer options must have unique ids and non-empty text');
    end if;
    select array_agg(x) into correct from jsonb_array_elements_text(coalesce(k -> 'correct', '[]')) x;
    if coalesce(array_length(correct, 1), 0) = 0 then
      issues := issues || jsonb_build_object('level', 'error', 'message', 'No correct answer is set');
    elsif not (correct <@ coalesce(ids, '{}')) then
      issues := issues || jsonb_build_object('level', 'error', 'message', 'Correct answer refers to an option that does not exist');
    elsif q.type = 'single' and array_length(correct, 1) <> 1 then
      issues := issues || jsonb_build_object('level', 'error', 'message', 'Single-best-answer questions need exactly one correct option');
    end if;
  elsif q.type = 'short_answer' then
    if coalesce(btrim(k ->> 'model_answer'), '') = '' then
      issues := issues || jsonb_build_object('level', 'warning', 'message', 'No model answer for graders');
    end if;
  elsif q.type = 'hotspot' then
    if jsonb_array_length(coalesce(k -> 'regions', '[]')) = 0 then
      issues := issues || jsonb_build_object('level', 'error', 'message', 'Hotspot question has no target region');
    end if;
    if not exists (select 1 from public.question_version_media where question_version_id = p_qv) then
      issues := issues || jsonb_build_object('level', 'error', 'message', 'Hotspot question needs an image');
    end if;
  end if;
  for m in
    select qvm.position, mv.upload_status, ma.authorization_status, ma.deidentified, ma.archived_at, ma.media_key
      from public.question_version_media qvm
      join public.media_versions mv on mv.id = qvm.media_version_id
      join public.media_assets ma on ma.id = mv.asset_id
     where qvm.question_version_id = p_qv
  loop
    if m.upload_status <> 'uploaded' then
      issues := issues || jsonb_build_object('level', 'error', 'message', format('Media %s has not finished uploading', m.media_key));
    end if;
    if m.authorization_status <> 'authorized' then
      issues := issues || jsonb_build_object('level', 'error', 'message', format('Media %s is not authorized for educational use (%s)', m.media_key, m.authorization_status));
    end if;
    if not m.deidentified then
      issues := issues || jsonb_build_object('level', 'error', 'message', format('Media %s has not been confirmed de-identified', m.media_key));
    end if;
    if m.archived_at is not null then
      issues := issues || jsonb_build_object('level', 'warning', 'message', format('Media %s is archived', m.media_key));
    end if;
  end loop;
  if q.domain_key is null then
    issues := issues || jsonb_build_object('level', 'warning', 'message', 'No curriculum domain (domain reporting will show it as "Unassigned")');
  end if;
  return issues;
end $$;

-- Create or edit a question. Edits a draft version in place; if the current
-- version is locked, creates a new version and repoints draft exams to it.
create or replace function public.save_question(p_question_id uuid, p jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_q    public.questions;
  v_cur  public.question_versions;
  v_qv   uuid;
  v_new  boolean := false;
  v_ver  int;
  m      jsonb;
  i      int := 0;
begin
  perform public.require_admin();
  if coalesce(p ->> 'type', '') not in ('single', 'multiple', 'short_answer', 'hotspot') then
    raise exception 'Invalid question type' using errcode = '22023';
  end if;
  if p_question_id is null then
    insert into public.questions (course_id, question_key)
    values ((p ->> 'course_id')::uuid, nullif(p ->> 'question_key', ''))
    returning * into v_q;
  else
    select * into v_q from public.questions where id = p_question_id for update;
    if not found then raise exception 'Question not found' using errcode = 'P0002'; end if;
    if p ? 'question_key' then
      update public.questions set question_key = nullif(p ->> 'question_key', '') where id = v_q.id;
    end if;
    select * into v_cur from public.question_versions where id = v_q.current_version_id;
  end if;

  if v_cur.id is null or v_cur.locked then
    select coalesce(max(version), 0) + 1 into v_ver from public.question_versions where question_id = v_q.id;
    insert into public.question_versions (question_id, version, type, stem, options, scoring, explanation, points,
                                          domain_key, objective_codes, needs_review, review_note, source)
    values (v_q.id, v_ver, (p ->> 'type')::public.question_type, coalesce(p ->> 'stem', ''),
            coalesce(p -> 'options', '[]'), coalesce(p -> 'scoring', '{}'), coalesce(p ->> 'explanation', ''),
            coalesce((p ->> 'points')::numeric, 1), nullif(p ->> 'domain_key', ''),
            coalesce((select array_agg(x) from jsonb_array_elements_text(p -> 'objective_codes') x), '{}'),
            coalesce((p ->> 'needs_review')::boolean, false), coalesce(p ->> 'review_note', ''), coalesce(p ->> 'source', ''))
    returning id into v_qv;
    v_new := true;
  else
    v_qv := v_cur.id;
    update public.question_versions set
      type = (p ->> 'type')::public.question_type, stem = coalesce(p ->> 'stem', ''),
      options = coalesce(p -> 'options', '[]'), scoring = coalesce(p -> 'scoring', '{}'),
      explanation = coalesce(p ->> 'explanation', ''), points = coalesce((p ->> 'points')::numeric, 1),
      domain_key = nullif(p ->> 'domain_key', ''),
      objective_codes = coalesce((select array_agg(x) from jsonb_array_elements_text(p -> 'objective_codes') x), '{}'),
      needs_review = coalesce((p ->> 'needs_review')::boolean, false), review_note = coalesce(p ->> 'review_note', ''),
      source = coalesce(p ->> 'source', '')
    where id = v_qv;
    delete from public.question_version_media where question_version_id = v_qv;
  end if;

  insert into public.question_keys (question_version_id, key) values (v_qv, coalesce(p -> 'key', '{}'))
  on conflict (question_version_id) do update set key = excluded.key;

  for m in select * from jsonb_array_elements(coalesce(p -> 'media', '[]')) loop
    insert into public.question_version_media (question_version_id, position, media_version_id, caption)
    values (v_qv, i, (m ->> 'media_version_id')::uuid, coalesce(m ->> 'caption', ''));
    i := i + 1;
  end loop;

  update public.questions set current_version_id = v_qv where id = v_q.id;
  if v_new and v_cur.id is not null then
    -- keep draft exams pointing at the newest wording; published ones are untouched
    update public.exam_items ei set question_version_id = v_qv
      from public.exam_versions ev
     where ei.exam_version_id = ev.id and ev.status = 'draft' and ei.question_version_id = v_cur.id;
  end if;
  return jsonb_build_object('question_id', v_q.id, 'question_version_id', v_qv, 'new_version', v_new,
                            'issues', public.question_issues(v_qv));
end $$;

create or replace function public.create_exam(p_course_id uuid, p_title text, p_description text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_exam uuid; v_ver uuid;
begin
  perform public.require_admin();
  insert into public.exams (course_id, title, description) values (p_course_id, p_title, coalesce(p_description, ''))
  returning id into v_exam;
  insert into public.exam_versions (exam_id, version, title) values (v_exam, 1, p_title) returning id into v_ver;
  return jsonb_build_object('exam_id', v_exam, 'exam_version_id', v_ver);
end $$;

-- Start a new draft from the latest version (settings + items, items moved
-- to each question's current version).
create or replace function public.new_exam_draft(p_exam_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_src public.exam_versions; v_new uuid; v_ver int;
begin
  perform public.require_admin();
  select id into v_new from public.exam_versions where exam_id = p_exam_id and status = 'draft';
  if v_new is not null then return v_new; end if;
  select * into v_src from public.exam_versions where exam_id = p_exam_id order by version desc limit 1;
  if not found then raise exception 'Exam not found' using errcode = 'P0002'; end if;
  v_ver := v_src.version + 1;
  insert into public.exam_versions (exam_id, version, title, instructions, time_limit_minutes, max_attempts,
         pass_threshold_pct, allow_resume, shuffle_questions, shuffle_options, feedback_policy, release_mode)
  values (p_exam_id, v_ver, v_src.title, v_src.instructions, v_src.time_limit_minutes, v_src.max_attempts,
         v_src.pass_threshold_pct, v_src.allow_resume, v_src.shuffle_questions, v_src.shuffle_options,
         v_src.feedback_policy, v_src.release_mode)
  returning id into v_new;
  insert into public.exam_items (exam_version_id, position, section, question_version_id, points)
  select v_new, ei.position, ei.section, coalesce(q.current_version_id, ei.question_version_id), ei.points
    from public.exam_items ei
    join public.question_versions qv on qv.id = ei.question_version_id
    join public.questions q on q.id = qv.question_id
   where ei.exam_version_id = v_src.id;
  return v_new;
end $$;

-- Replace the item list of a draft: p_items = [{question_version_id, section, points}]
create or replace function public.set_exam_items(p_exam_version_id uuid, p_items jsonb)
returns int language plpgsql security definer set search_path = public as $$
declare v_status public.exam_status; n int;
begin
  perform public.require_admin();
  select status into v_status from public.exam_versions where id = p_exam_version_id;
  if v_status is distinct from 'draft' then
    raise exception 'Only draft exam versions can be edited' using errcode = '42501';
  end if;
  delete from public.exam_items where exam_version_id = p_exam_version_id;
  insert into public.exam_items (exam_version_id, position, section, question_version_id, points)
  select p_exam_version_id, (t.ord - 1)::int, coalesce(t.e ->> 'section', ''), (t.e ->> 'question_version_id')::uuid,
         nullif(t.e ->> 'points', '')::numeric
    from jsonb_array_elements(p_items) with ordinality as t(e, ord);
  get diagnostics n = row_count;
  return n;
end $$;

create or replace function public.exam_version_issues(p_exam_version_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v public.exam_versions;
  issues jsonb := '[]';
  it record;
  qi jsonb;
begin
  perform public.require_staff();
  select * into v from public.exam_versions where id = p_exam_version_id;
  if not found then raise exception 'Exam version not found' using errcode = 'P0002'; end if;
  if not exists (select 1 from public.exam_items where exam_version_id = v.id) then
    issues := issues || jsonb_build_object('level', 'error', 'message', 'The exam has no questions');
  end if;
  if v.pass_threshold_pct is null then
    issues := issues || jsonb_build_object('level', 'warning', 'message', 'No pass threshold set (results will show score only)');
  end if;
  for it in select position, question_version_id from public.exam_items where exam_version_id = v.id order by position loop
    qi := public.question_issues(it.question_version_id);
    issues := issues || coalesce((select jsonb_agg(x || jsonb_build_object('position', it.position + 1)) from jsonb_array_elements(qi) x), '[]');
  end loop;
  return issues;
end $$;

create or replace function public.publish_exam_version(p_exam_version_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v public.exam_versions; issues jsonb;
begin
  perform public.require_admin();
  select * into v from public.exam_versions where id = p_exam_version_id for update;
  if not found then raise exception 'Exam version not found' using errcode = 'P0002'; end if;
  if v.status <> 'draft' then raise exception 'Only drafts can be published' using errcode = '42501'; end if;
  issues := public.exam_version_issues(v.id);
  if exists (select 1 from jsonb_array_elements(issues) x where x ->> 'level' = 'error') then
    return jsonb_build_object('published', false, 'issues', issues);
  end if;
  update public.question_versions set locked = true
   where id in (select question_version_id from public.exam_items where exam_version_id = v.id) and not locked;
  update public.exam_versions set status = 'published', published_at = now(), published_by = auth.uid() where id = v.id;
  return jsonb_build_object('published', true, 'issues', issues);
end $$;

create or replace function public.retire_exam_version(p_exam_version_id uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  perform public.require_admin();
  update public.exam_versions set status = 'retired', retired_at = now()
   where id = p_exam_version_id and status = 'published';
  if not found then raise exception 'Only published versions can be retired' using errcode = '42501'; end if;
end $$;

-- ---------------------------------------------------------------------------
-- RLS — content is staff-only. Learners reach exam content exclusively
-- through the attempt functions in migration 03.
-- ---------------------------------------------------------------------------
alter table public.media_assets           enable row level security;
alter table public.media_versions         enable row level security;
alter table public.questions              enable row level security;
alter table public.question_versions      enable row level security;
alter table public.question_keys          enable row level security;
alter table public.question_version_media enable row level security;
alter table public.exams                  enable row level security;
alter table public.exam_versions          enable row level security;
alter table public.exam_items             enable row level security;

create policy media_assets_read on public.media_assets for select to authenticated using (public.is_staff());
create policy media_assets_write on public.media_assets for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy media_versions_read on public.media_versions for select to authenticated using (public.is_staff());
create policy questions_read on public.questions for select to authenticated using (public.is_staff());
create policy questions_write on public.questions for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy qv_read on public.question_versions for select to authenticated using (public.is_staff());
create policy qkeys_read on public.question_keys for select to authenticated using (public.is_staff());
create policy qvm_read on public.question_version_media for select to authenticated using (public.is_staff());
create policy exams_read on public.exams for select to authenticated using (public.is_staff());
create policy exams_write on public.exams for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy ev_read on public.exam_versions for select to authenticated using (public.is_staff());
-- Status changes (publish/retire) only through publish_exam_version()/retire_exam_version(),
-- which validate and lock content; direct updates may edit draft settings only.
create policy ev_write on public.exam_versions for update to authenticated
  using (public.is_admin() and status = 'draft') with check (public.is_admin() and status = 'draft');
create policy ei_read on public.exam_items for select to authenticated using (public.is_staff());

revoke all on all tables in schema public from anon;
