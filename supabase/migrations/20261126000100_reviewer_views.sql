-- WP3: reviewer read access, perspectives, demonstration walkthrough and feedback.
--
-- Principles (docs/exam-platform/DEMO_ACCESS.md):
--  * Reviewers read; the only write they can make is feedback (submit_feedback).
--  * Reviewers see fictional data only: profiles/cohorts flagged is_fixture, exams
--    and media flagged reviewer_visible. Flags are set by fixtures/SQL, never from
--    the portal API, so an admin click cannot expose the real post-test or media.
--  * Perspectives (Resident / Faculty / Admin) change what is shown, never what is
--    permitted. "Resident" view of a fictional resident passes p_as_learner to the
--    learner read functions; it never signs anyone in as that resident.
--  * Every existing write path is unchanged: write functions still require
--    is_staff()/is_admin() or ownership, which reviewers never satisfy.
--  * The owner can preview the reviewer experience: an admin request carrying
--    `x-portal-preview: reviewer` is evaluated with the reviewer role. The header
--    can only lower privileges and is ignored for everyone except admins.

-- ---------------------------------------------------------------------------
-- 1. Flags
-- ---------------------------------------------------------------------------
alter table public.profiles add column if not exists is_fixture boolean not null default false;
alter table public.cohorts add column if not exists is_fixture boolean not null default false;
alter table public.exams add column if not exists reviewer_visible boolean not null default false;
alter table public.media_assets add column if not exists reviewer_visible boolean not null default false;

-- fictional people have undeliverable addresses, so a fixture can never be a real person who signs in
alter table public.profiles add constraint profiles_fixture_is_fictional
  check (not is_fixture or email ~ '^[a-z0-9._-]+@fixture\.invalid$');
-- reviewer-visible media must be de-identified and authorized for teaching use
alter table public.media_assets add constraint media_reviewer_visible_cleared
  check (not reviewer_visible or (deidentified and authorization_status = 'authorized'));

-- The flags are managed from SQL (fixtures, owner-run statements), never through the API.
create or replace function public.guard_review_flag()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  col text := tg_argv[0];
  n boolean := coalesce((to_jsonb(new) ->> col)::boolean, false);
  o boolean := case when tg_op = 'UPDATE' then coalesce((to_jsonb(old) ->> col)::boolean, false) else false end;
begin
  if n is distinct from o and auth.uid() is not null then
    raise exception '% is set by the demonstration fixtures, not from the portal', col using errcode = '42501';
  end if;
  return new;
end $$;
revoke all on function public.guard_review_flag() from public, anon, authenticated;

create trigger profiles_fixture_flag before insert or update of is_fixture on public.profiles
  for each row execute function public.guard_review_flag('is_fixture');
create trigger cohorts_fixture_flag before insert or update of is_fixture on public.cohorts
  for each row execute function public.guard_review_flag('is_fixture');
create trigger exams_reviewer_flag before insert or update of reviewer_visible on public.exams
  for each row execute function public.guard_review_flag('reviewer_visible');
create trigger media_reviewer_flag before insert or update of reviewer_visible on public.media_assets
  for each row execute function public.guard_review_flag('reviewer_visible');

-- Fictional and real people never share a block.
create or replace function public.guard_fixture_membership()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if (select is_fixture from public.cohorts where id = new.cohort_id)
     is distinct from coalesce((select is_fixture from public.profiles where id = new.user_id), false) then
    raise exception 'Fictional residents and faculty can only be in fictional blocks (and real people only in real blocks)'
      using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function public.guard_fixture_membership() from public, anon, authenticated;
create trigger cohort_members_fixture before insert or update on public.cohort_members
  for each row execute function public.guard_fixture_membership();

-- A question is never shared across the reviewer boundary: a reviewer-visible (demonstration)
-- exam cannot contain a question that a hidden exam uses, and vice versa.
create or replace function public.guard_review_boundary()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_visible boolean; v_question uuid;
begin
  select e.reviewer_visible into v_visible from public.exam_versions v join public.exams e on e.id = v.exam_id where v.id = new.exam_version_id;
  select question_id into v_question from public.question_versions where id = new.question_version_id;
  if exists (select 1 from public.question_versions qv join public.exam_items ei on ei.question_version_id = qv.id
               join public.exam_versions v on v.id = ei.exam_version_id join public.exams e on e.id = v.exam_id
              where qv.question_id = v_question and e.reviewer_visible is distinct from v_visible) then
    raise exception 'Demonstration exams and other exams cannot share questions' using errcode = '23514';
  end if;
  return new;
end $$;
revoke all on function public.guard_review_boundary() from public, anon, authenticated;
create trigger exam_items_review_boundary before insert or update of question_version_id, exam_version_id on public.exam_items
  for each row execute function public.guard_review_boundary();

-- ---------------------------------------------------------------------------
-- 2. Owner preview of the reviewer experience (downgrade only)
-- ---------------------------------------------------------------------------
create or replace function public._preview_as_reviewer()
returns boolean language plpgsql stable security definer set search_path = public as $$
declare h text := current_setting('request.headers', true);
begin
  if h is null or h = '' then return false; end if;
  return coalesce((h::jsonb ->> 'x-portal-preview') = 'reviewer', false) and public._demo_access_enabled();
exception when others then
  return false;
end $$;
revoke all on function public._preview_as_reviewer() from public, anon, authenticated;

create or replace function public.my_role()
returns public.app_role language sql stable security definer set search_path = public as $$
  select case
           when p.role = 'reviewer' then
             case when public._reviewer_grant_ok(p.id) then 'reviewer'::public.app_role end
           when p.role = 'admin' and public._admin_mfa_required() and public.current_aal() <> 'aal2' then null
           when p.role = 'admin' and public._preview_as_reviewer() then 'reviewer'::public.app_role
           else p.role
         end
    from public.profiles p
   where p.id = auth.uid() and p.active
$$;

create or replace function public.my_access()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'role', public.my_role(),
    'profile_role', (select p.role from public.profiles p where p.id = auth.uid() and p.active),
    'aal', public.current_aal(),
    'admin_mfa_required', public._admin_mfa_required(),
    'environment', (select s.environment from public.deployment_settings s),
    'demo_access_enabled', public._demo_access_enabled(),
    'preview', public._preview_as_reviewer()
               and exists (select 1 from public.profiles p where p.id = auth.uid() and p.active and p.role = 'admin'),
    'demo', (select jsonb_build_object('display_name', g.display_name, 'expires_at', least(g.expires_at, c.expires_at))
               from public.demo_grants g join public.demo_codes c on c.id = g.code_id
              where g.user_id = auth.uid() and public._reviewer_grant_ok(auth.uid())))
$$;

-- ---------------------------------------------------------------------------
-- 3. Visibility predicates (used by policies, so callable by authenticated)
-- ---------------------------------------------------------------------------
create or replace function public._fixture_learner(p_uid uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = p_uid and is_fixture and role = 'learner' and active)
$$;
create or replace function public._fixture_cohort(p_cohort uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.cohorts where id = p_cohort and is_fixture)
$$;
create or replace function public._exam_reviewer_visible(p_exam uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.exams where id = p_exam and reviewer_visible)
$$;
create or replace function public._exam_version_reviewer_visible(p_version uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.exam_versions v join public.exams e on e.id = v.exam_id
                  where v.id = p_version and e.reviewer_visible)
$$;
-- A question is shown to reviewers only if every exam that uses it is reviewer-visible
-- (so a question shared with the real post-test is never exposed).
create or replace function public._question_reviewer_visible(p_question uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.question_versions qv join public.exam_items ei on ei.question_version_id = qv.id
                   join public.exam_versions v on v.id = ei.exam_version_id join public.exams e on e.id = v.exam_id
                  where qv.question_id = p_question and e.reviewer_visible)
     and not exists (select 1 from public.question_versions qv join public.exam_items ei on ei.question_version_id = qv.id
                       join public.exam_versions v on v.id = ei.exam_version_id join public.exams e on e.id = v.exam_id
                      where qv.question_id = p_question and not e.reviewer_visible)
$$;
create or replace function public._qv_reviewer_visible(p_qv uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public._question_reviewer_visible((select question_id from public.question_versions where id = p_qv))
$$;
create or replace function public._reviewer_sees_learner(p_learner uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_reviewer() and public._fixture_learner(p_learner)
$$;
create or replace function public._reviewer_sees(p_learner uuid, p_cohort uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select public.is_reviewer() and public._fixture_learner(p_learner) and public._fixture_cohort(p_cohort)
     and exists (select 1 from public.cohort_members m where m.cohort_id = p_cohort and m.user_id = p_learner and m.member_role = 'learner')
$$;
do $$
declare f text;
begin
  foreach f in array array['_fixture_learner(uuid)', '_fixture_cohort(uuid)', '_exam_reviewer_visible(uuid)',
                           '_exam_version_reviewer_visible(uuid)', '_question_reviewer_visible(uuid)', '_qv_reviewer_visible(uuid)',
                           '_reviewer_sees_learner(uuid)', '_reviewer_sees(uuid, uuid)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Gates used by the read functions
-- ---------------------------------------------------------------------------
create or replace function public._require_staff_or_reviewer()
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if not (public.is_staff() or public.is_reviewer()) then
    raise exception 'Faculty access required' using errcode = '42501';
  end if;
end $$;

-- Whose learner data a learner read function returns: the caller, or (reviewer/admin)
-- a fictional resident chosen in the Resident perspective.
create or replace function public._acting_learner(p_as uuid)
returns uuid language plpgsql stable security definer set search_path = public as $$
begin
  if p_as is null then
    if not public.is_member() then raise exception 'Not signed in' using errcode = '42501'; end if;
    return auth.uid();
  end if;
  if not (public.is_reviewer() or public.is_admin()) then
    raise exception 'Only demonstration reviewers and the owner can view a fictional resident' using errcode = '42501';
  end if;
  if not public._fixture_learner(p_as) then
    raise exception 'Fictional resident not found' using errcode = '42501';
  end if;
  return p_as;
end $$;

-- Read-only attempt gate (staff_attempt_detail). Write paths keep _require_view_attempt.
create or replace function public._require_read_attempt(p_attempt uuid)
returns public.attempts language plpgsql stable security definer set search_path = public as $$
declare a public.attempts;
begin
  select * into a from public.attempts where id = p_attempt;
  if not found
     or not ((public.is_staff() and public.can_view_learner(a.user_id))
             or (public._reviewer_sees_learner(a.user_id) and public._exam_version_reviewer_visible(a.exam_version_id))) then
    raise exception 'Attempt not found' using errcode = '42501';
  end if;
  return a;
end $$;
revoke all on function public._require_staff_or_reviewer() from public, anon, authenticated;
revoke all on function public._acting_learner(uuid) from public, anon, authenticated;
revoke all on function public._require_read_attempt(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. Learner read functions gain p_as_learner (signature change: drop + recreate)
-- ---------------------------------------------------------------------------
drop function public.my_curriculum(text);
drop function public.my_evidence();
drop function public.my_requirements();
drop function public.my_exams();
drop function public.get_my_result(uuid);

-- ---------------------------------------------------------------------------
-- Read functions (generated from the WP2 definitions with checked edits)
-- ---------------------------------------------------------------------------
-- my_curriculum: + p_as_learner
CREATE OR REPLACE FUNCTION public.my_curriculum(p_course_slug text, p_as_learner uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare c public.courses; v_uid uuid;
begin
  v_uid := public._acting_learner(p_as_learner);
  select * into c from public.courses where slug = p_course_slug;
  if not found then raise exception 'Course not found' using errcode = 'P0002'; end if;
  return jsonb_build_object(
    'course', to_jsonb(c),
    'objectives', coalesce((select jsonb_agg(to_jsonb(o) order by o.sort, o.code) from public.learning_objectives o where o.course_id = c.id), '[]'),
    'domains', coalesce((select jsonb_agg(to_jsonb(d) order by d.sort) from public.domains d where d.course_id = c.id), '[]'),
    'items', coalesce((select jsonb_agg(to_jsonb(ci) || jsonb_build_object('completed_at', cp.completed_at) order by ci.sort, ci.title)
                         from public.curriculum_items ci
                         left join public.curriculum_progress cp on cp.item_id = ci.id and cp.user_id = v_uid
                        where ci.course_id = c.id), '[]'));
end $function$;

-- my_evidence: + p_as_learner (fixture blocks only when previewing)
CREATE OR REPLACE FUNCTION public.my_evidence(p_as_learner uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_uid uuid;
begin
  v_uid := public._acting_learner(p_as_learner);
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
                           where s.requirement_id = r.id and s.learner_id = v_uid and s.cohort_id = c.id and s.upload_status = 'uploaded'), '[]'))
                      order by r.sort, r.title)
                 from public.evidence_requirements r
                where r.course_id = c.course_id and (r.cohort_id is null or r.cohort_id = c.id) and r.archived_at is null), '[]'))
           order by c.start_date desc nulls last, c.name)
      from public.cohort_members m join public.cohorts c on c.id = m.cohort_id
     where m.user_id = v_uid and m.member_role = 'learner' and c.archived_at is null
       and (p_as_learner is null or c.is_fixture)), '[]'::jsonb);
end $function$;

-- my_requirements: + p_as_learner
CREATE OR REPLACE FUNCTION public.my_requirements(p_as_learner uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_uid uuid;
begin
  v_uid := public._acting_learner(p_as_learner);
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'cohort', jsonb_build_object('id', c.id, 'name', c.name, 'start_date', c.start_date, 'end_date', c.end_date,
                                          'course', (select title from public.courses where id = c.course_id)),
             'rotation', public._rotation_status(v_uid, c.id, true))
           order by c.start_date desc nulls last, c.name)
      from public.cohort_members m join public.cohorts c on c.id = m.cohort_id
     where m.user_id = v_uid and m.member_role = 'learner' and c.archived_at is null
       and (p_as_learner is null or c.is_fixture)), '[]'::jsonb);
end $function$;

-- my_exams: + p_as_learner (reviewer-visible exams only, no finalisation when previewing)
CREATE OR REPLACE FUNCTION public.my_exams(p_as_learner uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid;
  out jsonb := '[]';
  r record;
  acc public.accommodations;
  used int; open_id uuid; last record;
  v_max int; v_limit numeric; v_state text;
begin
  v_uid := public._acting_learner(p_as_learner);
  if p_as_learner is null then perform public._finalize_overdue(v_uid, null); end if;
  for r in
    select a.*, ev.title, ev.instructions, ev.time_limit_minutes, ev.max_attempts, ev.allow_resume, ev.feedback_policy,
           ev.release_mode, ev.pass_threshold_pct, ev.exam_id, ev.version, ev.status as ev_status,
           (select count(*) from public.exam_items ei where ei.exam_version_id = ev.id) as n_items
      from public.assignments a join public.exam_versions ev on ev.id = a.exam_version_id
     where a.id in (select public._my_assignment_ids(v_uid))
       and (p_as_learner is null or public._exam_reviewer_visible(ev.exam_id))
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
      'opens_at', r.opens_at, 'due_at', r.due_at, 'state', v_state, 'preview', p_as_learner is not null, 'open_attempt_id', open_id,
      'last_attempt', case when last.id is null then null else jsonb_build_object(
          'id', last.id, 'attempt_no', last.attempt_no, 'submitted_at', last.submitted_at,
          'released', last.released_at is not null) end);
  end loop;
  return out;
end $function$;

-- get_my_result: + p_as_learner
CREATE OR REPLACE FUNCTION public.get_my_result(p_attempt uuid, p_as_learner uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare a public.attempts; v public.exam_versions; out jsonb; bd jsonb;
begin
  select * into a from public.attempts where id = p_attempt;
  if not found or a.user_id <> public._acting_learner(p_as_learner) then raise exception 'Attempt not found' using errcode = '42501'; end if;
  select * into v from public.exam_versions where id = a.exam_version_id;
  if p_as_learner is not null and not public._exam_reviewer_visible(v.exam_id) then
    raise exception 'Attempt not found' using errcode = '42501';
  end if;
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
end $function$;

-- rotation_status
CREATE OR REPLACE FUNCTION public.rotation_status(p_learner uuid, p_cohort uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not ((public.is_staff() and public.can_evaluate(p_learner, p_cohort)) or public._reviewer_sees(p_learner, p_cohort)) then
    raise exception 'Resident not found in this block' using errcode = '42501';
  end if;
  if not public.is_reviewer() then perform public._finalize_overdue(p_learner, null); end if;
  return public._rotation_status(p_learner, p_cohort, false) || jsonb_build_object('itar', public._itar_state(p_learner, p_cohort));
end $function$;

-- itar_workspace
CREATE OR REPLACE FUNCTION public.itar_workspace(p_learner uuid, p_cohort uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare c public.cohorts; p public.profiles;
begin
  if not ((public.is_staff() and public.can_evaluate(p_learner, p_cohort)) or public._reviewer_sees(p_learner, p_cohort)) then
    raise exception 'Resident not found in this block' using errcode = '42501';
  end if;
  select * into c from public.cohorts where id = p_cohort;
  select * into p from public.profiles where id = p_learner;
  if c.id is null or p.id is null then raise exception 'Resident not found in this block' using errcode = 'P0002'; end if;
  if not public.is_reviewer() then perform public._finalize_overdue(p_learner, null); end if;
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
       where asg.archived_at is null and e.course_id = c.course_id and (asg.cohort_id = p_cohort or asg.user_id = p_learner)
         and (not public.is_reviewer() or e.reviewer_visible)),
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
end $function$;

-- itar_blocks
CREATE OR REPLACE FUNCTION public.itar_blocks()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  perform public._require_staff_or_reviewer();
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
        or (public.is_reviewer() and c.is_fixture)
        or exists (select 1 from public.cohort_members m where m.cohort_id = c.id and m.user_id = auth.uid() and m.member_role = 'evaluator')), '[]'::jsonb);
end $function$;

-- itar_block_overview
CREATE OR REPLACE FUNCTION public.itar_block_overview(p_cohort uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare c public.cohorts;
begin
  perform public._require_staff_or_reviewer();
  if not public.is_admin() and not (public.is_reviewer() and public._fixture_cohort(p_cohort))
     and not exists (select 1 from public.cohort_members m
                      where m.cohort_id = p_cohort and m.user_id = auth.uid() and m.member_role = 'evaluator') then
    raise exception 'Block not found' using errcode = '42501';
  end if;
  select * into c from public.cohorts where id = p_cohort;
  if not found then raise exception 'Block not found' using errcode = 'P0002'; end if;
  if not public.is_reviewer() then perform public._finalize_overdue(null, null); end if;
  return jsonb_build_object(
    'cohort', to_jsonb(c) || jsonb_build_object('course', (select title from public.courses where id = c.course_id)),
    'residents', coalesce((
      select jsonb_agg(jsonb_build_object(
               'id', pr.id, 'name', coalesce(nullif(pr.full_name, ''), pr.email), 'training_level', pr.training_level,
               'exam', jsonb_build_object(
                  'assigned', exists (select 1 from public.assignments asg join public.exam_versions ev on ev.id = asg.exam_version_id
                                        join public.exams e on e.id = ev.exam_id
                                       where asg.archived_at is null and e.course_id = c.course_id and (asg.cohort_id = p_cohort or asg.user_id = pr.id)
                                         and (not public.is_reviewer() or e.reviewer_visible)),
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
end $function$;

-- rotation_block_overview
CREATE OR REPLACE FUNCTION public.rotation_block_overview(p_cohort uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare res jsonb;
begin
  perform public._require_staff_or_reviewer();
  if not public.is_admin() and not (public.is_reviewer() and public._fixture_cohort(p_cohort))
     and not exists (select 1 from public.cohort_members m
                      where m.cohort_id = p_cohort and m.user_id = auth.uid() and m.member_role = 'evaluator') then
    raise exception 'Block not found' using errcode = '42501';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
           'learner_id', m.user_id,
           'requirements', (select jsonb_agg(jsonb_build_object('key', q ->> 'key', 'kind', q ->> 'kind', 'title', q ->> 'title', 'required', (q ->> 'required')::boolean,
                                                                 'status', q ->> 'status', 'action', q ->> 'action', 'detail', q ->> 'detail', 'extra', q -> 'extra'))
                              from jsonb_array_elements(s -> 'requirements') q),
           'scans', jsonb_build_object('verified_total', s -> 'scans' -> 'verified_total', 'target_total', s -> 'scans' -> 'target_total'),
           'itar', public._itar_state(m.user_id, p_cohort))), '[]')
    into res
    from public.cohort_members m
    join public.profiles p on p.id = m.user_id
    cross join lateral (select public._rotation_status(m.user_id, p_cohort, false) s) z
   where m.cohort_id = p_cohort and m.member_role = 'learner' and p.active;
  return res;
end $function$;

-- iter_template_for
CREATE OR REPLACE FUNCTION public.iter_template_for(p_cohort uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select to_jsonb(t) || jsonb_build_object('confirmed_by_name', (select full_name from public.profiles where id = t.confirmed_by))
    from public.iter_templates t
   where (public.is_staff() or public.is_reviewer())
     and (t.course_id = (select course_id from public.cohorts where id = p_cohort) or t.course_id is null)
   order by (t.course_id is null) limit 1
$function$;

-- learner_report
CREATE OR REPLACE FUNCTION public.learner_report(p_learner uuid, p_course uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare p public.profiles;
begin
  if not ((public.is_staff() and public.can_view_learner(p_learner)) or public._reviewer_sees_learner(p_learner)) then
    raise exception 'Learner not found' using errcode = '42501';
  end if;
  if not public.is_reviewer() then perform public._finalize_overdue(p_learner, null); end if;
  select * into p from public.profiles where id = p_learner;
  return jsonb_build_object(
    'learner', jsonb_build_object('id', p.id, 'full_name', p.full_name, 'email', p.email,
                                  'training_level', p.training_level, 'program', p.program),
    'cohorts', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'academic_year', c.academic_year,
                                     'block_label', c.block_label, 'start_date', c.start_date, 'end_date', c.end_date) order by c.start_date desc nulls last)
                         from public.cohort_members m join public.cohorts c on c.id = m.cohort_id
                        where m.user_id = p.id and c.course_id = p_course and (not public.is_reviewer() or c.is_fixture)), '[]'),
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
                         where a.user_id = p.id and e.course_id = p_course and (not public.is_reviewer() or e.reviewer_visible)), '[]'),
    'notes', coalesce((select jsonb_agg(jsonb_build_object('id', n.id, 'body', n.body, 'created_at', n.created_at,
                                  'author', (select full_name from public.profiles where id = n.author_id)) order by n.created_at desc)
                       from public.faculty_notes n where n.learner_id = p.id and n.course_id = p_course), '[]'),
    'curriculum', jsonb_build_object(
        'required', (select count(*) from public.curriculum_items where course_id = p_course and required),
        'required_completed', (select count(*) from public.curriculum_items ci join public.curriculum_progress cp on cp.item_id = ci.id
                                where ci.course_id = p_course and ci.required and cp.user_id = p.id),
        'completed', (select count(*) from public.curriculum_items ci join public.curriculum_progress cp on cp.item_id = ci.id
                       where ci.course_id = p_course and cp.user_id = p.id)));
end $function$;

-- exam_report
CREATE OR REPLACE FUNCTION public.exam_report(p_exam_version uuid, p_cohort uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v public.exam_versions; learners jsonb; items jsonb; stats jsonb; domains jsonb;
begin
  perform public._require_staff_or_reviewer();
  select * into v from public.exam_versions where id = p_exam_version;
  if not found or (public.is_reviewer() and not public._exam_reviewer_visible(v.exam_id)) then
    raise exception 'Exam version not found' using errcode = 'P0002';
  end if;
  if not public.is_reviewer() then perform public._finalize_overdue(null, v.id); end if;

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
  where (public.can_view_learner(u) or public._reviewer_sees_learner(u))
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
end $function$;

-- exam_version_issues
CREATE OR REPLACE FUNCTION public.exam_version_issues(p_exam_version_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v public.exam_versions;
  issues jsonb := '[]';
  it record;
  qi jsonb;
begin
  perform public._require_staff_or_reviewer();
  select * into v from public.exam_versions where id = p_exam_version_id;
  if not found or (public.is_reviewer() and not public._exam_reviewer_visible(v.exam_id)) then
    raise exception 'Exam version not found' using errcode = 'P0002';
  end if;
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
end $function$;

-- question_issues
CREATE OR REPLACE FUNCTION public.question_issues(p_qv uuid)
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
  perform public._require_staff_or_reviewer();  -- R: review notes are for staff (and reviewers, for demonstration questions)
  if public.is_reviewer() and not public._qv_reviewer_visible(p_qv) then
    return jsonb_build_array(jsonb_build_object('level', 'error', 'message', 'Question version not found'));
  end if;
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

-- staff_attempt_detail: read-only gate that also admits reviewers (write paths keep _require_view_attempt)
CREATE OR REPLACE FUNCTION public.staff_attempt_detail(p_attempt uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare a public.attempts; v public.exam_versions; p public.profiles;
begin
  a := public._require_read_attempt(p_attempt);
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
end $function$;

-- evidence_due_for_deletion: empty for reviewers
CREATE OR REPLACE FUNCTION public.evidence_due_for_deletion()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_days int;
begin
  if public.is_reviewer() then return '[]'::jsonb; end if;
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
end $function$;

-- _block_attempts: reviewers only see attempts on reviewer-visible exams
CREATE OR REPLACE FUNCTION public._block_attempts(p_learner uuid, p_cohort uuid)
 RETURNS SETOF attempts
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select a.* from public.attempts a
    join public.assignments asg on asg.id = a.assignment_id
    join public.exam_versions ev on ev.id = a.exam_version_id
    join public.exams e on e.id = ev.exam_id
    join public.cohorts c on c.id = p_cohort
   where a.user_id = p_learner and e.course_id = c.course_id
     and (asg.cohort_id = p_cohort or asg.user_id = p_learner)
     and (not public.is_reviewer() or e.reviewer_visible)
$function$;

-- can_read_exam_media: + reviewer-visible media
CREATE OR REPLACE FUNCTION public.can_read_exam_media(p_path text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select public.is_staff()
  or (public.is_reviewer() and exists (
    select 1 from public.media_versions mv join public.media_assets ma on ma.id = mv.asset_id
     where mv.storage_path = p_path and ma.reviewer_visible and ma.archived_at is null))
  or exists (
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
$function$;

-- can_read_evidence: + fictional residents for reviewers
CREATE OR REPLACE FUNCTION public.can_read_evidence(p_path text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.evidence_submissions s
     where s.storage_path = p_path and s.file_deleted_at is null
       and (s.learner_id = auth.uid() or (public.is_staff() and public.can_evaluate(s.learner_id, s.cohort_id))
            or public._reviewer_sees(s.learner_id, s.cohort_id)))
$function$;

do $$
declare f text;
begin
  foreach f in array array['my_curriculum(text, uuid)', 'my_evidence(uuid)', 'my_requirements(uuid)', 'my_exams(uuid)',
                           'get_my_result(uuid, uuid)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated, service_role', f);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Reviewer read policies (additive; SELECT only; fictional / reviewer-visible rows)
-- ---------------------------------------------------------------------------
create policy accommodations_reviewer_read on public.accommodations for select to authenticated
  using (public._reviewer_sees_learner(user_id));
create policy assignments_reviewer_read on public.assignments for select to authenticated
  using (public.is_reviewer() and public._exam_version_reviewer_visible(exam_version_id)
         and (cohort_id is null or public._fixture_cohort(cohort_id))
         and (user_id is null or public._fixture_learner(user_id)));
create policy attempts_reviewer_read on public.attempts for select to authenticated
  using (public._reviewer_sees_learner(user_id) and public._exam_version_reviewer_visible(exam_version_id));
create policy cohort_members_reviewer_read on public.cohort_members for select to authenticated
  using (public.is_reviewer() and public._fixture_cohort(cohort_id));
create policy cohorts_reviewer_read on public.cohorts for select to authenticated
  using (public.is_reviewer() and is_fixture);
create policy courses_reviewer_read on public.courses for select to authenticated using (public.is_reviewer());
create policy curriculum_reviewer_read on public.curriculum_items for select to authenticated using (public.is_reviewer());
create policy domains_reviewer_read on public.domains for select to authenticated using (public.is_reviewer());
create policy objectives_reviewer_read on public.learning_objectives for select to authenticated using (public.is_reviewer());
create policy scancat_reviewer_read on public.scan_categories for select to authenticated
  using (public.is_reviewer() and (cohort_id is null or public._fixture_cohort(cohort_id)));
create policy rotreq_reviewer_read on public.rotation_requirements for select to authenticated
  using (public.is_reviewer() and (cohort_id is null or public._fixture_cohort(cohort_id)));
create policy evreq_reviewer_read on public.evidence_requirements for select to authenticated
  using (public.is_reviewer() and (cohort_id is null or public._fixture_cohort(cohort_id)));
create policy iter_tpl_reviewer_read on public.iter_templates for select to authenticated using (public.is_reviewer());
create policy retention_reviewer_read on public.retention_settings for select to authenticated using (public.is_reviewer());
create policy progress_reviewer_read on public.curriculum_progress for select to authenticated
  using (public._reviewer_sees_learner(user_id));
create policy epa_reviewer_read on public.epa_reviews for select to authenticated
  using (public._reviewer_sees(learner_id, cohort_id));
create policy evalver_reviewer_read on public.evaluation_versions for select to authenticated
  using (public._reviewer_sees_learner(learner_id) and (cohort_id is null or public._fixture_cohort(cohort_id)));
create policy evals_reviewer_read on public.evaluations for select to authenticated
  using (public._reviewer_sees_learner(learner_id) and (cohort_id is null or public._fixture_cohort(cohort_id)));
create policy notes_reviewer_read on public.faculty_notes for select to authenticated
  using (public._reviewer_sees_learner(learner_id) and (cohort_id is null or public._fixture_cohort(cohort_id)));
create policy evsub_reviewer_read on public.evidence_submissions for select to authenticated
  using (public._reviewer_sees(learner_id, cohort_id));
create policy reqstat_reviewer_read on public.requirement_status for select to authenticated
  using (public._reviewer_sees(learner_id, cohort_id));
create policy scanatt_reviewer_read on public.scan_attestations for select to authenticated
  using (public._reviewer_sees(learner_id, cohort_id));
create policy scanself_reviewer_read on public.scan_self_reports for select to authenticated
  using (public._reviewer_sees(learner_id, cohort_id));
create policy exams_reviewer_read on public.exams for select to authenticated
  using (public.is_reviewer() and reviewer_visible);
create policy ev_reviewer_read on public.exam_versions for select to authenticated
  using (public.is_reviewer() and public._exam_reviewer_visible(exam_id));
create policy ei_reviewer_read on public.exam_items for select to authenticated
  using (public.is_reviewer() and public._exam_version_reviewer_visible(exam_version_id));
create policy questions_reviewer_read on public.questions for select to authenticated
  using (public.is_reviewer() and public._question_reviewer_visible(id));
create policy qv_reviewer_read on public.question_versions for select to authenticated
  using (public.is_reviewer() and public._question_reviewer_visible(question_id));
create policy qkeys_reviewer_read on public.question_keys for select to authenticated
  using (public.is_reviewer() and public._qv_reviewer_visible(question_version_id));
create policy qvm_reviewer_read on public.question_version_media for select to authenticated
  using (public.is_reviewer() and public._qv_reviewer_visible(question_version_id));
create policy media_assets_reviewer_read on public.media_assets for select to authenticated
  using (public.is_reviewer() and reviewer_visible and archived_at is null);
create policy media_versions_reviewer_read on public.media_versions for select to authenticated
  using (public.is_reviewer() and exists (select 1 from public.media_assets ma
                                            where ma.id = asset_id and ma.reviewer_visible and ma.archived_at is null));
create policy profiles_reviewer_read on public.profiles for select to authenticated
  using (public.is_reviewer() and is_fixture);
create policy responses_reviewer_read on public.responses for select to authenticated
  using (public.is_reviewer() and exists (select 1 from public.attempts a
                                            where a.id = attempt_id and public._fixture_learner(a.user_id)
                                              and public._exam_version_reviewer_visible(a.exam_version_id)));

-- ---------------------------------------------------------------------------
-- 7. Demonstration exam walkthrough: read-only, creates no attempt
-- ---------------------------------------------------------------------------
create or replace function public.preview_exam_version(p_exam_version uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare v public.exam_versions;
begin
  if not (public.is_reviewer() or public.is_admin()) then
    raise exception 'The walkthrough is for demonstration reviewers and the owner' using errcode = '42501';
  end if;
  select * into v from public.exam_versions where id = p_exam_version;
  if not found or not public._exam_reviewer_visible(v.exam_id) then
    raise exception 'Demonstration exam not found' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'exam_version_id', v.id, 'title', v.title, 'instructions', v.instructions, 'version', v.version,
    'time_limit_minutes', v.time_limit_minutes, 'pass_threshold_pct', v.pass_threshold_pct,
    'feedback_policy', v.feedback_policy, 'max_attempts', v.max_attempts,
    'items', coalesce((
      select jsonb_agg(jsonb_build_object(
               'item_id', ei.id, 'number', ei.position + 1, 'section', ei.section, 'type', qv.type, 'stem', qv.stem,
               'points', coalesce(ei.points, qv.points), 'options', qv.options, 'key', qk.key, 'explanation', qv.explanation,
               'domain_key', qv.domain_key,
               'media', coalesce((select jsonb_agg(jsonb_build_object(
                                     'path', mv.storage_path, 'kind', ma.kind, 'mime', mv.mime_type, 'width', mv.width,
                                     'height', mv.height, 'duration', mv.duration_seconds, 'frame_rate', mv.frame_rate,
                                     'caption', qvm.caption) order by qvm.position)
                                   from public.question_version_media qvm
                                   join public.media_versions mv on mv.id = qvm.media_version_id
                                   join public.media_assets ma on ma.id = mv.asset_id
                                  where qvm.question_version_id = qv.id and ma.reviewer_visible and ma.archived_at is null), '[]'))
             order by ei.position)
        from public.exam_items ei
        join public.question_versions qv on qv.id = ei.question_version_id
        left join public.question_keys qk on qk.question_version_id = qv.id
       where ei.exam_version_id = v.id and public._qv_reviewer_visible(qv.id)), '[]'));
end $$;
revoke all on function public.preview_exam_version(uuid) from public, anon;
grant execute on function public.preview_exam_version(uuid) to authenticated, service_role;

-- The fictional residents a reviewer or the owner can view in the Resident perspective.
create or replace function public.demo_fixture_learners()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  if not (public.is_reviewer() or public.is_admin()) then
    raise exception 'Not permitted' using errcode = '42501';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'id', p.id, 'full_name', p.full_name, 'training_level', p.training_level, 'program', p.program,
             'blocks', coalesce((select jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name, 'block_label', c.block_label,
                                                                      'start_date', c.start_date, 'end_date', c.end_date)
                                                   order by c.start_date desc nulls last)
                                   from public.cohort_members m join public.cohorts c on c.id = m.cohort_id
                                  where m.user_id = p.id and m.member_role = 'learner' and c.is_fixture and c.archived_at is null), '[]'))
           order by p.full_name)
      from public.profiles p
     where p.is_fixture and p.role = 'learner' and p.active), '[]'::jsonb);
end $$;
revoke all on function public.demo_fixture_learners() from public, anon;
grant execute on function public.demo_fixture_learners() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 8. Contextual feedback: reviewers (and the owner) submit; only the owner reads
-- ---------------------------------------------------------------------------
create table public.review_feedback (
  id uuid primary key default gen_random_uuid(),
  author_id uuid references public.profiles(id) on delete set null,
  grant_id uuid references public.demo_grants(id) on delete set null,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 80),
  role_label text not null default '' check (char_length(role_label) <= 80),
  perspective text check (perspective in ('resident', 'faculty', 'admin')),
  page text not null default '' check (char_length(page) <= 200),
  section text not null default '' check (char_length(section) <= 120),
  app_version text not null default '' check (char_length(app_version) <= 40),
  category text not null check (category in ('works_well', 'confusing', 'bug', 'missing', 'idea', 'other')),
  comments text not null check (char_length(btrim(comments)) between 1 and 4000),
  status text not null default 'new' check (status in ('new', 'read', 'actioned', 'dismissed')),
  owner_note text not null default '' check (char_length(owner_note) <= 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index review_feedback_created on public.review_feedback (created_at desc);
create index review_feedback_author on public.review_feedback (author_id, created_at);
alter table public.review_feedback enable row level security;
create policy review_feedback_owner_read on public.review_feedback for select to authenticated using (public.is_admin());
revoke all on public.review_feedback from anon, authenticated;
grant select on public.review_feedback to authenticated;

create or replace function public.submit_feedback(p jsonb)
returns uuid language plpgsql volatile security definer set search_path = public as $$
declare
  v_id uuid;
  v_grant uuid;
  v_comments text := btrim(coalesce(p ->> 'comments', ''));
  v_name text := btrim(coalesce(p ->> 'display_name', ''));
begin
  if not (public.is_reviewer() or public.is_admin()) then
    raise exception 'Feedback is for demonstration reviewers' using errcode = '42501';
  end if;
  if (select count(*) from public.review_feedback where author_id = auth.uid() and created_at > now() - interval '1 hour') >= 30 then
    raise exception 'Thank you — that is a lot of feedback in one hour. Please try again a little later.' using errcode = '54000';
  end if;
  perform public.assert_no_identifiers(v_comments);
  select id into v_grant from public.demo_grants where user_id = auth.uid();
  if v_name = '' then
    v_name := coalesce((select display_name from public.demo_grants where id = v_grant),
                       (select full_name from public.profiles where id = auth.uid()), 'Reviewer');
  end if;
  insert into public.review_feedback (author_id, grant_id, display_name, role_label, perspective, page, section, app_version, category, comments)
  values (auth.uid(), v_grant, left(v_name, 80), left(btrim(coalesce(p ->> 'role_label', '')), 80),
          nullif(p ->> 'perspective', ''), left(coalesce(p ->> 'page', ''), 200), left(coalesce(p ->> 'section', ''), 120),
          left(coalesce(p ->> 'app_version', ''), 40), coalesce(p ->> 'category', 'other'), v_comments)
  returning id into v_id;
  perform public.log_event('feedback_submitted', 'review_feedback', v_id::text, jsonb_build_object('category', p ->> 'category'));
  return v_id;
end $$;
revoke all on function public.submit_feedback(jsonb) from public, anon;
grant execute on function public.submit_feedback(jsonb) to authenticated, service_role;

create or replace function public.list_feedback()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.require_admin();
  return coalesce((
    select jsonb_agg(to_jsonb(f) - 'author_id' || jsonb_build_object(
             'grant_name', g.display_name, 'grant_active', g.revoked_at is null and g.expires_at > now())
           order by f.created_at desc)
      from public.review_feedback f left join public.demo_grants g on g.id = f.grant_id), '[]'::jsonb);
end $$;
revoke all on function public.list_feedback() from public, anon;
grant execute on function public.list_feedback() to authenticated, service_role;

create or replace function public.set_feedback_status(p_id uuid, p_status text, p_note text default null)
returns void language plpgsql volatile security definer set search_path = public as $$
begin
  perform public.require_admin();
  update public.review_feedback
     set status = p_status, owner_note = coalesce(p_note, owner_note), updated_at = now()
   where id = p_id;
  if not found then raise exception 'Feedback not found' using errcode = 'P0002'; end if;
end $$;
revoke all on function public.set_feedback_status(uuid, text, text) from public, anon;
grant execute on function public.set_feedback_status(uuid, text, text) to authenticated, service_role;

revoke truncate on public.review_feedback from authenticated, anon;
