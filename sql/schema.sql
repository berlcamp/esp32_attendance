-- ===========================================================================
-- MVTS ESP32 Attendance — schema, grants, RLS
-- Run this in the Supabase SQL editor (Dashboard -> SQL Editor -> New query).
--
-- AFTER running it, do the one thing SQL cannot do for you:
--   Dashboard -> Settings -> API -> "Exposed schemas" -> add  mvts_esp32
-- Without that, every POST from the device returns 404 (PGRST106).
-- ===========================================================================

create schema if not exists mvts_esp32;
grant usage on schema mvts_esp32 to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- students
-- ---------------------------------------------------------------------------
create table if not exists mvts_esp32.students (
  id          uuid primary key default gen_random_uuid(),
  full_name   text not null,
  student_no  text unique,
  created_at  timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- student_cards
-- A card UID is NOT a column on students, because cards get lost and reissued.
-- Keeping issue/revoke history means a scan resolves to whoever held that card
-- AT THAT MOMENT, so reissuing a card never silently rewrites past attendance.
-- ---------------------------------------------------------------------------
create table if not exists mvts_esp32.student_cards (
  id          uuid primary key default gen_random_uuid(),
  student_id  uuid not null references mvts_esp32.students(id) on delete cascade,
  card_uid    text not null,
  issued_at   timestamptz not null default now(),
  revoked_at  timestamptz
);

create index if not exists student_cards_uid_idx
  on mvts_esp32.student_cards (card_uid);

-- At most one *active* holder per physical card.
create unique index if not exists student_cards_active_uid_idx
  on mvts_esp32.student_cards (card_uid)
  where revoked_at is null;

-- ---------------------------------------------------------------------------
-- attendance
-- One row = "a card passed the gate". NOT "a student was present" — with a
-- single reader that is a rule your app applies, not something measured here.
-- ---------------------------------------------------------------------------
create table if not exists mvts_esp32.attendance (
  event_id     uuid primary key,              -- device-generated idempotency key
  card_uid     text not null,
  device_id    text not null,
  scanned_at   timestamptz not null,          -- the DEVICE's claim
  received_at  timestamptz not null default now(),  -- when the server saw it
  clock_synced boolean not null default false, -- false = timestamp is inferred
  direction    text not null default 'in',     -- reserved; one reader = 'in'
  queued       boolean not null default false, -- true = arrived after an outage
  -- Storage path of the gate capture. Nullable forever: the uploader gives up
  -- on the image rather than let a failed upload hold back the attendance row.
  image_path   text
);

-- For databases created before the camera existed.
alter table mvts_esp32.attendance
  add column if not exists image_path text;

create index if not exists attendance_card_time_idx
  on mvts_esp32.attendance (card_uid, scanned_at desc);
create index if not exists attendance_scanned_at_idx
  on mvts_esp32.attendance (scanned_at desc);

-- ---------------------------------------------------------------------------
-- RLS — the device holds the ANON key, so it must be able to do exactly one
-- thing: insert attendance. No select, no update, no delete, and no access at
-- all to students or student_cards.
-- ---------------------------------------------------------------------------
alter table mvts_esp32.attendance     enable row level security;
alter table mvts_esp32.students       enable row level security;
alter table mvts_esp32.student_cards  enable row level security;

revoke all on mvts_esp32.attendance    from anon;
revoke all on mvts_esp32.students      from anon;
revoke all on mvts_esp32.student_cards from anon;

-- NOTE: the device does NOT get table privileges. It calls the SECURITY
-- DEFINER function in sql/rpc.sql instead, so the public anon key can append
-- attendance and do nothing else. Run sql/rpc.sql after this file.

-- Your Next.js app should read with the service_role key from a server
-- component / route handler, or with an authenticated staff role. Grant here:
grant select on mvts_esp32.attendance, mvts_esp32.students,
                mvts_esp32.student_cards to authenticated;

drop policy if exists "staff read attendance" on mvts_esp32.attendance;
create policy "staff read attendance"
  on mvts_esp32.attendance for select to authenticated using (true);

drop policy if exists "staff read students" on mvts_esp32.students;
create policy "staff read students"
  on mvts_esp32.students for select to authenticated using (true);

drop policy if exists "staff read cards" on mvts_esp32.student_cards;
create policy "staff read cards"
  on mvts_esp32.student_cards for select to authenticated using (true);

-- ---------------------------------------------------------------------------
-- Convenience view for the web app: resolves each scan to the student who
-- held that card at scan time. Unknown cards come back with null student.
-- ---------------------------------------------------------------------------
create or replace view mvts_esp32.attendance_resolved
with (security_invoker = on) as
select
  a.event_id,
  a.card_uid,
  a.device_id,
  a.scanned_at,
  a.received_at,
  a.clock_synced,
  a.direction,
  a.queued,
  s.id        as student_id,
  s.full_name,
  s.student_no
from mvts_esp32.attendance a
left join mvts_esp32.student_cards c
       on c.card_uid = a.card_uid
      and a.scanned_at >= c.issued_at
      and (c.revoked_at is null or a.scanned_at < c.revoked_at)
left join mvts_esp32.students s
       on s.id = c.student_id;

grant select on mvts_esp32.attendance_resolved to authenticated;
