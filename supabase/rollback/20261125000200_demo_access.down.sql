-- =============================================================================
-- ROLLBACK for 20261125000200_demo_access.sql (and the reviewer role's use).
-- Restores the database logic to its state before WP2. Run manually, only after a
-- backup, and only if the migration must be undone:
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -1 -f supabase/rollback/20261125000200_demo_access.down.sql
-- Then remove the migration's row from supabase_migrations.schema_migrations if
-- it was applied with `supabase db push`.
-- The enum value 'reviewer' stays (Postgres can't drop enum values); with no
-- reviewer profiles and the original my_role() it grants nothing.
-- =============================================================================

-- Demonstration identities go first (their profiles cascade from auth.users).
delete from auth.users where email ~ '^reviewer-[0-9a-f-]{36}@demo\.invalid$';
delete from public.invitations where role = 'reviewer';

-- Original role resolution
create or replace function public.my_role()
returns public.app_role language sql stable security definer set search_path = public as $$
  select p.role from public.profiles p where p.id = auth.uid() and p.active
$$;
create or replace function public.is_member()
returns boolean language sql stable security definer set search_path = public
as $$ select public.my_role() is not null $$;

drop function if exists
  public.is_reviewer(), public.my_access(), public.current_aal(),
  public.rotate_demo_code(int), public.revoke_demo_code(text), public.revoke_demo_grant(uuid, text),
  public.demo_access_overview(), public.set_admin_mfa_required(boolean),
  public.demo_redeem_begin(text, text, text), public.demo_redeem_complete(uuid, uuid), public.demo_cleanup_candidates(),
  public._reviewer_grant_ok(uuid), public._require_demo_enabled(), public._require_admin_aal2(),
  public._new_demo_code(), public._normalize_demo_code(text),
  public._demo_access_enabled(), public._admin_mfa_required();

drop table if exists public.demo_redeem_attempts, public.demo_grants, public.demo_codes, public.deployment_settings;

alter table public.invitations drop constraint if exists invitations_reviewer_is_demo;
alter table public.profiles drop constraint if exists profiles_reviewer_is_demo;

-- Original self-update policy
drop policy if exists profiles_self_update on public.profiles;
create policy profiles_self_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

-- Original question_issues (without the staff check)
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

-- Original privileges (Supabase defaults granted TRUNCATE to the API roles)
grant truncate on all tables in schema public to anon, authenticated;
alter default privileges in schema public grant truncate on tables to anon, authenticated;
revoke all on all tables in schema public from anon;
