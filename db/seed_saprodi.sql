-- =============================================================================
-- Agro Supply Chain — Master data saprodi (48 items)
-- Source: Dokumentasi_Role_Approval_Procurement.pdf (2026-08-01), section 6.
--
-- Run standalone against an existing database:
--   mysql -u root -p agro_supply < db/seed_saprodi.sql
-- It is also run automatically by `npm run db:reset` (after seed.sql).
--
-- Written as INSERT ... ON DUPLICATE KEY UPDATE keyed on `item_code`, so it is
-- safe to re-run and safe against a populated production database: existing rows
-- are enriched in place, never deleted, so foreign keys held by
-- pre_finance_distributions / stock_in_items / purchase_request_items /
-- saprodi_reorder_levels stay intact.
--
-- Data notes carried over from the source document:
--  * `item_code` is the unique key. The 2-letter `short_code` is NOT unique —
--    MA is shared by Mango / Manure / Manzate / Machine Sprayer, and BA by
--    Banana / Bambu / Balsa / Bayclin.
--  * `legacy_no` is the original spreadsheet row number; it has gaps (3 -> 5,
--    18 -> 25, 37 -> 39), which is expected and preserved.
--  * ALEXANDER (legacy_no 43) has no unit in the source — unit_id stays NULL.
--  * Source units are inconsistent (kg / Kg / Kilogram, pcs / Pcs); they are
--    normalised here onto the `units` table.
--  * Ta040 is written with a lowercase prefix in the source; normalised to TA040.
-- =============================================================================
USE `agro_supply`;

INSERT INTO `sapropdi` (`item_code`, `short_code`, `category`, `legacy_no`, `sapropdi_name`, `unit_id`, `created_at`, `updated_at`) VALUES
-- Seedlings
('BA001', 'BA', 'Seedlings',   1, 'BANANA SEEDLINGS (BIBIT PISANG)',   8, NOW(), NOW()),
('MA002', 'MA', 'Seedlings',   2, 'MANGO SEEDLINGS (BIBIT MANGGA)',    8, NOW(), NOW()),
('CO003', 'CO', 'Seedlings',   3, 'COFFEE SEEDLINGS (BIBIT KOPI)',     8, NOW(), NOW()),
-- Fertilizer
('MA005', 'MA', 'Fertilizer',  5, 'MANURE',                            1, NOW(), NOW()),
('UR006', 'UR', 'Fertilizer',  6, 'UREA',                              1, NOW(), NOW()),
('KC007', 'KC', 'Fertilizer',  7, 'KCL MAHKOTA',                       1, NOW(), NOW()),
('SP008', 'SP', 'Fertilizer',  8, 'SP-26',                             1, NOW(), NOW()),
('NP009', 'NP', 'Fertilizer',  9, 'NPK',                               1, NOW(), NOW()),
('ZN010', 'ZN', 'Fertilizer', 10, 'ZN',                                1, NOW(), NOW()),
('KI011', 'KI', 'Fertilizer', 11, 'KIESERITE',                         1, NOW(), NOW()),
('ZA012', 'ZA', 'Fertilizer', 12, 'ZA',                                1, NOW(), NOW()),
-- Herbicide / Fungicide / Insecticide / Others
('SI013', 'SI', 'Herbicide',  13, 'SIDAFOS',                           4, NOW(), NOW()),
('NO014', 'NO', 'Herbicide',  14, 'NOXONE',                            4, NOW(), NOW()),
('MA015', 'MA', 'Fungicide',  15, 'MANZATE',                           2, NOW(), NOW()),
('ST016', 'ST', 'Insecticide',16, 'STARBAN',                           4, NOW(), NOW()),
('AD017', 'AD', 'Others',     17, 'ADHEREN (Perekat)',                 4, NOW(), NOW()),
('DO018', 'DO', 'Fertilizer', 18, 'DOLOMITE',                          1, NOW(), NOW()),
('AJ025', 'AJ', 'Others',     25, 'AJIR',                              8, NOW(), NOW()),
('TE028', 'TE', 'Others',     28, 'TENAGA KERJA',                      9, NOW(), NOW()),
('LO029', 'LO', 'Others',     29, 'LOSBUNCH BAG & PITA PANEN',         5, NOW(), NOW()),
('BA030', 'BA', 'Others',     30, 'BAMBU',                             5, NOW(), NOW()),
('BL031', 'BL', 'Fertilizer', 31, 'BLAZE NATURA',                      5, NOW(), NOW()),
('BA032', 'BA', 'Seedlings',  32, 'BALSA SEEDLING (Bibit Balsa)',      8, NOW(), NOW()),
('SE033', 'SE', 'Seedlings',  33, 'SENGON SEEDLING (Bibit Sengon)',    8, NOW(), NOW()),
('TR034', 'TR', 'Fungicide',  34, 'TRICODHERMA',                       5, NOW(), NOW()),
('AS035', 'AS', 'Fungicide',  35, 'ASAM HUMAT',                        5, NOW(), NOW()),
('BU036', 'BU', 'Insecticide',36, 'BULDOK',                            4, NOW(), NOW()),
('RI037', 'RI', 'Insecticide',37, 'RIZOTIN',                           4, NOW(), NOW()),
('GR039', 'GR', 'Herbicide',  39, 'GRAMAXONE',                         4, NOW(), NOW()),
('TA040', 'TA', 'Equipment',  40, 'Tanki Swan Electric F16',           5, NOW(), NOW()),
('RA041', 'RA', 'Others',     41, 'RAFIA',                            13, NOW(), NOW()),
('TA042', 'TA', 'Others',     42, 'TALI STRAP',                       13, NOW(), NOW()),
('AL043', 'AL', 'Others',     43, 'ALEXANDER',                      NULL, NOW(), NOW()),  -- no unit in source
('BU044', 'BU', 'Others',     44, 'BUFOS',                            15, NOW(), NOW()),
('PU045', 'PU', 'Fertilizer', 45, 'PUPUK ORGANIK BIOASTRAL',           1, NOW(), NOW()),
('FE046', 'FE', 'Fertilizer', 46, 'FERTIPHOS',                         1, NOW(), NOW()),
('KO047', 'KO', 'Fertilizer', 47, 'KOMPOS',                            1, NOW(), NOW()),
('SE048', 'SE', 'Fertilizer', 48, 'SEKAM',                             1, NOW(), NOW()),
('RO049', 'RO', 'Herbicide',  49, 'ROUNDUP',                           4, NOW(), NOW()),
('RE050', 'RE', 'Insecticide',50, 'REGENT',                            4, NOW(), NOW()),
('PO051', 'PO', 'Others',     51, 'POLITRON (Adjuvant/Perekat)',       4, NOW(), NOW()),
('TA052', 'TA', 'Others',     52, 'TAWAS',                             1, NOW(), NOW()),
('JA053', 'JA', 'Others',     53, 'JARUM SUNTIK PISANG',              13, NOW(), NOW()),
('BA054', 'BA', 'Others',     54, 'BAYCLIN',                           5, NOW(), NOW()),
('KE055', 'KE', 'Others',     55, 'KERANJANG KONTAINER',               5, NOW(), NOW()),
('PE056', 'PE', 'Others',     56, 'PE FOAM ROLL',                     13, NOW(), NOW()),
('WA057', 'WA', 'Others',     57, 'WARING (JARING)',                  13, NOW(), NOW()),
('MA058', 'MA', 'Equipment',  58, 'MACHINE SPRAYER',                  14, NOW(), NOW())
ON DUPLICATE KEY UPDATE
  `short_code`    = VALUES(`short_code`),
  `category`      = VALUES(`category`),
  `legacy_no`     = VALUES(`legacy_no`),
  `sapropdi_name` = VALUES(`sapropdi_name`),
  `unit_id`       = VALUES(`unit_id`),
  `updated_at`    = NOW();

-- Example reorder levels. Kept here rather than in seed.sql because they reference
-- sapropdi rows, and they are looked up by item_code so they survive id changes.
INSERT INTO `saprodi_reorder_levels` (warehouse_id, sapropdi_id, min_stock, reorder_qty, is_active)
SELECT 1, `id`, 3000, 4000, 1 FROM `sapropdi` WHERE `item_code` = 'UR006'
UNION ALL SELECT 1, `id`, 2000, 3000, 1 FROM `sapropdi` WHERE `item_code` = 'NP009'
UNION ALL SELECT 2, `id`, 1000, 1500, 1 FROM `sapropdi` WHERE `item_code` = 'KC007';
