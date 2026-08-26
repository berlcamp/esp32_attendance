-- Nine simulated students matching kRoster in include/config.h.
-- The tenth roster UID (DEADC0DE) is deliberately NOT registered: it is how
-- you see what your web app does with an unknown card before a real student
-- shows up holding one.
insert into mvts_esp32.students (full_name, student_no) values
  ('Ana Reyes',        'S-1001'),
  ('Ben Cruz',         'S-1002'),
  ('Cara Domingo',     'S-1003'),
  ('Dino Espino',      'S-1004'),
  ('Elena Fajardo',    'S-1005'),
  ('Franco Gutierrez', 'S-1006'),
  ('Gina Herrera',     'S-1007'),
  ('Hector Ilagan',    'S-1008'),
  ('Ivy Jimenez',      'S-1009')
on conflict (student_no) do nothing;

insert into mvts_esp32.student_cards (student_id, card_uid)
select s.id, v.uid
from (values
  ('S-1001','04A1B2C3'), ('S-1002','04B2C3D4'), ('S-1003','04C3D4E5'),
  ('S-1004','04D4E5F6'), ('S-1005','04E5F607'), ('S-1006','04F60718'),
  ('S-1007','04071829'), ('S-1008','0418293A'), ('S-1009','04293A4B')
) as v(student_no, uid)
join mvts_esp32.students s on s.student_no = v.student_no
on conflict do nothing;
