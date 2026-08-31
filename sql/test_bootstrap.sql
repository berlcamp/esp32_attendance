-- ===========================================================================
-- Test scaffolding ONLY. Supabase provides all of this; a bare Postgres does
-- not, and the pta migrations reference it. Never run this against Supabase.
--
-- Used by sql/test_notify.sql, which loads the real pta migrations from the
-- pta-collections repo rather than a hand-copied fixture -- so the tests fail
-- if that schema drifts, which is the entire point of running them.
-- ===========================================================================
create role anon;
create role authenticated;
-- On Supabase, service_role carries BYPASSRLS. The gate dashboard reads with
-- it, so the tests must model that or they would prove the wrong thing: a
-- plain role here would be stopped by forced RLS and every grant would look
-- sufficient whether it was or not.
create role service_role bypassrls;

-- auth: pta.profiles has an FK to auth.users, and the RLS helpers call
-- auth.uid(). Nothing here authenticates anybody; it just has to exist.
create schema if not exists auth;
create table if not exists auth.users (
  id    uuid primary key default gen_random_uuid(),
  email text
);

create or replace function auth.uid() returns uuid
language sql stable as $$ select null::uuid $$;

-- storage: the gate migration registers its capture bucket, and pta's 0011
-- puts bucket-scoped policies on storage.objects.
create schema if not exists storage;
create table if not exists storage.buckets (
  id text primary key, name text, public boolean
);
create table if not exists storage.objects (
  id        uuid primary key default gen_random_uuid(),
  bucket_id text references storage.buckets(id),
  name      text,
  owner     uuid
);
alter table storage.objects enable row level security;

create or replace function storage.foldername(name text)
returns text[]
language sql
immutable
as $$ select string_to_array(name, '/') $$;
