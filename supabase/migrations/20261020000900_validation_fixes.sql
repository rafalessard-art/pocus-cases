-- =============================================================================
-- POCUS Exam Platform — 09 validation fixes (pre-demonstration).
--
-- 1. Approved ITARs are preserved: every approval stores an immutable version
--    (text, sections, evidence snapshot, approver, time). Re-opening and
--    re-approving creates a new version; nothing is overwritten.
-- 2. Evidence that changes after approval is detected and listed, so faculty
--    can decide whether to revise. Nothing is modified automatically.
-- 3. The rotation exam requirement uses the same attempt as the ITAR: the
--    faculty-selected attempt when one was chosen, otherwise the most recent
--    submitted attempt.
-- 4. Scan attestation requires an explicit statement that the images were
--    reviewed (p_attested = true).
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Approved ITAR versions (append-only)
-- ---------------------------------------------------------------------------
create table public.evaluation_versions (
  id                uuid primary key default gen_random_uuid(),
  evaluation_id     uuid not null references public.evaluations (id) on delete restrict,
  version           int not null,
  learner_id        uuid not null references public.profiles (id) on delete restrict,
  cohort_id         uuid references public.cohorts (id) on delete restrict,
  summary           text not null,
  itar_sections     jsonb not null default '[]',
  evidence_snapshot jsonb not null default '{}',
  exam_snapshot     jsonb not null default '{}',
  attempt_id        uuid,
  attempt_rule      text,
  approved_by       uuid references public.profiles (id) on delete set null,
  approved_at       timestamptz not null,
  summary_sha       text not null,
  unique (evaluation_id, version)
);
comment on table public.evaluation_versions is 'Immutable copy of every approved ITAR. Re-opening an ITAR never changes these rows.';

create or replace function public.snapshot_approved_evaluation()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'approved' and (tg_op = 'INSERT' or old.status is distinct from 'approved') then
    insert into public.evaluation_versions (evaluation_id, version, learner_id, cohort_id, summary, itar_sections, evidence_snapshot, exam_snapshot,
                                            attempt_id, attempt_rule, approved_by, approved_at, summary_sha)
    values (new.id, coalesce((select max(version) from public.evaluation_versions where evaluation_id = new.id), 0) + 1,
            new.learner_id, new.cohort_id, new.summary, new.itar_sections, new.evidence_snapshot, new.exam_snapshot,
            new.attempt_id, new.attempt_rule, new.approved_by, coalesce(new.approved_at, now()),
            encode(extensions.digest(new.summary, 'sha256'), 'hex'));
  end if;
  return null;
end $$;
create trigger evaluations_snapshot after insert or update on public.evaluations
  for each row execute function public.snapshot_approved_evaluation();

-- existing approved ITARs become version 1
insert into public.evaluation_versions (evaluation_id, version, learner_id, cohort_id, summary, itar_sections, evidence_snapshot, exam_snapshot,
                                        attempt_id, attempt_rule, approved_by, approved_at, summary_sha)
select e.id, 1, e.learner_id, e.cohort_id, e.summary, e.itar_sections, e.evidence_snapshot, e.exam_snapshot, e.attempt_id, e.attempt_rule,
       e.approved_by, e.approved_at, encode(extensions.digest(e.summary, 'sha256'), 'hex')
  from public.evaluations e
 where e.status = 'approved' and e.approved_at is not null
   and not exists (select 1 from public.evaluation_versions v where v.evaluation_id = e.id);

alter table public.evaluation_versions enable row level security;
create policy evalver_read on public.evaluation_versions for select to authenticated
  using (public.is_staff() and public.can_view_learner(learner_id) and (cohort_id is null or public.can_evaluate(learner_id, cohort_id)));
revoke insert, update, delete, truncate on public.evaluation_versions from authenticated;
revoke all on public.evaluation_versions from anon;

-- ---------------------------------------------------------------------------
-- 2. What changed after a point in time (used against the approval time)
-- ---------------------------------------------------------------------------
create or replace function public._changes_since(p_learner uuid, p_cohort uuid, p_since timestamptz)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(x order by x ->> 'at'), '[]') from (
    select jsonb_build_object('area', 'Exam', 'what',
             case l.action when 'attempt_submitted' then 'New attempt submitted' when 'response_graded' then 'Grade changed' else 'Results released' end,
             'at', l.at) x
      from public.audit_log l
     where l.entity = 'attempts' and l.at > p_since and l.action in ('attempt_submitted', 'response_graded', 'results_released')
       and l.entity_id in (select a.id::text from public._block_attempts(p_learner, p_cohort) a)
    union all
    select jsonb_build_object('area', 'Learning cases', 'what', 'Evidence uploaded: ' || s.original_filename, 'at', s.uploaded_at)
      from public.evidence_submissions s
     where s.learner_id = p_learner and s.cohort_id = p_cohort and s.uploaded_at > p_since
    union all
    select jsonb_build_object('area', 'Learning cases', 'what', 'Evidence ' || replace(s.status::text, '_', ' ') || ': ' || s.original_filename, 'at', s.reviewed_at)
      from public.evidence_submissions s
     where s.learner_id = p_learner and s.cohort_id = p_cohort and s.reviewed_at > p_since
    union all
    select jsonb_build_object('area', 'EPA review', 'what', 'EPA review ' || r.status, 'at', r.updated_at)
      from public.epa_reviews r where r.learner_id = p_learner and r.cohort_id = p_cohort and r.updated_at > p_since
    union all
    select jsonb_build_object('area', 'Scan logbook', 'what', case when bool_or(a.is_correction) then 'Scan counts corrected' else 'Scan counts attested' end, 'at', min(a.created_at))
      from public.scan_attestations a where a.learner_id = p_learner and a.cohort_id = p_cohort and a.created_at > p_since
     group by a.batch_id
    union all
    select jsonb_build_object('area', 'Requirements', 'what', rr.title || ': ' || replace(s.status::text, '_', ' '), 'at', s.updated_at)
      from public.requirement_status s join public.rotation_requirements rr on rr.id = s.requirement_id
     where s.learner_id = p_learner and s.cohort_id = p_cohort and s.updated_at > p_since
    union all
    select jsonb_build_object('area', 'Observations', 'what', 'Observation added', 'at', n.created_at)
      from public.faculty_notes n where n.learner_id = p_learner and n.cohort_id = p_cohort and n.created_at > p_since
  ) q
$$;

create or replace function public._itar_state(p_learner uuid, p_cohort uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
           'status', e.status, 'approved_at', e.approved_at,
           'versions', (select count(*) from public.evaluation_versions v where v.evaluation_id = e.id),
           'changes_since_approval', case when e.status = 'approved' then public._changes_since(p_learner, p_cohort, e.approved_at) else '[]'::jsonb end)
    from public.evaluations e where e.learner_id = p_learner and e.cohort_id = p_cohort
$$;

-- ---------------------------------------------------------------------------
-- 3. Exam requirement uses the ITAR's attempt (faculty selection or latest)
-- ---------------------------------------------------------------------------
-- Only the exam branch changes; the rest of _rotation_status is unchanged.
do $$
declare src text;
begin
  select pg_get_functiondef('public._rotation_status(uuid, uuid, boolean)'::regprocedure) into src;
  src := replace(src,
    'select * into a from public._block_attempts(p_learner, p_cohort) x where x.status = ''submitted'' order by x.submitted_at desc limit 1;',
    'select x.* into a from public._block_attempts(p_learner, p_cohort) x
        left join public.evaluations ev on ev.learner_id = p_learner and ev.cohort_id = p_cohort
                                       and ev.attempt_rule = ''faculty_selected'' and ev.attempt_id = x.id
       where x.status = ''submitted''
       order by (ev.id is not null) desc, x.submitted_at desc limit 1;');
  src := replace(src,
    'detail := ''Score '' || round(a.score_pct, 1) || ''%'' || coalesce('' — rotation pass mark '' || round(v_pass) || ''% met'', '''');',
    'detail := ''Score '' || round(a.score_pct, 1) || ''% (attempt '' || a.attempt_no || '')'' || coalesce('' — rotation pass mark '' || round(v_pass) || ''% met'', '''');');
  src := replace(src,
    'detail := ''Score '' || round(a.score_pct, 1) || ''% — below the rotation pass mark of '' || round(v_pass) || ''%'';',
    'detail := ''Score '' || round(a.score_pct, 1) || ''% (attempt '' || a.attempt_no || '') — below the rotation pass mark of '' || round(v_pass) || ''%'';');
  if src not like '%faculty_selected%' or src not like '%(attempt ''%' then
    raise exception 'validation fix 3 did not apply cleanly';
  end if;
  execute src;
end $$;

-- rotation_status / overview now also report the ITAR state and post-approval changes
create or replace function public.rotation_status(p_learner uuid, p_cohort uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.is_staff() or not public.can_evaluate(p_learner, p_cohort) then
    raise exception 'Resident not found in this block' using errcode = '42501';
  end if;
  perform public._finalize_overdue(p_learner, null);
  return public._rotation_status(p_learner, p_cohort, false) || jsonb_build_object('itar', public._itar_state(p_learner, p_cohort));
end $$;

create or replace function public.rotation_block_overview(p_cohort uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
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
end $$;

-- ---------------------------------------------------------------------------
-- 4. Scan attestation requires an explicit review statement
-- ---------------------------------------------------------------------------
drop function public.attest_scans(uuid, uuid, jsonb, date, text, boolean);
create function public.attest_scans(p_learner uuid, p_cohort uuid, p_entries jsonb, p_reviewed_on date,
                                    p_note text default '', p_correction boolean default false, p_attested boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_batch uuid := gen_random_uuid();
  x jsonb; v_cat uuid; v_delta int; v_views boolean; n int := 0;
  bad text;
begin
  if not public.is_staff() or not public.can_evaluate(p_learner, p_cohort) then
    raise exception 'Resident not found in this block' using errcode = '42501';
  end if;
  if p_learner = auth.uid() then raise exception 'You cannot attest your own scans' using errcode = '42501'; end if;
  if not coalesce(p_attested, false) then
    raise exception 'Confirm that you reviewed these studies before recording them' using errcode = '22023';
  end if;
  if p_reviewed_on is null or p_reviewed_on > current_date then raise exception 'Enter the review date (not in the future)' using errcode = '22023'; end if;
  perform public.assert_no_identifiers(p_note);
  if p_correction and btrim(coalesce(p_note, '')) = '' then raise exception 'Give a reason for the correction' using errcode = '22023'; end if;
  if jsonb_typeof(p_entries) <> 'array' then raise exception 'Invalid entries' using errcode = '22023'; end if;

  for x in select * from jsonb_array_elements(p_entries) loop
    v_cat := (x ->> 'category')::uuid;
    v_delta := coalesce((x ->> 'delta')::int, 0);
    v_views := (x ->> 'views_confirmed')::boolean;
    if v_delta = 0 and v_views is null then continue; end if;
    if not exists (select 1 from public._block_scan_categories(p_cohort) s where s.id = v_cat) then
      raise exception 'Unknown scan category for this block' using errcode = '22023';
    end if;
    if v_delta < 0 and not p_correction then
      raise exception 'Use a correction (with a reason) to reduce a count' using errcode = '22023';
    end if;
    insert into public.scan_attestations (batch_id, learner_id, cohort_id, category_id, delta, views_confirmed, reviewed_on, is_correction, note)
    values (v_batch, p_learner, p_cohort, v_cat, v_delta, v_views, p_reviewed_on, p_correction, left(coalesce(p_note, ''), 300));
    n := n + 1;
  end loop;
  if n = 0 then raise exception 'Nothing to record' using errcode = '22023'; end if;

  select string_agg(s.label, ', ') into bad from public.scan_categories s
   where s.id in (select category_id from public.scan_attestations where batch_id = v_batch)
     and (select sum(delta) from public.scan_attestations a where a.learner_id = p_learner and a.cohort_id = p_cohort and a.category_id = s.id) < 0;
  if bad is not null then raise exception 'A count cannot go below zero (%)', bad using errcode = '22023'; end if;

  perform public.log_event(case when p_correction then 'scans_corrected' else 'scans_attested' end, 'scan_attestations', v_batch::text,
    jsonb_build_object('learner', p_learner, 'cohort', p_cohort, 'reviewed_on', p_reviewed_on, 'entries', p_entries, 'note', p_note,
                       'attestation', 'Studies reviewed by the attesting faculty member in QPath or another approved system'));
  return public._rotation_status(p_learner, p_cohort, false);
end $$;

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke execute on function public.snapshot_approved_evaluation(), public._changes_since(uuid, uuid, timestamptz), public._itar_state(uuid, uuid)
  from public, anon, authenticated;
revoke execute on function public.attest_scans(uuid, uuid, jsonb, date, text, boolean, boolean) from public, anon;
grant execute on function public.attest_scans(uuid, uuid, jsonb, date, text, boolean, boolean) to authenticated;
