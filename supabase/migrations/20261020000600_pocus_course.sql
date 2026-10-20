-- =============================================================================
-- POCUS Exam Platform — 06 POCUS rotation course scaffold.
--
-- Domains and curriculum links are structural. The learning objectives below
-- are a DRAFT scaffold so that question tagging and domain reporting work out
-- of the box; replace them with the program's approved objectives (Admin →
-- Curriculum) before relying on objective-level reporting.
-- =============================================================================

insert into public.courses (slug, title, description) values
  ('pocus', 'POCUS Rotation', 'Perioperative point-of-care ultrasound subspecialty rotation for anesthesiology residents.')
on conflict (slug) do nothing;

with c as (select id from public.courses where slug = 'pocus')
insert into public.domains (course_id, key, label, sort)
select c.id, d.key, d.label, d.sort from c, (values
  ('cardiac',   'Cardiac / echocardiography', 10),
  ('lung',      'Lung and pleural ultrasound', 20),
  ('gastric',   'Gastric ultrasound', 30),
  ('vascular',  'Vascular ultrasound and access', 40),
  ('diaphragm', 'Diaphragm ultrasound', 50),
  ('airway',    'Airway ultrasound', 60),
  ('ocular',    'Ocular / optic nerve sheath', 70),
  ('fundamentals', 'Physics, knobology and image optimisation', 5),
  ('other',     'Other POCUS applications', 90)
) as d(key, label, sort)
on conflict (course_id, key) do nothing;

with c as (select id from public.courses where slug = 'pocus')
insert into public.learning_objectives (course_id, domain_key, code, title, sort)
select c.id, o.domain_key, o.code, o.title, o.sort from c, (values
  ('fundamentals', 'FUND-1', '[Draft] Select transducer, preset and depth/gain settings appropriate to the clinical question', 1),
  ('fundamentals', 'FUND-2', '[Draft] Recognise common artefacts and their effect on interpretation', 2),
  ('cardiac',      'CARD-1', '[Draft] Identify standard focused cardiac views (PLAX, PSAX, A4C, subcostal, IVC)', 10),
  ('cardiac',      'CARD-2', '[Draft] Qualitatively assess LV function, RV size/function and pericardial effusion', 11),
  ('lung',         'LUNG-1', '[Draft] Recognise lung sliding, A-lines, B-lines, consolidation and pleural effusion', 20),
  ('lung',         'LUNG-2', '[Draft] Apply lung ultrasound to perioperative hypoxaemia and pneumothorax', 21),
  ('gastric',      'GAST-1', '[Draft] Perform and grade gastric antral ultrasound (Perlas grade, CSA volume)', 30),
  ('vascular',     'VASC-1', '[Draft] Distinguish arteries from veins and plan ultrasound-guided vascular access', 40),
  ('vascular',     'VASC-2', '[Draft] Screen for proximal lower-limb DVT using compression ultrasound', 41),
  ('diaphragm',    'DIAP-1', '[Draft] Measure diaphragmatic excursion and thickening fraction', 50),
  ('airway',       'AIRW-1', '[Draft] Identify the cricothyroid membrane and relevant airway anatomy', 60),
  ('ocular',       'OCUL-1', '[Draft] Measure optic nerve sheath diameter and interpret its limitations', 70)
) as o(domain_key, code, title, sort)
on conflict (course_id, code) do nothing;

with c as (select id from public.courses where slug = 'pocus')
insert into public.curriculum_items (course_id, section, kind, title, description, url, required, sort, objective_codes)
select c.id, i.section, i.kind, i.title, i.description, i.url, i.required, i.sort, i.objectives from c, (values
  ('Teaching cases', 'case', 'Gastric Ultrasound & the Patient on a GLP-1 Receptor Agonist', 'Two-part simulated case with answer key.', '/cases/glp1-gastric', true, 10, array['GAST-1']),
  ('Teaching cases', 'case', 'Diaphragm POCUS & First Rib Resection', 'Phrenic nerve injury, excursion and thickening fraction.', '/cases/diaphragm-first-rib', true, 20, array['DIAP-1']),
  ('Teaching cases', 'case', 'Optic Nerve Sheath Diameter & PDPH', 'ONSD technique and interpretation.', '/cases/onsd-pdph', true, 30, array['OCUL-1']),
  ('Teaching cases', 'case', 'Systematic Peripheral Vascular Access', 'Difficult-access patient; vessel selection and technique.', '/cases/vascular-access', true, 40, array['VASC-1']),
  ('Interactive tools', 'tool', 'Interactive 3D Heart & Live Echo', 'Explore standard TTE windows on a 3D heart.', '/Echocardiography_3D_Sono.html', false, 50, array['CARD-1']),
  ('Interactive tools', 'tool', '3D Arm & Live Ultrasound', 'Upper-limb vascular anatomy with live ultrasound.', '/VascularAccess_3D_Sono.html', false, 60, array['VASC-1']),
  ('Interactive tools', 'tool', 'EchoSimulator', 'Parametric pathology echo loops across standard views.', '/echo-simulator/', false, 70, array['CARD-2'])
) as i(section, kind, title, description, url, required, sort, objectives)
where not exists (select 1 from public.curriculum_items ci where ci.course_id = c.id and ci.url = i.url);
