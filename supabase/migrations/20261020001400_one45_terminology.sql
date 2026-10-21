-- =============================================================================
-- POCUS Exam Platform — 14 One45 terminology (data only, no schema change).
--
-- The final ITER is completed and submitted in One45; C6 POCUS EPAs are
-- completed and reviewed in Elentra. The ITER export template's destination
-- texts said "Elentra ITER"; they now say "One45 ITER". Only the editable
-- template changes: approved draft versions, evidence and audit history are
-- untouched (an approved draft keeps the wording it was approved with).
-- =============================================================================

update public.iter_templates
   set definition = replace(definition::text, 'Elentra ITER', 'One45 ITER')::jsonb
 where definition::text like '%Elentra ITER%';

update public.iter_templates
   set definition = jsonb_set(definition, '{based_on}',
         to_jsonb('Elective assessment ITER example from One45 (October 2026). Confirm that the current POCUS block ITER in One45 uses the same headings and options.'::text))
 where definition ->> 'based_on' = 'Elective assessment ITER example (October 2026). Confirm that the current POCUS block ITER uses the same headings and options.';
