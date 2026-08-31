-- ===========================================================================
-- ONE-TIME CUTOVER: mvts_esp32  ->  pta
--
-- Moves the gate off its own schema and onto the PTA Collections database, so
-- there is one roster and one guardian list instead of two.
--
-- RUN THIS AFTER 0013_gate_attendance.sql (in the pta-collections repo) has
-- been applied. Run it in the Supabase SQL Editor, like every other production
-- migration on this shared project. Never `supabase db push`.
--
-- BEFORE YOU START: take a backup. Dashboard -> Database -> Backups. Step 4
-- is the only destructive-by-omission part -- simulated attendance is not
-- carried across -- and nothing here is reversible without one.
--
-- EDIT THIS ONE LINE:  the school_code of the school the gate belongs to.
-- It must already exist in pta.schools. The script fails loudly if it does not,
-- rather than inventing a tenant for you.
-- ===========================================================================

do $cutover$
declare
  -- >>> EDIT ME <<<
  c_school_code constant text := 'MVTS';
  c_device_id   constant text := 'gate-01';
  c_device_label constant text := 'Main gate';

  -- The simulator's roster from include/config.h, plus the deliberately
  -- unregistered DEADC0DE. `burst n` mints B0000001-style uids, matched by
  -- regex below. None of these are real cards and none are worth keeping.
  c_demo_uids constant text[] := array[
    '04A1B2C3','04B2C3D4','04C3D4E5','04D4E5F6','04E5F607',
    '04F60718','04071829','0418293A','04293A4B','DEADC0DE'
  ];

  v_school   uuid;
  v_moved    integer;
  v_skipped  integer;
  v_uids     text;
  v_guardian uuid;
  r          record;
begin
  if to_regclass('mvts_esp32.attendance') is null then
    raise notice 'mvts_esp32 is already gone -- nothing to cut over.';
    return;
  end if;

  -- 1. Resolve the tenant. ---------------------------------------------------
  select id into v_school from pta.schools where school_code = c_school_code;
  if not found then
    raise exception
      'No school with school_code %. Create it in PTA Collections first, or fix c_school_code at the top of this file.',
      c_school_code;
  end if;
  raise notice 'Cutting the gate over to school % (%)', c_school_code, v_school;

  -- 2. Register the device. This is what turns DEVICE_ID into a school from
  --    now on; without it record_attendance() refuses every batch. -----------
  insert into pta.gate_devices (device_id, school_id, label)
  values (c_device_id, v_school, c_device_label)
  on conflict (device_id) do update
    set school_id = excluded.school_id,
        label     = excluded.label,
        active    = true;
  raise notice 'Device % registered.', c_device_id;

  -- 3. Carry the notification thresholds across, defaults and all. -----------
  insert into pta.gate_notify_config
    (school_id, enabled, fresh_within_s, suppress_after_s, capture_retention_days)
  select v_school, c.enabled, c.fresh_within_s, c.suppress_after_s, c.capture_retention_days
    from mvts_esp32.notify_config c
   where c.id
  on conflict (school_id) do nothing;
  -- If the old table was empty for any reason, fall back to the defaults.
  insert into pta.gate_notify_config (school_id) values (v_school)
  on conflict (school_id) do nothing;

  -- 4. Carry REAL attendance across. ----------------------------------------
  --    event_id is preserved, so this whole script is safe to re-run: the
  --    second pass conflicts on every row and moves nothing.
  --
  --    Simulated scans are left behind deliberately. They resolve to demo
  --    students who are not coming with us, so carrying them would fill the
  --    board with rows that say "unknown card" forever.
  insert into pta.attendance (
    event_id, school_id, device_id, card_uid, scanned_at, received_at,
    clock_synced, direction, queued, image_path
  )
  select a.event_id, v_school, c_device_id, upper(a.card_uid), a.scanned_at,
         a.received_at, a.clock_synced,
         case when a.direction in ('in','out') then a.direction else 'in' end,
         a.queued, a.image_path
    from mvts_esp32.attendance a
   where upper(a.card_uid) <> all (c_demo_uids)
     and a.card_uid !~ '^B[0-9]{7}$'
  on conflict (event_id) do nothing;
  get diagnostics v_moved = row_count;

  select count(*) into v_skipped from mvts_esp32.attendance a
   where upper(a.card_uid) = any (c_demo_uids) or a.card_uid ~ '^B[0-9]{7}$';

  raise notice '% real attendance rows moved; % simulated rows left behind.',
    v_moved, v_skipped;

  -- 5. Report the real cards. ------------------------------------------------
  --    They are NOT recreated in pta.student_cards: every one of them is
  --    currently issued to a demo student who does not exist in pta, and a card
  --    pointing at the wrong child is worse than a card pointing at nobody.
  --    They surface on /enroll as unassigned (the scans above are what puts
  --    them there) and get bound to real PTA students by hand.
  select string_agg(distinct upper(card_uid), ', ' order by upper(card_uid))
    into v_uids
    from mvts_esp32.attendance
   where upper(card_uid) <> all (c_demo_uids)
     and card_uid !~ '^B[0-9]{7}$';

  if v_uids is null then
    raise notice 'No real cards had been tapped yet -- nothing to re-enrol.';
  else
    raise notice 'RE-ENROL THESE CARDS on /enroll (they are unassigned now): %', v_uids;
  end if;

  -- 6. Carry linked guardians across. ---------------------------------------
  --    Only the Telegram link is portable. Their student link pointed at a demo
  --    student, so it is NOT recreated -- re-link via the enrolment QR or in
  --    PTA Collections. Without a student link they receive nothing, which is
  --    the correct failure: silence, not somebody else's child.
  for r in
    select g.full_name, g.telegram_chat_id, g.linked_at
      from mvts_esp32.guardians g
     where g.telegram_chat_id is not null and g.active
  loop
    select id into v_guardian
      from pta.parents_guardians
     where school_id = v_school and telegram_chat_id = r.telegram_chat_id;

    if v_guardian is null then
      insert into pta.parents_guardians
        (school_id, first_name, last_name, telegram_chat_id, telegram_active, telegram_linked_at)
      values (
        v_school,
        coalesce(nullif(btrim(regexp_replace(r.full_name, '\s+\S+$', '')), ''), r.full_name),
        coalesce((regexp_match(r.full_name, '(\S+)$'))[1], r.full_name),
        r.telegram_chat_id, true, coalesce(r.linked_at, now())
      );
      raise notice 'Guardian "%" (chat %) created -- NOT yet linked to a student.',
        r.full_name, r.telegram_chat_id;
    else
      update pta.parents_guardians
         set telegram_chat_id   = r.telegram_chat_id,
             telegram_active    = true,
             telegram_linked_at = coalesce(telegram_linked_at, r.linked_at, now())
       where id = v_guardian;
      raise notice 'Guardian "%" (chat %) already in pta -- Telegram link refreshed.',
        r.full_name, r.telegram_chat_id;
    end if;
  end loop;

  raise notice '--- cutover complete ---';
  raise notice 'Next: deploy the dashboard and edge functions, re-point the';
  raise notice 'Database Webhook at pta.attendance, then flash the firmware.';
end;
$cutover$;

-- ===========================================================================
-- LAST STEP -- deliberately not run by the script above.
--
-- Only after the gate is verified end to end on `pta`: a real tap lands in
-- pta.attendance, the board shows it, and a guardian gets their message. Until
-- then mvts_esp32 is the rollback.
--
-- Also remove `mvts_esp32` from Settings -> API -> Exposed schemas.
-- ===========================================================================
-- drop schema mvts_esp32 cascade;
