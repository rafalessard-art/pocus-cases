-- POCUS Portal — complete database setup for Supabase project ngnggoekezucadlwiomp
-- Paste the whole file into Supabase Dashboard → SQL Editor → New query → Run (once).
-- Generated from supabase/migrations/*.sql (in order) + the first-administrator invitation.


-- ===================== 20261020000100_core.sql =====================
-- =============================================================================
-- POCUS Exam Platform — 01 core: identity, roles, courses, cohorts, curriculum,
-- audit log.
--
-- Security model (applies to every migration):
--   * Every table has RLS enabled. Supabase grants table privileges to `anon`
--     and `authenticated` by default, so RLS is the gate.
--   * `anon` gets nothing: every policy below is `to authenticated`.
--   * A signed-in user with no active `profiles` row (i.e. not invited) has no
--     role and therefore matches no policy.
--   * Privileged operations go through SECURITY DEFINER functions that check
--     the caller's role explicitly and run with a pinned search_path.
-- =============================================================================

create type public.app_role as enum ('learner', 'faculty', 'admin');

-- ---------------------------------------------------------------------------
-- Profiles (1:1 with auth.users, created only from an invitation)
-- ---------------------------------------------------------------------------
create table public.profiles (
  id             uuid primary key references auth.users (id) on delete cascade,
  email          text not null unique check (email = lower(email)),
  full_name      text not null default '',
  role           public.app_role not null default 'learner',
  training_level text,          -- e.g. "PGY-3"
  program        text,          -- e.g. "Anesthesiology"
  active         boolean not null default true,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);
comment on table public.profiles is 'Portal users. Minimal PII by design: name, email, role, training level.';

-- ---------------------------------------------------------------------------
-- Role helpers. SECURITY DEFINER so they can read profiles without recursing
-- through profiles' own RLS policies.
-- ---------------------------------------------------------------------------
create or replace function public.my_role()
returns public.app_role
language sql stable security definer set search_path = public
as $$
  select p.role from public.profiles p where p.id = auth.uid() and p.active
$$;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public
as $$ select coalesce(public.my_role() = 'admin', false) $$;

create or replace function public.is_staff()
returns boolean language sql stable security definer set search_path = public
as $$ select coalesce(public.my_role() in ('faculty', 'admin'), false) $$;

create or replace function public.is_member()
returns boolean language sql stable security definer set search_path = public
as $$ select public.my_role() is not null $$;

-- ---------------------------------------------------------------------------
-- Courses, curriculum domains, learning objectives
-- (generic: POCUS is the first course; regional, OB, cardiac… later)
-- ---------------------------------------------------------------------------
create table public.courses (
  id          uuid primary key default gen_random_uuid(),
  slug        text not null unique check (slug ~ '^[a-z0-9-]+$'),
  title       text not null,
  description text not null default '',
  created_at  timestamptz not null default now()
);

create table public.domains (
  id         uuid primary key default gen_random_uuid(),
  course_id  uuid not null references public.courses (id) on delete cascade,
  key        text not null check (key ~ '^[a-z0-9_-]+$'),
  label      text not null,
  sort       int not null default 0,
  unique (course_id, key)
);
comment on table public.domains is 'Curriculum domains used for performance-by-domain reporting (e.g. cardiac, lung, gastric).';

create table public.learning_objectives (
  id         uuid primary key default gen_random_uuid(),
  course_id  uuid not null references public.courses (id) on delete cascade,
  domain_key text,
  code       text not null,
  title      text not null,
  sort       int not null default 0,
  unique (course_id, code)
);

-- ---------------------------------------------------------------------------
-- Cohorts (a rotation block, e.g. "POCUS 2026-27 Block 4") and membership
-- ---------------------------------------------------------------------------
create table public.cohorts (
  id            uuid primary key default gen_random_uuid(),
  course_id     uuid not null references public.courses (id) on delete restrict,
  name          text not null,
  academic_year text,            -- e.g. "2026-2027"
  block_label   text,            -- e.g. "Block 4"
  start_date    date,
  end_date      date,
  archived_at   timestamptz,
  created_at    timestamptz not null default now(),
  check (end_date is null or start_date is null or end_date >= start_date)
);

create table public.cohort_members (
  cohort_id   uuid not null references public.cohorts (id) on delete cascade,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  member_role text not null default 'learner' check (member_role in ('learner', 'evaluator')),
  added_at    timestamptz not null default now(),
  primary key (cohort_id, user_id)
);
create index on public.cohort_members (user_id);

-- ---------------------------------------------------------------------------
-- Invitations: the only way to obtain an account. Public sign-up is rejected
-- by the before-user-created auth hook (below) and, as a second line of
-- defence, an un-invited auth user never receives a profile and so matches no
-- RLS policy anywhere.
-- ---------------------------------------------------------------------------
create table public.invitations (
  email          text primary key check (email = lower(email) and email like '%_@_%'),
  full_name      text not null default '',
  role           public.app_role not null default 'learner',
  training_level text,
  program        text,
  cohort_id      uuid references public.cohorts (id) on delete set null,
  invited_by     uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at     timestamptz not null default now(),
  accepted_at    timestamptz,
  revoked_at     timestamptz
);

-- ---------------------------------------------------------------------------
-- Faculty visibility: faculty see learners in cohorts where they are an
-- evaluator; admins see everyone; a user always sees themself.
-- ---------------------------------------------------------------------------
create or replace function public.can_view_learner(p_learner uuid)
returns boolean language sql stable security definer set search_path = public
as $$
  select
    p_learner = auth.uid()
    or public.is_admin()
    or (
      public.my_role() = 'faculty' and exists (
        select 1
        from public.cohort_members ev
        join public.cohort_members le on le.cohort_id = ev.cohort_id
        where ev.user_id = auth.uid() and ev.member_role = 'evaluator'
          and le.user_id = p_learner
      )
    )
$$;

-- ---------------------------------------------------------------------------
-- Curriculum: links to existing cases/tools (by URL — content is not
-- duplicated), articles, videos and the end-of-block exam.
-- ---------------------------------------------------------------------------
create table public.curriculum_items (
  id            uuid primary key default gen_random_uuid(),
  course_id     uuid not null references public.courses (id) on delete cascade,
  section       text not null default 'Resources',
  kind          text not null check (kind in ('overview', 'case', 'tool', 'article', 'video', 'reference', 'exam', 'other')),
  title         text not null,
  description   text not null default '',
  url           text,
  required      boolean not null default false,
  sort          int not null default 0,
  objective_codes text[] not null default '{}',
  created_at    timestamptz not null default now()
);

create table public.curriculum_progress (
  user_id      uuid not null references public.profiles (id) on delete cascade,
  item_id      uuid not null references public.curriculum_items (id) on delete cascade,
  completed_at timestamptz not null default now(),
  primary key (user_id, item_id)
);

-- ---------------------------------------------------------------------------
-- Audit log (append-only; written only by SECURITY DEFINER code)
-- ---------------------------------------------------------------------------
create table public.audit_log (
  id        bigint generated always as identity primary key,
  at        timestamptz not null default now(),
  actor     uuid default auth.uid(),
  action    text not null,
  entity    text not null,
  entity_id text,
  details   jsonb not null default '{}'
);
create index on public.audit_log (entity, entity_id);
create index on public.audit_log (at desc);

create or replace function public.log_event(p_action text, p_entity text, p_entity_id text, p_details jsonb default '{}')
returns void language sql security definer set search_path = public
as $$
  insert into public.audit_log (action, entity, entity_id, details)
  values (p_action, p_entity, p_entity_id, coalesce(p_details, '{}'))
$$;
revoke execute on function public.log_event(text, text, text, jsonb) from public, anon, authenticated;

-- Generic row-change auditing for administrative tables
create or replace function public.audit_trigger()
returns trigger language plpgsql security definer set search_path = public
as $$
declare
  v_id text;
begin
  v_id := coalesce(
    (case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end) ->> 'id',
    (case when tg_op = 'DELETE' then to_jsonb(old) else to_jsonb(new) end) ->> 'email'
  );
  perform public.log_event(lower(tg_op), tg_table_name, v_id,
    case when tg_op = 'UPDATE' then jsonb_build_object('before', to_jsonb(old), 'after', to_jsonb(new))
         when tg_op = 'DELETE' then to_jsonb(old)
         else to_jsonb(new) end);
  return coalesce(new, old);
end $$;

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

create trigger profiles_touch before update on public.profiles for each row execute function public.touch_updated_at();
create trigger profiles_audit after insert or update or delete on public.profiles for each row execute function public.audit_trigger();
create trigger invitations_audit after insert or update or delete on public.invitations for each row execute function public.audit_trigger();
create trigger cohort_members_audit after insert or update or delete on public.cohort_members for each row execute function public.audit_trigger();

-- Prevent anyone but an admin from changing role/active, even through a
-- permissive policy added later by mistake.
-- Deliberately NOT security definer: current_user must be the caller's role
-- (authenticated for API requests; postgres/service_role for trusted code).
create or replace function public.guard_profile_update()
returns trigger language plpgsql set search_path = public
as $$
begin
  if (new.role is distinct from old.role or new.active is distinct from old.active or new.email is distinct from old.email)
     and current_user in ('authenticated', 'anon') and not public.is_admin() then
    raise exception 'Only an administrator can change role, status or email' using errcode = '42501';
  end if;
  if old.id = auth.uid() and old.role = 'admin' and (new.role <> 'admin' or not new.active) then
    raise exception 'Administrators cannot demote or deactivate themselves' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger profiles_guard before update on public.profiles for each row execute function public.guard_profile_update();

-- ---------------------------------------------------------------------------
-- Account creation from invitation
-- ---------------------------------------------------------------------------
create or replace function public.handle_new_auth_user()
returns trigger language plpgsql security definer set search_path = public
as $$
declare
  inv public.invitations;
begin
  select * into inv from public.invitations
   where email = lower(new.email) and revoked_at is null;
  if not found then
    return new;  -- no invitation ⇒ no profile ⇒ no access
  end if;
  insert into public.profiles (id, email, full_name, role, training_level, program)
  values (new.id, lower(new.email), inv.full_name, inv.role, inv.training_level, inv.program)
  on conflict (id) do nothing;
  if inv.cohort_id is not null then
    insert into public.cohort_members (cohort_id, user_id, member_role)
    values (inv.cohort_id, new.id, case when inv.role = 'learner' then 'learner' else 'evaluator' end)
    on conflict do nothing;
  end if;
  update public.invitations set accepted_at = now() where email = inv.email;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- Supabase Auth "before user created" hook: reject sign-ups that were not
-- invited, so un-invited emails never even receive a sign-in code.
-- Enable in Dashboard → Authentication → Hooks → Before User Created →
-- Postgres function public.hook_before_user_created.
create or replace function public.hook_before_user_created(event jsonb)
returns jsonb language plpgsql security definer set search_path = public
as $$
declare
  v_email text := lower(event -> 'user' ->> 'email');
begin
  if v_email is not null and exists (
       select 1 from public.invitations where email = v_email and revoked_at is null) then
    return '{}'::jsonb;
  end if;
  return jsonb_build_object('error', jsonb_build_object(
    'http_code', 403,
    'message', 'This portal is invitation-only. Please contact the course administrator.'));
end $$;
revoke execute on function public.hook_before_user_created(jsonb) from public, anon, authenticated;
grant usage on schema public to supabase_auth_admin;
grant execute on function public.hook_before_user_created(jsonb) to supabase_auth_admin;

-- When an existing user's invitation is re-issued with a cohort, add them.
create or replace function public.invitation_sync_existing()
returns trigger language plpgsql security definer set search_path = public
as $$
declare v_uid uuid;
begin
  select id into v_uid from public.profiles where email = new.email;
  if v_uid is not null and new.cohort_id is not null and new.revoked_at is null then
    insert into public.cohort_members (cohort_id, user_id, member_role)
    values (new.cohort_id, v_uid, case when new.role = 'learner' then 'learner' else 'evaluator' end)
    on conflict do nothing;
  end if;
  return new;
end $$;
create trigger invitations_sync after insert or update on public.invitations
  for each row execute function public.invitation_sync_existing();

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.profiles            enable row level security;
alter table public.courses             enable row level security;
alter table public.domains             enable row level security;
alter table public.learning_objectives enable row level security;
alter table public.cohorts             enable row level security;
alter table public.cohort_members      enable row level security;
alter table public.invitations         enable row level security;
alter table public.curriculum_items    enable row level security;
alter table public.curriculum_progress enable row level security;
alter table public.audit_log           enable row level security;

-- profiles
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or public.is_admin()
         or (public.is_staff() and (role <> 'learner' or public.can_view_learner(id))));
create policy profiles_admin_write on public.profiles for update to authenticated
  using (public.is_admin()) with check (public.is_admin());
create policy profiles_self_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
create policy profiles_admin_delete on public.profiles for delete to authenticated
  using (public.is_admin() and id <> auth.uid());

-- reference data: readable by any member, writable by admins
create policy courses_read on public.courses for select to authenticated using (public.is_member());
create policy courses_write on public.courses for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy domains_read on public.domains for select to authenticated using (public.is_member());
create policy domains_write on public.domains for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy objectives_read on public.learning_objectives for select to authenticated using (public.is_member());
create policy objectives_write on public.learning_objectives for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy curriculum_read on public.curriculum_items for select to authenticated using (public.is_member());
create policy curriculum_write on public.curriculum_items for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- cohorts: staff see all; learners see their own cohorts
create policy cohorts_read on public.cohorts for select to authenticated
  using (public.is_staff() or exists (select 1 from public.cohort_members m where m.cohort_id = cohorts.id and m.user_id = auth.uid()));
create policy cohorts_write on public.cohorts for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy cohort_members_read on public.cohort_members for select to authenticated
  using (user_id = auth.uid() or public.is_staff());
create policy cohort_members_write on public.cohort_members for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- invitations: admins only
create policy invitations_admin on public.invitations for all to authenticated using (public.is_admin()) with check (public.is_admin());

-- curriculum progress: own rows; staff can read for learners they can view
create policy progress_read on public.curriculum_progress for select to authenticated
  using (user_id = auth.uid() or (public.is_staff() and public.can_view_learner(user_id)));
create policy progress_own_insert on public.curriculum_progress for insert to authenticated
  with check (user_id = auth.uid() and public.is_member());
create policy progress_own_delete on public.curriculum_progress for delete to authenticated
  using (user_id = auth.uid());

-- audit log: admins read; nobody writes directly
create policy audit_read on public.audit_log for select to authenticated using (public.is_admin());
revoke insert, update, delete, truncate on public.audit_log from anon, authenticated;

-- anon has no business with any of this
revoke all on all tables in schema public from anon;

-- ===================== 20261020000200_content.sql =====================
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

-- ===================== 20261020000300_delivery.sql =====================
-- =============================================================================
-- POCUS Exam Platform — 03 delivery: assignments, accommodations, attempts,
-- autosaved responses, server-side scoring, result release.
--
-- Learners have NO direct table access here. Every learner action goes through
-- a SECURITY DEFINER function that checks ownership, timing and attempt state,
-- and that never returns answer keys or explanations before release.
-- =============================================================================

create table public.assignments (
  id              uuid primary key default gen_random_uuid(),
  exam_version_id uuid not null references public.exam_versions (id) on delete restrict,
  cohort_id       uuid references public.cohorts (id) on delete restrict,
  user_id         uuid references public.profiles (id) on delete restrict,
  opens_at        timestamptz,
  due_at          timestamptz,
  note            text not null default '',
  archived_at     timestamptz,
  created_by      uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at      timestamptz not null default now(),
  check (num_nonnulls(cohort_id, user_id) = 1),
  check (due_at is null or opens_at is null or due_at > opens_at)
);
create index on public.assignments (cohort_id);
create index on public.assignments (user_id);

create or replace function public.guard_assignment()
returns trigger language plpgsql as $$
begin
  if (select status from public.exam_versions where id = new.exam_version_id) <> 'published' then
    raise exception 'Only published exam versions can be assigned' using errcode = '42501';
  end if;
  return new;
end $$;
create trigger assignments_guard before insert or update of exam_version_id on public.assignments for each row execute function public.guard_assignment();
create trigger assignments_audit after insert or update or delete on public.assignments for each row execute function public.audit_trigger();

create table public.accommodations (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references public.profiles (id) on delete cascade,
  exam_id         uuid references public.exams (id) on delete cascade,   -- null ⇒ all exams
  time_multiplier numeric(4, 2) not null default 1 check (time_multiplier between 1 and 4),
  extra_minutes   int not null default 0 check (extra_minutes between 0 and 600),
  extra_attempts  int not null default 0 check (extra_attempts between 0 and 10),
  notes           text not null default '',   -- keep clinical detail out; e.g. "Approved by PGME"
  created_by      uuid references public.profiles (id) on delete set null default auth.uid(),
  created_at      timestamptz not null default now()
);
create trigger accommodations_audit after insert or update or delete on public.accommodations for each row execute function public.audit_trigger();

create type public.attempt_status as enum ('in_progress', 'submitted');

create table public.attempts (
  id              uuid primary key default gen_random_uuid(),
  assignment_id   uuid not null references public.assignments (id) on delete restrict,
  user_id         uuid not null references public.profiles (id) on delete restrict,
  exam_version_id uuid not null references public.exam_versions (id) on delete restrict,
  attempt_no      int not null,
  status          public.attempt_status not null default 'in_progress',
  started_at      timestamptz not null default now(),
  deadline_at     timestamptz,
  submitted_at    timestamptz,
  submit_reason   text check (submit_reason in ('learner', 'time_expired', 'faculty')),
  item_order      uuid[] not null,
  option_orders   jsonb not null default '{}',
  score_points    numeric(8, 2),
  max_points      numeric(8, 2),
  score_pct       numeric(5, 2),
  passed          boolean,
  grading_status  text not null default 'not_graded' check (grading_status in ('not_graded', 'pending_manual', 'complete')),
  released_at     timestamptz,
  released_by     uuid references public.profiles (id) on delete set null,
  last_saved_at   timestamptz,
  unique (assignment_id, user_id, attempt_no)
);
create index on public.attempts (user_id);
create index on public.attempts (exam_version_id);
create unique index attempts_one_open on public.attempts (assignment_id, user_id) where status = 'in_progress';

create table public.responses (
  attempt_id     uuid not null references public.attempts (id) on delete restrict,
  exam_item_id   uuid not null references public.exam_items (id) on delete restrict,
  response       jsonb,
  flagged        boolean not null default false,
  client_seq     bigint not null default 0,
  saved_at       timestamptz not null default now(),
  is_correct     boolean,
  points_awarded numeric(6, 2),
  graded_by      uuid references public.profiles (id) on delete set null,
  graded_at      timestamptz,
  grader_comment text not null default '',
  primary key (attempt_id, exam_item_id)
);

-- Submitted attempts are historical records.
create or replace function public.guard_attempt_delete()
returns trigger language plpgsql as $$
begin
  raise exception 'Attempts and responses are permanent records' using errcode = '42501';
end $$;
create trigger attempts_no_delete before delete on public.attempts for each row execute function public.guard_attempt_delete();
create trigger responses_no_delete before delete on public.responses for each row execute function public.guard_attempt_delete();

-- ---------------------------------------------------------------------------
-- Scoring (pure function; no table access)
-- ---------------------------------------------------------------------------
create or replace function public.score_item(p_type public.question_type, p_key jsonb, p_response jsonb, p_scoring jsonb, p_points numeric)
returns table (is_correct boolean, points numeric)
language plpgsql immutable set search_path = public as $$
declare
  sel text[];
  cor text[];
  n_hit int; n_wrong int;
  pt jsonb; r jsonb;
  px numeric; py numeric; cx numeric; cy numeric; rx numeric; ry numeric;
begin
  if p_type = 'short_answer' then
    return query select null::boolean, null::numeric;   -- manual grading
    return;
  end if;
  if p_response is null then
    return query select false, 0::numeric;
    return;
  end if;
  if p_type in ('single', 'multiple') then
    select coalesce(array_agg(distinct x order by x), '{}') into sel from jsonb_array_elements_text(coalesce(p_response -> 'selected', '[]')) x;
    select coalesce(array_agg(distinct x order by x), '{}') into cor from jsonb_array_elements_text(coalesce(p_key -> 'correct', '[]')) x;
    if cardinality(sel) = 0 then return query select false, 0::numeric; return; end if;
    if sel = cor then return query select true, p_points; return; end if;
    if p_type = 'multiple' and coalesce(p_scoring ->> 'mode', 'all_or_nothing') = 'partial' and cardinality(cor) > 0 then
      select count(*) into n_hit from unnest(sel) s where s = any (cor);
      n_wrong := cardinality(sel) - n_hit;
      return query select false, round(greatest(0, least(1, (n_hit - n_wrong)::numeric / cardinality(cor))) * p_points, 2);
      return;
    end if;
    return query select false, 0::numeric;
    return;
  end if;
  if p_type = 'hotspot' then
    pt := p_response -> 'point';
    if pt is null then return query select false, 0::numeric; return; end if;
    px := (pt ->> 'x')::numeric; py := (pt ->> 'y')::numeric;
    for r in select * from jsonb_array_elements(coalesce(p_key -> 'regions', '[]')) loop
      if coalesce((r ->> 'media')::int, 0) <> coalesce((pt ->> 'media')::int, 0) then continue; end if;
      if coalesce(r ->> 'shape', 'rect') = 'ellipse' then
        rx := (r ->> 'w')::numeric / 2; ry := (r ->> 'h')::numeric / 2;
        cx := (r ->> 'x')::numeric + rx; cy := (r ->> 'y')::numeric + ry;
        if rx > 0 and ry > 0 and ((px - cx) / rx) ^ 2 + ((py - cy) / ry) ^ 2 <= 1 then
          return query select true, p_points; return;
        end if;
      else
        if px between (r ->> 'x')::numeric and (r ->> 'x')::numeric + (r ->> 'w')::numeric
           and py between (r ->> 'y')::numeric and (r ->> 'y')::numeric + (r ->> 'h')::numeric then
          return query select true, p_points; return;
        end if;
      end if;
    end loop;
    return query select false, 0::numeric;
    return;
  end if;
  return query select false, 0::numeric;
end $$;

-- ---------------------------------------------------------------------------
-- Internal helpers (not callable by clients)
-- ---------------------------------------------------------------------------
create or replace function public._accommodation(p_user uuid, p_exam uuid)
returns public.accommodations language sql stable security definer set search_path = public as $$
  select * from public.accommodations
   where user_id = p_user and (exam_id = p_exam or exam_id is null)
   order by (exam_id is not null) desc, created_at desc
   limit 1
$$;

-- Assignments that apply to a learner.
create or replace function public._my_assignment_ids(p_user uuid)
returns setof uuid language sql stable security definer set search_path = public as $$
  select a.id from public.assignments a
   where a.archived_at is null
     and (a.user_id = p_user
          or exists (select 1 from public.cohort_members m
                      where m.cohort_id = a.cohort_id and m.user_id = p_user and m.member_role = 'learner'))
$$;

create or replace function public._grade_attempt(p_attempt uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  a public.attempts;
  v public.exam_versions;
  it record;
  s record;
  v_pending boolean := false;
begin
  select * into a from public.attempts where id = p_attempt for update;
  select * into v from public.exam_versions where id = a.exam_version_id;
  -- ensure every item has a response row (unanswered ⇒ null response)
  insert into public.responses (attempt_id, exam_item_id, response, client_seq)
  select a.id, ei.id, null, 0 from public.exam_items ei
   where ei.exam_version_id = a.exam_version_id
  on conflict do nothing;
  for it in
    select r.exam_item_id, r.response, r.graded_by, qv.type, qv.scoring, qk.key, coalesce(ei.points, qv.points) as pts
      from public.responses r
      join public.exam_items ei on ei.id = r.exam_item_id
      join public.question_versions qv on qv.id = ei.question_version_id
      left join public.question_keys qk on qk.question_version_id = qv.id
     where r.attempt_id = a.id
  loop
    if it.graded_by is not null then continue; end if;  -- keep manual grades
    select * into s from public.score_item(it.type, it.key, it.response, it.scoring, it.pts);
    if it.type = 'short_answer' and it.response is not null and coalesce(btrim(it.response ->> 'text'), '') <> '' then
      v_pending := true;
    end if;
    update public.responses
       set is_correct = case when it.type = 'short_answer' and (it.response is null or coalesce(btrim(it.response ->> 'text'), '') = '') then false else s.is_correct end,
           points_awarded = case when it.type = 'short_answer' and (it.response is null or coalesce(btrim(it.response ->> 'text'), '') = '') then 0 else s.points end
     where attempt_id = a.id and exam_item_id = it.exam_item_id;
  end loop;
  perform public._recompute_attempt(a.id);
end $$;

create or replace function public._recompute_attempt(p_attempt uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_earned numeric; v_max numeric; v_pending int; v_thr numeric;
begin
  select coalesce(sum(r.points_awarded), 0),
         coalesce(sum(coalesce(ei.points, qv.points)), 0),
         count(*) filter (where r.points_awarded is null)
    into v_earned, v_max, v_pending
    from public.responses r
    join public.exam_items ei on ei.id = r.exam_item_id
    join public.question_versions qv on qv.id = ei.question_version_id
   where r.attempt_id = p_attempt;
  select ev.pass_threshold_pct into v_thr
    from public.attempts a join public.exam_versions ev on ev.id = a.exam_version_id where a.id = p_attempt;
  update public.attempts set
    score_points   = v_earned,
    max_points     = v_max,
    score_pct      = case when v_pending = 0 and v_max > 0 then round(100 * v_earned / v_max, 2) end,
    passed         = case when v_pending = 0 and v_max > 0 and v_thr is not null then (100 * v_earned / v_max) >= v_thr end,
    grading_status = case when v_pending = 0 then 'complete' else 'pending_manual' end
  where id = p_attempt;
end $$;

create or replace function public._finalize(p_attempt uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare a public.attempts; v public.exam_versions;
begin
  select * into a from public.attempts where id = p_attempt for update;
  if a.status <> 'in_progress' then return; end if;
  update public.attempts set status = 'submitted', submitted_at = now(), submit_reason = p_reason where id = a.id;
  perform public._grade_attempt(a.id);
  select * into v from public.exam_versions where id = a.exam_version_id;
  if v.release_mode = 'immediate' and (select grading_status from public.attempts where id = a.id) = 'complete' then
    update public.attempts set released_at = now() where id = a.id;
  end if;
  perform public.log_event('attempt_submitted', 'attempts', a.id::text, jsonb_build_object('reason', p_reason));
end $$;

-- Close attempts whose time has run out (60 s grace for in-flight saves).
create or replace function public._finalize_overdue(p_user uuid default null, p_exam_version uuid default null)
returns int language plpgsql security definer set search_path = public as $$
declare r record; n int := 0;
begin
  for r in select id from public.attempts
            where status = 'in_progress' and deadline_at is not null and now() > deadline_at + interval '60 seconds'
              and (p_user is null or user_id = p_user)
              and (p_exam_version is null or exam_version_id = p_exam_version)
  loop
    perform public._finalize(r.id, 'time_expired');
    n := n + 1;
  end loop;
  return n;
end $$;

revoke execute on function public._accommodation(uuid, uuid), public._my_assignment_ids(uuid), public._grade_attempt(uuid),
  public._recompute_attempt(uuid), public._finalize(uuid, text), public._finalize_overdue(uuid, uuid)
  from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Learner API
-- ---------------------------------------------------------------------------
create or replace function public.my_exams()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  out jsonb := '[]';
  r record;
  acc public.accommodations;
  used int; open_id uuid; last record;
  v_max int; v_limit numeric; v_state text;
begin
  if not public.is_member() then raise exception 'Not signed in' using errcode = '42501'; end if;
  perform public._finalize_overdue(v_uid, null);
  for r in
    select a.*, ev.title, ev.instructions, ev.time_limit_minutes, ev.max_attempts, ev.allow_resume, ev.feedback_policy,
           ev.release_mode, ev.pass_threshold_pct, ev.exam_id, ev.version, ev.status as ev_status,
           (select count(*) from public.exam_items ei where ei.exam_version_id = ev.id) as n_items
      from public.assignments a join public.exam_versions ev on ev.id = a.exam_version_id
     where a.id in (select public._my_assignment_ids(v_uid))
     order by coalesce(a.due_at, a.created_at)
  loop
    acc := public._accommodation(v_uid, r.exam_id);
    select count(*) into used from public.attempts where assignment_id = r.id and user_id = v_uid;
    select id into open_id from public.attempts where assignment_id = r.id and user_id = v_uid and status = 'in_progress';
    select id, submitted_at, released_at, attempt_no into last from public.attempts
     where assignment_id = r.id and user_id = v_uid and status = 'submitted' order by attempt_no desc limit 1;
    v_max := r.max_attempts + coalesce(acc.extra_attempts, 0);
    v_limit := case when r.time_limit_minutes is null then null
                    else r.time_limit_minutes * coalesce(acc.time_multiplier, 1) + coalesce(acc.extra_minutes, 0) end;
    v_state := case
      when open_id is not null then 'in_progress'
      when r.ev_status = 'retired' then 'closed'
      when r.opens_at is not null and now() < r.opens_at then 'upcoming'
      when r.due_at is not null and now() > r.due_at then case when used > 0 then 'completed' else 'closed' end
      when used >= v_max then 'completed'
      else 'available' end;
    out := out || jsonb_build_object(
      'assignment_id', r.id, 'exam_version_id', r.exam_version_id, 'title', r.title, 'version', r.version,
      'instructions', r.instructions, 'n_items', r.n_items, 'time_limit_minutes', v_limit,
      'accommodated', acc.id is not null,
      'max_attempts', v_max, 'attempts_used', used, 'allow_resume', r.allow_resume,
      'opens_at', r.opens_at, 'due_at', r.due_at, 'state', v_state, 'open_attempt_id', open_id,
      'last_attempt', case when last.id is null then null else jsonb_build_object(
          'id', last.id, 'attempt_no', last.attempt_no, 'submitted_at', last.submitted_at,
          'released', last.released_at is not null) end);
  end loop;
  return out;
end $$;

create or replace function public.start_attempt(p_assignment uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  a public.assignments; v public.exam_versions; acc public.accommodations;
  v_open public.attempts; used int; v_no int; v_id uuid; v_deadline timestamptz;
  v_order uuid[]; v_opts jsonb := '{}'; it record;
begin
  if not public.is_member() then raise exception 'Not signed in' using errcode = '42501'; end if;
  if p_assignment is null or p_assignment not in (select public._my_assignment_ids(v_uid)) then
    raise exception 'This exam is not assigned to you' using errcode = '42501';
  end if;
  -- serialise concurrent starts (two tabs) for this learner + assignment
  perform pg_advisory_xact_lock(hashtext(p_assignment::text || v_uid::text));
  perform public._finalize_overdue(v_uid, null);
  select * into a from public.assignments where id = p_assignment;
  select * into v from public.exam_versions where id = a.exam_version_id;
  select * into v_open from public.attempts where assignment_id = a.id and user_id = v_uid and status = 'in_progress';
  if v_open.id is not null then
    if not v.allow_resume then
      raise exception 'This exam does not allow resuming. Please contact your course administrator.' using errcode = '42501';
    end if;
    return v_open.id;
  end if;
  if v.status <> 'published' then raise exception 'This exam is no longer available' using errcode = '42501'; end if;
  if a.opens_at is not null and now() < a.opens_at then raise exception 'This exam is not open yet' using errcode = '42501'; end if;
  if a.due_at is not null and now() > a.due_at then raise exception 'The deadline for this exam has passed' using errcode = '42501'; end if;
  acc := public._accommodation(v_uid, v.exam_id);
  select count(*) into used from public.attempts where assignment_id = a.id and user_id = v_uid;
  if used >= v.max_attempts + coalesce(acc.extra_attempts, 0) then
    raise exception 'No attempts remaining' using errcode = '42501';
  end if;
  v_no := used + 1;
  if v.time_limit_minutes is not null then
    v_deadline := now() + make_interval(mins => 1) * (v.time_limit_minutes * coalesce(acc.time_multiplier, 1) + coalesce(acc.extra_minutes, 0));
  end if;
  if v.shuffle_questions then
    select array_agg(id order by random()) into v_order from public.exam_items where exam_version_id = v.id;
  else
    select array_agg(id order by position) into v_order from public.exam_items where exam_version_id = v.id;
  end if;
  for it in select ei.id, qv.options from public.exam_items ei join public.question_versions qv on qv.id = ei.question_version_id
             where ei.exam_version_id = v.id and jsonb_array_length(qv.options) > 0 loop
    v_opts := v_opts || jsonb_build_object(it.id::text, (
      select jsonb_agg(o ->> 'id' order by case when v.shuffle_options then random() else ord end)
        from jsonb_array_elements(it.options) with ordinality as t(o, ord)));
  end loop;
  insert into public.attempts (assignment_id, user_id, exam_version_id, attempt_no, deadline_at, item_order, option_orders, max_points)
  values (a.id, v_uid, v.id, v_no, v_deadline, v_order, v_opts,
          (select sum(coalesce(ei.points, qv.points)) from public.exam_items ei join public.question_versions qv on qv.id = ei.question_version_id where ei.exam_version_id = v.id))
  returning id into v_id;
  perform public.log_event('attempt_started', 'attempts', v_id::text, jsonb_build_object('assignment', a.id, 'attempt_no', v_no));
  return v_id;
end $$;

-- Exam content for an in-progress attempt: stems, options (attempt order),
-- media references, saved responses. Never keys or explanations.
create or replace function public.get_attempt(p_attempt uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a public.attempts; v public.exam_versions; items jsonb; resp jsonb;
begin
  select * into a from public.attempts where id = p_attempt;
  if not found or a.user_id <> auth.uid() then raise exception 'Attempt not found' using errcode = '42501'; end if;
  if a.status = 'in_progress' and a.deadline_at is not null and now() > a.deadline_at + interval '60 seconds' then
    perform public._finalize(a.id, 'time_expired');
    select * into a from public.attempts where id = p_attempt;
  end if;
  select * into v from public.exam_versions where id = a.exam_version_id;
  if a.status <> 'in_progress' then
    return jsonb_build_object('id', a.id, 'status', a.status, 'title', v.title, 'submitted_at', a.submitted_at, 'submit_reason', a.submit_reason);
  end if;
  select jsonb_agg(jsonb_build_object(
           'item_id', ei.id, 'number', o.n, 'section', ei.section, 'type', qv.type, 'stem', qv.stem,
           'points', coalesce(ei.points, qv.points),
           'options', coalesce((select jsonb_agg(opt order by array_position(
                                     array(select jsonb_array_elements_text(a.option_orders -> ei.id::text)), opt ->> 'id'))
                                from jsonb_array_elements(qv.options) opt), '[]'),
           'media', coalesce((select jsonb_agg(jsonb_build_object(
                                 'path', mv.storage_path, 'kind', ma.kind, 'mime', mv.mime_type, 'width', mv.width,
                                 'height', mv.height, 'duration', mv.duration_seconds, 'frame_rate', mv.frame_rate,
                                 'caption', qvm.caption) order by qvm.position)
                               from public.question_version_media qvm
                               join public.media_versions mv on mv.id = qvm.media_version_id
                               join public.media_assets ma on ma.id = mv.asset_id
                              where qvm.question_version_id = qv.id), '[]'))
         order by o.n)
    into items
    from unnest(a.item_order) with ordinality as o(item_id, n)
    join public.exam_items ei on ei.id = o.item_id
    join public.question_versions qv on qv.id = ei.question_version_id;
  select coalesce(jsonb_agg(jsonb_build_object('item_id', exam_item_id, 'response', response, 'flagged', flagged, 'seq', client_seq)), '[]')
    into resp from public.responses where attempt_id = a.id;
  return jsonb_build_object(
    'id', a.id, 'status', a.status, 'title', v.title, 'instructions', v.instructions, 'attempt_no', a.attempt_no,
    'started_at', a.started_at, 'deadline_at', a.deadline_at, 'server_now', now(),
    'items', coalesce(items, '[]'), 'responses', resp);
end $$;

-- Autosave. p_items = [{ item_id, response, flagged, seq }]. A save only
-- overwrites a stored answer when its seq is higher, so retries and
-- out-of-order network deliveries can never roll an answer back.
create or replace function public.save_responses(p_attempt uuid, p_items jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  a public.attempts; e jsonb; v_item uuid; v_type public.question_type; v_opts jsonb; v_resp jsonb; n int := 0;
begin
  select * into a from public.attempts where id = p_attempt for update;
  if not found or a.user_id <> auth.uid() then raise exception 'Attempt not found' using errcode = '42501'; end if;
  if a.status <> 'in_progress' then
    return jsonb_build_object('status', a.status, 'saved', 0, 'server_now', now());
  end if;
  if a.deadline_at is not null and now() > a.deadline_at + interval '60 seconds' then
    perform public._finalize(a.id, 'time_expired');
    return jsonb_build_object('status', 'submitted', 'saved', 0, 'server_now', now(), 'reason', 'time_expired');
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) > 500 then
    raise exception 'Invalid payload' using errcode = '22023';
  end if;
  for e in select * from jsonb_array_elements(p_items) loop
    v_item := (e ->> 'item_id')::uuid;
    if not (v_item = any (a.item_order)) then raise exception 'Item does not belong to this attempt' using errcode = '22023'; end if;
    select qv.type, qv.options into v_type, v_opts from public.exam_items ei
      join public.question_versions qv on qv.id = ei.question_version_id where ei.id = v_item;
    v_resp := e -> 'response';
    if v_resp = 'null'::jsonb then v_resp := null; end if;
    -- shape validation
    if v_resp is not null then
      if v_type in ('single', 'multiple') then
        if jsonb_typeof(v_resp -> 'selected') <> 'array'
           or exists (select 1 from jsonb_array_elements_text(v_resp -> 'selected') s
                       where not exists (select 1 from jsonb_array_elements(v_opts) o where o ->> 'id' = s))
           or (v_type = 'single' and jsonb_array_length(v_resp -> 'selected') > 1) then
          raise exception 'Invalid answer for item %', v_item using errcode = '22023';
        end if;
        v_resp := jsonb_build_object('selected', v_resp -> 'selected');
      elsif v_type = 'short_answer' then
        if jsonb_typeof(v_resp -> 'text') <> 'string' or length(v_resp ->> 'text') > 10000 then
          raise exception 'Invalid answer for item %', v_item using errcode = '22023';
        end if;
        v_resp := jsonb_build_object('text', v_resp -> 'text');
      elsif v_type = 'hotspot' then
        if jsonb_typeof(v_resp -> 'point') <> 'object' then
          raise exception 'Invalid answer for item %', v_item using errcode = '22023';
        end if;
        v_resp := jsonb_build_object('point', jsonb_build_object('media', coalesce((v_resp -> 'point' ->> 'media')::int, 0),
                  'x', least(1, greatest(0, (v_resp -> 'point' ->> 'x')::numeric)),
                  'y', least(1, greatest(0, (v_resp -> 'point' ->> 'y')::numeric))));
      end if;
    end if;
    insert into public.responses (attempt_id, exam_item_id, response, flagged, client_seq, saved_at)
    values (a.id, v_item, v_resp, coalesce((e ->> 'flagged')::boolean, false), coalesce((e ->> 'seq')::bigint, 0), now())
    on conflict (attempt_id, exam_item_id) do update
      set response = excluded.response, flagged = excluded.flagged, client_seq = excluded.client_seq, saved_at = now()
      where public.responses.client_seq < excluded.client_seq;
    n := n + 1;
  end loop;
  update public.attempts set last_saved_at = now() where id = a.id;
  return jsonb_build_object('status', 'in_progress', 'saved', n, 'server_now', now(), 'deadline_at', a.deadline_at);
end $$;

create or replace function public.submit_attempt(p_attempt uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a public.attempts;
begin
  select * into a from public.attempts where id = p_attempt;
  if not found or a.user_id <> auth.uid() then raise exception 'Attempt not found' using errcode = '42501'; end if;
  if a.status = 'in_progress' then
    perform public._finalize(a.id, case when a.deadline_at is not null and now() > a.deadline_at then 'time_expired' else 'learner' end);
  end if;
  return public.get_my_result(a.id);
end $$;

-- Per-domain / per-objective breakdown of a submitted attempt (server data only).
create or replace function public.attempt_breakdown(p_attempt uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  with x as (
    select qv.domain_key, qv.objective_codes, coalesce(ei.points, qv.points) as possible, r.points_awarded as earned, ev.exam_id
      from public.responses r
      join public.exam_items ei on ei.id = r.exam_item_id
      join public.question_versions qv on qv.id = ei.question_version_id
      join public.exam_versions ev on ev.id = ei.exam_version_id
     where r.attempt_id = p_attempt
  ), course as (
    select e.course_id from public.attempts a join public.exam_versions ev on ev.id = a.exam_version_id
      join public.exams e on e.id = ev.exam_id where a.id = p_attempt
  )
  select jsonb_build_object(
    'domains', coalesce((
      select jsonb_agg(jsonb_build_object('key', d.key, 'label', d.label, 'n_items', d.n, 'earned', d.earned,
                                          'possible', d.possible, 'pending', d.pending,
                                          'pct', case when d.possible > 0 and d.pending = 0 then round(100 * d.earned / d.possible, 1) end)
             order by d.sort, d.label)
        from (select coalesce(x.domain_key, 'unassigned') as key,
                     coalesce(dm.label, case when x.domain_key is null then 'Unassigned' else x.domain_key end) as label,
                     coalesce(min(dm.sort), 999) as sort, count(*) as n, coalesce(sum(x.earned), 0) as earned,
                     sum(x.possible) as possible, count(*) filter (where x.earned is null) as pending
                from x left join public.domains dm on dm.key = x.domain_key and dm.course_id = (select course_id from course)
               group by 1, 2) d), '[]'),
    'objectives', coalesce((
      select jsonb_agg(jsonb_build_object('code', o.code, 'title', o.title, 'n_items', o.n, 'earned', o.earned, 'possible', o.possible,
                                          'pct', case when o.possible > 0 and o.pending = 0 then round(100 * o.earned / o.possible, 1) end)
             order by o.code)
        from (select c as code, lo.title, count(*) as n, coalesce(sum(x.earned), 0) as earned, sum(x.possible) as possible,
                     count(*) filter (where x.earned is null) as pending
                from x cross join lateral unnest(x.objective_codes) c
                left join public.learning_objectives lo on lo.code = c and lo.course_id = (select course_id from course)
               group by c, lo.title) o), '[]'))
$$;
revoke execute on function public.attempt_breakdown(uuid) from public, anon, authenticated;

-- What a learner may see about their own submitted attempt, according to the
-- exam's feedback policy and whether faculty have released results.
create or replace function public.get_my_result(p_attempt uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a public.attempts; v public.exam_versions; out jsonb; bd jsonb;
begin
  select * into a from public.attempts where id = p_attempt;
  if not found or a.user_id <> auth.uid() then raise exception 'Attempt not found' using errcode = '42501'; end if;
  select * into v from public.exam_versions where id = a.exam_version_id;
  out := jsonb_build_object('id', a.id, 'title', v.title, 'status', a.status, 'attempt_no', a.attempt_no,
                            'submitted_at', a.submitted_at, 'submit_reason', a.submit_reason,
                            'released', a.released_at is not null, 'feedback_policy', v.feedback_policy);
  if a.status <> 'submitted' or a.released_at is null or v.feedback_policy = 'none' then
    return out;
  end if;
  out := out || jsonb_build_object('score_points', a.score_points, 'max_points', a.max_points, 'score_pct', a.score_pct,
                                   'passed', a.passed, 'pass_threshold_pct', v.pass_threshold_pct);
  if v.feedback_policy in ('score_domains', 'full_review') then
    bd := public.attempt_breakdown(a.id);
    out := out || jsonb_build_object('domains', bd -> 'domains', 'objectives', bd -> 'objectives');
  end if;
  if v.feedback_policy = 'full_review' then
    out := out || jsonb_build_object('items', (
      select jsonb_agg(jsonb_build_object(
               'number', o.n, 'type', qv.type, 'stem', qv.stem, 'options', qv.options, 'explanation', qv.explanation,
               'key', qk.key, 'response', r.response, 'is_correct', r.is_correct, 'points_awarded', r.points_awarded,
               'points', coalesce(ei.points, qv.points), 'grader_comment', r.grader_comment,
               'media', coalesce((select jsonb_agg(jsonb_build_object('path', mv.storage_path, 'kind', ma.kind, 'mime', mv.mime_type,
                                      'width', mv.width, 'height', mv.height, 'caption', qvm.caption) order by qvm.position)
                                    from public.question_version_media qvm
                                    join public.media_versions mv on mv.id = qvm.media_version_id
                                    join public.media_assets ma on ma.id = mv.asset_id
                                   where qvm.question_version_id = qv.id), '[]'))
             order by o.n)
        from unnest(a.item_order) with ordinality as o(item_id, n)
        join public.exam_items ei on ei.id = o.item_id
        join public.question_versions qv on qv.id = ei.question_version_id
        left join public.question_keys qk on qk.question_version_id = qv.id
        left join public.responses r on r.attempt_id = a.id and r.exam_item_id = ei.id));
  end if;
  return out;
end $$;

-- ---------------------------------------------------------------------------
-- Faculty API
-- ---------------------------------------------------------------------------
create or replace function public._require_view_attempt(p_attempt uuid)
returns public.attempts language plpgsql stable security definer set search_path = public as $$
declare a public.attempts;
begin
  select * into a from public.attempts where id = p_attempt;
  if not found or not public.is_staff() or not public.can_view_learner(a.user_id) then
    raise exception 'Attempt not found' using errcode = '42501';
  end if;
  return a;
end $$;
revoke execute on function public._require_view_attempt(uuid) from public, anon, authenticated;

create or replace function public.staff_attempt_detail(p_attempt uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a public.attempts; v public.exam_versions; p public.profiles;
begin
  a := public._require_view_attempt(p_attempt);
  select * into v from public.exam_versions where id = a.exam_version_id;
  select * into p from public.profiles where id = a.user_id;
  return jsonb_build_object(
    'attempt', to_jsonb(a) - 'option_orders',
    'learner', jsonb_build_object('id', p.id, 'full_name', p.full_name, 'email', p.email, 'training_level', p.training_level),
    'exam', jsonb_build_object('id', v.exam_id, 'version_id', v.id, 'title', v.title, 'version', v.version,
                               'pass_threshold_pct', v.pass_threshold_pct, 'feedback_policy', v.feedback_policy, 'release_mode', v.release_mode),
    'breakdown', public.attempt_breakdown(a.id),
    'items', (
      select jsonb_agg(jsonb_build_object(
               'item_id', ei.id, 'number', o.n, 'position', ei.position + 1, 'type', qv.type, 'stem', qv.stem, 'options', qv.options,
               'key', qk.key, 'explanation', qv.explanation, 'domain_key', qv.domain_key, 'objective_codes', qv.objective_codes,
               'points', coalesce(ei.points, qv.points), 'response', r.response, 'flagged', r.flagged,
               'is_correct', r.is_correct, 'points_awarded', r.points_awarded, 'grader_comment', r.grader_comment,
               'graded_by', r.graded_by, 'saved_at', r.saved_at)
             order by o.n)
        from unnest(a.item_order) with ordinality as o(item_id, n)
        join public.exam_items ei on ei.id = o.item_id
        join public.question_versions qv on qv.id = ei.question_version_id
        left join public.question_keys qk on qk.question_version_id = qv.id
        left join public.responses r on r.attempt_id = a.id and r.exam_item_id = ei.id));
end $$;

create or replace function public.grade_response(p_attempt uuid, p_item uuid, p_points numeric, p_comment text default '')
returns jsonb language plpgsql security definer set search_path = public as $$
declare a public.attempts; v_max numeric; v_type public.question_type;
begin
  a := public._require_view_attempt(p_attempt);
  if a.status <> 'submitted' then raise exception 'Only submitted attempts can be graded' using errcode = '42501'; end if;
  select coalesce(ei.points, qv.points), qv.type into v_max, v_type
    from public.exam_items ei join public.question_versions qv on qv.id = ei.question_version_id
   where ei.id = p_item and ei.exam_version_id = a.exam_version_id;
  if v_max is null then raise exception 'Item not in this attempt' using errcode = '22023'; end if;
  if p_points is null or p_points < 0 or p_points > v_max then
    raise exception 'Points must be between 0 and %', v_max using errcode = '22023';
  end if;
  update public.responses
     set points_awarded = p_points, is_correct = (p_points = v_max), graded_by = auth.uid(), graded_at = now(),
         grader_comment = coalesce(p_comment, '')
   where attempt_id = a.id and exam_item_id = p_item;
  perform public._recompute_attempt(a.id);
  perform public.log_event('response_graded', 'attempts', a.id::text,
          jsonb_build_object('item', p_item, 'points', p_points, 'type', v_type));
  return public.staff_attempt_detail(a.id);
end $$;

create or replace function public.release_results(p_attempts uuid[])
returns int language plpgsql security definer set search_path = public as $$
declare x uuid; a public.attempts; n int := 0;
begin
  foreach x in array p_attempts loop
    a := public._require_view_attempt(x);
    if a.status = 'submitted' and a.grading_status = 'complete' and a.released_at is null then
      update public.attempts set released_at = now(), released_by = auth.uid() where id = a.id;
      perform public.log_event('results_released', 'attempts', a.id::text, '{}');
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

create or replace function public.staff_close_attempt(p_attempt uuid)
returns void language plpgsql security definer set search_path = public as $$
declare a public.attempts;
begin
  a := public._require_view_attempt(p_attempt);
  if a.status = 'in_progress' then perform public._finalize(a.id, 'faculty'); end if;
end $$;

-- Exam-level report: learner results, domain summary, item analysis.
create or replace function public.exam_report(p_exam_version uuid, p_cohort uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v public.exam_versions; learners jsonb; items jsonb; stats jsonb; domains jsonb;
begin
  perform public.require_staff();
  select * into v from public.exam_versions where id = p_exam_version;
  if not found then raise exception 'Exam version not found' using errcode = 'P0002'; end if;
  perform public._finalize_overdue(null, v.id);

  create temporary table if not exists _rep_learners (user_id uuid primary key) on commit drop;
  truncate _rep_learners;
  insert into _rep_learners
  select distinct u from (
    select a.user_id as u from public.assignments a where a.exam_version_id = v.id and a.user_id is not null and a.archived_at is null
    union
    select m.user_id from public.assignments a join public.cohort_members m on m.cohort_id = a.cohort_id and m.member_role = 'learner'
     where a.exam_version_id = v.id and a.archived_at is null
    union
    select at.user_id from public.attempts at where at.exam_version_id = v.id
  ) s
  where public.can_view_learner(u)
    and (p_cohort is null or exists (select 1 from public.cohort_members cm where cm.cohort_id = p_cohort and cm.user_id = u));

  create temporary table if not exists _rep_latest (attempt_id uuid primary key, user_id uuid, total numeric) on commit drop;
  truncate _rep_latest;
  insert into _rep_latest
  select distinct on (at.user_id) at.id, at.user_id, at.score_pct
    from public.attempts at join _rep_learners l on l.user_id = at.user_id
   where at.exam_version_id = v.id and at.status = 'submitted'
   order by at.user_id, at.attempt_no desc;

  select coalesce(jsonb_agg(jsonb_build_object(
           'user_id', p.id, 'full_name', p.full_name, 'email', p.email, 'training_level', p.training_level,
           'attempts', (select coalesce(jsonb_agg(jsonb_build_object(
                          'id', at.id, 'attempt_no', at.attempt_no, 'status', at.status, 'started_at', at.started_at,
                          'submitted_at', at.submitted_at, 'submit_reason', at.submit_reason, 'score_pct', at.score_pct,
                          'score_points', at.score_points, 'max_points', at.max_points, 'passed', at.passed,
                          'grading_status', at.grading_status, 'released', at.released_at is not null) order by at.attempt_no), '[]')
                          from public.attempts at where at.user_id = p.id and at.exam_version_id = v.id),
           'domains', (select public.attempt_breakdown(lt.attempt_id) -> 'domains' from _rep_latest lt where lt.user_id = p.id))
         order by p.full_name), '[]')
    into learners
    from _rep_learners l join public.profiles p on p.id = l.user_id;

  select jsonb_build_object(
           'n_learners', (select count(*) from _rep_learners),
           'n_completed', count(*),
           'n_scored', count(total),
           'mean', round(avg(total), 1),
           'median', round((percentile_cont(0.5) within group (order by total))::numeric, 1),
           'sd', round(stddev_samp(total), 1),
           'min', min(total), 'max', max(total),
           'n_passed', count(*) filter (where (select passed from public.attempts where id = attempt_id)),
           'pass_threshold_pct', v.pass_threshold_pct)
    into stats from _rep_latest;

  -- item analysis on each learner's latest submitted attempt.
  -- discrimination = corrected item–rest correlation (point-biserial for 0/1
  -- items), reported only when at least 5 scored responses exist.
  select coalesce(jsonb_agg(row_to_json(q)::jsonb order by q.position), '[]') into items
    from (
      select ei.id as item_id, ei.position + 1 as position, ei.section, qv.type, left(qv.stem, 160) as stem, qv.domain_key,
             qv.question_id, qv.version as question_version,
             count(b.pa) as n,
             round(100 * avg(b.pa / nullif(b.pts, 0)), 1) as pct_correct,
             case when count(b.pa) >= 5 then round(corr((b.pa / nullif(b.pts, 0))::float8, (b.sp - b.pa)::float8)::numeric, 2) end as discrimination,
             (select jsonb_object_agg(s, c) from (
                 select s, count(*) c from public.responses r2 join _rep_latest l2 on l2.attempt_id = r2.attempt_id
                   cross join lateral jsonb_array_elements_text(coalesce(r2.response -> 'selected', '[]')) s
                  where r2.exam_item_id = ei.id group by s) z) as option_counts,
             qk.key -> 'correct' as correct
        from public.exam_items ei
        join public.question_versions qv on qv.id = ei.question_version_id
        left join public.question_keys qk on qk.question_version_id = qv.id
        left join (
          select r.exam_item_id, r.points_awarded as pa, coalesce(ei2.points, qv2.points) as pts, at.score_points as sp
            from _rep_latest lt
            join public.attempts at on at.id = lt.attempt_id
            join public.responses r on r.attempt_id = lt.attempt_id
            join public.exam_items ei2 on ei2.id = r.exam_item_id
            join public.question_versions qv2 on qv2.id = ei2.question_version_id
        ) b on b.exam_item_id = ei.id
       where ei.exam_version_id = v.id
       group by ei.id, ei.position, ei.section, qv.type, qv.stem, qv.domain_key, qv.question_id, qv.version, qk.key
    ) q;

  select coalesce(jsonb_agg(jsonb_build_object('key', d.key, 'label', d.label, 'mean_pct', d.mean_pct, 'n', d.n) order by d.sort), '[]')
    into domains
    from (
      select coalesce(qv.domain_key, 'unassigned') as key, coalesce(min(dm.label), coalesce(qv.domain_key, 'Unassigned')) as label,
             coalesce(min(dm.sort), 999) as sort, count(distinct lt.user_id) as n,
             round(100 * sum(r.points_awarded) / nullif(sum(coalesce(ei.points, qv.points)) filter (where r.points_awarded is not null), 0), 1) as mean_pct
        from _rep_latest lt
        join public.responses r on r.attempt_id = lt.attempt_id
        join public.exam_items ei on ei.id = r.exam_item_id
        join public.question_versions qv on qv.id = ei.question_version_id
        join public.exams e on e.id = v.exam_id
        left join public.domains dm on dm.key = qv.domain_key and dm.course_id = e.course_id
       group by coalesce(qv.domain_key, 'unassigned'), qv.domain_key
    ) d;

  return jsonb_build_object('exam', jsonb_build_object('id', v.exam_id, 'version_id', v.id, 'title', v.title, 'version', v.version,
                                                       'status', v.status, 'pass_threshold_pct', v.pass_threshold_pct),
                            'stats', stats, 'learners', learners, 'items', items, 'domains', domains);
end $$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.assignments    enable row level security;
alter table public.accommodations enable row level security;
alter table public.attempts       enable row level security;
alter table public.responses      enable row level security;

create policy assignments_read on public.assignments for select to authenticated using (public.is_staff());
create policy assignments_write on public.assignments for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy accommodations_read on public.accommodations for select to authenticated
  using (public.is_staff() and public.can_view_learner(user_id));
create policy accommodations_write on public.accommodations for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy attempts_staff_read on public.attempts for select to authenticated
  using (public.is_staff() and public.can_view_learner(user_id));
create policy responses_staff_read on public.responses for select to authenticated
  using (public.is_staff() and exists (select 1 from public.attempts a where a.id = attempt_id and public.can_view_learner(a.user_id)));
-- no insert/update/delete policies on attempts/responses: writes only via functions
revoke insert, update, delete, truncate on public.attempts, public.responses from authenticated;

revoke all on all tables in schema public from anon;

-- ===================== 20261020000400_assessment.sql =====================
-- =============================================================================
-- POCUS Exam Platform — 04 assessment: faculty notes, end-of-block evaluation
-- workspace, learner report.
--
-- Principle: the system summarises verified exam data and faculty-entered
-- observations only. It never generates clinical, procedural, scanning-skill
-- or professionalism judgements. Every evaluation is a draft until a faculty
-- member explicitly approves it.
-- =============================================================================

create table public.faculty_notes (
  id         uuid primary key default gen_random_uuid(),
  course_id  uuid not null references public.courses (id) on delete cascade,
  learner_id uuid not null references public.profiles (id) on delete cascade,
  author_id  uuid references public.profiles (id) on delete set null default auth.uid(),
  body       text not null check (length(body) between 1 and 10000),
  created_at timestamptz not null default now()
);
create index on public.faculty_notes (learner_id);

create table public.evaluations (
  id                    uuid primary key default gen_random_uuid(),
  course_id             uuid not null references public.courses (id) on delete restrict,
  learner_id            uuid not null references public.profiles (id) on delete restrict,
  cohort_id             uuid references public.cohorts (id) on delete set null,
  evaluator_id          uuid references public.profiles (id) on delete set null default auth.uid(),
  rotation_start        date,
  rotation_end          date,
  attempt_id            uuid references public.attempts (id) on delete set null,
  exam_snapshot         jsonb not null default '{}',   -- verified data captured when the draft was generated
  strengths             text not null default '',      -- faculty-entered
  areas_for_improvement text not null default '',      -- faculty-entered
  observations          text not null default '',      -- faculty-entered (clinical/scanning observations belong here, typed by faculty)
  summary               text not null default '',      -- editable draft text
  status                text not null default 'draft' check (status in ('draft', 'approved')),
  approved_by           uuid references public.profiles (id) on delete set null,
  approved_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index on public.evaluations (learner_id);

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
    new.approved_by := auth.uid(); new.approved_at := now();
    perform public.log_event('evaluation_approved', 'evaluations', new.id::text,
      jsonb_build_object('learner', new.learner_id, 'summary_sha', encode(extensions.digest(new.summary, 'sha256'), 'hex')));
  end if;
  return new;
end $$;
create trigger evaluations_guard before insert or update on public.evaluations for each row execute function public.guard_evaluation();
create trigger evaluations_no_delete before delete on public.evaluations for each row
  when (old.status = 'approved') execute function public.guard_attempt_delete();

alter table public.faculty_notes enable row level security;
alter table public.evaluations   enable row level security;

create policy notes_read on public.faculty_notes for select to authenticated
  using (public.is_staff() and public.can_view_learner(learner_id));
create policy notes_insert on public.faculty_notes for insert to authenticated
  with check (public.is_staff() and public.can_view_learner(learner_id) and author_id = auth.uid());
create policy notes_delete on public.faculty_notes for delete to authenticated
  using (author_id = auth.uid() or public.is_admin());

create policy evals_read on public.evaluations for select to authenticated
  using (public.is_staff() and public.can_view_learner(learner_id));
create policy evals_insert on public.evaluations for insert to authenticated
  with check (public.is_staff() and public.can_view_learner(learner_id));
create policy evals_update on public.evaluations for update to authenticated
  using (public.is_staff() and public.can_view_learner(learner_id))
  with check (public.is_staff() and public.can_view_learner(learner_id));
create policy evals_delete on public.evaluations for delete to authenticated
  using (public.is_staff() and public.can_view_learner(learner_id) and status = 'draft');

-- Learner report used by the faculty dashboard and the evaluation workspace.
create or replace function public.learner_report(p_learner uuid, p_course uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare p public.profiles;
begin
  if not public.is_staff() or not public.can_view_learner(p_learner) then
    raise exception 'Learner not found' using errcode = '42501';
  end if;
  perform public._finalize_overdue(p_learner, null);
  select * into p from public.profiles where id = p_learner;
  return jsonb_build_object(
    'learner', jsonb_build_object('id', p.id, 'full_name', p.full_name, 'email', p.email,
                                  'training_level', p.training_level, 'program', p.program),
    'cohorts', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'academic_year', c.academic_year,
                                     'block_label', c.block_label, 'start_date', c.start_date, 'end_date', c.end_date) order by c.start_date desc nulls last)
                         from public.cohort_members m join public.cohorts c on c.id = m.cohort_id
                        where m.user_id = p.id and c.course_id = p_course), '[]'),
    'attempts', coalesce((select jsonb_agg(jsonb_build_object(
                            'id', a.id, 'exam_title', ev.title, 'exam_id', ev.exam_id, 'exam_version_id', ev.id, 'version', ev.version,
                            'attempt_no', a.attempt_no, 'status', a.status, 'started_at', a.started_at, 'submitted_at', a.submitted_at,
                            'submit_reason', a.submit_reason, 'score_points', a.score_points, 'max_points', a.max_points,
                            'score_pct', a.score_pct, 'passed', a.passed, 'pass_threshold_pct', ev.pass_threshold_pct,
                            'grading_status', a.grading_status, 'released', a.released_at is not null,
                            'breakdown', case when a.status = 'submitted' then public.attempt_breakdown(a.id) end)
                          order by a.started_at desc)
                          from public.attempts a join public.exam_versions ev on ev.id = a.exam_version_id
                          join public.exams e on e.id = ev.exam_id
                         where a.user_id = p.id and e.course_id = p_course), '[]'),
    'notes', coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'body', n.body, 'created_at', n.created_at,
                                  'author', (select full_name from public.profiles where id = n.author_id)) order by n.created_at desc)
                       from public.faculty_notes n where n.learner_id = p.id and n.course_id = p_course), '[]'),
    'curriculum', jsonb_build_object(
        'required', (select count(*) from public.curriculum_items where course_id = p_course and required),
        'required_completed', (select count(*) from public.curriculum_items ci join public.curriculum_progress cp on cp.item_id = ci.id
                                where ci.course_id = p_course and ci.required and cp.user_id = p.id),
        'completed', (select count(*) from public.curriculum_items ci join public.curriculum_progress cp on cp.item_id = ci.id
                       where ci.course_id = p_course and cp.user_id = p.id)));
end $$;

-- Learner-facing curriculum view (own progress only).
create or replace function public.my_curriculum(p_course_slug text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c public.courses;
begin
  if not public.is_member() then raise exception 'Not signed in' using errcode = '42501'; end if;
  select * into c from public.courses where slug = p_course_slug;
  if not found then raise exception 'Course not found' using errcode = 'P0002'; end if;
  return jsonb_build_object(
    'course', to_jsonb(c),
    'objectives', coalesce((select jsonb_agg(to_jsonb(o) order by o.sort, o.code) from public.learning_objectives o where o.course_id = c.id), '[]'),
    'domains', coalesce((select jsonb_agg(to_jsonb(d) order by d.sort) from public.domains d where d.course_id = c.id), '[]'),
    'items', coalesce((select jsonb_agg(to_jsonb(ci) || jsonb_build_object('completed_at', cp.completed_at) order by ci.sort, ci.title)
                         from public.curriculum_items ci
                         left join public.curriculum_progress cp on cp.item_id = ci.id and cp.user_id = auth.uid()
                        where ci.course_id = c.id), '[]'));
end $$;

revoke all on all tables in schema public from anon;

-- ===================== 20261020000500_storage_and_grants.sql =====================
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

-- ===================== 20261020000600_pocus_course.sql =====================
-- =============================================================================
-- POCUS Exam Platform — 06 POCUS rotation course scaffold.
--
-- Domains and curriculum links are structural. The learning objectives below
-- are a DRAFT scaffold so that question tagging and domain reporting work out
-- of the box; replace them with the program's approved objectives (Admin →
-- Curriculum) before relying on objective-level reporting.
-- =============================================================================

insert into public.courses (slug, title, description) values
  ('pocus', 'POCUS Rotation', 'Perioperative point-of-care ultrasound subspecialty rotation for anesthesiology residents.')
on conflict (slug) do nothing;

with c as (select id from public.courses where slug = 'pocus')
insert into public.domains (course_id, key, label, sort)
select c.id, d.key, d.label, d.sort from c, (values
  ('cardiac',   'Cardiac / echocardiography', 10),
  ('lung',      'Lung and pleural ultrasound', 20),
  ('gastric',   'Gastric ultrasound', 30),
  ('vascular',  'Vascular ultrasound and access', 40),
  ('diaphragm', 'Diaphragm ultrasound', 50),
  ('airway',    'Airway ultrasound', 60),
  ('ocular',    'Ocular / optic nerve sheath', 70),
  ('fundamentals', 'Physics, knobology and image optimisation', 5),
  ('other',     'Other POCUS applications', 90)
) as d(key, label, sort)
on conflict (course_id, key) do nothing;

with c as (select id from public.courses where slug = 'pocus')
insert into public.learning_objectives (course_id, domain_key, code, title, sort)
select c.id, o.domain_key, o.code, o.title, o.sort from c, (values
  ('fundamentals', 'FUND-1', '[Draft] Select transducer, preset and depth/gain settings appropriate to the clinical question', 1),
  ('fundamentals', 'FUND-2', '[Draft] Recognise common artefacts and their effect on interpretation', 2),
  ('cardiac',      'CARD-1', '[Draft] Identify standard focused cardiac views (PLAX, PSAX, A4C, subcostal, IVC)', 10),
  ('cardiac',      'CARD-2', '[Draft] Qualitatively assess LV function, RV size/function and pericardial effusion', 11),
  ('lung',         'LUNG-1', '[Draft] Recognise lung sliding, A-lines, B-lines, consolidation and pleural effusion', 20),
  ('lung',         'LUNG-2', '[Draft] Apply lung ultrasound to perioperative hypoxaemia and pneumothorax', 21),
  ('gastric',      'GAST-1', '[Draft] Perform and grade gastric antral ultrasound (Perlas grade, CSA volume)', 30),
  ('vascular',     'VASC-1', '[Draft] Distinguish arteries from veins and plan ultrasound-guided vascular access', 40),
  ('vascular',     'VASC-2', '[Draft] Screen for proximal lower-limb DVT using compression ultrasound', 41),
  ('diaphragm',    'DIAP-1', '[Draft] Measure diaphragmatic excursion and thickening fraction', 50),
  ('airway',       'AIRW-1', '[Draft] Identify the cricothyroid membrane and relevant airway anatomy', 60),
  ('ocular',       'OCUL-1', '[Draft] Measure optic nerve sheath diameter and interpret its limitations', 70)
) as o(domain_key, code, title, sort)
on conflict (course_id, code) do nothing;

with c as (select id from public.courses where slug = 'pocus')
insert into public.curriculum_items (course_id, section, kind, title, description, url, required, sort, objective_codes)
select c.id, i.section, i.kind, i.title, i.description, i.url, i.required, i.sort, i.objectives from c, (values
  ('Teaching cases', 'case', 'Gastric Ultrasound & the Patient on a GLP-1 Receptor Agonist', 'Two-part simulated case with answer key.', '/cases/glp1-gastric', true, 10, array['GAST-1']),
  ('Teaching cases', 'case', 'Diaphragm POCUS & First Rib Resection', 'Phrenic nerve injury, excursion and thickening fraction.', '/cases/diaphragm-first-rib', true, 20, array['DIAP-1']),
  ('Teaching cases', 'case', 'Optic Nerve Sheath Diameter & PDPH', 'ONSD technique and interpretation.', '/cases/onsd-pdph', true, 30, array['OCUL-1']),
  ('Teaching cases', 'case', 'Systematic Peripheral Vascular Access', 'Difficult-access patient; vessel selection and technique.', '/cases/vascular-access', true, 40, array['VASC-1']),
  ('Interactive tools', 'tool', 'Interactive 3D Heart & Live Echo', 'Explore standard TTE windows on a 3D heart.', '/Echocardiography_3D_Sono.html', false, 50, array['CARD-1']),
  ('Interactive tools', 'tool', '3D Arm & Live Ultrasound', 'Upper-limb vascular anatomy with live ultrasound.', '/VascularAccess_3D_Sono.html', false, 60, array['VASC-1']),
  ('Interactive tools', 'tool', 'EchoSimulator', 'Parametric pathology echo loops across standard views.', '/echo-simulator/', false, 70, array['CARD-2'])
) as i(section, kind, title, description, url, required, sort, objectives)
where not exists (select 1 from public.curriculum_items ci where ci.course_id = c.id and ci.url = i.url);

-- ===================== first administrator =====================
-- Change the email if you want to sign in with your institutional address instead.
insert into public.invitations (email, full_name, role)
values ('rlessard@toh.ca', 'Raphael Lessard', 'admin')
on conflict (email) do update set role = 'admin', revoked_at = null;
