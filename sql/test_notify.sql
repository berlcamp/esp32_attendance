-- ===========================================================================
-- Behavioural tests for the gate half of pta (0013_gate_attendance.sql) — the
-- fan-out, staleness, retry and tenancy rules. These are the parts where a bug
-- means a parent gets a duplicate message at midnight, gets told about this
-- morning at dinner, or gets told about somebody else's child entirely.
--
-- Run against a scratch Postgres, NOT against Supabase (it writes test rows):
--
--   docker run -d --rm --name gatepg -e POSTGRES_PASSWORD=pw -p 55433:5432 postgres:16
--   export PGPASSWORD=pw PTA=../../pta-collections/supabase/migrations
--   psql -h localhost -p 55433 -U postgres -v ON_ERROR_STOP=1 \
--        -f sql/test_bootstrap.sql \
--        -f $PTA/0001_schema_and_identity.sql \
--        -f $PTA/0002_academic_and_people.sql \
--        -f $PTA/0003_financial.sql \
--        -f $PTA/0005_rls_helpers.sql \
--        -f $PTA/0013_gate_attendance.sql \
--        -f sql/test_notify.sql
--   docker stop gatepg
--
-- The real pta migrations are loaded rather than a hand-copied fixture, so
-- these tests fail if that schema drifts. That is the point of running them.
--
-- Every check raises on failure, so a clean run ending in "all tests passed"
-- is the whole result.
-- ===========================================================================

\set ON_ERROR_STOP on
set search_path = pta, public;

-- ---------------------------------------------------------------------------
-- Fixture. TWO schools, because half of what is being tested is that one
-- school's gate cannot see the other's people.
-- ---------------------------------------------------------------------------
do $f$
declare
  sch_a uuid; sch_b uuid; yr_a uuid; yr_b uuid;
  ana uuid; ben uuid; zoe uuid;
begin
  insert into schools (school_code, name, receipt_prefix)
    values ('MVTS', 'Mater Vitae Tech School', 'MVTS') returning id into sch_a;
  insert into schools (school_code, name, receipt_prefix)
    values ('OTHR', 'Other School', 'OTHR') returning id into sch_b;

  insert into school_years (school_id, name, start_date, end_date, is_active)
    values (sch_a, '2026-2027', date '2026-06-01', date '2027-03-31', true)
    returning id into yr_a;
  insert into school_years (school_id, name, start_date, end_date, is_active)
    values (sch_b, '2026-2027', date '2026-06-01', date '2027-03-31', true)
    returning id into yr_b;

  insert into students (school_id, first_name, last_name)
    values (sch_a, 'Ana', 'Reyes') returning id into ana;
  insert into students (school_id, first_name, last_name)
    values (sch_a, 'Ben', 'Cruz') returning id into ben;
  -- Same name, other school. If anything leaks across tenants, this is who
  -- turns up in the wrong place.
  insert into students (school_id, first_name, last_name)
    values (sch_b, 'Zoe', 'Santos') returning id into zoe;

  insert into student_enrollments (school_id, student_id, school_year_id, grade_level, student_number)
    values (sch_a, ana, yr_a, 'Grade 7', 'S-1001'),
           (sch_a, ben, yr_a, 'Grade 7', 'S-1002'),
           (sch_b, zoe, yr_b, 'Grade 7', 'S-2001');

  insert into gate_devices (device_id, school_id, label)
    values ('gate-01', sch_a, 'Main gate'),
           ('gate-02', sch_b, 'Other school gate');

  insert into gate_notify_config (school_id) values (sch_a), (sch_b);

  -- Back-dated on purpose: a card issued at now() makes every back-dated test
  -- scan fall outside its validity window and resolve to no student.
  insert into student_cards (school_id, student_id, card_uid, issued_at)
    values (sch_a, ana, '04A1B2C3', now() - interval '1 year'),
           (sch_a, ben, '04B2C3D4', now() - interval '1 year'),
           (sch_a, ben, '04C3D4E5', now() - interval '1 year'),
           -- The SAME physical uid, issued at the other school. Legal, and the
           -- reason the active-card index is (school_id, card_uid).
           (sch_b, zoe, '04A1B2C3', now() - interval '1 year');
end;
$f$;

do $t$
declare
  sch_a uuid; sch_b uuid;
  ana uuid; ben uuid;
  g_mum uuid; g_dad uuid;
  e1 uuid := gen_random_uuid(); e2 uuid := gen_random_uuid();
  e3 uuid := gen_random_uuid(); e4 uuid := gen_random_uuid();
  e5 uuid := gen_random_uuid(); e6 uuid := gen_random_uuid();
  n int; tok text; res jsonb; msg text;
begin
  select id into sch_a from schools where school_code = 'MVTS';
  select id into sch_b from schools where school_code = 'OTHR';
  select student_id into ana from gate_roster where student_no = 'S-1001';
  select student_id into ben from gate_roster where student_no = 'S-1002';

  insert into parents_guardians (school_id, first_name, last_name, telegram_chat_id, telegram_linked_at)
    values (sch_a, 'Mum', 'Reyes', '111', now()) returning id into g_mum;
  insert into parents_guardians (school_id, first_name, last_name, telegram_chat_id, telegram_linked_at)
    values (sch_a, 'Dad', 'Reyes', '222', now()) returning id into g_dad;
  insert into student_guardians (school_id, student_id, guardian_id)
    values (sch_a, ana, g_mum), (sch_a, ana, g_dad);

  -- T1: fresh scan fans out to BOTH guardians ------------------------------
  insert into attendance (event_id, school_id, device_id, card_uid, scanned_at,
                          received_at, clock_synced, image_path)
    values (e1, sch_a, 'gate-01', '04A1B2C3', now() - interval '5 s', now(), true,
            'gate-01/2026/08/28/e1.jpg');
  select count(*) into n from claim_notifications(e1);
  if n <> 2 then raise exception 'T1 expected 2 recipients, got %', n; end if;
  perform 1 from gate_notifications where event_id = e1 and delivery_class = 'fresh'
    and status = 'sending' and attempts = 1;
  if not found then raise exception 'T1 rows not claimed as fresh/sending/1'; end if;
  raise notice 'T1 ok  fresh scan -> 2 recipients, claimed as sending';

  -- T2: replayed webhook sends NOTHING the second time ---------------------
  select count(*) into n from claim_notifications(e1);
  if n <> 0 then raise exception 'T2 duplicate webhook re-sent % rows', n; end if;
  raise notice 'T2 ok  duplicate webhook -> 0 rows';

  -- T3: 30 min late -> delivered, but worded as delayed --------------------
  insert into attendance (event_id, school_id, device_id, card_uid, scanned_at, received_at, clock_synced)
    values (e2, sch_a, 'gate-01', '04A1B2C3', now() - interval '30 min', now(), true);
  select count(*) into n from claim_notifications(e2) where delivery_class = 'delayed';
  if n <> 2 then raise exception 'T3 expected 2 delayed, got %', n; end if;
  raise notice 'T3 ok  30min late -> delivery_class=delayed';

  -- T4: 5 h late -> suppressed, nothing handed to the sender ---------------
  insert into attendance (event_id, school_id, device_id, card_uid, scanned_at, received_at, clock_synced)
    values (e3, sch_a, 'gate-01', '04A1B2C3', now() - interval '5 h', now(), true);
  select count(*) into n from claim_notifications(e3);
  if n <> 0 then raise exception 'T4 stale event handed out % rows', n; end if;
  select count(*) into n from gate_notifications
    where event_id = e3 and status = 'suppressed' and delivery_class = 'stale';
  if n <> 2 then raise exception 'T4 expected 2 suppressed rows, got %', n; end if;
  raise notice 'T4 ok  5h late -> 0 sent, 2 recorded suppressed';

  -- T5: unknown card -> nobody to tell -------------------------------------
  insert into attendance (event_id, school_id, device_id, card_uid, scanned_at, received_at, clock_synced)
    values (e4, sch_a, 'gate-01', 'DEADC0DE', now(), now(), true);
  select count(*) into n from claim_notifications(e4);
  if n <> 0 then raise exception 'T5 unknown card produced % rows', n; end if;
  raise notice 'T5 ok  unknown card -> 0 rows';

  -- T6: opted-out guardian is skipped --------------------------------------
  update student_guardians set notify = false where student_id = ana and guardian_id = g_dad;
  insert into attendance (event_id, school_id, device_id, card_uid, scanned_at, received_at, clock_synced)
    values (e5, sch_a, 'gate-01', '04A1B2C3', now(), now(), true);
  select count(*) into n from claim_notifications(e5);
  if n <> 1 then raise exception 'T6 expected 1 after opt-out, got %', n; end if;
  update student_guardians set notify = true where student_id = ana and guardian_id = g_dad;
  raise notice 'T6 ok  notify=false guardian skipped';

  -- T7: mark sent does not inflate attempts --------------------------------
  perform mark_notification(e1, g_mum, 'sent');
  select attempts into n from gate_notifications where event_id = e1 and guardian_id = g_mum;
  if n <> 1 then raise exception 'T7 attempts became % after mark sent', n; end if;
  perform 1 from gate_notifications where event_id = e1 and guardian_id = g_mum
    and status = 'sent' and sent_at is not null;
  if not found then raise exception 'T7 sent_at not stamped'; end if;
  raise notice 'T7 ok  mark sent -> attempts stays 1, sent_at stamped';

  -- T8: sweeper picks up a failure and bumps attempts -----------------------
  perform mark_notification(e1, g_dad, 'failed', '502 Bad Gateway');
  update gate_notifications set updated_at = now() - interval '10 min'
    where event_id = e1 and guardian_id = g_dad;
  select count(*) into n from retry_notifications(120, 5, 100)
    where event_id = e1 and guardian_id = g_dad;
  if n <> 1 then raise exception 'T8 sweeper returned % rows', n; end if;
  select attempts into n from gate_notifications where event_id = e1 and guardian_id = g_dad;
  if n <> 2 then raise exception 'T8 attempts is % not 2', n; end if;
  raise notice 'T8 ok  failed row retried, attempts 1 -> 2';

  -- T9: a row that ages out while failing is re-scored and dropped ---------
  perform mark_notification(e2, g_mum, 'failed', 'network');
  update gate_notifications set updated_at = now() - interval '10 min'
    where event_id = e2 and guardian_id = g_mum;
  update attendance set scanned_at = now() - interval '6 h' where event_id = e2;
  select count(*) into n from retry_notifications(120, 5, 100)
    where event_id = e2 and guardian_id = g_mum;
  if n <> 0 then raise exception 'T9 aged-out row was still handed out'; end if;
  select count(*) into n from gate_notifications
    where event_id = e2 and guardian_id = g_mum and status = 'suppressed';
  if n <> 1 then raise exception 'T9 aged-out row not suppressed'; end if;
  raise notice 'T9 ok  row that aged out while failing -> suppressed, not sent';

  -- T10: attempts ceiling holds --------------------------------------------
  update gate_notifications set status = 'failed', attempts = 5,
         updated_at = now() - interval '1 h' where event_id = e1 and guardian_id = g_dad;
  select count(*) into n from retry_notifications(120, 5, 100)
    where event_id = e1 and guardian_id = g_dad;
  if n <> 0 then raise exception 'T10 exhausted row retried anyway'; end if;
  raise notice 'T10 ok exhausted row not retried';

  -- T11: enrolment token, single use ---------------------------------------
  tok := issue_enroll_token(ben, 'Mother');
  res := redeem_enroll_token(tok, '333', 'Mum Cruz');
  if not (res->>'ok')::boolean then raise exception 'T11 redeem failed: %', res; end if;
  if res->>'student_name' <> 'Cruz, Ben' then raise exception 'T11 wrong student: %', res; end if;
  if res->>'student_no' <> 'S-1002' then raise exception 'T11 wrong student_no: %', res; end if;
  res := redeem_enroll_token(tok, '333', 'Mum Cruz');
  if (res->>'ok')::boolean or res->>'reason' <> 'already_used' then
    raise exception 'T11 token reusable: %', res; end if;
  raise notice 'T11 ok enrolment token redeems once, then already_used';

  -- T11b: the redeemed guardian landed in pta with a split name ------------
  perform 1 from parents_guardians
    where telegram_chat_id = '333' and first_name = 'Mum' and last_name = 'Cruz'
      and school_id = sch_a;
  if not found then raise exception 'T11b redeemed guardian not created correctly'; end if;
  raise notice 'T11b ok redeemed guardian created in pta.parents_guardians';

  -- T12: expired token rejected --------------------------------------------
  tok := issue_enroll_token(ben, 'Father', interval '-1 s');
  res := redeem_enroll_token(tok, '444', 'Dad Cruz');
  if (res->>'ok')::boolean or res->>'reason' <> 'expired' then
    raise exception 'T12 expired token accepted: %', res; end if;
  raise notice 'T12 ok expired token rejected';

  -- T13: /stop actually stops ----------------------------------------------
  res := set_notify_preference('333', false);
  if not (res->>'ok')::boolean then raise exception 'T13 stop failed: %', res; end if;
  insert into attendance (event_id, school_id, device_id, card_uid, scanned_at, received_at, clock_synced)
    values (e6, sch_a, 'gate-01', '04B2C3D4', now(), now(), true);
  select count(*) into n from claim_notifications(e6);
  if n <> 0 then raise exception 'T13 /stop did not stop, got % rows', n; end if;
  raise notice 'T13 ok /stop suppresses fan-out';

  -- T14: record_attendance stamps school from the device registry ----------
  perform record_attendance(jsonb_build_array(jsonb_build_object(
    'event_id', gen_random_uuid()::text, 'card_uid', '04C3D4E5', 'device_id', 'gate-01',
    'scanned_at', now()::text, 'clock_synced', true,
    'image_path', 'gate-01/2026/08/28/x.jpg')));
  select count(*) into n from attendance
    where card_uid = '04C3D4E5' and image_path = 'gate-01/2026/08/28/x.jpg'
      and school_id = sch_a;
  if n <> 1 then raise exception 'T14 image_path / school_id not stored'; end if;
  raise notice 'T14 ok record_attendance stores image_path and stamps school_id';

  -- T15: retention names old captures ---------------------------------------
  update attendance set received_at = now() - interval '90 days' where event_id = e1;
  select count(*) into n from expired_captures(500) where event_id = e1;
  if n <> 1 then raise exception 'T15 old capture not listed'; end if;
  perform forget_capture(e1);
  select count(*) into n from expired_captures(500) where event_id = e1;
  if n <> 0 then raise exception 'T15 forget_capture did not clear'; end if;
  raise notice 'T15 ok retention lists then clears old captures';

  -- T16: an unregistered device is REFUSED, not silently dropped ------------
  -- The device queues whatever it cannot deliver, so refusing keeps the events
  -- on flash. Skipping them would destroy them while reporting success.
  begin
    perform record_attendance(jsonb_build_array(jsonb_build_object(
      'event_id', gen_random_uuid()::text, 'card_uid', '04A1B2C3',
      'device_id', 'gate-99', 'scanned_at', now()::text)));
    raise exception 'T16 unregistered device was accepted';
  exception when insufficient_privilege then
    get stacked diagnostics msg = message_text;
    if msg not like '%gate-99%' then raise exception 'T16 wrong error: %', msg; end if;
  end;
  select count(*) into n from attendance where device_id = 'gate-99';
  if n <> 0 then raise exception 'T16 rows leaked from unregistered device'; end if;
  raise notice 'T16 ok unregistered device refused, nothing written';

  -- T17: the same card uid at two schools resolves to two different people --
  -- This is the tenancy test. School B's gate reads uid 04A1B2C3 and must get
  -- Zoe Santos, never Ana Reyes -- and must tell nobody at school A.
  perform record_attendance(jsonb_build_array(jsonb_build_object(
    'event_id', gen_random_uuid()::text, 'card_uid', '04A1B2C3',
    'device_id', 'gate-02', 'scanned_at', now()::text, 'clock_synced', true)));
  select count(*) into n from attendance_resolved
    where device_id = 'gate-02' and full_name = 'Santos, Zoe' and school_id = sch_b;
  if n <> 1 then raise exception 'T17 school B scan did not resolve to its own student'; end if;
  select count(*) into n from attendance_resolved
    where device_id = 'gate-02' and school_id = sch_a;
  if n <> 0 then raise exception 'T17 school B scan leaked into school A'; end if;
  select count(*) into n from claim_notifications(
    (select event_id from attendance where device_id = 'gate-02' limit 1));
  if n <> 0 then raise exception 'T17 school B scan notified school A guardians'; end if;
  raise notice 'T17 ok same uid at two schools stays two different students';

  -- T18: a scan resolves to the student number of ITS school year ----------
  -- Not to whatever the student's number happens to be today.
  select count(*) into n from attendance_resolved
    where event_id = e5 and student_no = 'S-1001';
  if n <> 1 then raise exception 'T18 scan did not pick up its year''s student number'; end if;
  raise notice 'T18 ok scan resolves to its own school year''s student number';

end;
$t$;

-- ---------------------------------------------------------------------------
-- T19: the dashboard's read path actually works as service_role.
--
-- This is a GRANTS test, not a logic test. attendance_resolved and gate_roster
-- are security_invoker views, so reading them checks privileges on every base
-- table they touch — students, enrollments, school_years, sections, cards.
-- Miss one grant and the board shows an empty screen with a permission error
-- that points at a view rather than at the table actually refusing.
-- ---------------------------------------------------------------------------
do $t$
declare n int;
begin
  set local role service_role;

  select count(*) into n from pta.attendance_resolved;
  if n = 0 then raise exception 'T19 service_role cannot read attendance_resolved'; end if;

  select count(*) into n from pta.gate_roster;
  if n = 0 then raise exception 'T19 service_role cannot read gate_roster'; end if;

  -- The device→school lookup, and the PostgREST embed the dashboard uses for it.
  select count(*) into n
    from pta.gate_devices d join pta.schools s on s.id = d.school_id;
  if n = 0 then raise exception 'T19 service_role cannot resolve gate_devices -> schools'; end if;

  -- Card enrolment writes.
  select count(*) into n from pta.student_cards;
  if n = 0 then raise exception 'T19 service_role cannot read student_cards'; end if;

  reset role;
  raise notice 'T19 ok service_role can read everything the dashboard needs';
end;
$t$;

-- ---------------------------------------------------------------------------
-- T20: anon can do exactly one thing, and it is not reading anybody's day.
-- ---------------------------------------------------------------------------
do $t$
declare n int; blocked boolean; tbl text;
begin
  set local role anon;

  for tbl in select unnest(array['attendance','students','student_cards',
                                 'parents_guardians','gate_devices']) loop
    blocked := false;
    begin
      execute format('select count(*) from pta.%I', tbl) into n;
    exception when insufficient_privilege then
      blocked := true;
    end;
    if not blocked then
      raise exception 'T20 anon could SELECT pta.% -- it must hold no table privileges', tbl;
    end if;
  end loop;

  reset role;
  raise notice 'T20 ok anon is refused on every gate and roster table';
  raise notice '--- all tests passed ---';
end;
$t$;
