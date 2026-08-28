-- ===========================================================================
-- Idempotent batch insert via a SECURITY DEFINER function.
-- Run this AFTER sql/schema.sql. Safe to re-run.
-- Carries image_path through to attendance; that column is defined in
-- sql/schema.sql, so the documented order (schema, then rpc) still holds.
--
-- Why not just `GRANT SELECT ON attendance TO anon`?
-- PostgREST's ignore-duplicates upsert compiles to ON CONFLICT (event_id) DO
-- NOTHING, and Postgres requires SELECT on the table to infer that conflict
-- target. Granting it would mean the public anon key is one accidental
-- permissive policy away from exposing every student's movements. Instead the
-- device loses ALL table privileges and gets exactly one verb: append.
-- ===========================================================================

create or replace function mvts_esp32.record_attendance(events jsonb)
returns integer
language plpgsql
security definer
set search_path = mvts_esp32, pg_temp
as $$
declare
  inserted integer;
begin
  if jsonb_typeof(events) <> 'array' then
    raise exception 'events must be a JSON array';
  end if;
  -- Bound the batch so a stolen anon key cannot post a 100MB array.
  if jsonb_array_length(events) > 200 then
    raise exception 'batch too large (max 200)';
  end if;

  insert into mvts_esp32.attendance (
    event_id, card_uid, device_id, scanned_at, clock_synced, direction, queued,
    image_path
  )
  select
    (e->>'event_id')::uuid,
    e->>'card_uid',
    e->>'device_id',
    (e->>'scanned_at')::timestamptz,
    coalesce((e->>'clock_synced')::boolean, false),
    coalesce(nullif(e->>'direction', ''), 'in'),
    coalesce((e->>'queued')::boolean, false),
    -- Storage path of the gate capture, or null. Null is not an error: the
    -- uploader gives up on the image rather than let it hold back the event.
    nullif(e->>'image_path', '')
  from jsonb_array_elements(events) as e
  where e->>'event_id' is not null
    and e->>'card_uid'  is not null
    and e->>'device_id' is not null
  on conflict (event_id) do nothing;   -- retries are no-ops, never duplicates

  get diagnostics inserted = row_count;
  return inserted;
end;
$$;

-- The device may call this and nothing else.
revoke all on function mvts_esp32.record_attendance(jsonb) from public;
grant execute on function mvts_esp32.record_attendance(jsonb) to anon;

-- Direct table access is no longer needed by the device. Take it away.
revoke insert on mvts_esp32.attendance from anon;
drop policy if exists "device inserts attendance" on mvts_esp32.attendance;
