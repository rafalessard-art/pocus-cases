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
