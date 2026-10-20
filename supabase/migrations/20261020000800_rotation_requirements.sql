-- =============================================================================
-- POCUS Exam Platform — 08 rotation requirements and completion tracking.
--
-- One list of mandatory rotation activities per rotation (course), optionally
-- overridden per block (cohort). Statuses are COMPUTED from records that already
-- exist wherever possible, never duplicated:
--   exam           → attempts (rotation pass mark in config, e.g. 75 %)
--   learning_cases → evidence_submissions (Brightspace uploads, faculty-verified)
--   epa            → epa_reviews (faculty-entered from Elentra)
--   scan_log       → scan_attestations (faculty-attested counts per category)
--   attestation    → requirement_status (resident submits, faculty confirms;
--                    optional stages, e.g. rounds: planned → reviewed → presented)
-- Faculty can mark any requirement "not yet due" or "not applicable".
--
-- Privacy: the scan log stores COUNTS per category only — no patient-level rows,
-- images, MRNs, names or dates of birth. Free-text notes are short and pass a
-- server-side identifier screen. Studies are reviewed in QPath (or another
-- approved system); only the attestation that they were reviewed lives here.
-- `source = 'qpath_count_import'` is reserved for an approved future import of
-- per-trainee counts.
--
-- Completion counts are not a competence judgement; nothing here rates anyone.
-- =============================================================================

create type public.req_status as enum
  ('not_started', 'in_progress', 'submitted', 'verified', 'clarification_requested', 'not_yet_due', 'not_applicable');

-- ---------------------------------------------------------------------------
-- Identifier screen for short free-text notes (defence in depth; the UI warns too)
-- ---------------------------------------------------------------------------
create or replace function public.assert_no_identifiers(p_text text)
returns void language plpgsql immutable set search_path = public as $$
begin
  if p_text is null or btrim(p_text) = '' then return; end if;
  if p_text ~ '\d{6,}'                                              -- MRN / health-card-like numbers
     or p_text ~ '\m\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}\M'               -- dates (could be DOB / scan date)
     or p_text ~* '\m(mrn|dob|d\.o\.b|date of birth|health card|ohip|patient name)\M' then
    raise exception 'Notes must not contain patient identifiers (numbers of 6+ digits, dates, MRN/DOB/health-card references). Describe the review without patient details.'
      using errcode = '22023';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Configuration
-- ---------------------------------------------------------------------------
create table public.rotation_requirements (
  id                      uuid primary key default gen_random_uuid(),
  course_id               uuid not null references public.courses (id) on delete cascade,
  cohort_id               uuid references public.cohorts (id) on delete cascade,   -- null ⇒ every block; a block row with the same key overrides
  key                     text not null check (key ~ '^[a-z0-9_]{1,40}$'),
  kind                    text not null check (kind in ('exam', 'learning_cases', 'epa', 'scan_log', 'attestation')),
  title                   text not null check (length(btrim(title)) between 1 and 200),
  description             text not null default '' check (length(description) <= 2000),
  required                boolean not null default true,
  resident_submits        boolean not null default false,   -- attestation: the resident can mark it in progress / submitted
  stages                  jsonb not null default '[]' check (jsonb_typeof(stages) = 'array'),  -- [{key,label,by:'resident'|'faculty'}]
  config                  jsonb not null default '{}' check (jsonb_typeof(config) = 'object'), -- exam: {"pass_pct": 75}
  evidence_requirement_id uuid references public.evidence_requirements (id) on delete set null,  -- optional supporting upload
  external_ref            text check (length(external_ref) <= 500),   -- reserved for an approved future integration
  sort                    int not null default 0,
  archived_at             timestamptz,
  created_at              timestamptz not null default now()
);
create unique index rotation_requirements_key on public.rotation_requirements
  (course_id, coalesce(cohort_id, '00000000-0000-0000-0000-000000000000'::uuid), key) where archived_at is null;
create trigger rotation_requirements_audit after insert or update or delete on public.rotation_requirements
  for each row execute function public.audit_trigger();
comment on table public.rotation_requirements is 'Mandatory rotation activities, per rotation (course) or block. Statuses are computed by _rotation_status().';

create table public.scan_categories (
  id          uuid primary key default gen_random_uuid(),
  course_id   uuid not null references public.courses (id) on delete cascade,
  cohort_id   uuid references public.cohorts (id) on delete cascade,
  key         text not null check (key ~ '^[a-z0-9_]{1,40}$'),
  label       text not null check (length(btrim(label)) between 1 and 100),
  target      int not null check (target between 0 and 1000),
  views_note  text not null default '' check (length(views_note) <= 300),   -- e.g. "PLAX, PSAX, S4C, A4C and IVC"; faculty confirm coverage
  sort        int not null default 0,
  archived_at timestamptz,
  created_at  timestamptz not null default now()
);
create unique index scan_categories_key on public.scan_categories
  (course_id, coalesce(cohort_id, '00000000-0000-0000-0000-000000000000'::uuid), key) where archived_at is null;
create trigger scan_categories_audit after insert or update or delete on public.scan_categories
  for each row execute function public.audit_trigger();

-- ---------------------------------------------------------------------------
-- Records
-- ---------------------------------------------------------------------------
create table public.requirement_status (
  id              uuid primary key default gen_random_uuid(),
  requirement_id  uuid not null references public.rotation_requirements (id) on delete restrict,
  learner_id      uuid not null references public.profiles (id) on delete restrict,
  cohort_id       uuid not null references public.cohorts (id) on delete restrict,
  status          public.req_status not null default 'not_started',
  stage           text check (length(stage) <= 40),
  resident_note   text not null default '' check (length(resident_note) <= 500),
  faculty_message text not null default '' check (length(faculty_message) <= 500),   -- shown to the resident
  updated_by      uuid references public.profiles (id) on delete set null,
  updated_at      timestamptz not null default now(),
  verified_by     uuid references public.profiles (id) on delete set null,
  verified_at     timestamptz,
  unique (requirement_id, learner_id, cohort_id)
);
create trigger requirement_status_audit after insert or update or delete on public.requirement_status
  for each row execute function public.audit_trigger();

-- Append-only: corrections are new rows with a negative delta and a reason.
create table public.scan_attestations (
  id              uuid primary key default gen_random_uuid(),
  batch_id        uuid not null,
  learner_id      uuid not null references public.profiles (id) on delete restrict,
  cohort_id       uuid not null references public.cohorts (id) on delete restrict,
  category_id     uuid not null references public.scan_categories (id) on delete restrict,
  delta           int not null check (delta between -500 and 500),
  views_confirmed boolean,
  reviewed_on     date not null,
  source          text not null default 'faculty_attestation' check (source in ('faculty_attestation', 'qpath_count_import')),
  is_correction   boolean not null default false,
  note            text not null default '' check (length(note) <= 300),
  attested_by     uuid not null references public.profiles (id) on delete restrict default auth.uid(),
  created_at      timestamptz not null default now(),
  check (delta <> 0 or views_confirmed is not null)
);
create index on public.scan_attestations (learner_id, cohort_id);

-- What the resident says they have done (never counts toward completion).
create table public.scan_self_reports (
  learner_id  uuid not null references public.profiles (id) on delete cascade,
  cohort_id   uuid not null references public.cohorts (id) on delete cascade,
  category_id uuid not null references public.scan_categories (id) on delete cascade,
  count       int not null check (count between 0 and 2000),
  updated_at  timestamptz not null default now(),
  primary key (learner_id, cohort_id, category_id)
);

-- ---------------------------------------------------------------------------
-- Applicable configuration for a block (block rows override rotation rows by key)
-- ---------------------------------------------------------------------------
create or replace function public._block_requirements(p_cohort uuid)
returns setof public.rotation_requirements language sql stable security definer set search_path = public as $$
  select x.* from (
    select distinct on (r.key) r.* from public.rotation_requirements r join public.cohorts c on c.id = p_cohort
     where r.course_id = c.course_id and (r.cohort_id is null or r.cohort_id = p_cohort) and r.archived_at is null
     order by r.key, r.cohort_id nulls last) x
  order by x.sort, x.title
$$;

create or replace function public._block_scan_categories(p_cohort uuid)
returns setof public.scan_categories language sql stable security definer set search_path = public as $$
  select x.* from (
    select distinct on (s.key) s.* from public.scan_categories s join public.cohorts c on c.id = p_cohort
     where s.course_id = c.course_id and (s.cohort_id is null or s.cohort_id = p_cohort) and s.archived_at is null
     order by s.key, s.cohort_id nulls last) x
  order by x.sort, x.label
$$;

-- ---------------------------------------------------------------------------
-- Status computation (internal). p_learner_view hides faculty-only detail and
-- unreleased exam scores.
-- ---------------------------------------------------------------------------
create or replace function public._rotation_status(p_learner uuid, p_cohort uuid, p_learner_view boolean)
returns jsonb language plpgsql stable security definer set search_path = public as $$
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
      select * into a from public._block_attempts(p_learner, p_cohort) x where x.status = 'submitted' order by x.submitted_at desc limit 1;
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
        detail := 'Score ' || round(a.score_pct, 1) || '%' || coalesce(' — rotation pass mark ' || round(v_pass) || '% met', '');
        extra := jsonb_build_object('score_pct', a.score_pct, 'pass_pct', v_pass, 'met', true, 'attempt_no', a.attempt_no, 'auto', true);
      else
        st := 'in_progress'; act := 'resident';
        detail := 'Score ' || round(a.score_pct, 1) || '% — below the rotation pass mark of ' || round(v_pass) || '%';
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
      select * into e from public.epa_reviews x where x.learner_id = p_learner and x.cohort_id = p_cohort;
      if e.id is not null and e.status = 'complete' then
        st := 'verified'; vby := e.completed_by; vat := e.completed_at; detail := 'EPA review complete';
      elsif e.id is not null then st := 'in_progress'; act := 'faculty'; detail := 'EPA review started';
      else st := 'not_started'; act := 'faculty'; detail := 'EPA review not yet recorded';
      end if;

    elsif r.kind = 'scan_log' then
      select bool_and((c ->> 'met')::boolean), bool_or(coalesce((c ->> 'reported')::int, 0) > (c ->> 'verified')::int),
             bool_or((c ->> 'verified')::int > 0 or coalesce((c ->> 'reported')::int, 0) > 0)
        into v_all_met, v_pending, v_any from jsonb_array_elements(scans) c;
      select x.attested_by, x.created_at into v_last from public.scan_attestations x
       where x.learner_id = p_learner and x.cohort_id = p_cohort order by x.created_at desc limit 1;
      detail := coalesce((select sum((c ->> 'verified')::int) from jsonb_array_elements(scans) c), 0) || '/'
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
      'status', st, 'action', act, 'detail', case when p_learner_view and r.kind = 'epa' then '' else detail end,
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
      'verified_total', coalesce((select sum((c ->> 'verified')::int) from jsonb_array_elements(scans) c), 0),
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
end $$;

-- ---------------------------------------------------------------------------
-- Read RPCs
-- ---------------------------------------------------------------------------
create or replace function public.rotation_status(p_learner uuid, p_cohort uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not public.is_staff() or not public.can_evaluate(p_learner, p_cohort) then
    raise exception 'Resident not found in this block' using errcode = '42501';
  end if;
  perform public._finalize_overdue(p_learner, null);
  return public._rotation_status(p_learner, p_cohort, false);
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
                                                                 'status', q ->> 'status', 'action', q ->> 'action', 'detail', q ->> 'detail'))
                              from jsonb_array_elements(s -> 'requirements') q),
           'scans', jsonb_build_object('verified_total', s -> 'scans' -> 'verified_total', 'target_total', s -> 'scans' -> 'target_total'))), '[]')
    into res
    from public.cohort_members m
    join public.profiles p on p.id = m.user_id
    cross join lateral (select public._rotation_status(m.user_id, p_cohort, false) s) z
   where m.cohort_id = p_cohort and m.member_role = 'learner' and p.active;
  return res;
end $$;

create or replace function public.my_requirements()
returns jsonb language plpgsql security definer set search_path = public as $$
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
end $$;

-- ---------------------------------------------------------------------------
-- Write RPCs
-- ---------------------------------------------------------------------------
create or replace function public.set_requirement_status(p_requirement uuid, p_learner uuid, p_cohort uuid, p_status text,
                                                         p_stage text default null, p_note text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r     public.rotation_requirements;
  cur   public.requirement_status;
  staff boolean; self boolean;
  v_stage_by text;
begin
  select * into r from public._block_requirements(p_cohort) x where x.id = p_requirement;
  if not found then raise exception 'This requirement does not apply to this block' using errcode = 'P0002'; end if;
  staff := public.is_staff() and public.can_evaluate(p_learner, p_cohort) and p_learner <> auth.uid();
  self := p_learner = auth.uid() and exists (select 1 from public.cohort_members m
                                              where m.cohort_id = p_cohort and m.user_id = auth.uid() and m.member_role = 'learner');
  if not staff and not self then raise exception 'Not allowed' using errcode = '42501'; end if;
  perform public.assert_no_identifiers(p_note);
  select * into cur from public.requirement_status s where s.requirement_id = r.id and s.learner_id = p_learner and s.cohort_id = p_cohort for update;

  if p_stage is not null then
    select s ->> 'by' into v_stage_by from jsonb_array_elements(r.stages) s where s ->> 'key' = p_stage;
    if v_stage_by is null then raise exception 'Unknown stage' using errcode = '22023'; end if;
    if not staff and v_stage_by <> 'resident' then raise exception 'Only faculty can record this stage' using errcode = '42501'; end if;
  end if;

  if not staff then
    if r.kind <> 'attestation' or not r.resident_submits then
      raise exception 'This requirement is recorded by faculty' using errcode = '42501';
    end if;
    if p_status not in ('in_progress', 'submitted') then raise exception 'Residents can mark a requirement in progress or submitted' using errcode = '42501'; end if;
    if cur.status in ('verified', 'not_applicable') then raise exception 'Already confirmed by faculty' using errcode = '42501'; end if;
  else
    if p_status = 'clear' then
      if cur.id is not null then
        delete from public.requirement_status where id = cur.id;
        perform public.log_event('requirement_cleared', 'rotation_requirements', r.id::text, jsonb_build_object('learner', p_learner, 'cohort', p_cohort));
      end if;
      return public._rotation_status(p_learner, p_cohort, false);
    end if;
    if r.kind <> 'attestation' and p_status not in ('not_yet_due', 'not_applicable') then
      raise exception 'This status is calculated automatically; you can only mark it not yet due or not applicable' using errcode = '22023';
    end if;
    if p_status = 'clarification_requested' and btrim(coalesce(p_note, '')) = '' then
      raise exception 'Add a message telling the resident what is needed' using errcode = '22023';
    end if;
  end if;
  if p_status not in ('not_started', 'in_progress', 'submitted', 'verified', 'clarification_requested', 'not_yet_due', 'not_applicable') then
    raise exception 'Unknown status' using errcode = '22023';
  end if;

  insert into public.requirement_status as s (requirement_id, learner_id, cohort_id, status, stage, resident_note, faculty_message, updated_by, updated_at, verified_by, verified_at)
  values (r.id, p_learner, p_cohort, p_status::public.req_status, p_stage,
          case when self then left(coalesce(p_note, ''), 500) else '' end,
          case when staff then left(coalesce(p_note, ''), 500) else '' end,
          auth.uid(), now(),
          case when p_status in ('verified', 'not_applicable', 'not_yet_due') and staff then auth.uid() end,
          case when p_status in ('verified', 'not_applicable', 'not_yet_due') and staff then now() end)
  on conflict (requirement_id, learner_id, cohort_id) do update set
    status = excluded.status,
    stage = coalesce(excluded.stage, s.stage),
    resident_note = case when self and p_note is not null then excluded.resident_note else s.resident_note end,
    faculty_message = case when staff and p_note is not null then excluded.faculty_message
                           when self then s.faculty_message else s.faculty_message end,
    updated_by = auth.uid(), updated_at = now(),
    verified_by = excluded.verified_by, verified_at = excluded.verified_at;

  perform public.log_event('requirement_' || p_status, 'rotation_requirements', r.id::text,
    jsonb_build_object('learner', p_learner, 'cohort', p_cohort, 'stage', p_stage, 'by', case when staff then 'faculty' else 'resident' end));
  return public._rotation_status(p_learner, p_cohort, not staff);
end $$;

-- Faculty: record reviewed-and-accepted scans for several categories at once.
-- p_entries: [{"category": uuid, "delta": int, "views_confirmed": bool|null}]
create or replace function public.attest_scans(p_learner uuid, p_cohort uuid, p_entries jsonb, p_reviewed_on date,
                                               p_note text default '', p_correction boolean default false)
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
    jsonb_build_object('learner', p_learner, 'cohort', p_cohort, 'reviewed_on', p_reviewed_on, 'entries', p_entries, 'note', p_note));
  return public._rotation_status(p_learner, p_cohort, false);
end $$;

-- Resident: how many scans I have done that await faculty review (not counted).
create or replace function public.report_scans(p_cohort uuid, p_counts jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare x jsonb;
begin
  if not exists (select 1 from public.cohort_members m where m.cohort_id = p_cohort and m.user_id = auth.uid() and m.member_role = 'learner') then
    raise exception 'You are not a resident in this rotation block' using errcode = '42501';
  end if;
  for x in select * from jsonb_array_elements(p_counts) loop
    if not exists (select 1 from public._block_scan_categories(p_cohort) s where s.id = (x ->> 'category')::uuid) then
      raise exception 'Unknown scan category' using errcode = '22023';
    end if;
    insert into public.scan_self_reports (learner_id, cohort_id, category_id, count, updated_at)
    values (auth.uid(), p_cohort, (x ->> 'category')::uuid, greatest(0, least(2000, (x ->> 'count')::int)), now())
    on conflict (learner_id, cohort_id, category_id) do update set count = excluded.count, updated_at = now();
  end loop;
  perform public.log_event('scans_self_reported', 'scan_self_reports', p_cohort::text, jsonb_build_object('learner', auth.uid(), 'counts', p_counts));
  return public._rotation_status(auth.uid(), p_cohort, true);
end $$;

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.rotation_requirements enable row level security;
alter table public.scan_categories       enable row level security;
alter table public.requirement_status    enable row level security;
alter table public.scan_attestations     enable row level security;
alter table public.scan_self_reports     enable row level security;

create policy rotreq_read on public.rotation_requirements for select to authenticated using (public.is_member());
create policy rotreq_write on public.rotation_requirements for all to authenticated using (public.is_admin()) with check (public.is_admin());
create policy scancat_read on public.scan_categories for select to authenticated using (public.is_member());
create policy scancat_write on public.scan_categories for all to authenticated using (public.is_admin()) with check (public.is_admin());

create policy reqstat_read on public.requirement_status for select to authenticated
  using (learner_id = auth.uid() or (public.is_staff() and public.can_evaluate(learner_id, cohort_id)));
create policy scanatt_read on public.scan_attestations for select to authenticated
  using (public.is_staff() and public.can_evaluate(learner_id, cohort_id));
create policy scanself_read on public.scan_self_reports for select to authenticated
  using (learner_id = auth.uid() or (public.is_staff() and public.can_evaluate(learner_id, cohort_id)));
-- all writes go through the functions above
revoke insert, update, delete, truncate on public.requirement_status, public.scan_attestations, public.scan_self_reports from authenticated;
revoke all on public.rotation_requirements, public.scan_categories, public.requirement_status, public.scan_attestations, public.scan_self_reports from anon;

-- ---------------------------------------------------------------------------
-- POCUS rotation: official requirements and minimum reviewed-scan targets
-- ---------------------------------------------------------------------------
insert into public.evidence_requirements (course_id, kind, source, title, description, required, sort)
select co.id, 'module', 'other', 'TeachingMedicine online skills modules — completion record (optional)',
       'Optional. If your program asks for it, upload the TeachingMedicine completion page or certificate. Faculty confirmation is sufficient when program policy allows.',
       false, 900
  from public.courses co where co.slug = 'pocus'
   and not exists (select 1 from public.evidence_requirements r where r.course_id = co.id and r.title like 'TeachingMedicine%');

insert into public.rotation_requirements (course_id, key, kind, title, description, required, resident_submits, stages, config, evidence_requirement_id, sort)
select co.id, v.key, v.kind, v.title, v.description, true, v.resident_submits, v.stages::jsonb, v.config::jsonb,
       case when v.key = 'teachingmedicine' then (select id from public.evidence_requirements r where r.course_id = co.id and r.title like 'TeachingMedicine%' limit 1) end,
       v.sort
  from public.courses co
  cross join (values
    ('c6_epas', 'epa', 'C6 POCUS EPAs', 'Completion of the C6 POCUS EPAs, reviewed by faculty in the EPA review (Elentra) section.', false, '[]', '{}', 10),
    ('brightspace_cases', 'learning_cases', 'Brightspace learning cases', 'All required Brightspace learning cases, verified from the resident''s uploaded completion evidence.', false, '[]', '{}', 20),
    ('teachingmedicine', 'attestation', 'TeachingMedicine online skills modules', 'The resident marks the modules complete; faculty confirm. Evidence upload is optional.', true, '[]', '{}', 30),
    ('scan_logbook', 'scan_log', 'Logbook of reviewed POCUS scans', 'Minimum numbers of scans with archived images, reviewed and accepted by anesthesiology staff (102 in total). Counts are attested by faculty after review in QPath or another approved system.', false, '[]', '{}', 40),
    ('qpath_portfolio', 'attestation', 'QPath mentor review and ultrasound portfolio', 'Scans reviewed with POCUS mentors in QPath and a small ultrasound portfolio created. Faculty attest that the portfolio was reviewed.', true, '[]', '{}', 50),
    ('written_exam', 'exam', 'Written POCUS examination', 'End-of-block written examination; minimum passing score 75%.', false, '[]', '{"pass_pct": 75}', 60),
    ('pocus_rounds', 'attestation', 'POCUS rounds presentation', 'Presentation reviewed by faculty before it is given, during the applicable educational period. May be marked "not yet due".', true,
     '[{"key":"planned","label":"Planned (topic and date set)","by":"resident"},{"key":"faculty_reviewed","label":"Reviewed by faculty before presenting","by":"faculty"},{"key":"presented","label":"Presented","by":"faculty"}]', '{}', 70)
  ) as v(key, kind, title, description, resident_submits, stages, config, sort)
 where co.slug = 'pocus'
   and not exists (select 1 from public.rotation_requirements r where r.course_id = co.id and r.cohort_id is null and r.key = v.key and r.archived_at is null);

insert into public.scan_categories (course_id, key, label, target, views_note, sort)
select co.id, v.key, v.label, v.target, v.views_note, v.sort
  from public.courses co
  cross join (values
    ('airway', 'Airway', 5, 'Both views', 10),
    ('cardiac', 'Cardiac', 40, 'Required PLAX, PSAX, S4C, A4C and IVC views per program rules', 20),
    ('lung_pleura', 'Lung and pleura', 15, 'At least two points on each hemithorax', 30),
    ('abdominal_fast', 'Abdominal / FAST', 20, 'RUQ, LUQ, pelvis and subcostal views', 40),
    ('gastric', 'Gastric', 20, '', 50),
    ('dvt', 'DVT', 2, '', 60)
  ) as v(key, label, target, views_note, sort)
 where co.slug = 'pocus'
   and not exists (select 1 from public.scan_categories s where s.course_id = co.id and s.cohort_id is null and s.key = v.key and s.archived_at is null);

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------
revoke execute on function
  public._block_requirements(uuid), public._block_scan_categories(uuid), public._rotation_status(uuid, uuid, boolean)
from public, anon, authenticated;
revoke execute on function
  public.rotation_status(uuid, uuid), public.rotation_block_overview(uuid), public.my_requirements(),
  public.set_requirement_status(uuid, uuid, uuid, text, text, text), public.attest_scans(uuid, uuid, jsonb, date, text, boolean),
  public.report_scans(uuid, jsonb), public.assert_no_identifiers(text)
from public, anon;
grant execute on function
  public.rotation_status(uuid, uuid), public.rotation_block_overview(uuid), public.my_requirements(),
  public.set_requirement_status(uuid, uuid, uuid, text, text, text), public.attest_scans(uuid, uuid, jsonb, date, text, boolean),
  public.report_scans(uuid, jsonb), public.assert_no_identifiers(text)
to authenticated;
