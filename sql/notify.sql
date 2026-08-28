-- ===========================================================================
-- MVTS ESP32 Attendance — guardian notifications (Telegram)
-- Run AFTER sql/schema.sql and sql/rpc.sql. Safe to re-run.
--
-- The device is not involved in any of this. It appends attendance and, once
-- the camera lands, a capture path. Everything below runs server-side, because
-- a Telegram bot token in readable flash would let anyone with a USB cable
-- message every parent as the school -- and there is no RLS equivalent that
-- would contain that.
--
-- Nothing here is granted to anon. The gate device gains no new privileges.
-- ===========================================================================

-- ---------------------------------------------------------------------------
-- Defensive: attendance.image_path is defined in sql/schema.sql, but this file
-- must not depend on you having re-run that one first.
-- ---------------------------------------------------------------------------
alter table mvts_esp32.attendance
  add column if not exists image_path text;

-- Private bucket. The notifier mints a short-lived signed URL per message;
-- Telegram fetches it once and re-hosts its own copy.
insert into storage.buckets (id, name, public)
values ('gate-captures', 'gate-captures', false)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- notify_config
-- One row. The staleness rule lives HERE and nowhere else, so the Edge
-- Function stays dumb: it sends what it is told to send.
--
-- Why a staleness rule at all: the device is designed to survive a three-hour
-- outage and then flush. Without this, 200 events land at 4pm and 200 parents
-- are told their child "has arrived" for a 7am arrival. Every one of those
-- messages costs credibility, and nobody is helped by them.
-- ---------------------------------------------------------------------------
create table if not exists mvts_esp32.notify_config (
  id                     boolean primary key default true check (id),
  enabled                boolean not null default true,
  -- delay <= fresh_within_s          -> send normally
  -- fresh_within_s < delay <= suppress_after_s -> send, worded as delayed
  -- delay > suppress_after_s         -> record as suppressed, send nothing
  fresh_within_s         integer not null default 900,    -- 15 min
  suppress_after_s       integer not null default 7200,   -- 2 h
  capture_retention_days integer not null default 30,
  updated_at             timestamptz not null default now()
);

insert into mvts_esp32.notify_config (id) values (true)
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- guardians
-- telegram_chat_id is null until the guardian redeems an enrolment token. A
-- Telegram bot cannot start a conversation, so this column can only ever be
-- filled in by the guardian making first contact. See redeem_enroll_token().
-- ---------------------------------------------------------------------------
create table if not exists mvts_esp32.guardians (
  id               uuid primary key default gen_random_uuid(),
  full_name        text not null,
  telegram_chat_id text unique,
  -- Cleared when Telegram reports the bot was blocked, so we stop retrying a
  -- recipient who has opted out at their end.
  active           boolean not null default true,
  linked_at        timestamptz,
  created_at       timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- student_guardians
-- Many-to-many on purpose: one tap can mean three messages to three people,
-- and a guardian can have more than one child at the school.
-- `notify` is the opt-out that consent paperwork promises.
-- ---------------------------------------------------------------------------
create table if not exists mvts_esp32.student_guardians (
  student_id  uuid not null references mvts_esp32.students(id)  on delete cascade,
  guardian_id uuid not null references mvts_esp32.guardians(id) on delete cascade,
  relation    text,
  notify      boolean not null default true,
  primary key (student_id, guardian_id)
);

create index if not exists student_guardians_guardian_idx
  on mvts_esp32.student_guardians (guardian_id);

-- ---------------------------------------------------------------------------
-- guardian_enroll_tokens
-- Printed on the enrolment slip as a QR for
--   https://t.me/<YourSchoolBot>?start=<token>
-- One tap, no typing, no support call. Single use, and it expires.
-- ---------------------------------------------------------------------------
create table if not exists mvts_esp32.guardian_enroll_tokens (
  token       text primary key,
  student_id  uuid not null references mvts_esp32.students(id) on delete cascade,
  relation    text,
  expires_at  timestamptz not null,
  used_at     timestamptz,
  guardian_id uuid references mvts_esp32.guardians(id) on delete set null,
  created_at  timestamptz not null default now()
);

create index if not exists guardian_enroll_tokens_student_idx
  on mvts_esp32.guardian_enroll_tokens (student_id);

-- ---------------------------------------------------------------------------
-- notifications
-- The composite primary key is the whole point. record_attendance() already
-- makes a replayed batch a no-op; this makes a replayed FAN-OUT a no-op. A
-- duplicate attendance insert is invisible. A duplicate "Ana arrived at
-- school" at 11pm is how parents stop trusting the system.
-- ---------------------------------------------------------------------------
create table if not exists mvts_esp32.notifications (
  event_id    uuid not null references mvts_esp32.attendance(event_id) on delete cascade,
  guardian_id uuid not null references mvts_esp32.guardians(id)        on delete cascade,
  -- 'sending' is set when an attempt STARTS, not when it is queued, so a
  -- notifier that dies mid-send leaves a row that times out and is retried
  -- rather than one that looks pending forever.
  status      text not null default 'sending'
                check (status in ('sending','sent','failed','suppressed')),
  -- 'fresh' | 'delayed' | 'stale' -- what the staleness rule decided
  delivery_class text not null default 'fresh',
  delay_s     integer not null default 0,
  -- Incremented when an attempt begins. Bounding retries matters: Telegram
  -- charges nothing, but a wedged row retried forever is a wedged row.
  attempts    integer not null default 0,
  sent_at     timestamptz,
  error       text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (event_id, guardian_id)
);

create index if not exists notifications_unfinished_idx
  on mvts_esp32.notifications (updated_at)
  where status in ('sending','failed');

-- ---------------------------------------------------------------------------
-- RLS
-- No policies, and no grants to anon or authenticated. Every table here is
-- reachable only with service_role, which bypasses RLS -- and service_role is
-- exactly what the dashboard already reads with (web/lib/supabase.ts).
--
-- If you later add real staff auth, expose a VIEW that omits
-- telegram_chat_id rather than granting select on guardians directly.
-- ---------------------------------------------------------------------------
alter table mvts_esp32.notify_config           enable row level security;
alter table mvts_esp32.guardians               enable row level security;
alter table mvts_esp32.student_guardians       enable row level security;
alter table mvts_esp32.guardian_enroll_tokens  enable row level security;
alter table mvts_esp32.notifications           enable row level security;

revoke all on mvts_esp32.notify_config          from anon, authenticated;
revoke all on mvts_esp32.guardians              from anon, authenticated;
revoke all on mvts_esp32.student_guardians      from anon, authenticated;
revoke all on mvts_esp32.guardian_enroll_tokens from anon, authenticated;
revoke all on mvts_esp32.notifications          from anon, authenticated;

-- ---------------------------------------------------------------------------
-- attendance_resolved gains image_path, so the dashboard can show the capture
-- next to the row. create or replace only permits appending columns, which is
-- why it lands at the end rather than beside the other attendance fields.
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
  s.student_no,
  a.image_path
from mvts_esp32.attendance a
left join mvts_esp32.student_cards c
       on c.card_uid = a.card_uid
      and a.scanned_at >= c.issued_at
      and (c.revoked_at is null or a.scanned_at < c.revoked_at)
left join mvts_esp32.students s
       on s.id = c.student_id;

-- ===========================================================================
-- claim_notifications(event_id)
--
-- Called by the notifier once per attendance insert. Decides who should be
-- told, applies the staleness rule, and reserves the work in one statement.
--
-- Returns ONLY rows it newly inserted. A webhook that fires twice therefore
-- returns zero rows the second time and nothing is sent again -- the same
-- ON CONFLICT DO NOTHING trick record_attendance() uses, applied to fan-out.
-- ===========================================================================
create or replace function mvts_esp32.claim_notifications(p_event_id uuid)
returns table (
  guardian_id    uuid,
  chat_id        text,
  guardian_name  text,
  student_name   text,
  student_no     text,
  scanned_at     timestamptz,
  image_path     text,
  clock_synced   boolean,
  delivery_class text,
  delay_s        integer
)
language plpgsql
security definer
set search_path = mvts_esp32, storage, pg_temp
as $$
-- RETURNS TABLE names (event_id, guardian_id, ...) are plpgsql variables, and
-- ON CONFLICT's column list cannot be table-qualified -- so without this the
-- insert below fails with "column reference guardian_id is ambiguous". Every
-- genuine variable read here is a v_/p_/cfg./ev. name, so preferring the
-- column is unambiguous.
#variable_conflict use_column
declare
  cfg   mvts_esp32.notify_config%rowtype;
  ev    record;
  v_delay integer;
  v_class text;
begin
  select * into cfg from mvts_esp32.notify_config where id;
  if not found or not cfg.enabled then
    return;
  end if;

  select r.event_id, r.student_id, r.full_name, r.student_no, r.scanned_at,
         r.received_at, r.clock_synced, a.image_path
    into ev
    from mvts_esp32.attendance_resolved r
    join mvts_esp32.attendance a on a.event_id = r.event_id
   where r.event_id = p_event_id;

  -- Unknown card, or the event vanished. Nothing to send; the dashboard
  -- already surfaces unknown scans.
  if not found or ev.student_id is null then
    return;
  end if;

  v_delay := greatest(0, floor(extract(epoch from (ev.received_at - ev.scanned_at)))::integer);

  v_class := case
    when v_delay <= cfg.fresh_within_s   then 'fresh'
    when v_delay <= cfg.suppress_after_s then 'delayed'
    else 'stale'
  end;

  return query
  with recipients as (
    select g.id as gid, g.telegram_chat_id, g.full_name
      from mvts_esp32.student_guardians sg
      join mvts_esp32.guardians g on g.id = sg.guardian_id
     where sg.student_id = ev.student_id
       and sg.notify
       and g.active
       and g.telegram_chat_id is not null
  ),
  claimed as (
    insert into mvts_esp32.notifications
      (event_id, guardian_id, status, delivery_class, delay_s, attempts)
    select p_event_id, r.gid,
           case when v_class = 'stale' then 'suppressed' else 'sending' end,
           v_class, v_delay,
           case when v_class = 'stale' then 0 else 1 end
      from recipients r
    on conflict (event_id, guardian_id) do nothing
    returning notifications.guardian_id
  )
  select r.gid, r.telegram_chat_id, r.full_name,
         ev.full_name, ev.student_no, ev.scanned_at, ev.image_path,
         ev.clock_synced, v_class, v_delay
    from claimed c
    join recipients r on r.gid = c.guardian_id
   -- A stale event is recorded above and reported on the dashboard, but the
   -- caller is handed nothing to send.
   where v_class <> 'stale';
end;
$$;

-- ===========================================================================
-- mark_notification(...)
-- 'blocked' is not a status: Telegram reporting that the user blocked the bot
-- deactivates the guardian instead, so we stop burning retries on them.
-- ===========================================================================
create or replace function mvts_esp32.mark_notification(
  p_event_id    uuid,
  p_guardian_id uuid,
  p_status      text,
  p_error       text default null,
  p_deactivate  boolean default false
) returns void
language plpgsql
security definer
set search_path = mvts_esp32, pg_temp
as $$
begin
  if p_status not in ('sending','sent','failed','suppressed') then
    raise exception 'bad status %', p_status;
  end if;

  -- attempts is NOT touched here: it is incremented when an attempt begins,
  -- in claim_notifications() and retry_notifications(). Counting on completion
  -- would let a notifier that crashes mid-send retry without limit.
  update mvts_esp32.notifications
     set status     = p_status,
         error      = p_error,
         updated_at = now(),
         sent_at    = case when p_status = 'sent' then now() else sent_at end
   where event_id = p_event_id and guardian_id = p_guardian_id;

  if p_deactivate then
    update mvts_esp32.guardians set active = false where id = p_guardian_id;
  end if;
end;
$$;

-- ===========================================================================
-- retry_notifications(...)
--
-- The sweeper, and the only way a stuck row ever moves again:
-- claim_notifications() will never hand the same (event_id, guardian_id) out
-- twice, because the conflict target is already taken.
--
-- Two things it must get right:
--
--   FOR UPDATE SKIP LOCKED -- two overlapping cron ticks must not both grab
--   the same row and message the parent twice.
--
--   Re-scoring staleness -- a row that has been failing for four hours must
--   not finally go out claiming the gate was "20 minutes late". It is
--   re-measured against now(), and if it has aged past suppress_after_s it is
--   marked suppressed and never sent. Nobody is helped by a notification about
--   this morning arriving at dinner.
--
-- Schedule with pg_cron:
--
--   select cron.schedule('gate-notify-retry', '*/5 * * * *', $c$
--     select net.http_post(
--       url     := 'https://<ref>.supabase.co/functions/v1/notify-guardian',
--       headers := '{"Content-Type":"application/json",
--                    "x-webhook-secret":"<WEBHOOK_SECRET>"}'::jsonb,
--       body    := '{"mode":"retry"}'::jsonb)
--   $c$);
-- ===========================================================================
create or replace function mvts_esp32.retry_notifications(
  p_older_than_s integer default 120,
  p_max_attempts integer default 5,
  p_limit        integer default 100
)
returns table (
  event_id       uuid,
  guardian_id    uuid,
  chat_id        text,
  guardian_name  text,
  student_name   text,
  student_no     text,
  scanned_at     timestamptz,
  image_path     text,
  clock_synced   boolean,
  delivery_class text,
  delay_s        integer
)
language plpgsql
security definer
set search_path = mvts_esp32, pg_temp
as $fn$
-- Same shadowing hazard as claim_notifications(): the RETURNS TABLE names
-- collide with the columns this statement updates.
#variable_conflict use_column
declare
  cfg mvts_esp32.notify_config%rowtype;
begin
  select * into cfg from mvts_esp32.notify_config where id;
  if not found or not cfg.enabled then
    return;
  end if;

  return query
  with due as (
    select n.event_id, n.guardian_id
      from mvts_esp32.notifications n
      join mvts_esp32.guardians g
        on g.id = n.guardian_id and g.active and g.telegram_chat_id is not null
     where n.status in ('sending','failed')
       and n.attempts < p_max_attempts
       and n.updated_at < now() - make_interval(secs => p_older_than_s)
     order by n.updated_at
     limit p_limit
     for update of n skip locked
  ),
  rescored as (
    select d.event_id, d.guardian_id,
           greatest(0, floor(extract(epoch from (now() - a.scanned_at)))::integer) as new_delay
      from due d
      join mvts_esp32.attendance a on a.event_id = d.event_id
  ),
  claimed as (
    update mvts_esp32.notifications n
       set status = case
                      when rs.new_delay > cfg.suppress_after_s then 'suppressed'
                      else 'sending'
                    end,
           delivery_class = case
                      when rs.new_delay > cfg.suppress_after_s then 'stale'
                      when rs.new_delay <= cfg.fresh_within_s  then 'fresh'
                      else 'delayed'
                    end,
           delay_s    = rs.new_delay,
           attempts   = n.attempts + 1,
           updated_at = now()
      from rescored rs
     where n.event_id = rs.event_id and n.guardian_id = rs.guardian_id
    returning n.event_id, n.guardian_id, n.status,
              n.delivery_class, n.delay_s
  )
  select c.event_id, c.guardian_id, g.telegram_chat_id, g.full_name,
         r.full_name, r.student_no, r.scanned_at, a.image_path,
         r.clock_synced, c.delivery_class, c.delay_s
    from claimed c
    join mvts_esp32.guardians g on g.id = c.guardian_id
    join mvts_esp32.attendance a on a.event_id = c.event_id
    join mvts_esp32.attendance_resolved r on r.event_id = c.event_id
   -- Rows just aged out are recorded as suppressed above and handed back to
   -- nobody.
   where c.status = 'sending';
end;
$fn$;

-- ===========================================================================
-- Guardian enrolment
--
-- A Telegram bot cannot initiate a conversation -- the API answers
-- "Forbidden: bot can't initiate conversation with a user". The guardian MUST
-- message the bot first. These two functions are the whole onboarding path:
-- issue a single-use token, print it as a t.me deep-link QR, redeem it when
-- the guardian taps it.
-- ===========================================================================
create or replace function mvts_esp32.issue_enroll_token(
  p_student_id uuid,
  p_relation   text default null,
  p_valid_for  interval default interval '30 days'
) returns text
language plpgsql
security definer
set search_path = mvts_esp32, pg_temp
as $$
declare
  v_token text;
begin
  -- 122 bits, and no pgcrypto dependency.
  v_token := replace(gen_random_uuid()::text, '-', '');
  insert into mvts_esp32.guardian_enroll_tokens
    (token, student_id, relation, expires_at)
  values (v_token, p_student_id, p_relation, now() + p_valid_for);
  return v_token;
end;
$$;

create or replace function mvts_esp32.redeem_enroll_token(
  p_token        text,
  p_chat_id      text,
  p_display_name text
) returns jsonb
language plpgsql
security definer
set search_path = mvts_esp32, pg_temp
as $$
declare
  tok record;
  v_guardian uuid;
  v_student  record;
begin
  select * into tok
    from mvts_esp32.guardian_enroll_tokens
   where token = p_token
   for update;

  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_token');
  end if;
  if tok.used_at is not null then
    return jsonb_build_object('ok', false, 'reason', 'already_used');
  end if;
  if tok.expires_at < now() then
    return jsonb_build_object('ok', false, 'reason', 'expired');
  end if;

  -- Same person, second child: reuse the guardian row keyed on chat_id.
  select id into v_guardian
    from mvts_esp32.guardians
   where telegram_chat_id = p_chat_id;

  if v_guardian is null then
    insert into mvts_esp32.guardians (full_name, telegram_chat_id, active, linked_at)
    values (coalesce(nullif(p_display_name, ''), 'Guardian'), p_chat_id, true, now())
    returning id into v_guardian;
  else
    update mvts_esp32.guardians
       set active = true,
           linked_at = coalesce(linked_at, now())
     where id = v_guardian;
  end if;

  insert into mvts_esp32.student_guardians (student_id, guardian_id, relation)
  values (tok.student_id, v_guardian, tok.relation)
  on conflict (student_id, guardian_id) do update set notify = true;

  update mvts_esp32.guardian_enroll_tokens
     set used_at = now(), guardian_id = v_guardian
   where token = p_token;

  select full_name, student_no into v_student
    from mvts_esp32.students where id = tok.student_id;

  return jsonb_build_object(
    'ok', true,
    'guardian_id', v_guardian,
    'student_name', v_student.full_name,
    'student_no', v_student.student_no
  );
end;
$$;

-- ===========================================================================
-- expired_captures(...)
-- Retention. Attendance rows are kept forever; photographs of minors are not.
-- SQL cannot delete the underlying object reliably, so this only NAMES the
-- paths -- the purge job calls the Storage API with them and then clears
-- image_path.
-- ===========================================================================
create or replace function mvts_esp32.expired_captures(p_limit integer default 500)
returns table (event_id uuid, image_path text)
language sql
security definer
set search_path = mvts_esp32, pg_temp
as $$
  select a.event_id, a.image_path
    from mvts_esp32.attendance a, mvts_esp32.notify_config c
   where c.id
     and a.image_path is not null
     and a.received_at < now() - make_interval(days => c.capture_retention_days)
   order by a.received_at
   limit p_limit;
$$;

create or replace function mvts_esp32.forget_capture(p_event_id uuid)
returns void
language sql
security definer
set search_path = mvts_esp32, pg_temp
as $$
  update mvts_esp32.attendance set image_path = null where event_id = p_event_id;
$$;

-- ===========================================================================
-- set_notify_preference(chat_id, on)
-- Backs /stop and /resume in the bot. A guardian who mutes the bot at their
-- end is invisible to us; one who tells us to stop should be recorded, because
-- consent paperwork promised an opt-out that actually does something.
-- ===========================================================================
create or replace function mvts_esp32.set_notify_preference(
  p_chat_id text,
  p_on      boolean
) returns jsonb
language plpgsql
security definer
set search_path = mvts_esp32, pg_temp
as $fn$
declare
  v_guardian uuid;
  v_count    integer;
begin
  select id into v_guardian
    from mvts_esp32.guardians where telegram_chat_id = p_chat_id;

  if v_guardian is null then
    return jsonb_build_object('ok', false, 'reason', 'not_linked');
  end if;

  update mvts_esp32.student_guardians
     set notify = p_on
   where guardian_id = v_guardian;
  get diagnostics v_count = row_count;

  update mvts_esp32.guardians set active = true where id = v_guardian;

  return jsonb_build_object('ok', true, 'students', v_count);
end;
$fn$;

-- ---------------------------------------------------------------------------
-- Table grants. Only service_role, which is what the dashboard and the Edge
-- Functions already authenticate as. anon and authenticated were revoked
-- above and are not granted back.
-- ---------------------------------------------------------------------------
grant select, insert, update, delete on
  mvts_esp32.guardians,
  mvts_esp32.student_guardians,
  mvts_esp32.guardian_enroll_tokens,
  mvts_esp32.notifications,
  mvts_esp32.notify_config
to service_role;

-- ---------------------------------------------------------------------------
-- Function grants. service_role only -- the device holds none of these, and
-- the browser never sees them.
-- ---------------------------------------------------------------------------
revoke all on function mvts_esp32.claim_notifications(uuid)                    from public;
revoke all on function mvts_esp32.mark_notification(uuid,uuid,text,text,boolean) from public;
revoke all on function mvts_esp32.retry_notifications(integer,integer,integer) from public;
revoke all on function mvts_esp32.issue_enroll_token(uuid,text,interval)       from public;
revoke all on function mvts_esp32.redeem_enroll_token(text,text,text)          from public;
revoke all on function mvts_esp32.expired_captures(integer)                    from public;
revoke all on function mvts_esp32.forget_capture(uuid)                         from public;

grant execute on function mvts_esp32.claim_notifications(uuid)                    to service_role;
grant execute on function mvts_esp32.mark_notification(uuid,uuid,text,text,boolean) to service_role;
grant execute on function mvts_esp32.retry_notifications(integer,integer,integer) to service_role;
grant execute on function mvts_esp32.issue_enroll_token(uuid,text,interval)       to service_role;
grant execute on function mvts_esp32.redeem_enroll_token(text,text,text)          to service_role;
grant execute on function mvts_esp32.expired_captures(integer)                    to service_role;
grant execute on function mvts_esp32.forget_capture(uuid)                         to service_role;
revoke all  on function mvts_esp32.set_notify_preference(text,boolean)          from public;
grant execute on function mvts_esp32.set_notify_preference(text,boolean)          to service_role;
