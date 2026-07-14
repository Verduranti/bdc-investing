-- ============================================================
-- BDC Stress Radar — Seed Data
-- Run after schema.sql. Seeds the BDC universe with CIKs.
-- Safe to re-run (ON CONFLICT DO NOTHING).
-- ============================================================

insert into bdcs (ticker, name, manager, cik, fiscal_year_end) values
  ('ARCC', 'Ares Capital Corporation',        'Ares Management',      '0001287750', 'December'),
  ('BXSL', 'Blackstone Secured Lending Fund', 'Blackstone Credit',    '0001736035', 'December'),
  ('TSLX', 'Sixth Street Specialty Lending',  'Sixth Street Partners','0001559846', 'December'),
  ('GBDC', 'Golub Capital BDC',               'Golub Capital',        '0001476765', 'September'),
  ('FSK',  'FS KKR Capital Corp',             'FS/KKR Advisor',       '0001514281', 'December')
on conflict (ticker) do nothing;
