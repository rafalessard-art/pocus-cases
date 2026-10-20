-- Local development seed (run by `supabase db reset`; never applied to production).
-- Invites a local administrator so you can sign in at http://127.0.0.1:5173/app/login.
-- Local sign-in codes appear in the Supabase CLI mail viewer (Inbucket/Mailpit).
insert into public.invitations (email, full_name, role)
values ('admin@localhost.test', 'Local Admin', 'admin')
on conflict (email) do nothing;
