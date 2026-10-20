-- =============================================================================
-- POCUS Exam Platform — 04 assessment: faculty notes, end-of-block evaluation
-- workspace, learner report.
--
-- Principle: the system summarises verified exam data and faculty-entered
-- observations only. It never generates clinical, procedural, scanning-skill
-- or professionalism judgements. Every evaluation is a draft until a faculty
-- member explicitly approves it.
-- =============================================================================

create table public.faculty_notes (
  id         uuid primary key default gen_random_uuid(),
  course_id  uuid not null references public.courses (id) on delete cascade,
  learner_id uuid not null references public.profiles (id) on delete cascade,
  author_id  uuid references public.profiles (id) on delete set null default auth.uid(),
  body       text not null check (length(body) between 1 and 10000),
  created_at timestamptz not null default now()
);
create index on public.faculty_notes (learner_id);

create table public.evaluations (
  id                    uuid primary key default gen_random_uuid(),
  course_id             uuid not null references public.courses (id) on delete restrict,
  learner_id            uuid not null references public.profiles (id) on delete restrict,
  cohort_id             uuid references public.cohorts (id) on delete set null,
  evaluator_id          uuid references public.profiles (id) on delete set null default auth.uid(),
  rotation_start        date,
  rotation_end          date,
  attempt_id            uuid references public.attempts (id) on delete set null,
  exam_snapshot         jsonb not null default '{}',   -- verified data captured when the draft was generated
  strengths             text not null default '',      -- faculty-entered
  areas_for_improvement text not null default '',      -- faculty-entered
  observations          text not null default '',      -- faculty-entered (clinical/scanning observations belong here, typed by faculty)
  summary               text not null default '',      -- editable draft text
  status                text not null default 'draft' check (status in ('draft', 'approved')),
  approved_by           uuid references public.profiles (id) on delete set null,
  approved_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);
create index on public.evaluations (learner_id);

create or replace function public.guard_evaluation()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  if tg_op = 'INSERT' and auth.uid() is not null then
    new.evaluator_id := auth.uid();
  elsif tg_op = 'UPDATE' then
    new.evaluator_id := old.evaluator_id;
  end if;
  if tg_op = 'UPDATE' and old.status = 'approved' then
    if new.status = 'approved' then
      raise exception 'Approved evaluations are locked. Re-open the evaluation to edit it.' using errcode = '42501';
    end if;
    -- re-opening: only content-neutral transition allowed in the same statement
    if (to_jsonb(new) - 'status' - 'approved_by' - 'approved_at' - 'updated_at')
       <> (to_jsonb(old) - 'status' - 'approved_by' - 'approved_at' - 'updated_at') then
      raise exception 'Re-open the evaluation before editing it' using errcode = '42501';
    end if;
    new.approved_by := null; new.approved_at := null;
    perform public.log_event('evaluation_reopened', 'evaluations', new.id::text, '{}');
  elsif new.status = 'approved' and (tg_op = 'INSERT' or old.status = 'draft') then
    if btrim(new.summary) = '' then
      raise exception 'Cannot approve an empty evaluation summary' using errcode = '22023';
    end if;
    new.approved_by := auth.uid(); new.approved_at := now();
    perform public.log_event('evaluation_approved', 'evaluations', new.id::text,
      jsonb_build_object('learner', new.learner_id, 'summary_sha', encode(extensions.digest(new.summary, 'sha256'), 'hex')));
  end if;
  return new;
end $$;
create trigger evaluations_guard before insert or update on public.evaluations for each row execute function public.guard_evaluation();
create trigger evaluations_no_delete before delete on public.evaluations for each row
  when (old.status = 'approved') execute function public.guard_attempt_delete();

alter table public.faculty_notes enable row level security;
alter table public.evaluations   enable row level security;

create policy notes_read on public.faculty_notes for select to authenticated
  using (public.is_staff() and public.can_view_learner(learner_id));
create policy notes_insert on public.faculty_notes for insert to authenticated
  with check (public.is_staff() and public.can_view_learner(learner_id) and author_id = auth.uid());
create policy notes_delete on public.faculty_notes for delete to authenticated
  using (author_id = auth.uid() or public.is_admin());

create policy evals_read on public.evaluations for select to authenticated
  using (public.is_staff() and public.can_view_learner(learner_id));
create policy evals_insert on public.evaluations for insert to authenticated
  with check (public.is_staff() and public.can_view_learner(learner_id));
create policy evals_update on public.evaluations for update to authenticated
  using (public.is_staff() and public.can_view_learner(learner_id))
  with check (public.is_staff() and public.can_view_learner(learner_id));
create policy evals_delete on public.evaluations for delete to authenticated
  using (public.is_staff() and public.can_view_learner(learner_id) and status = 'draft');

-- Learner report used by the faculty dashboard and the evaluation workspace.
create or replace function public.learner_report(p_learner uuid, p_course uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
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
end $$;

-- Learner-facing curriculum view (own progress only).
create or replace function public.my_curriculum(p_course_slug text)
returns jsonb language plpgsql security definer set search_path = public as $$
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
end $$;

revoke all on all tables in schema public from anon;
