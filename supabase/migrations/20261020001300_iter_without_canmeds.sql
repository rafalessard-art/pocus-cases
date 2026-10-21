-- =============================================================================
-- POCUS Exam Platform — 13 ITER-ready summary without CanMEDS role sections.
--
-- The CanMEDS role sections added in migration 12 are removed from the export
-- template: in the Elentra form they are tick boxes faculty complete directly,
-- and per-role notes added work without adding useful information. Faculty
-- observations remain available as one reference section.
--
-- Approved versions are untouched (an approved ITER that contained role
-- sections keeps them exactly as approved).
-- =============================================================================

create or replace function public.guard_iter_template()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  new.updated_at := now();
  new.updated_by := auth.uid();
  if jsonb_typeof(new.definition -> 'narrative') is distinct from 'object'
     or jsonb_typeof(new.definition -> 'outcome' -> 'options') is distinct from 'array'
     or jsonb_array_length(new.definition -> 'outcome' -> 'options') = 0 then
    raise exception 'The ITER template needs narrative headings and outcome options' using errcode = '22023';
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

update public.iter_templates
   set definition = definition - 'roles' - 'role_destination' - 'rating_scale'
 where definition ?| array['roles', 'role_destination', 'rating_scale'];

-- observation categories back to the original set (the four role-only categories had no other use)
update public.faculty_notes set category = 'general' where category in ('manager', 'scholar', 'collaborator', 'health_advocate');
alter table public.faculty_notes drop constraint faculty_notes_category_check;
alter table public.faculty_notes add constraint faculty_notes_category_check
  check (category in ('general', 'scanning', 'clinical_judgement', 'technical', 'professionalism', 'communication'));
