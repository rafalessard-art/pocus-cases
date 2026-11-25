-- =============================================================================
-- Local-only bootstrap: the Supabase roles, schemas and functions the portal's
-- migrations and database tests rely on, for a plain PostgreSQL 16 server
-- (CI, or a machine without Docker). Not used by hosted Supabase, which
-- provides all of this itself.
--
--   psql "$DATABASE_URL" -f scripts/local-stack/bootstrap.sql
--   for f in supabase/migrations/*.sql; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"; done
--   psql "$DATABASE_URL" -f supabase/seed.sql
--
-- Mirrors Supabase defaults that matter for authorization:
--   * roles anon / authenticated / service_role, switched to by PostgREST via
--     SET ROLE plus request.jwt.claims (tests/db/helpers.ts does the same);
--   * default table privileges for those roles on public (RLS is the gate);
--   * auth.uid() / auth.jwt() / auth.role() reading request.jwt.claims;
--   * minimal auth.users / auth.sessions / auth.mfa_factors and
--     storage.buckets / storage.objects tables with RLS on storage.objects;
--   * pgcrypto in the extensions schema.
-- =============================================================================

do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then create role authenticator login noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then create role supabase_auth_admin login noinherit createrole; end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_storage_admin') then create role supabase_storage_admin login noinherit; end if;
end $$;
grant anon, authenticated, service_role to authenticator;

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;
grant usage on schema extensions to anon, authenticated, service_role;

-- public: Supabase's default privileges (RLS decides)
grant usage on schema public to anon, authenticated, service_role;
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- auth
-- ---------------------------------------------------------------------------
create schema if not exists auth authorization supabase_auth_admin;
grant usage on schema auth to anon, authenticated, service_role;

create table if not exists auth.users (
  instance_id        uuid,
  id                 uuid primary key,
  aud                text,
  role               text,
  email              text,
  encrypted_password text,
  email_confirmed_at timestamptz,
  raw_app_meta_data  jsonb default '{}'::jsonb,
  raw_user_meta_data jsonb default '{}'::jsonb,
  is_anonymous       boolean not null default false,
  banned_until       timestamptz,
  created_at         timestamptz default now(),
  updated_at         timestamptz default now()
);
create table if not exists auth.sessions (
  id         uuid primary key,
  user_id    uuid not null references auth.users (id) on delete cascade,
  aal        text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create table if not exists auth.mfa_factors (
  id          uuid primary key,
  user_id     uuid not null references auth.users (id) on delete cascade,
  factor_type text not null default 'totp',
  status      text not null default 'unverified',
  created_at  timestamptz default now(),
  updated_at  timestamptz default now()
);
alter table auth.users owner to supabase_auth_admin;
alter table auth.sessions owner to supabase_auth_admin;
alter table auth.mfa_factors owner to supabase_auth_admin;

create or replace function auth.jwt() returns jsonb language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim', true), ''),
                  nullif(current_setting('request.jwt.claims', true), ''))::jsonb
$$;
create or replace function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$$;
create or replace function auth.role() returns text language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.role', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'))::text
$$;
grant execute on function auth.jwt(), auth.uid(), auth.role() to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- storage (just the tables the policies and functions reference)
-- ---------------------------------------------------------------------------
create schema if not exists storage authorization supabase_storage_admin;
grant usage on schema storage to anon, authenticated, service_role;
create table if not exists storage.buckets (
  id                 text primary key,
  name               text not null,
  owner              uuid,
  public             boolean default false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  created_at         timestamptz default now(),
  updated_at         timestamptz default now()
);
create table if not exists storage.objects (
  id         uuid primary key default gen_random_uuid(),
  bucket_id  text references storage.buckets (id),
  name       text,
  owner      uuid,
  metadata   jsonb,
  created_at timestamptz default now(),
  updated_at timestamptz default now(),
  unique (bucket_id, name)
);
alter table storage.objects enable row level security;
grant all on storage.buckets, storage.objects to anon, authenticated, service_role;

-- Supabase Storage refuses direct SQL deletes unless the Storage API set this flag.
create or replace function storage.protect_delete() returns trigger language plpgsql as $$
begin
  if coalesce(current_setting('storage.allow_delete_query', true), '') <> 'true' then
    raise exception 'Direct deletion from storage tables is not allowed. Use the Storage API instead.' using errcode = '42501';
  end if;
  return old;
end $$;
drop trigger if exists protect_objects_delete on storage.objects;
create trigger protect_objects_delete before delete on storage.objects for each row execute function storage.protect_delete();
