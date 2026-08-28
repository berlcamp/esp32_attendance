-- ===========================================================================
-- Behavioural tests for sql/notify.sql — the fan-out, staleness and retry
-- rules. These are the parts where a bug means a parent gets a duplicate
-- message at midnight, or gets told about this morning at dinner, so they are
-- worth pinning down.
--
-- Run against a scratch Postgres, NOT against Supabase (it writes test rows):
--
--   docker run -d --rm --name gatepg -e POSTGRES_PASSWORD=pw -p 55433:5432 postgres:16
--   export PGPASSWORD=pw
--   psql -h localhost -p 55433 -U postgres -v ON_ERROR_STOP=1 \
--        -f sql/test_bootstrap.sql -f sql/schema.sql -f sql/rpc.sql \
--        -f sql/seed.sql -f sql/notify.sql -f sql/test_notify.sql
--   docker stop gatepg
--
-- Every check raises on failure, so a clean run ending in "all tests passed"
-- is the whole result.
-- ===========================================================================

\set ON_ERROR_STOP on
set search_path = mvts_esp32, public;

do $t$
declare
  ana uuid; ben uuid;
  g_mum uuid; g_dad uuid;
  e1 uuid := gen_random_uuid(); e2 uuid := gen_random_uuid();
  e3 uuid := gen_random_uuid(); e4 uuid := gen_random_uuid();
  e5 uuid := gen_random_uuid();
  n int; r record; tok text; res jsonb;
begin
  -- seed.sql issues cards at now(); back-date them or every back-dated test
  -- scan falls outside the card's validity window and resolves to no student.
  update student_cards set issued_at = now() - interval '1 year';

  select id into ana from students where student_no = 'S-1001';
  select id into ben from students where student_no = 'S-1002';

  insert into guardians (full_name, telegram_chat_id, linked_at)
    values ('Mum Reyes', '111', now()) returning id into g_mum;
  insert into guardians (full_name, telegram_chat_id, linked_at)
    values ('Dad Reyes', '222', now()) returning id into g_dad;
  insert into student_guardians (student_id, guardian_id) values (ana, g_mum), (ana, g_dad);

  -- T1: fresh scan fans out to BOTH guardians ------------------------------
  insert into attendance (event_id, card_uid, device_id, scanned_at, received_at,
                          clock_synced, image_path)
    values (e1, '04A1B2C3', 'gate-01', now() - interval '5 s', now(), true,
            'gate-01/2026/08/28/e1.jpg');
  select count(*) into n from claim_notifications(e1);
  if n <> 2 then raise exception 'T1 expected 2 recipients, got %', n; end if;
  select delivery_class into r from claim_notifications(e1) limit 1;
  perform 1 from notifications where event_id = e1 and delivery_class = 'fresh'
    and status = 'sending' and attempts = 1;
  if not found then raise exception 'T1 rows not claimed as fresh/sending/1'; end if;
  raise notice 'T1 ok  fresh scan -> 2 recipients, claimed as sending';

  -- T2: replayed webhook sends NOTHING the second time ---------------------
  select count(*) into n from claim_notifications(e1);
  if n <> 0 then raise exception 'T2 duplicate webhook re-sent % rows', n; end if;
  raise notice 'T2 ok  duplicate webhook -> 0 rows';

  -- T3: 30 min late -> delivered, but worded as delayed --------------------
  insert into attendance (event_id, card_uid, device_id, scanned_at, received_at, clock_synced)
    values (e2, '04A1B2C3', 'gate-01', now() - interval '30 min', now(), true);
  select count(*) into n from claim_notifications(e2) where delivery_class = 'delayed';
  if n <> 2 then raise exception 'T3 expected 2 delayed, got %', n; end if;
  raise notice 'T3 ok  30min late -> delivery_class=delayed';

  -- T4: 5 h late -> suppressed, nothing handed to the sender ---------------
  insert into attendance (event_id, card_uid, device_id, scanned_at, received_at, clock_synced)
    values (e3, '04A1B2C3', 'gate-01', now() - interval '5 h', now(), true);
  select count(*) into n from claim_notifications(e3);
  if n <> 0 then raise exception 'T4 stale event handed out % rows', n; end if;
  select count(*) into n from notifications
    where event_id = e3 and status = 'suppressed' and delivery_class = 'stale';
  if n <> 2 then raise exception 'T4 expected 2 suppressed rows, got %', n; end if;
  raise notice 'T4 ok  5h late -> 0 sent, 2 recorded suppressed';

  -- T5: unknown card -> nobody to tell -------------------------------------
  insert into attendance (event_id, card_uid, device_id, scanned_at, received_at, clock_synced)
    values (e4, 'DEADC0DE', 'gate-01', now(), now(), true);
  select count(*) into n from claim_notifications(e4);
  if n <> 0 then raise exception 'T5 unknown card produced % rows', n; end if;
  raise notice 'T5 ok  unknown card -> 0 rows';

  -- T6: opted-out guardian is skipped --------------------------------------
  update student_guardians set notify = false where student_id = ana and guardian_id = g_dad;
  insert into attendance (event_id, card_uid, device_id, scanned_at, received_at, clock_synced)
    values (e5, '04A1B2C3', 'gate-01', now(), now(), true);
  select count(*) into n from claim_notifications(e5);
  if n <> 1 then raise exception 'T6 expected 1 after opt-out, got %', n; end if;
  update student_guardians set notify = true where student_id = ana and guardian_id = g_dad;
  raise notice 'T6 ok  notify=false guardian skipped';

  -- T7: mark sent does not inflate attempts --------------------------------
  perform mark_notification(e1, g_mum, 'sent');
  select attempts into n from notifications where event_id = e1 and guardian_id = g_mum;
  if n <> 1 then raise exception 'T7 attempts became % after mark sent', n; end if;
  perform 1 from notifications where event_id = e1 and guardian_id = g_mum
    and status = 'sent' and sent_at is not null;
  if not found then raise exception 'T7 sent_at not stamped'; end if;
  raise notice 'T7 ok  mark sent -> attempts stays 1, sent_at stamped';

  -- T8: sweeper picks up a failure and bumps attempts -----------------------
  perform mark_notification(e1, g_dad, 'failed', '502 Bad Gateway');
  update notifications set updated_at = now() - interval '10 min'
    where event_id = e1 and guardian_id = g_dad;
  select count(*) into n from retry_notifications(120, 5, 100)
    where event_id = e1 and guardian_id = g_dad;
  if n <> 1 then raise exception 'T8 sweeper returned % rows', n; end if;
  select attempts into n from notifications where event_id = e1 and guardian_id = g_dad;
  if n <> 2 then raise exception 'T8 attempts is % not 2', n; end if;
  raise notice 'T8 ok  failed row retried, attempts 1 -> 2';

  -- T9: a row that ages out while failing is re-scored and dropped ---------
  perform mark_notification(e2, g_mum, 'failed', 'network');
  update notifications set updated_at = now() - interval '10 min'
    where event_id = e2 and guardian_id = g_mum;
  update attendance set scanned_at = now() - interval '6 h' where event_id = e2;
  select count(*) into n from retry_notifications(120, 5, 100)
    where event_id = e2 and guardian_id = g_mum;
  if n <> 0 then raise exception 'T9 aged-out row was still handed out'; end if;
  select count(*) into n from notifications
    where event_id = e2 and guardian_id = g_mum and status = 'suppressed';
  if n <> 1 then raise exception 'T9 aged-out row not suppressed'; end if;
  raise notice 'T9 ok  row that aged out while failing -> suppressed, not sent';

  -- T10: attempts ceiling holds --------------------------------------------
  update notifications set status = 'failed', attempts = 5,
         updated_at = now() - interval '1 h' where event_id = e1 and guardian_id = g_dad;
  select count(*) into n from retry_notifications(120, 5, 100)
    where event_id = e1 and guardian_id = g_dad;
  if n <> 0 then raise exception 'T10 exhausted row retried anyway'; end if;
  raise notice 'T10 ok exhausted row not retried';

  -- T11: enrolment token, single use ---------------------------------------
  tok := issue_enroll_token(ben, 'mother');
  res := redeem_enroll_token(tok, '333', 'Mum Cruz');
  if not (res->>'ok')::boolean then raise exception 'T11 redeem failed: %', res; end if;
  if res->>'student_name' <> 'Ben Cruz' then raise exception 'T11 wrong student: %', res; end if;
  res := redeem_enroll_token(tok, '333', 'Mum Cruz');
  if (res->>'ok')::boolean or res->>'reason' <> 'already_used' then
    raise exception 'T11 token reusable: %', res; end if;
  raise notice 'T11 ok enrolment token redeems once, then already_used';

  -- T12: expired token rejected --------------------------------------------
  tok := issue_enroll_token(ben, 'father', interval '-1 s');
  res := redeem_enroll_token(tok, '444', 'Dad Cruz');
  if (res->>'ok')::boolean or res->>'reason' <> 'expired' then
    raise exception 'T12 expired token accepted: %', res; end if;
  raise notice 'T12 ok expired token rejected';

  -- T13: /stop actually stops ----------------------------------------------
  res := set_notify_preference('333', false);
  if not (res->>'ok')::boolean then raise exception 'T13 stop failed: %', res; end if;
  insert into attendance (event_id, card_uid, device_id, scanned_at, received_at, clock_synced)
    values (gen_random_uuid(), '04B2C3D4', 'gate-01', now(), now(), true);
  select count(*) into n from claim_notifications(
    (select event_id from attendance where card_uid = '04B2C3D4' order by received_at desc limit 1));
  if n <> 0 then raise exception 'T13 /stop did not stop, got % rows', n; end if;
  raise notice 'T13 ok /stop suppresses fan-out';

  -- T14: record_attendance carries image_path through -----------------------
  perform record_attendance(jsonb_build_array(jsonb_build_object(
    'event_id', gen_random_uuid()::text, 'card_uid', '04C3D4E5', 'device_id', 'gate-01',
    'scanned_at', now()::text, 'clock_synced', true,
    'image_path', 'gate-01/2026/08/28/x.jpg')));
  select count(*) into n from attendance
    where card_uid = '04C3D4E5' and image_path = 'gate-01/2026/08/28/x.jpg';
  if n <> 1 then raise exception 'T14 image_path not stored'; end if;
  raise notice 'T14 ok record_attendance stores image_path';

  -- T15: retention names old captures ---------------------------------------
  update attendance set received_at = now() - interval '90 days' where event_id = e1;
  select count(*) into n from expired_captures(500) where event_id = e1;
  if n <> 1 then raise exception 'T15 old capture not listed'; end if;
  perform forget_capture(e1);
  select count(*) into n from expired_captures(500) where event_id = e1;
  if n <> 0 then raise exception 'T15 forget_capture did not clear'; end if;
  raise notice 'T15 ok retention lists then clears old captures';

  raise notice '--- all tests passed ---';
end;
$t$;
