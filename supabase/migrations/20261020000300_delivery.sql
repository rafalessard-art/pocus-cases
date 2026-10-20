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
