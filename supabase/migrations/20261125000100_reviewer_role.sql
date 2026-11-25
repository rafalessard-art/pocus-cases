-- =============================================================================
-- POCUS Portal — reviewer role (demonstration access).
-- Its own migration because a new enum value can't be used in the transaction
-- that adds it. The role grants nothing by itself: see ..._000200_demo_access.
-- =============================================================================
alter type public.app_role add value if not exists 'reviewer';
