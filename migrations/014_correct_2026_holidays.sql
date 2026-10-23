-- Correct only known erroneous seed labels; preserve operator overrides and history.
UPDATE holidays SET name='Cuti Bersama Hari Raya Idul Fitri 1447 H',type='JOINT_LEAVE'
WHERE holiday_date='2026-03-20' AND name='Hari Suci Nyepi Tahun Baru Saka 1948' AND type='NATIONAL_HOLIDAY';
UPDATE holidays SET name='Hari Raya Idul Adha 1447 Hijriah',type='NATIONAL_HOLIDAY'
WHERE holiday_date='2026-05-27' AND name='Hari Raya Waisak 2570 BE' AND type='NATIONAL_HOLIDAY';
UPDATE holidays SET name='Cuti Bersama Hari Raya Idul Adha 1447 H',type='JOINT_LEAVE'
WHERE holiday_date='2026-05-28' AND name='Hari Raya Idul Adha 1447 Hijriah' AND type='NATIONAL_HOLIDAY';

-- Source: SKB 1497/2025, 2/2025, 5/2025, published by Sekretariat Negara.
-- https://www.setneg.go.id/baca/index/inilah_skb_3_menteri_libur_nasional_dan_cuti_bersama_2026
INSERT INTO holidays(holiday_date,name,type) VALUES
  ('2026-02-16','Cuti Bersama Tahun Baru Imlek 2577 Kongzili','JOINT_LEAVE'),
  ('2026-03-18','Cuti Bersama Hari Suci Nyepi Tahun Baru Saka 1948','JOINT_LEAVE'),
  ('2026-03-19','Hari Suci Nyepi Tahun Baru Saka 1948','NATIONAL_HOLIDAY'),
  ('2026-04-03','Wafat Yesus Kristus','NATIONAL_HOLIDAY'),
  ('2026-04-05','Kebangkitan Yesus Kristus (Paskah)','NATIONAL_HOLIDAY'),
  ('2026-05-15','Cuti Bersama Kenaikan Yesus Kristus','JOINT_LEAVE'),
  ('2026-05-31','Hari Raya Waisak 2570 BE','NATIONAL_HOLIDAY'),
  ('2026-12-24','Cuti Bersama Kelahiran Yesus Kristus','JOINT_LEAVE')
ON CONFLICT(holiday_date) DO NOTHING;
