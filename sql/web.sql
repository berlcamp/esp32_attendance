-- ===========================================================================
-- Grants for the Smart Campus web app.
-- Run in the Supabase SQL editor after schema.sql / rpc.sql.
--
-- Supabase's default privileges only cover the `public` schema, so the
-- service_role has no access to mvts_esp32 until this runs. The web app reads
-- with service_role server-side; the browser never sees that key.
-- ===========================================================================

grant usage on schema mvts_esp32 to service_role;
grant all on all tables    in schema mvts_esp32 to service_role;
grant all on all sequences in schema mvts_esp32 to service_role;
grant all on all functions in schema mvts_esp32 to service_role;

alter default privileges in schema mvts_esp32
  grant all on tables to service_role;
alter default privileges in schema mvts_esp32
  grant all on sequences to service_role;
