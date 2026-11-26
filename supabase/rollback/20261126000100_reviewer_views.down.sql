-- Rollback for 20261126000100_reviewer_views.sql (tested locally: migrations up to WP2 + this file + rollback = WP2 behaviour).
-- Feedback is preserved in a backup table before the feedback table is dropped.
begin;

create table if not exists public.review_feedback_backup as select * from public.review_feedback;
revoke all on public.review_feedback_backup from anon, authenticated;
drop policy if exists accommodations_reviewer_read on public.accommodations;
drop policy if exists assignments_reviewer_read on public.assignments;
drop policy if exists attempts_reviewer_read on public.attempts;
drop policy if exists cohort_members_reviewer_read on public.cohort_members;
drop policy if exists cohorts_reviewer_read on public.cohorts;
drop policy if exists courses_reviewer_read on public.courses;
drop policy if exists curriculum_reviewer_read on public.curriculum_items;
drop policy if exists domains_reviewer_read on public.domains;
drop policy if exists objectives_reviewer_read on public.learning_objectives;
drop policy if exists scancat_reviewer_read on public.scan_categories;
drop policy if exists rotreq_reviewer_read on public.rotation_requirements;
drop policy if exists evreq_reviewer_read on public.evidence_requirements;
drop policy if exists iter_tpl_reviewer_read on public.iter_templates;
drop policy if exists retention_reviewer_read on public.retention_settings;
drop policy if exists progress_reviewer_read on public.curriculum_progress;
drop policy if exists epa_reviewer_read on public.epa_reviews;
drop policy if exists evalver_reviewer_read on public.evaluation_versions;
drop policy if exists evals_reviewer_read on public.evaluations;
drop policy if exists notes_reviewer_read on public.faculty_notes;
drop policy if exists evsub_reviewer_read on public.evidence_submissions;
drop policy if exists reqstat_reviewer_read on public.requirement_status;
drop policy if exists scanatt_reviewer_read on public.scan_attestations;
drop policy if exists scanself_reviewer_read on public.scan_self_reports;
drop policy if exists exams_reviewer_read on public.exams;
drop policy if exists ev_reviewer_read on public.exam_versions;
drop policy if exists ei_reviewer_read on public.exam_items;
drop policy if exists questions_reviewer_read on public.questions;
drop policy if exists qv_reviewer_read on public.question_versions;
drop policy if exists qkeys_reviewer_read on public.question_keys;
drop policy if exists qvm_reviewer_read on public.question_version_media;
drop policy if exists media_assets_reviewer_read on public.media_assets;
drop policy if exists media_versions_reviewer_read on public.media_versions;
drop policy if exists profiles_reviewer_read on public.profiles;
drop policy if exists responses_reviewer_read on public.responses;
drop policy if exists review_feedback_owner_read on public.review_feedback;
drop trigger if exists profiles_fixture_flag on public.profiles;
drop trigger if exists cohorts_fixture_flag on public.cohorts;
drop trigger if exists exams_reviewer_flag on public.exams;
drop trigger if exists media_reviewer_flag on public.media_assets;
drop trigger if exists cohort_members_fixture on public.cohort_members;
drop trigger if exists exam_items_review_boundary on public.exam_items;
drop function if exists public.submit_feedback(jsonb);
drop function if exists public.list_feedback();
drop function if exists public.set_feedback_status(uuid, text, text);
drop function if exists public.preview_exam_version(uuid);
drop function if exists public.demo_fixture_learners();
drop function if exists public.my_curriculum(text, uuid);
drop function if exists public.my_evidence(uuid);
drop function if exists public.my_requirements(uuid);
drop function if exists public.my_exams(uuid);
drop function if exists public.get_my_result(uuid, uuid);
drop table if exists public.review_feedback;

-- my_curriculum (WP2 definition)
CREATE OR REPLACE FUNCTION public.my_curriculum(p_course_slug text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;
-- my_evidence (WP2 definition)
CREATE OR REPLACE FUNCTION public.my_evidence()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;
-- my_requirements (WP2 definition)
CREATE OR REPLACE FUNCTION public.my_requirements()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_member() then raise exception 'Not signed in' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
             'cohort', jsonb_build_object('id', c.id, 'name', c.name, 'start_date', c.start_date, 'end_date', c.end_date,
                                          'course', (select title from public.courses where id = c.course_id)),
             'rotation', public._rotation_status(auth.uid(), c.id, true))
           order by c.start_date desc nulls last, c.name)
      from public.cohort_members m join public.cohorts c on c.id = m.cohort_id
     where m.user_id = auth.uid() and m.member_role = 'learner' and c.archived_at is null), '[]'::jsonb);
end $function$;
-- my_exams (WP2 definition)
CREATE OR REPLACE FUNCTION public.my_exams()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;
-- get_my_result (WP2 definition)
CREATE OR REPLACE FUNCTION public.get_my_result(p_attempt uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;
-- rotation_status (WP2 definition)
CREATE OR REPLACE FUNCTION public.rotation_status(p_learner uuid, p_cohort uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
begin
  if not public.is_staff() or not public.can_evaluate(p_learner, p_cohort) then
    raise exception 'Resident not found in this block' using errcode = '42501';
  end if;
  perform public._finalize_overdue(p_learner, null);
  return public._rotation_status(p_learner, p_cohort, false) || jsonb_build_object('itar', public._itar_state(p_learner, p_cohort));
end $function$;
-- itar_workspace (WP2 definition)
CREATE OR REPLACE FUNCTION public.itar_workspace(p_learner uuid, p_cohort uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;
-- itar_blocks (WP2 definition)
CREATE OR REPLACE FUNCTION public.itar_blocks()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;
-- itar_block_overview (WP2 definition)
CREATE OR REPLACE FUNCTION public.itar_block_overview(p_cohort uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;
-- rotation_block_overview (WP2 definition)
CREATE OR REPLACE FUNCTION public.rotation_block_overview(p_cohort uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare res jsonb;
begin
  perform public.require_staff();
  if not public.is_admin() and not exists (select 1 from public.cohort_members m
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
-- iter_template_for (WP2 definition)
CREATE OR REPLACE FUNCTION public.iter_template_for(p_cohort uuid)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select to_jsonb(t) || jsonb_build_object('confirmed_by_name', (select full_name from public.profiles where id = t.confirmed_by))
    from public.iter_templates t
   where public.is_staff()
     and (t.course_id = (select course_id from public.cohorts where id = p_cohort) or t.course_id is null)
   order by (t.course_id is null) limit 1
$function$;
-- learner_report (WP2 definition)
CREATE OR REPLACE FUNCTION public.learner_report(p_learner uuid, p_course uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;
-- exam_report (WP2 definition)
CREATE OR REPLACE FUNCTION public.exam_report(p_exam_version uuid, p_cohort uuid DEFAULT NULL::uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;
-- exam_version_issues (WP2 definition)
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
end $function$;
-- question_issues (WP2 definition)
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
-- staff_attempt_detail (WP2 definition)
CREATE OR REPLACE FUNCTION public.staff_attempt_detail(p_attempt uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;
-- evidence_due_for_deletion (WP2 definition)
CREATE OR REPLACE FUNCTION public.evidence_due_for_deletion()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
end $function$;
-- _block_attempts (WP2 definition)
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
$function$;
-- can_read_exam_media (WP2 definition)
CREATE OR REPLACE FUNCTION public.can_read_exam_media(p_path text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$;
-- can_read_evidence (WP2 definition)
CREATE OR REPLACE FUNCTION public.can_read_evidence(p_path text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select exists (
    select 1 from public.evidence_submissions s
     where s.storage_path = p_path and s.file_deleted_at is null
       and (s.learner_id = auth.uid() or (public.is_staff() and public.can_evaluate(s.learner_id, s.cohort_id))))
$function$;
-- my_role (WP2 definition)
CREATE OR REPLACE FUNCTION public.my_role()
 RETURNS app_role
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select case
           when p.role = 'reviewer' then
             case when public._reviewer_grant_ok(p.id) then 'reviewer'::public.app_role end
           when p.role = 'admin' and public._admin_mfa_required() and public.current_aal() <> 'aal2' then null
           else p.role
         end
    from public.profiles p
   where p.id = auth.uid() and p.active
$function$;
-- my_access (WP2 definition)
CREATE OR REPLACE FUNCTION public.my_access()
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select jsonb_build_object(
    'role', public.my_role(),
    'profile_role', (select p.role from public.profiles p where p.id = auth.uid() and p.active),
    'aal', public.current_aal(),
    'admin_mfa_required', public._admin_mfa_required(),
    'environment', (select s.environment from public.deployment_settings s),
    'demo', (select jsonb_build_object('display_name', g.display_name, 'expires_at', least(g.expires_at, c.expires_at))
               from public.demo_grants g join public.demo_codes c on c.id = g.code_id
              where g.user_id = auth.uid() and public._reviewer_grant_ok(auth.uid())))
$function$;
revoke all on function public.my_curriculum(text) from public, anon;
grant execute on function public.my_curriculum(text) to authenticated, service_role;
revoke all on function public.my_evidence() from public, anon;
grant execute on function public.my_evidence() to authenticated, service_role;
revoke all on function public.my_requirements() from public, anon;
grant execute on function public.my_requirements() to authenticated, service_role;
revoke all on function public.my_exams() from public, anon;
grant execute on function public.my_exams() to authenticated, service_role;
revoke all on function public.get_my_result(uuid) from public, anon;
grant execute on function public.get_my_result(uuid) to authenticated, service_role;
drop function if exists public._require_read_attempt(uuid);
drop function if exists public._acting_learner(uuid);
drop function if exists public._require_staff_or_reviewer();
drop function if exists public._reviewer_sees(uuid, uuid);
drop function if exists public._reviewer_sees_learner(uuid);
drop function if exists public._qv_reviewer_visible(uuid);
drop function if exists public._question_reviewer_visible(uuid);
drop function if exists public._exam_version_reviewer_visible(uuid);
drop function if exists public._exam_reviewer_visible(uuid);
drop function if exists public._fixture_cohort(uuid);
drop function if exists public._fixture_learner(uuid);
drop function if exists public._preview_as_reviewer();
drop function if exists public.guard_review_flag();
drop function if exists public.guard_fixture_membership();
drop function if exists public.guard_review_boundary();
alter table public.media_assets drop constraint if exists media_reviewer_visible_cleared;
alter table public.profiles drop constraint if exists profiles_fixture_is_fictional;
alter table public.media_assets drop column if exists reviewer_visible;
alter table public.exams drop column if exists reviewer_visible;
alter table public.cohorts drop column if exists is_fixture;
alter table public.profiles drop column if exists is_fixture;

commit;
