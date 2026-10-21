-- =============================================================================
-- POCUS Exam Platform — 12 ITER-ready export (University of Ottawa ITER structure).
--
-- The ITAR draft can now be generated as an "ITER-ready summary" whose sections
-- follow the headings of the institutional ITER (CanMEDS roles, overall
-- rotation objectives, narrative fields, basis of assessment, discussion with
-- the trainee). Faculty paste each section into Elentra; nothing is submitted
-- automatically.
--
--  * iter_templates: the export template (headings, Elentra destinations,
--    options). Configurable by admins; DRAFT until the rotation director
--    confirms it matches the current POCUS block form (the seeded template is
--    based on an elective ITER example).
--  * evaluations.iter_fields: faculty selections and narrative for the ITER
--    (overall outcome, basis of assessment, discussed with trainee, overall
--    explanation, recommendations). The portal never assigns ratings or the
--    overall outcome; approved versions copy these fields (immutable).
--  * epa_reviews: optional C6 counts (assessments reviewed in Elentra, count
--    per entrustment level) and faculty-identified findings. They are recorded
--    for the ITER only and never decide the C6 requirement.
--  * faculty_notes: observation categories for the remaining CanMEDS roles so
--    notes can be grouped by role when real observations support them.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. Export template
-- ---------------------------------------------------------------------------
create table public.iter_templates (
  id           uuid primary key default gen_random_uuid(),
  course_id    uuid references public.courses (id) on delete cascade,   -- null = default for all rotations
  name         text not null check (length(name) between 1 and 200),
  definition   jsonb not null check (jsonb_typeof(definition) = 'object'),
  status       text not null default 'draft' check (status in ('draft', 'confirmed')),
  confirmed_by uuid references public.profiles (id) on delete set null,
  confirmed_at timestamptz,
  updated_by   uuid references public.profiles (id) on delete set null,
  updated_at   timestamptz not null default now(),
  created_at   timestamptz not null default now()
);
create unique index iter_templates_one_per_course on public.iter_templates (coalesce(course_id, '00000000-0000-0000-0000-000000000000'::uuid));

create or replace function public.guard_iter_template()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  if jsonb_typeof(new.definition -> 'roles') <> 'array' or jsonb_array_length(new.definition -> 'roles') = 0
     or jsonb_typeof(new.definition -> 'narrative') <> 'object'
     or jsonb_typeof(new.definition -> 'outcome' -> 'options') <> 'array' then
    raise exception 'The ITER template needs roles, narrative headings and outcome options' using errcode = '22023';
  end if;
  -- an edited template needs re-confirmation unless it is being confirmed in the same save
  if tg_op = 'UPDATE' and new.definition <> old.definition and old.status = 'confirmed' and new.status = 'confirmed' then
    new.status := 'draft';
  end if;
  if new.status = 'confirmed' and (tg_op = 'INSERT' or old.status <> 'confirmed') then
    new.confirmed_by := auth.uid(); new.confirmed_at := now();
    perform public.log_event('iter_template_confirmed', 'iter_templates', new.id::text, jsonb_build_object('name', new.name));
  elsif new.status = 'draft' then
    new.confirmed_by := null; new.confirmed_at := null;
  end if;
  return new;
end $$;
create trigger iter_templates_guard before insert or update on public.iter_templates for each row execute function public.guard_iter_template();
create trigger iter_templates_audit after insert or update or delete on public.iter_templates for each row execute function public.audit_trigger();

alter table public.iter_templates enable row level security;
create policy iter_tpl_read on public.iter_templates for select to authenticated using (public.is_staff());
create policy iter_tpl_insert on public.iter_templates for insert to authenticated with check (public.is_admin());
create policy iter_tpl_update on public.iter_templates for update to authenticated using (public.is_admin()) with check (public.is_admin());
revoke delete, truncate on public.iter_templates from authenticated;
revoke all on public.iter_templates from anon;

-- The template that applies to a block: the rotation's own, else the default.
create or replace function public.iter_template_for(p_cohort uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select to_jsonb(t) || jsonb_build_object('confirmed_by_name', (select full_name from public.profiles where id = t.confirmed_by))
    from public.iter_templates t
   where public.is_staff()
     and (t.course_id = (select course_id from public.cohorts where id = p_cohort) or t.course_id is null)
   order by (t.course_id is null) limit 1
$$;
revoke execute on function public.iter_template_for(uuid) from public, anon;
grant execute on function public.iter_template_for(uuid) to authenticated;

insert into public.iter_templates (course_id, name, definition) values (null,
  'University of Ottawa Anesthesiology ITER (based on an elective ITER example)',
  $json${
    "version": 1,
    "form_name": "University of Ottawa Anesthesiology ITER",
    "based_on": "Elective assessment ITER example (October 2026). Confirm that the current POCUS block ITER uses the same headings and options.",
    "rating_scale": ["Not assessed", "Unsatisfactory", "Below expectations", "Meets expectations", "Above expectations", "Outstanding"],
    "evidence": { "heading": "Verified rotation evidence (POCUS portal)",
                  "destination": "Reference for rating. If useful, paste after your own text in “Overall explanation of performance”." },
    "roles": [
      { "key": "medical_expert",  "heading": "Medical Expert",  "categories": ["scanning", "clinical_judgement", "technical"] },
      { "key": "communicator",    "heading": "Communicator",    "categories": ["communication"] },
      { "key": "manager",         "heading": "Manager",         "categories": ["manager"] },
      { "key": "scholar",         "heading": "Scholar",         "categories": ["scholar"] },
      { "key": "collaborator",    "heading": "Collaborator",    "categories": ["collaborator"] },
      { "key": "health_advocate", "heading": "Health Advocate", "categories": ["health_advocate"] },
      { "key": "professional",    "heading": "Professional",    "categories": ["professionalism"] }
    ],
    "role_destination": "Elentra ITER → {heading}: select a rating for each item yourself (the portal assigns none). Use these notes as evidence; paste them into the role's comment box if the form has one.",
    "outcome": { "heading": "Overall rotation objectives",
                 "destination": "Elentra ITER → rotation objectives: select the same option.",
                 "options": ["No, due to other reasons", "No, due to absence", "No, due to unsatisfactory performance", "Yes, Partially", "Yes, Fully"] },
    "narrative": {
      "overall":         { "heading": "Overall explanation of performance",       "required": false },
      "strengths":       { "heading": "Summary of strengths",                      "required": true },
      "areas":           { "heading": "Summary of areas needing improvement",      "required": true },
      "recommendations": { "heading": "Recommendations for ongoing improvement",  "required": false }
    },
    "narrative_destination": "Elentra ITER → “{heading}”: paste.",
    "basis": { "heading": "Basis of assessment",
               "destination": "Elentra ITER → basis of assessment: tick the same boxes.",
               "options": ["Informal observation", "Formal direct observation", "Written examination", "Oral examination", "OSCE", "Other"] },
    "discussed": { "heading": "Performance discussed with the trainee",
                   "destination": "Elentra ITER → select Yes or No." }
  }$json$::jsonb);

-- ---------------------------------------------------------------------------
-- 2. Faculty ITER fields on the draft, copied into every approved version
-- ---------------------------------------------------------------------------
alter table public.evaluations
  add column iter_fields jsonb not null default '{}' check (jsonb_typeof(iter_fields) = 'object' and length(iter_fields::text) <= 40000);
alter table public.evaluation_versions
  add column iter_fields jsonb not null default '{}';

create or replace function public.guard_iter_fields()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  perform public.assert_no_identifiers(coalesce(new.iter_fields ->> 'overall', ''));
  perform public.assert_no_identifiers(coalesce(new.iter_fields ->> 'recommendations', ''));
  if new.iter_fields ? 'outcome' and jsonb_typeof(new.iter_fields -> 'outcome') not in ('string', 'null') then
    raise exception 'Invalid rotation-objectives selection' using errcode = '22023';
  end if;
  if new.iter_fields ? 'basis' and jsonb_typeof(new.iter_fields -> 'basis') <> 'array' then
    raise exception 'Invalid basis of assessment' using errcode = '22023';
  end if;
  return new;
end $$;
create trigger evaluations_iter_guard before insert or update of iter_fields on public.evaluations
  for each row execute function public.guard_iter_fields();

create or replace function public.snapshot_approved_evaluation()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'approved' and (tg_op = 'INSERT' or old.status is distinct from 'approved') then
    insert into public.evaluation_versions (evaluation_id, version, learner_id, cohort_id, summary, itar_sections, evidence_snapshot, exam_snapshot,
                                            attempt_id, attempt_rule, approved_by, approved_at, summary_sha, iter_fields)
    values (new.id, coalesce((select max(version) from public.evaluation_versions where evaluation_id = new.id), 0) + 1,
            new.learner_id, new.cohort_id, new.summary, new.itar_sections, new.evidence_snapshot, new.exam_snapshot,
            new.attempt_id, new.attempt_rule, new.approved_by, coalesce(new.approved_at, now()),
            encode(extensions.digest(new.summary, 'sha256'), 'hex'), new.iter_fields);
  end if;
  return null;
end $$;

create or replace function public.log_itar_export(p_evaluation uuid, p_format text)
returns void language plpgsql security definer set search_path = public as $$
declare e public.evaluations;
begin
  select * into e from public.evaluations where id = p_evaluation;
  if not found or not public.is_staff() or not public.can_view_learner(e.learner_id)
     or (e.cohort_id is not null and not public.can_evaluate(e.learner_id, e.cohort_id)) then
    raise exception 'Evaluation not found' using errcode = '42501';
  end if;
  if p_format not in ('copy_all', 'copy_section', 'text', 'print', 'csv', 'iter_copy_all', 'iter_copy_section', 'iter_text') then
    raise exception 'Unknown export format' using errcode = '22023';
  end if;
  perform public.log_event('itar_exported', 'evaluations', e.id::text,
    jsonb_build_object('format', p_format, 'status', e.status, 'learner', e.learner_id,
                       'summary_sha', encode(extensions.digest(e.summary, 'sha256'), 'hex')));
end $$;

-- ---------------------------------------------------------------------------
-- 3. Optional C6 EPA details (never decide the requirement)
-- ---------------------------------------------------------------------------
alter table public.epa_reviews
  add column assessments_reviewed int check (assessments_reviewed between 0 and 500),
  add column entrustment_counts   jsonb not null default '{}' check (jsonb_typeof(entrustment_counts) = 'object'),
  add column key_findings         text not null default '' check (length(key_findings) <= 2000);

create or replace function public.guard_epa_review()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_criteria text; v_key text; v_val jsonb; v_sum int := 0;
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  new.course_id := (select course_id from public.cohorts where id = new.cohort_id);
  perform public.assert_no_identifiers(new.strengths);
  perform public.assert_no_identifiers(new.areas_for_improvement);
  perform public.assert_no_identifiers(new.concerns);
  perform public.assert_no_identifiers(new.key_findings);
  -- entrustment counts: levels 1–5 (1 = "I had to do", 5 = "I did not need to be there"), whole numbers
  for v_key, v_val in select * from jsonb_each(new.entrustment_counts) loop
    if v_key not in ('1', '2', '3', '4', '5') or jsonb_typeof(v_val) <> 'number' or (v_val #>> '{}')::numeric < 0
       or (v_val #>> '{}')::numeric <> trunc((v_val #>> '{}')::numeric) then
      raise exception 'Entrustment counts must be whole numbers for levels 1 to 5' using errcode = '22023';
    end if;
    v_sum := v_sum + (v_val #>> '{}')::int;
  end loop;
  if v_sum > 0 and new.assessments_reviewed is null then
    raise exception 'Enter how many C6 POCUS assessments you reviewed before the entrustment counts' using errcode = '22023';
  end if;
  if v_sum > coalesce(new.assessments_reviewed, 0) and new.assessments_reviewed is not null then
    raise exception 'The entrustment counts add up to more than the number of assessments reviewed' using errcode = '22023';
  end if;
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
                         'criteria_confirmed', new.criteria_confirmed, 'reviewed_in_elentra', true, 'has_concerns', btrim(new.concerns) <> '',
                         'assessments_reviewed', new.assessments_reviewed));
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

-- verify_epa gains an optional p_details object:
--   { "assessments_reviewed": int|null, "entrustment_counts": {"1".."5": int}, "key_findings": text }
-- When p_details is omitted the stored details are kept.
drop function public.verify_epa(uuid, uuid, boolean, text, boolean, text, text, text, jsonb);
create function public.verify_epa(p_learner uuid, p_cohort uuid, p_reviewed boolean, p_criteria_status text,
                                  p_criteria_confirmed boolean default false, p_strengths text default '',
                                  p_areas text default '', p_concerns text default '', p_entries jsonb default null,
                                  p_details jsonb default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare cur public.epa_reviews; res public.epa_reviews;
begin
  if not public.is_staff() or not public.can_evaluate(p_learner, p_cohort) then
    raise exception 'Resident not found in this block' using errcode = '42501';
  end if;
  if p_learner = auth.uid() then raise exception 'You cannot verify your own EPAs' using errcode = '42501'; end if;
  if p_details is not null and jsonb_typeof(p_details) <> 'object' then
    raise exception 'Invalid EPA details' using errcode = '22023';
  end if;
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
         concerns = left(coalesce(p_concerns, ''), 4000), entries = coalesce(p_entries, entries),
         assessments_reviewed = case when p_details is null then assessments_reviewed
                                     else nullif(p_details ->> 'assessments_reviewed', '')::int end,
         entrustment_counts = case when p_details is null then entrustment_counts
                                   else coalesce(jsonb_strip_nulls(p_details -> 'entrustment_counts'), '{}') end,
         key_findings = case when p_details is null then key_findings else left(coalesce(p_details ->> 'key_findings', ''), 2000) end,
         status = 'complete'
   where id = cur.id
  returning * into res;
  return to_jsonb(res);
end $$;
revoke execute on function public.verify_epa(uuid, uuid, boolean, text, boolean, text, text, text, jsonb, jsonb) from public, anon;
grant execute on function public.verify_epa(uuid, uuid, boolean, text, boolean, text, text, text, jsonb, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 4. Observation categories for every CanMEDS role
-- ---------------------------------------------------------------------------
alter table public.faculty_notes drop constraint faculty_notes_category_check;
alter table public.faculty_notes add constraint faculty_notes_category_check
  check (category in ('general', 'scanning', 'clinical_judgement', 'technical', 'professionalism', 'communication',
                      'manager', 'scholar', 'collaborator', 'health_advocate'));
