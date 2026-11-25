-- Local development seed (run by `supabase db reset`; never applied to production).
-- Invites a local administrator so you can sign in at http://127.0.0.1:5173/app/login.
-- Local sign-in codes appear in the Supabase CLI mail viewer (Inbucket/Mailpit).
insert into public.invitations (email, full_name, role)
values ('admin@localhost.test', 'Local Admin', 'admin')
on conflict (email) do nothing;

-- Local development: demonstration access on, owner MFA not yet required.
-- Hosted databases get their row from the owner (SQL editor), never from the API:
--   development demo → ('development', <false until the reviewer release>, false)
--   review project   → ('review', true, true once owner MFA is tested)
--   production       → ('production', false, true)   -- demo access can't be enabled there
insert into public.deployment_settings (environment, demo_access_enabled, admin_mfa_required)
values ('development', true, false)
on conflict (id) do nothing;
