-- ===========================================================================
-- Test scaffolding ONLY. Supabase provides all of this; a bare Postgres does
-- not, and sql/schema.sql + sql/notify.sql reference it. Never run this
-- against Supabase.
-- ===========================================================================
create role anon;
create role authenticated;
create role service_role;

create schema if not exists storage;
create table if not exists storage.buckets (
  id text primary key, name text, public boolean
);
