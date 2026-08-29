-- ===========================================================================
-- DESTRUCTIVE. Clears the simulated roster and its scan history so the board
-- starts empty for real cards and real students.
--
-- Run this ONLY when you are done with the simulator. Nothing here is
-- reversible, and attendance rows are the record you would be discarding.
-- Take a backup first: Supabase dashboard -> Database -> Backups.
--
-- Cards issued to real students are untouched: this only removes the nine
-- seeded UIDs from sql/seed.sql plus the synthetic `burst` UIDs.
-- ===========================================================================

begin;

-- 1. Scans made by the simulator: the nine seeded roster UIDs, the deliberately
--    unregistered DEADC0DE, and the B0000001-style UIDs that `burst n` mints.
delete from mvts_esp32.attendance
where card_uid in (
        '04A1B2C3','04B2C3D4','04C3D4E5','04D4E5F6','04E5F607',
        '04F60718','04071829','0418293A','04293A4B','DEADC0DE')
   or card_uid ~ '^B[0-9]{7}$';

-- 2. The card assignments for those UIDs.
delete from mvts_esp32.student_cards
where card_uid in (
        '04A1B2C3','04B2C3D4','04C3D4E5','04D4E5F6','04E5F607',
        '04F60718','04071829','0418293A','04293A4B');

-- 3. The nine seeded students. Only ones still holding no card are removed, so
--    a demo student you have since given a REAL card to survives.
delete from mvts_esp32.students s
where s.student_no in (
        'S-1001','S-1002','S-1003','S-1004','S-1005',
        'S-1006','S-1007','S-1008','S-1009')
  and not exists (
        select 1 from mvts_esp32.student_cards c where c.student_id = s.id);

commit;
