-- ===========================================================================
-- The trigger that calls notify-guardian on every new scan.
--
-- This is what the dashboard's "Database Webhooks" UI generates for you. Doing
-- it in SQL instead means it is version-controlled, reviewable, and does not
-- depend on where Supabase last moved that page in Studio.
--
-- It lives here rather than in 0013_gate_attendance.sql because it carries a
-- secret, and migrations are committed.
--
-- BEFORE RUNNING: replace PASTE_WEBHOOK_SECRET_HERE below with the value of
-- WEBHOOK_SECRET from .env.notify (NOT TELEGRAM_WEBHOOK_SECRET — there are two
-- similarly named secrets and they are not interchangeable):
--
--     grep '^WEBHOOK_SECRET='.env.notify
--
-- Then paste the whole file into the Supabase SQL editor. Safe to re-run.
-- ===========================================================================

-- pg_net gives Postgres an async HTTP client. Async matters: the request is
-- queued and the INSERT returns immediately, so a slow or down Telegram can
-- never block a student walking through the gate.
create extension if not exists pg_net;

create or replace function pta.on_attendance_insert()
returns trigger
language plpgsql
security definer
set search_path = pta, net, public, pg_temp
as $$
begin
  perform net.http_post(
    url     := 'https://lvcbmopdstvupjpytjbb.supabase.co/functions/v1/notify-guardian',
    -- Same envelope the dashboard's webhook sends, so the function does not
    -- care which of the two created it.
    body    := jsonb_build_object(
                 'type',   'INSERT',
                 'schema', 'pta',
                 'table',  'attendance',
                 'record', to_jsonb(new)),
    headers := jsonb_build_object(
                 'Content-Type',     'application/json',
                 'x-webhook-secret', 'PASTE_WEBHOOK_SECRET_HERE')
  );
  return new;
end;
$$;

drop trigger if exists gate_notify on pta.attendance;

create trigger gate_notify
  after insert on pta.attendance
  for each row
  execute function pta.on_attendance_insert();

-- The old trigger, if the pre-cutover schema is still around. Leaving it in
-- place would double-message every parent for as long as both schemas exist.
do $$
begin
  if to_regclass('mvts_esp32.attendance') is not null then
    drop trigger if exists gate_notify on mvts_esp32.attendance;
    raise notice 'Old mvts_esp32 notify trigger removed.';
  end if;
end;
$$;
