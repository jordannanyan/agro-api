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
-- Units are resolved BY NAME, never by a hard-coded id. A database that was
-- seeded at a different time can easily hold different unit ids, and assuming
-- otherwise fails the fk_sapropdi_unit foreign key. The units this file needs
-- are upserted first, so 'Botol' exists even on databases seeded before it was
-- introduced.
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

-- Make sure every unit this file references exists. `units.unit_name` is unique,
-- so re-running leaves existing rows (and their ids) untouched.
INSERT INTO `units` (`unit_name`, `symbol`, `created_at`, `updated_at`) VALUES
  ('Kg',     'kg',   NOW(), NOW()),
  ('Gram',   'g',    NOW(), NOW()),
  ('Ml',     'ml',   NOW(), NOW()),
  ('Pcs',    'pcs',  NOW(), NOW()),
  ('Batang', 'btg',  NOW(), NOW()),
  ('Hari',   'hari', NOW(), NOW()),
  ('Roll',   'roll', NOW(), NOW()),
  ('Unit',   'unit', NOW(), NOW()),
  ('Botol',  'btl',  NOW(), NOW())
ON DUPLICATE KEY UPDATE `unit_name` = VALUES(`unit_name`);

INSERT INTO `sapropdi`
  (`item_code`, `short_code`, `category`, `legacy_no`, `sapropdi_name`, `unit_id`, `created_at`, `updated_at`)
SELECT d.item_code, d.short_code, d.category, d.legacy_no, d.sapropdi_name, u.id, NOW(), NOW()
FROM (
            SELECT 'BA001' AS item_code, 'BA' AS short_code, 'Seedlings' AS category, 1 AS legacy_no, 'BANANA SEEDLINGS (BIBIT PISANG)' AS sapropdi_name, 'Batang' AS unit_name
  UNION ALL SELECT 'MA002', 'MA', 'Seedlings',    2, 'MANGO SEEDLINGS (BIBIT MANGGA)',  'Batang'
  UNION ALL SELECT 'CO003', 'CO', 'Seedlings',    3, 'COFFEE SEEDLINGS (BIBIT KOPI)',   'Batang'
  UNION ALL SELECT 'MA005', 'MA', 'Fertilizer',   5, 'MANURE',                          'Kg'
  UNION ALL SELECT 'UR006', 'UR', 'Fertilizer',   6, 'UREA',                            'Kg'
  UNION ALL SELECT 'KC007', 'KC', 'Fertilizer',   7, 'KCL MAHKOTA',                     'Kg'
  UNION ALL SELECT 'SP008', 'SP', 'Fertilizer',   8, 'SP-26',                           'Kg'
  UNION ALL SELECT 'NP009', 'NP', 'Fertilizer',   9, 'NPK',                             'Kg'
  UNION ALL SELECT 'ZN010', 'ZN', 'Fertilizer',  10, 'ZN',                              'Kg'
  UNION ALL SELECT 'KI011', 'KI', 'Fertilizer',  11, 'KIESERITE',                       'Kg'
  UNION ALL SELECT 'ZA012', 'ZA', 'Fertilizer',  12, 'ZA',                              'Kg'
  UNION ALL SELECT 'SI013', 'SI', 'Herbicide',   13, 'SIDAFOS',                         'Ml'
  UNION ALL SELECT 'NO014', 'NO', 'Herbicide',   14, 'NOXONE',                          'Ml'
  UNION ALL SELECT 'MA015', 'MA', 'Fungicide',   15, 'MANZATE',                         'Gram'
  UNION ALL SELECT 'ST016', 'ST', 'Insecticide', 16, 'STARBAN',                         'Ml'
  UNION ALL SELECT 'AD017', 'AD', 'Others',      17, 'ADHEREN (Perekat)',               'Ml'
  UNION ALL SELECT 'DO018', 'DO', 'Fertilizer',  18, 'DOLOMITE',                        'Kg'
  UNION ALL SELECT 'AJ025', 'AJ', 'Others',      25, 'AJIR',                            'Batang'
  UNION ALL SELECT 'TE028', 'TE', 'Others',      28, 'TENAGA KERJA',                    'Hari'
  UNION ALL SELECT 'LO029', 'LO', 'Others',      29, 'LOSBUNCH BAG & PITA PANEN',       'Pcs'
  UNION ALL SELECT 'BA030', 'BA', 'Others',      30, 'BAMBU',                           'Pcs'
  UNION ALL SELECT 'BL031', 'BL', 'Fertilizer',  31, 'BLAZE NATURA',                    'Pcs'
  UNION ALL SELECT 'BA032', 'BA', 'Seedlings',   32, 'BALSA SEEDLING (Bibit Balsa)',    'Batang'
  UNION ALL SELECT 'SE033', 'SE', 'Seedlings',   33, 'SENGON SEEDLING (Bibit Sengon)',  'Batang'
  UNION ALL SELECT 'TR034', 'TR', 'Fungicide',   34, 'TRICODHERMA',                     'Pcs'
  UNION ALL SELECT 'AS035', 'AS', 'Fungicide',   35, 'ASAM HUMAT',                      'Pcs'
  UNION ALL SELECT 'BU036', 'BU', 'Insecticide', 36, 'BULDOK',                          'Ml'
  UNION ALL SELECT 'RI037', 'RI', 'Insecticide', 37, 'RIZOTIN',                         'Ml'
  UNION ALL SELECT 'GR039', 'GR', 'Herbicide',   39, 'GRAMAXONE',                       'Ml'
  UNION ALL SELECT 'TA040', 'TA', 'Equipment',   40, 'Tanki Swan Electric F16',         'Pcs'
  UNION ALL SELECT 'RA041', 'RA', 'Others',      41, 'RAFIA',                           'Roll'
  UNION ALL SELECT 'TA042', 'TA', 'Others',      42, 'TALI STRAP',                      'Roll'
  UNION ALL SELECT 'AL043', 'AL', 'Others',      43, 'ALEXANDER',                       NULL      -- no unit in source
  UNION ALL SELECT 'BU044', 'BU', 'Others',      44, 'BUFOS',                           'Botol'
  UNION ALL SELECT 'PU045', 'PU', 'Fertilizer',  45, 'PUPUK ORGANIK BIOASTRAL',         'Kg'
  UNION ALL SELECT 'FE046', 'FE', 'Fertilizer',  46, 'FERTIPHOS',                       'Kg'
  UNION ALL SELECT 'KO047', 'KO', 'Fertilizer',  47, 'KOMPOS',                          'Kg'
  UNION ALL SELECT 'SE048', 'SE', 'Fertilizer',  48, 'SEKAM',                           'Kg'
  UNION ALL SELECT 'RO049', 'RO', 'Herbicide',   49, 'ROUNDUP',                         'Ml'
  UNION ALL SELECT 'RE050', 'RE', 'Insecticide', 50, 'REGENT',                          'Ml'
  UNION ALL SELECT 'PO051', 'PO', 'Others',      51, 'POLITRON (Adjuvant/Perekat)',     'Ml'
  UNION ALL SELECT 'TA052', 'TA', 'Others',      52, 'TAWAS',                           'Kg'
  UNION ALL SELECT 'JA053', 'JA', 'Others',      53, 'JARUM SUNTIK PISANG',             'Roll'
  UNION ALL SELECT 'BA054', 'BA', 'Others',      54, 'BAYCLIN',                         'Pcs'
  UNION ALL SELECT 'KE055', 'KE', 'Others',      55, 'KERANJANG KONTAINER',             'Pcs'
  UNION ALL SELECT 'PE056', 'PE', 'Others',      56, 'PE FOAM ROLL',                    'Roll'
  UNION ALL SELECT 'WA057', 'WA', 'Others',      57, 'WARING (JARING)',                 'Roll'
  UNION ALL SELECT 'MA058', 'MA', 'Equipment',   58, 'MACHINE SPRAYER',                 'Unit'
) d
LEFT JOIN `units` u ON u.`unit_name` = d.unit_name
ON DUPLICATE KEY UPDATE
  `short_code`    = VALUES(`short_code`),
  `category`      = VALUES(`category`),
  `legacy_no`     = VALUES(`legacy_no`),
  `sapropdi_name` = VALUES(`sapropdi_name`),
  `unit_id`       = VALUES(`unit_id`),
  `updated_at`    = NOW();

-- Example reorder levels. Kept here rather than in seed.sql because they reference
-- sapropdi rows, and they are looked up by item_code so they survive id changes.
-- Skipped when the warehouse does not exist, and not duplicated on a re-run.
INSERT INTO `saprodi_reorder_levels` (`warehouse_id`, `sapropdi_id`, `min_stock`, `reorder_qty`, `is_active`)
SELECT w.id, s.id, d.min_stock, d.reorder_qty, 1
FROM (
            SELECT 1 AS warehouse_id, 'UR006' AS item_code, 3000 AS min_stock, 4000 AS reorder_qty
  UNION ALL SELECT 1, 'NP009', 2000, 3000
  UNION ALL SELECT 2, 'KC007', 1000, 1500
) d
JOIN `warehouse` w ON w.id = d.warehouse_id
JOIN `sapropdi`  s ON s.`item_code` = d.item_code
LEFT JOIN `saprodi_reorder_levels` r ON r.`warehouse_id` = w.id AND r.`sapropdi_id` = s.id
WHERE r.id IS NULL;
