-- =============================================================================
-- POCUS Exam Platform — 10 scan totals count each category only up to its target.
-- Extra scans in one category (e.g. 22 gastric for a target of 20) must not make
-- up for a shortfall elsewhere, so "verified_total" is now the credited total
-- (sum of min(verified, target)); "reviewed_total" keeps the raw number.
-- =============================================================================
do $$
declare src text; n int;
begin
  select pg_get_functiondef('public._rotation_status(uuid, uuid, boolean)'::regprocedure) into src;
  n := (length(src) - length(replace(src, 'sum((c ->> ''verified'')::int)', ''))) / length('sum((c ->> ''verified'')::int)');
  if n <> 2 then raise exception 'scan totals patch: expected 2 occurrences, found %', n; end if;
  src := replace(src, 'sum((c ->> ''verified'')::int)', 'sum(least((c ->> ''verified'')::int, (c ->> ''target'')::int))');
  src := replace(src, '''target_total'', coalesce(',
    '''reviewed_total'', coalesce((select sum((c ->> ''verified'')::int) from jsonb_array_elements(scans) c), 0),
      ''target_total'', coalesce(');
  if src not like '%reviewed_total%' then raise exception 'scan totals patch did not apply'; end if;
  execute src;
end $$;
