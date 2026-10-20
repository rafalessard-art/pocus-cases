-- =============================================================================
-- POCUS Exam Platform — 11 streamlined EPA verification.
--
-- Faculty no longer re-type EPA identifiers, ratings and comments from Elentra.
-- They (1) attest that they reviewed the resident's EPA assessments in Elentra,
-- (2) state whether the program-defined C6 POCUS EPA criteria are met,
-- partially met or outstanding, and (3) optionally note strengths, areas for
-- improvement and concerns. Reviewer and date are recorded automatically.
-- "Met" satisfies the rotation requirement only when the criteria shown were
-- explicitly confirmed; the criteria text is configurable (draft until the
-- rotation director approves it). Detailed EPA rows remain optional.
-- Existing reviews, audit history and approved ITAR versions are untouched;
-- reviews completed under the old form show "please re-verify".
-- =============================================================================

alter table public.epa_reviews
  add column reviewed_in_elentra boolean not null default false,
  add column criteria_status     text check (criteria_status in ('met', 'partially_met', 'outstanding')),
  add column criteria_confirmed  boolean not null default false,
  add column criteria_snapshot   text not null default '' check (length(criteria_snapshot) <= 4000),
  add column concerns            text not null default '' check (length(concerns) <= 4000);

-- Completion criteria for the C6 EPA requirement (configurable; draft until approved)
update public.rotation_requirements
   set config = config || jsonb_build_object(
         'criteria', 'DRAFT — pending rotation director approval: the C6 POCUS EPAs required by the program have been assessed and documented in Elentra at the program-defined entrustment level.',
         'criteria_status', 'draft')
 where kind = 'epa' and not (config ? 'criteria');

create or replace function public.guard_epa_review()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_criteria text;
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  new.course_id := (select course_id from public.cohorts where id = new.cohort_id);
  perform public.assert_no_identifiers(new.strengths);
  perform public.assert_no_identifiers(new.areas_for_improvement);
  perform public.assert_no_identifiers(new.concerns);
  if tg_op = 'UPDATE' then
    new.created_by := old.created_by;
    if old.status = 'complete' and new.status = 'complete'
       and (to_jsonb(new) - 'updated_at' - 'updated_by') <> (to_jsonb(old) - 'updated_at' - 'updated_by') then
      raise exception 'Re-open the EPA review before editing it' using errcode = '42501';
    end if;
  end if;
  if new.status = 'complete' and (tg_op = 'INSERT' or old.status <> 'complete') then
    if not new.reviewed_in_elentra then
      raise exception 'Confirm that you reviewed the resident''s EPA assessments in Elentra' using errcode = '22023';
    end if;
    if new.criteria_status is null then
      raise exception 'Indicate whether the C6 EPA criteria are met, partially met or outstanding' using errcode = '22023';
    end if;
    select r.config ->> 'criteria' into v_criteria from public._block_requirements(new.cohort_id) r where r.kind = 'epa' limit 1;
    if new.criteria_status = 'met' then
      if btrim(coalesce(v_criteria, '')) = '' then
        raise exception 'The C6 EPA completion criteria are not configured (Admin → ITAR setup)' using errcode = '22023';
      end if;
      if not new.criteria_confirmed then
        raise exception 'Confirm that the program-defined criteria are met' using errcode = '22023';
      end if;
    else
      new.criteria_confirmed := false;
    end if;
    new.criteria_snapshot := coalesce(v_criteria, '');
    new.review_date := current_date;
    new.completed_by := auth.uid();
    new.completed_at := now();
    perform public.log_event('epa_review_completed', 'epa_reviews', new.id::text,
      jsonb_build_object('learner', new.learner_id, 'cohort', new.cohort_id, 'criteria_status', new.criteria_status,
                         'criteria_confirmed', new.criteria_confirmed, 'reviewed_in_elentra', true, 'has_concerns', btrim(new.concerns) <> ''));
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

-- One call: record (or update) the faculty verification. An existing completed
-- review is re-opened first, so the previous version stays in the audit log.
create or replace function public.verify_epa(p_learner uuid, p_cohort uuid, p_reviewed boolean, p_criteria_status text,
                                             p_criteria_confirmed boolean default false, p_strengths text default '',
                                             p_areas text default '', p_concerns text default '', p_entries jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare cur public.epa_reviews; res public.epa_reviews;
begin
  if not public.is_staff() or not public.can_evaluate(p_learner, p_cohort) then
    raise exception 'Resident not found in this block' using errcode = '42501';
  end if;
  if p_learner = auth.uid() then raise exception 'You cannot verify your own EPAs' using errcode = '42501'; end if;
  select * into cur from public.epa_reviews where learner_id = p_learner and cohort_id = p_cohort for update;
  if cur.id is not null and cur.status = 'complete' then
    update public.epa_reviews set status = 'pending' where id = cur.id;
  end if;
  if cur.id is null then
    insert into public.epa_reviews (course_id, learner_id, cohort_id, status)
    select c.course_id, p_learner, p_cohort, 'pending' from public.cohorts c where c.id = p_cohort
    returning * into cur;
  end if;
  update public.epa_reviews
     set reviewed_in_elentra = coalesce(p_reviewed, false), criteria_status = p_criteria_status,
         criteria_confirmed = coalesce(p_criteria_confirmed, false),
         strengths = left(coalesce(p_strengths, ''), 10000), areas_for_improvement = left(coalesce(p_areas, ''), 10000),
         concerns = left(coalesce(p_concerns, ''), 4000), entries = coalesce(p_entries, entries), status = 'complete'
   where id = cur.id
  returning * into res;
  return to_jsonb(res);
end $$;

revoke execute on function public.verify_epa(uuid, uuid, boolean, text, boolean, text, text, text, jsonb) from public, anon;
grant execute on function public.verify_epa(uuid, uuid, boolean, text, boolean, text, text, text, jsonb) to authenticated;

-- Requirement status: the EPA branch now reflects the verification (complete definition).
create or replace function public._rotation_status(p_learner uuid, p_cohort uuid, p_learner_view boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  r        public.rotation_requirements;
  ov       public.requirement_status;
  a        public.attempts;
  out      jsonb := '[]';
  st       text; act text; detail text; vby uuid; vat timestamptz; extra jsonb;
  v_pass   numeric; v_inprog boolean;
  n_tot int; n_ver int; n_sub int; n_ret int; n_started int;
  e        public.epa_reviews;
  scans    jsonb; v_all_met boolean; v_pending boolean; v_any boolean;
  v_last   record;
begin
  -- scan categories (shared by the scan_log requirement and the returned summary)
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', s.id, 'key', s.key, 'label', s.label, 'target', s.target, 'views_note', s.views_note,
           'verified', coalesce(v.total, 0), 'reported', sr.count,
           'views_confirmed', vc.views_confirmed,
           'met', coalesce(v.total, 0) >= s.target and (btrim(s.views_note) = '' or coalesce(vc.views_confirmed, false)))
         order by s.sort, s.label), '[]')
    into scans
    from public._block_scan_categories(p_cohort) s
    left join lateral (select sum(x.delta)::int total from public.scan_attestations x
                        where x.learner_id = p_learner and x.cohort_id = p_cohort and x.category_id = s.id) v on true
    left join lateral (select x.views_confirmed from public.scan_attestations x
                        where x.learner_id = p_learner and x.cohort_id = p_cohort and x.category_id = s.id and x.views_confirmed is not null
                        order by x.created_at desc limit 1) vc on true
    left join public.scan_self_reports sr on sr.learner_id = p_learner and sr.cohort_id = p_cohort and sr.category_id = s.id;

  for r in select * from public._block_requirements(p_cohort) loop
    select * into ov from public.requirement_status s where s.requirement_id = r.id and s.learner_id = p_learner and s.cohort_id = p_cohort;
    st := 'not_started'; act := null; detail := ''; vby := null; vat := null; extra := '{}';

    if r.kind = 'exam' then
      select x.* into a from public._block_attempts(p_learner, p_cohort) x
        left join public.evaluations ev on ev.learner_id = p_learner and ev.cohort_id = p_cohort
                                       and ev.attempt_rule = 'faculty_selected' and ev.attempt_id = x.id
       where x.status = 'submitted'
       order by (ev.id is not null) desc, x.submitted_at desc limit 1;
      v_inprog := exists (select 1 from public._block_attempts(p_learner, p_cohort) x where x.status = 'in_progress');
      v_pass := coalesce((r.config ->> 'pass_pct')::numeric,
                         (select ev.pass_threshold_pct from public.exam_versions ev where ev.id = a.exam_version_id));
      if a.id is null then
        st := case when v_inprog then 'in_progress' else 'not_started' end; act := 'resident';
        detail := case when v_inprog then 'Examination in progress' else 'Examination not yet taken' end;
      elsif a.grading_status <> 'complete' or a.score_pct is null then
        st := 'submitted'; act := 'faculty'; detail := 'Submitted — grading in progress';
      elsif p_learner_view and a.released_at is null then
        st := 'submitted'; detail := 'Submitted — results not yet released';
      elsif v_pass is null or a.score_pct >= v_pass then
        st := 'verified'; vat := a.submitted_at;
        detail := 'Score ' || round(a.score_pct, 1) || '% (attempt ' || a.attempt_no || ')' || coalesce(' — rotation pass mark ' || round(v_pass) || '% met', '');
        extra := jsonb_build_object('score_pct', a.score_pct, 'pass_pct', v_pass, 'met', true, 'attempt_no', a.attempt_no, 'auto', true);
      else
        st := 'in_progress'; act := 'resident';
        detail := 'Score ' || round(a.score_pct, 1) || '% (attempt ' || a.attempt_no || ') — below the rotation pass mark of ' || round(v_pass) || '%';
        extra := jsonb_build_object('score_pct', a.score_pct, 'pass_pct', v_pass, 'met', false, 'attempt_no', a.attempt_no);
      end if;
      if not (p_learner_view and a.id is not null and a.released_at is null) then
        extra := extra || jsonb_build_object('pass_pct', v_pass);
      end if;

    elsif r.kind = 'learning_cases' then
      with req as (
        select er.id from public.evidence_requirements er join public.cohorts c on c.id = p_cohort
         where er.course_id = c.course_id and (er.cohort_id is null or er.cohort_id = p_cohort)
           and er.archived_at is null and er.required and er.kind = 'learning_case'),
      latest as (
        select distinct on (s.requirement_id) s.requirement_id, s.status, s.reviewed_by, s.reviewed_at
          from public.evidence_submissions s
         where s.learner_id = p_learner and s.cohort_id = p_cohort and s.upload_status = 'uploaded' and s.requirement_id in (select id from req)
         order by s.requirement_id, s.created_at desc)
      select (select count(*) from req), count(*) filter (where status = 'verified'), count(*) filter (where status = 'submitted'),
             count(*) filter (where status in ('clarification_requested', 'rejected')), count(*)
        into n_tot, n_ver, n_sub, n_ret, n_started from latest;
      select l.reviewed_by, l.reviewed_at into vby, vat from public.evidence_submissions l
       where l.learner_id = p_learner and l.cohort_id = p_cohort and l.status = 'verified' order by l.reviewed_at desc nulls last limit 1;
      detail := n_ver || '/' || n_tot || ' verified';
      extra := jsonb_build_object('total', n_tot, 'verified', n_ver, 'awaiting', n_sub, 'returned', n_ret, 'missing', n_tot - n_started);
      if n_tot = 0 then st := 'not_applicable'; detail := 'No learning cases configured';
      elsif n_ver = n_tot then st := 'verified';
      elsif n_ret > 0 then st := 'clarification_requested'; act := 'resident';
      elsif n_sub > 0 then st := 'submitted'; act := 'faculty';
      elsif n_started > 0 then st := 'in_progress'; act := 'resident';
      else st := 'not_started'; act := 'resident';
      end if;
      if st <> 'verified' then vby := null; vat := null; end if;

    elsif r.kind = 'epa' then
      -- Faculty verification of the resident's Elentra EPA assessments. Only "met", with the
      -- program-defined criteria explicitly confirmed, satisfies the requirement.
      select * into e from public.epa_reviews x where x.learner_id = p_learner and x.cohort_id = p_cohort;
      if e.id is null then
        st := 'not_started'; act := 'faculty'; detail := 'Not yet reviewed';
      elsif e.status <> 'complete' then
        st := 'in_progress'; act := 'faculty'; detail := 'Review started, not yet saved';
      elsif e.criteria_status is null then
        st := 'in_progress'; act := 'faculty'; detail := 'Recorded before criteria verification — please re-verify';
      else
        detail := 'Reviewed in Elentra by ' || coalesce((select coalesce(nullif(p.full_name, ''), p.email) from public.profiles p where p.id = e.completed_by), 'faculty')
               || ' on ' || to_char(e.completed_at at time zone 'America/Toronto', 'Mon DD, YYYY') || ' — criteria '
               || case e.criteria_status when 'met' then 'met' when 'partially_met' then 'partially met' else 'outstanding' end;
        if e.criteria_status = 'met' and e.criteria_confirmed then
          st := 'verified'; vby := e.completed_by; vat := e.completed_at;
        else
          st := 'in_progress'; act := 'resident';
        end if;
        extra := jsonb_build_object('criteria_status', e.criteria_status, 'reviewed_at', e.completed_at,
                                    'criteria_draft', coalesce(r.config ->> 'criteria_status', 'draft') <> 'approved')
              || case when p_learner_view then '{}'::jsonb else jsonb_build_object('has_concerns', btrim(e.concerns) <> '') end;
      end if;

    elsif r.kind = 'scan_log' then
      select bool_and((c ->> 'met')::boolean), bool_or(coalesce((c ->> 'reported')::int, 0) > (c ->> 'verified')::int),
             bool_or((c ->> 'verified')::int > 0 or coalesce((c ->> 'reported')::int, 0) > 0)
        into v_all_met, v_pending, v_any from jsonb_array_elements(scans) c;
      select x.attested_by, x.created_at into v_last from public.scan_attestations x
       where x.learner_id = p_learner and x.cohort_id = p_cohort order by x.created_at desc limit 1;
      detail := coalesce((select sum(least((c ->> 'verified')::int, (c ->> 'target')::int)) from jsonb_array_elements(scans) c), 0) || '/'
             || coalesce((select sum((c ->> 'target')::int) from jsonb_array_elements(scans) c), 0) || ' faculty-verified scans';
      if jsonb_array_length(scans) = 0 then st := 'not_applicable'; detail := 'No scan targets configured';
      elsif v_all_met then st := 'verified'; vby := v_last.attested_by; vat := v_last.created_at;
      elsif v_pending then st := 'submitted'; act := 'faculty'; vby := v_last.attested_by; vat := v_last.created_at;
      elsif v_any then st := 'in_progress'; act := 'resident';
      else st := 'not_started'; act := 'resident';
      end if;
      if st <> 'verified' then extra := jsonb_build_object('last_attested_by', v_last.attested_by, 'last_attested_at', v_last.created_at); end if;

    else  -- attestation
      st := coalesce(ov.status::text, 'not_started');
      vby := ov.verified_by; vat := ov.verified_at;
      act := case
               when st = 'submitted' then 'faculty'
               when st in ('not_started', 'in_progress', 'clarification_requested') then case when r.resident_submits then 'resident' else 'faculty' end
             end;
      detail := coalesce((select s ->> 'label' from jsonb_array_elements(r.stages) s where s ->> 'key' = ov.stage), '');
      if r.evidence_requirement_id is not null then
        extra := jsonb_build_object('evidence', (
          select jsonb_build_object('status', s.status, 'filename', s.original_filename, 'uploaded_at', s.created_at)
            from public.evidence_submissions s
           where s.requirement_id = r.evidence_requirement_id and s.learner_id = p_learner and s.cohort_id = p_cohort and s.upload_status = 'uploaded'
           order by s.created_at desc limit 1));
      end if;
    end if;

    -- faculty overrides for computed requirements
    if r.kind <> 'attestation' and ov.status in ('not_yet_due', 'not_applicable') then
      st := ov.status::text; act := null; vby := ov.verified_by; vat := ov.verified_at;
    end if;
    if st in ('verified', 'not_applicable', 'not_yet_due') then act := null; end if;

    out := out || jsonb_build_object(
      'id', r.id, 'key', r.key, 'kind', r.kind, 'title', r.title, 'description', r.description, 'required', r.required,
      'resident_submits', r.resident_submits, 'stages', r.stages, 'evidence_requirement_id', r.evidence_requirement_id,
      'status', st, 'action', act, 'detail', detail,
      'stage', ov.stage, 'resident_note', coalesce(ov.resident_note, ''), 'faculty_message', coalesce(ov.faculty_message, ''),
      'verified_by_name', case when r.kind = 'exam' and st = 'verified' and ov.status is null then 'the portal (automatic scoring)'
                               else (select coalesce(nullif(p.full_name, ''), p.email) from public.profiles p where p.id = vby) end,
      'verified_at', vat, 'updated_at', ov.updated_at, 'override', r.kind <> 'attestation' and ov.status is not null,
      'extra', extra);
  end loop;

  return jsonb_build_object(
    'requirements', out,
    'scans', jsonb_build_object(
      'categories', scans,
      'verified_total', coalesce((select sum(least((c ->> 'verified')::int, (c ->> 'target')::int)) from jsonb_array_elements(scans) c), 0),
      'reviewed_total', coalesce((select sum((c ->> 'verified')::int) from jsonb_array_elements(scans) c), 0),
      'target_total', coalesce((select sum((c ->> 'target')::int) from jsonb_array_elements(scans) c), 0),
      'reported_total', (select sum((c ->> 'reported')::int) from jsonb_array_elements(scans) c),
      'history', coalesce((
        select jsonb_agg(h order by h ->> 'created_at' desc) from (
          select jsonb_build_object(
                   'batch_id', x.batch_id, 'created_at', min(x.created_at), 'reviewed_on', min(x.reviewed_on), 'is_correction', bool_or(x.is_correction),
                   'source', min(x.source),
                   'by', (select coalesce(nullif(p.full_name, ''), p.email) from public.profiles p where p.id = min(x.attested_by::text)::uuid),
                   'note', case when p_learner_view then '' else min(x.note) end,
                   'entries', jsonb_agg(jsonb_build_object('category', (select label from public.scan_categories where id = x.category_id),
                                                           'delta', x.delta, 'views_confirmed', x.views_confirmed))) h
            from public.scan_attestations x
           where x.learner_id = p_learner and x.cohort_id = p_cohort
           group by x.batch_id) q), '[]')));
end $function$;
