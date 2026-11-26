-- =============================================================================
-- POCUS Portal — demonstration access, owner MFA gate, related hardening.
--
-- Reviewer (demonstration-code) access, enforced in the database:
--   * A reviewer identity is created only by the `demo-redeem` Edge Function,
--     after it validates the shared code (service role; see
--     supabase/functions/demo-redeem). Every redemption gets its own identity.
--   * my_role() returns 'reviewer' only while that identity's grant is active,
--     unexpired, and issued under the current, unrevoked, unexpired code — and
--     only where this database's deployment_settings enable demo access.
--     Otherwise the identity has no role and therefore no access.
--   * Reviewers are NOT members: is_member() now covers learners, faculty and
--     admins only, so every existing read and write path refuses reviewers.
--     Reviewer read views are granted explicitly, one by one, in later
--     migrations; there are no reviewer writes yet.
--   * Nothing a client sends (metadata, claims, arguments) can create, extend
--     or reactivate a grant. Rotation revokes the code and its grants at once.
--   * Fail-closed: with no deployment_settings row, demo access is off. A
--     production database can never enable it (check constraint).
--
-- Owner MFA (staged): when deployment_settings.admin_mfa_required is true,
-- an admin session below aal2 has no role at all, so every admin privilege
-- (policies, privileged functions, storage) needs MFA, not just admin pages.
-- It is off by default and can only be switched on from an aal2 session.
-- Demonstration-access management always requires aal2.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- Deployment settings (one row; absent row = most restrictive defaults)
-- ---------------------------------------------------------------------------
create table public.deployment_settings (
  id                  boolean primary key default true check (id),
  environment         text not null check (environment in ('development', 'review', 'production')),
  demo_access_enabled boolean not null default false,
  admin_mfa_required  boolean not null default false,
  updated_at          timestamptz not null default now(),
  constraint demo_access_never_in_production check (not (environment = 'production' and demo_access_enabled))
);
comment on table public.deployment_settings is
  'One row. environment and demo_access_enabled are set only by the database owner (SQL), never through the API. Missing row = demo access off, admin MFA not required.';
alter table public.deployment_settings enable row level security;
create policy deployment_settings_read on public.deployment_settings for select to authenticated using (true);
revoke all on public.deployment_settings from anon, authenticated;
grant select on public.deployment_settings to authenticated;

create or replace function public._demo_access_enabled()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select s.demo_access_enabled and s.environment <> 'production' from public.deployment_settings s), false)
$$;

create or replace function public._admin_mfa_required()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select s.admin_mfa_required from public.deployment_settings s), false)
$$;

-- Authenticator assurance level of the current session ('aal1' when absent).
create or replace function public.current_aal()
returns text language sql stable set search_path = public as $$
  select coalesce(nullif(auth.jwt() ->> 'aal', ''), 'aal1')
$$;

-- ---------------------------------------------------------------------------
-- Demonstration codes, grants, redemption attempts
-- ---------------------------------------------------------------------------
create table public.demo_codes (
  id             uuid primary key default gen_random_uuid(),
  code_hash      text not null,                 -- bcrypt; the code itself is never stored
  created_by     uuid references public.profiles (id) on delete set null,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  revoked_at     timestamptz,
  revoked_reason text,
  check (expires_at > created_at)
);
-- At most one unrevoked code at any time.
create unique index demo_codes_one_active on public.demo_codes ((true)) where revoked_at is null;

create table public.demo_grants (
  id                  uuid primary key default gen_random_uuid(),
  code_id             uuid not null references public.demo_codes (id) on delete restrict,
  email               text not null unique check (email ~ '^reviewer-[0-9a-f-]{36}@demo\.invalid$'),
  user_id             uuid unique references public.profiles (id) on delete set null,
  display_name        text not null check (char_length(display_name) between 1 and 80),  -- self-reported, unverified
  created_at          timestamptz not null default now(),
  activated_at        timestamptz,
  expires_at          timestamptz not null,
  revoked_at          timestamptz,
  revoked_reason      text,
  identity_deleted_at timestamptz                 -- set when cleanup removed the sign-in identity
);
comment on table public.demo_grants is
  'One row per redemption of a demonstration code. Kept after the identity is cleaned up (access history). display_name is self-reported.';
create index demo_grants_code on public.demo_grants (code_id);

create table public.demo_redeem_attempts (
  id           bigint generated always as identity primary key,
  ip_hash      text not null,   -- keyed hash computed by the Edge Function; never the IP itself
  succeeded    boolean not null,
  attempted_at timestamptz not null default now()
);
create index demo_redeem_attempts_ip on public.demo_redeem_attempts (ip_hash, attempted_at);
create index demo_redeem_attempts_at on public.demo_redeem_attempts (attempted_at);

alter table public.demo_codes enable row level security;
alter table public.demo_grants enable row level security;
alter table public.demo_redeem_attempts enable row level security;
revoke all on public.demo_codes, public.demo_grants, public.demo_redeem_attempts from anon, authenticated;
-- Admins may list codes (never the hash) and grants; a reviewer may read their own grant.
grant select (id, created_by, created_at, expires_at, revoked_at, revoked_reason) on public.demo_codes to authenticated;
grant select on public.demo_grants to authenticated;
create policy demo_codes_admin_read on public.demo_codes for select to authenticated using (public.is_admin());
create policy demo_grants_read on public.demo_grants for select to authenticated
  using (public.is_admin() or (user_id = auth.uid() and public.my_role() = 'reviewer'));
-- demo_redeem_attempts: no client access at all.

-- Demonstration identities and real people never mix.
alter table public.invitations add constraint invitations_reviewer_is_demo
  check ((role = 'reviewer') = (email ~ '^reviewer-[0-9a-f-]{36}@demo\.invalid$'));
alter table public.profiles add constraint profiles_reviewer_is_demo
  check ((role = 'reviewer') = (email ~ '^reviewer-[0-9a-f-]{36}@demo\.invalid$'));

-- ---------------------------------------------------------------------------
-- Role resolution
-- ---------------------------------------------------------------------------
create or replace function public._reviewer_grant_ok(p_uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public._demo_access_enabled() and exists (
    select 1
      from public.demo_grants g
      join public.demo_codes c on c.id = g.code_id
     where g.user_id = p_uid
       and g.activated_at is not null
       and g.revoked_at is null
       and g.expires_at > now()
       and c.revoked_at is null
       and c.expires_at > now())
$$;

create or replace function public.my_role()
returns public.app_role language sql stable security definer set search_path = public as $$
  select case
           when p.role = 'reviewer' then
             case when public._reviewer_grant_ok(p.id) then 'reviewer'::public.app_role end
           when p.role = 'admin' and public._admin_mfa_required() and public.current_aal() <> 'aal2' then null
           else p.role
         end
    from public.profiles p
   where p.id = auth.uid() and p.active
$$;

-- Members (learners, faculty, admins) act in the portal; reviewers only look.
create or replace function public.is_member()
returns boolean language sql stable security definer set search_path = public
as $$ select coalesce(public.my_role() in ('learner', 'faculty', 'admin'), false) $$;

create or replace function public.is_reviewer()
returns boolean language sql stable security definer set search_path = public
as $$ select coalesce(public.my_role() = 'reviewer', false) $$;

-- What the signed-in session may do, for the interface (never used for authorization).
create or replace function public.my_access()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'role', public.my_role(),
    'profile_role', (select p.role from public.profiles p where p.id = auth.uid() and p.active),
    'aal', public.current_aal(),
    'admin_mfa_required', public._admin_mfa_required(),
    'environment', (select s.environment from public.deployment_settings s),
    'demo', (select jsonb_build_object('display_name', g.display_name, 'expires_at', least(g.expires_at, c.expires_at))
               from public.demo_grants g join public.demo_codes c on c.id = g.code_id
              where g.user_id = auth.uid() and public._reviewer_grant_ok(auth.uid())))
$$;

-- ---------------------------------------------------------------------------
-- Guards for privileged demonstration-access management
-- ---------------------------------------------------------------------------
create or replace function public._require_demo_enabled()
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not public._demo_access_enabled() then
    raise exception 'Demonstration access is not enabled in this environment' using errcode = '42501';
  end if;
end $$;

create or replace function public._require_admin_aal2()
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not public.is_admin() or public.current_aal() <> 'aal2' then
    raise exception 'Administrator access with multi-factor sign-in required' using errcode = '42501';
  end if;
end $$;

-- 16 characters from a 32-symbol alphabet without 0/O/1/I (80 bits), unbiased.
create or replace function public._new_demo_code()
returns text language sql volatile security definer set search_path = public, extensions as $$
  select string_agg(substr('23456789ABCDEFGHJKLMNPQRSTUVWXYZ', (get_byte(x.b, i) % 32) + 1, 1), '' order by i)
    from (select extensions.gen_random_bytes(16) as b) x, generate_series(0, 15) i
$$;

create or replace function public._normalize_demo_code(p text)
returns text language sql immutable set search_path = public as $$
  select upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g'))
$$;

-- ---------------------------------------------------------------------------
-- Owner: rotate, revoke, review
-- ---------------------------------------------------------------------------
create or replace function public.rotate_demo_code(p_valid_days int default 30)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_old     public.demo_codes;
  v_revoked int := 0;
  v_code    text;
  v_new     public.demo_codes;
begin
  perform public._require_demo_enabled();
  perform public._require_admin_aal2();
  if p_valid_days is null or p_valid_days not between 1 and 90 then
    raise exception 'A code can be valid for 1 to 90 days' using errcode = '22023';
  end if;
  -- One transaction: retire the current code and every grant issued under it,
  -- then create the new code. Redemptions take a share lock on the code row,
  -- so none can attach to a code while it is being rotated.
  select * into v_old from public.demo_codes where revoked_at is null for update;
  if found then
    update public.demo_codes set revoked_at = now(), revoked_reason = 'rotated' where id = v_old.id;
    update public.demo_grants set revoked_at = now(), revoked_reason = 'code rotated'
     where code_id = v_old.id and revoked_at is null;
    get diagnostics v_revoked = row_count;
  end if;
  v_code := public._new_demo_code();
  insert into public.demo_codes (code_hash, created_by, expires_at)
  values (extensions.crypt(v_code, extensions.gen_salt('bf', 10)), auth.uid(), now() + make_interval(days => p_valid_days))
  returning * into v_new;
  perform public.log_event('demo_code_rotated', 'demo_codes', v_new.id::text,
    jsonb_build_object('previous_code', v_old.id, 'grants_revoked', v_revoked, 'expires_at', v_new.expires_at));
  -- The only time the code exists in readable form. Never stored or logged.
  return jsonb_build_object(
    'code', substr(v_code, 1, 4) || '-' || substr(v_code, 5, 4) || '-' || substr(v_code, 9, 4) || '-' || substr(v_code, 13, 4),
    'code_id', v_new.id, 'expires_at', v_new.expires_at, 'grants_revoked', v_revoked);
end $$;

create or replace function public.revoke_demo_code(p_reason text default null)
returns jsonb language plpgsql volatile security definer set search_path = public as $$
declare v_old public.demo_codes; v_revoked int := 0;
begin
  perform public._require_admin_aal2();
  select * into v_old from public.demo_codes where revoked_at is null for update;
  if not found then return jsonb_build_object('revoked', false); end if;
  update public.demo_codes set revoked_at = now(), revoked_reason = coalesce(nullif(btrim(p_reason), ''), 'revoked') where id = v_old.id;
  update public.demo_grants set revoked_at = now(), revoked_reason = 'code revoked' where code_id = v_old.id and revoked_at is null;
  get diagnostics v_revoked = row_count;
  perform public.log_event('demo_code_revoked', 'demo_codes', v_old.id::text, jsonb_build_object('grants_revoked', v_revoked));
  return jsonb_build_object('revoked', true, 'grants_revoked', v_revoked);
end $$;

create or replace function public.revoke_demo_grant(p_grant uuid, p_reason text default null)
returns boolean language plpgsql volatile security definer set search_path = public as $$
begin
  perform public._require_admin_aal2();
  update public.demo_grants set revoked_at = now(), revoked_reason = coalesce(nullif(btrim(p_reason), ''), 'revoked by owner')
   where id = p_grant and revoked_at is null;
  if not found then return false; end if;
  perform public.log_event('demo_grant_revoked', 'demo_grants', p_grant::text, '{}'::jsonb);
  return true;
end $$;

create or replace function public.demo_access_overview()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public._require_admin_aal2();
  return jsonb_build_object(
    'enabled', public._demo_access_enabled(),
    'environment', (select environment from public.deployment_settings),
    'code', (select jsonb_build_object('id', id, 'created_at', created_at, 'expires_at', expires_at, 'expired', expires_at <= now())
               from public.demo_codes where revoked_at is null),
    'grants', coalesce((select jsonb_agg(jsonb_build_object(
        'id', g.id, 'display_name', g.display_name, 'created_at', g.created_at, 'activated_at', g.activated_at,
        'expires_at', g.expires_at, 'revoked_at', g.revoked_at, 'revoked_reason', g.revoked_reason,
        'identity_deleted_at', g.identity_deleted_at,
        'active', g.user_id is not null and public._reviewer_grant_ok(g.user_id)) order by g.created_at desc)
      from public.demo_grants g where g.created_at > now() - interval '180 days'), '[]'::jsonb));
end $$;

-- Staged owner MFA. Only an aal2 session can switch it (on or off), so it can't
-- be turned on before MFA demonstrably works for the person turning it on.
create or replace function public.set_admin_mfa_required(p_on boolean)
returns boolean language plpgsql volatile security definer set search_path = public as $$
begin
  if not exists (select 1 from public.profiles where id = auth.uid() and role = 'admin' and active)
     or public.current_aal() <> 'aal2' then
    raise exception 'Administrator access with multi-factor sign-in required' using errcode = '42501';
  end if;
  if not exists (select 1 from public.deployment_settings) then
    raise exception 'Deployment settings are not configured for this database' using errcode = '55000';
  end if;
  update public.deployment_settings set admin_mfa_required = coalesce(p_on, false), updated_at = now() where id;  -- one row; Supabase rejects WHERE-less updates
  perform public.log_event('admin_mfa_required_set', 'deployment_settings', 'singleton', jsonb_build_object('on', p_on));
  return coalesce(p_on, false);
end $$;

-- ---------------------------------------------------------------------------
-- Service role only: called by the demo-redeem Edge Function
-- ---------------------------------------------------------------------------
create or replace function public.demo_redeem_begin(p_ip_hash text, p_code text, p_name text)
returns jsonb language plpgsql volatile security definer set search_path = public, extensions as $$
declare
  v_ip    text := left(coalesce(nullif(btrim(p_ip_hash), ''), 'unknown'), 128);
  v_name  text := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  v_norm  text := public._normalize_demo_code(p_code);
  v_code  public.demo_codes;
  v_email text;
  v_grant uuid;
begin
  if not public._demo_access_enabled() then
    return jsonb_build_object('ok', false, 'reason', 'disabled');
  end if;
  delete from public.demo_redeem_attempts where attempted_at < now() - interval '2 days';
  -- Rate limits, checked before any code comparison:
  --   5 failures per source per 15 min · 60 attempts per 10 min overall · 20 redemptions per hour.
  if (select count(*) from public.demo_redeem_attempts where ip_hash = v_ip and not succeeded and attempted_at > now() - interval '15 minutes') >= 5
     or (select count(*) from public.demo_redeem_attempts where attempted_at > now() - interval '10 minutes') >= 60
     or (select count(*) from public.demo_redeem_attempts where succeeded and attempted_at > now() - interval '1 hour') >= 20 then
    return jsonb_build_object('ok', false, 'reason', 'rate_limited');
  end if;
  if char_length(v_name) not between 1 and 80 then
    return jsonb_build_object('ok', false, 'reason', 'invalid_name');
  end if;
  if char_length(v_norm) = 16 then
    select * into v_code from public.demo_codes where revoked_at is null and expires_at > now() for share;
  end if;
  if v_code.id is null or v_code.code_hash <> extensions.crypt(v_norm, v_code.code_hash) then
    insert into public.demo_redeem_attempts (ip_hash, succeeded) values (v_ip, false);
    return jsonb_build_object('ok', false, 'reason', 'invalid');
  end if;
  v_email := 'reviewer-' || gen_random_uuid()::text || '@demo.invalid';
  -- The existing invitation path (before-user-created hook, profile trigger) creates the identity.
  insert into public.invitations (email, full_name, role, invited_by) values (v_email, v_name, 'reviewer', null);
  insert into public.demo_grants (code_id, email, display_name, expires_at)
  values (v_code.id, v_email, v_name, least(now() + interval '30 days', v_code.expires_at))
  returning id into v_grant;
  insert into public.demo_redeem_attempts (ip_hash, succeeded) values (v_ip, true);
  return jsonb_build_object('ok', true, 'grant_id', v_grant, 'email', v_email);
end $$;

create or replace function public.demo_redeem_complete(p_grant uuid, p_user uuid)
returns boolean language plpgsql volatile security definer set search_path = public as $$
declare g public.demo_grants;
begin
  select * into g from public.demo_grants where id = p_grant for update;
  if not found then return false; end if;
  perform 1 from public.demo_codes where id = g.code_id for share;
  update public.demo_grants d set user_id = p_user, activated_at = now()
   where d.id = g.id and d.user_id is null and d.activated_at is null and d.revoked_at is null
     and d.created_at > now() - interval '5 minutes'
     and public._demo_access_enabled()
     and exists (select 1 from public.demo_codes c where c.id = d.code_id and c.revoked_at is null and c.expires_at > now())
     and exists (select 1 from public.profiles p where p.id = p_user and p.email = d.email and p.role = 'reviewer' and p.active);
  if not found then return false; end if;
  -- The invitation has done its job; nobody can sign up with that address again.
  update public.invitations set revoked_at = now() where email = g.email and revoked_at is null;
  return true;
end $$;

-- Identities to delete through the Auth admin API: reviewer identities whose
-- access ended more than 7 days ago, or that never activated within an hour.
-- Marks the grant first, so the access history survives the deletion.
create or replace function public.demo_cleanup_candidates()
returns setof uuid language plpgsql volatile security definer set search_path = public as $$
begin
  update public.demo_grants set revoked_at = now(), revoked_reason = 'never activated'
   where activated_at is null and revoked_at is null and created_at < now() - interval '1 hour';
  update public.invitations i set revoked_at = now()
    from public.demo_grants g
   where g.email = i.email and g.activated_at is null and i.revoked_at is null and g.created_at < now() - interval '1 hour';
  return query
    with ended as (
      select p.id
        from public.profiles p
        left join public.demo_grants g on g.user_id = p.id
        left join public.demo_codes c on c.id = g.code_id
       where p.role = 'reviewer'
         and p.email ~ '^reviewer-[0-9a-f-]{36}@demo\.invalid$'
         and not public._reviewer_grant_ok(p.id)
         and (g.id is null and p.created_at < now() - interval '1 hour'
              or least(g.revoked_at, c.revoked_at,
                       case when g.expires_at <= now() then g.expires_at end,
                       case when c.expires_at <= now() then c.expires_at end) < now() - interval '7 days'))
    update public.demo_grants g set identity_deleted_at = coalesce(g.identity_deleted_at, now())
      from ended where g.user_id = ended.id
    returning g.user_id;
  -- Profiles without any grant row (redemption failed half-way) are returned too.
  return query
    select p.id from public.profiles p
     where p.role = 'reviewer' and p.email ~ '^reviewer-[0-9a-f-]{36}@demo\.invalid$'
       and not exists (select 1 from public.demo_grants g where g.user_id = p.id)
       and p.created_at < now() - interval '1 hour';
end $$;

-- ---------------------------------------------------------------------------
-- Related hardening (readiness items)
-- ---------------------------------------------------------------------------
-- Users can't rename themselves (display names appear in faculty views and exports).
drop policy if exists profiles_self_update on public.profiles;

-- question_issues returns faculty review notes: staff only.
create or replace function public.question_issues(p_qv uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  q   public.question_versions;
  k   jsonb;
  ids text[];
  correct text[];
  issues jsonb := '[]';
  m record;
begin
  perform public.require_staff();  -- R: review notes are for staff only
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
end $function$;

-- TRUNCATE bypasses RLS; no API role needs it.
revoke truncate on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke truncate on tables from anon, authenticated;

-- ---------------------------------------------------------------------------
-- Function privileges
-- ---------------------------------------------------------------------------
revoke execute on function
  public._demo_access_enabled(),
  public._admin_mfa_required(),
  public._reviewer_grant_ok(uuid),
  public._require_demo_enabled(),
  public._require_admin_aal2(),
  public._new_demo_code(),
  public._normalize_demo_code(text),
  public.demo_redeem_begin(text, text, text),
  public.demo_redeem_complete(uuid, uuid),
  public.demo_cleanup_candidates()
from public, anon, authenticated;
grant execute on function
  public.demo_redeem_begin(text, text, text),
  public.demo_redeem_complete(uuid, uuid),
  public.demo_cleanup_candidates()
to service_role;
grant execute on function
  public.my_access(), public.is_reviewer(), public.current_aal(),
  public.rotate_demo_code(int), public.revoke_demo_code(text), public.revoke_demo_grant(uuid, text),
  public.demo_access_overview(), public.set_admin_mfa_required(boolean)
to authenticated;
revoke execute on function
  public.my_access(), public.is_reviewer(), public.current_aal(),
  public.rotate_demo_code(int), public.revoke_demo_code(text), public.revoke_demo_grant(uuid, text),
  public.demo_access_overview(), public.set_admin_mfa_required(boolean)
from public, anon;
