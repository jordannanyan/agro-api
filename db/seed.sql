-- =============================================================================
-- Agro Supply Chain — Seed data (minimal, for dashboard prototype)
-- Run AFTER schema.sql:  mysql -u root -p agro_supply < db/seed.sql
--
-- All passwords below are bcrypt($2y$) of "password".
-- =============================================================================
USE `agro_supply`;

SET @PW := '$2y$12$e0MYzXyjpJS7Pd0RVvHwHe1DYQyDzYqZ0zK7Yy8mQF3q8m9pC1yfa'; -- "password"

-- Entities. SNBS & JNBS are the operational PTs (they own land, plots, trees).
-- WLI holds Procurement + Finance; NBSV holds Super Admin + Admin. Neither owns land,
-- so both are excluded from GET /api/entities unless ?type=all is passed.
INSERT INTO `entities` (id, entities_name, location, username, password, is_superadmin, entity_type, created_at, updated_at) VALUES
(1, 'PT Sumatra Nature Based Solutions (SNBS)', 'Bengkulu', 'snbs', @PW, 1, 'Operational', NOW(), NOW()),
(2, 'PT Java Nature Based Solutions (JNBS)',    'Java',     'jnbs', @PW, 0, 'Operational', NOW(), NOW()),
(3, 'WLI',                                      NULL,       'wli',  @PW, 0, 'Support',     NOW(), NOW()),
(4, 'NBSV',                                     NULL,       'nbsv', @PW, 0, 'System',      NOW(), NOW());

-- Roles. `role_code` is the stable slug the code compares against; `role_name` is the
-- display label and may be renamed from Settings without breaking authorization.
-- is_cross_entity = 1 means the holder acts across SNBS and JNBS.
INSERT INTO `roles` (id, role_code, role_name, is_cross_entity, created_at, updated_at) VALUES
(1, 'FIELD_ADMIN',     'Field Admin',     0, NOW(), NOW()),
(2, 'PROJECT_MANAGER', 'Project Manager', 0, NOW(), NOW()),
(3, 'PROCUREMENT',     'Procurement',     1, NOW(), NOW()),
(4, 'FINANCE_MANAGER', 'Finance Manager', 1, NOW(), NOW()),
(5, 'FINANCE_STAFF',   'Finance Staff',   1, NOW(), NOW()),
(6, 'DIRECTOR',        'Director',        1, NOW(), NOW()),
(7, 'SUPER_ADMIN',     'Super Admin',     1, NOW(), NOW()),
(8, 'ADMIN',           'Admin',           1, NOW(), NOW());

-- Users (staff login) — the real people from Dokumentasi_Role_Approval_Procurement.pdf.
-- Login accepts either `username` or `email`.
-- NOTE: seeded passwords are all "password" — DEV ONLY. Production accounts get
-- individually generated passwords via scripts/migrateRoles2026-08.js.
INSERT INTO `users` (id, entity_id, role_id, name, username, email, password, position, is_active, created_at, updated_at) VALUES
-- SNBS field admins
(1,  1, 1, 'Elma Aryanti',           'elma.aryanti',      'elma.aryanti@snbs.earth',      @PW, 'Field Admin — buku besar (pembelian & penjualan)', 1, NOW(), NOW()),
(2,  1, 1, 'Bambang Triatmaja',      'bambang.triatmaja', 'bambang.triatmaja@snbs.earth', @PW, 'Field Admin — stok masuk & stok keluar',           1, NOW(), NOW()),
-- JNBS field admin
(3,  2, 1, 'Alfina Octa Shabilla',   'alfina.octa',       'alfina.octa@jnbs.earth',       @PW, 'Field Admin — buku besar & stok masuk/keluar',     1, NOW(), NOW()),
-- Project managers (per entity — this is what makes approval routes entity-specific)
(4,  1, 2, 'Edo Santeyo Lensiyus',   'edo.santeyo',       'edo.santeyo@snbs.earth',       @PW, 'Project Manager SNBS', 1, NOW(), NOW()),
(5,  2, 2, 'Eren Nur Efendi',        'eren.efendi',       'eren.efendi@jnbs.earth',       @PW, 'Project Manager JNBS', 1, NOW(), NOW()),
-- WLI — procurement & finance, cross-entity (serve both SNBS and JNBS)
(6,  3, 3, 'Putri Gandini',          'putri.gandini',     'putri.gandini@wli.earth',      @PW, 'Procurement — membuat PO & Payment Request', 1, NOW(), NOW()),
(7,  3, 4, 'Nyi Arum S',             'nyi.arum',          'nyi.arum@wli.earth',           @PW, 'Director WLI (Plt. Finance Manager)',        1, NOW(), NOW()),
(8,  3, 5, 'Saskia Vianacika',       'saskia.vianacika',  'saskia.vianacika@wli.earth',   @PW, 'Finance Staff — input pembayaran',           1, NOW(), NOW()),
-- Director — covers SNBS and JNBS, so entity_id is NULL (cross-entity)
(9,  NULL, 6, 'M. Rizky Sudirman',   'rizky.sudirman',    'rizky.sudirman@snbs.earth',    @PW, 'Director SNBS / JNBS', 1, NOW(), NOW()),
-- NBSV — system administration, outside the business flow
(10, 4, 7, 'Jordan Nanyan',          'jordan.nanyan',     'jordan.nanyan@nbsv.earth',     @PW, 'Super Admin', 1, NOW(), NOW()),
(11, 4, 8, 'Pinky Kathlea Diatmiko', 'pinky.kathlea',     'pinky.kathlea@nbsv.earth',     @PW, 'Admin',       1, NOW(), NOW()),
(12, 4, 8, 'Sven Koenig',            'sven.koenig',       'sven.koenig@nbsv.earth',       @PW, 'Admin',       1, NOW(), NOW()),
(13, 4, 8, 'Paul Schuller',          'paul.schuller',     'paul.schuller@nbsv.earth',     @PW, 'Admin',       1, NOW(), NOW()),
(14, 3, 8, 'Cindra Veranita',        'cindra.veranita',   'cindra.veranita@wli.earth',    @PW, 'Admin',       1, NOW(), NOW());

-- Master lookups
INSERT INTO `budget_codes` (id, code, name, is_active) VALUES
(1, '1_Investment', 'Investment',  1),
(2, '2_Operational','Operational', 1),
(3, '3_Materials',  'Materials',   1),
(4, '4_Salary',     'Salary',      1),
(5, '5_Transport',  'Transport',   1),
(6, '6_Rent',       'Rent',        1);

INSERT INTO `units` (id, unit_name, symbol) VALUES
(1, 'Kg', 'kg'), (2, 'Gram', 'g'), (3, 'Liter', 'L'), (4, 'Ml', 'ml'),
(5, 'Pcs', 'pcs'), (6, 'Box', 'box'), (7, 'Karung', 'krg'), (8, 'Batang', 'btg'),
(9, 'Hari', 'hari'), (10, 'Trip', 'trip'), (11, 'Bulan', 'bln'), (12, 'Meter', 'm'),
(13, 'Roll', 'roll'), (14, 'Unit', 'unit'), (15, 'Botol', 'btl');

INSERT INTO `payment_methods` (id, method_name, is_active) VALUES
(1, 'Cash', 1), (2, 'Transfer', 1), (3, 'Giro', 1);

INSERT INTO `pre_finance_types` (id, type_name, is_active) VALUES
(1, 'Saprodi', 1), (2, 'Labor', 1), (3, 'Transport', 1), (4, 'Other', 1);

-- Saprodi master (48 items) lives in db/seed_saprodi.sql, which runs right after
-- this file. It is kept separate so it can also be applied on its own to an
-- already-populated database.

INSERT INTO `commodities` (id, commodities_name) VALUES
(1, 'Cocoa'), (2, 'Pisang'), (3, 'Kopi');

INSERT INTO `grade` (id, grade_name) VALUES
(1, 'A'), (2, 'B'), (3, 'C');

INSERT INTO `offtaker` (id, offtaker_name, entities_id) VALUES
(1, 'PT Cocoa Nusantara', 1),
(2, 'Banana Export Co', 2);

-- KTH / Warehouse / Farmers / Plots
INSERT INTO `kth` (id, kth_name, entities_id, username, password) VALUES
(1, 'KTH Sumber Jaya', 1, 'kth_sj', @PW),
(2, 'KTH Maju Bersama', 2, 'kth_mb', @PW);

INSERT INTO `warehouse` (id, warehouse_name, kth_id) VALUES
(1, 'Gudang Utama - Bengkulu', 1),
(2, 'Gudang Lampung', 2);

INSERT INTO `farmers` (id, farmer_name, nik, kth_id, password) VALUES
(1, 'Pak Sumarno',  '1771010101010001', 1, @PW),
(2, 'Pak Sudirman', '1771010101010002', 1, @PW),
(3, 'Rofiq',        '1871010101010003', 2, @PW),
(4, 'Suyanto',      '1871010101010004', 2, @PW);

-- Plots carry the scheme (kategori)
INSERT INTO `plot` (id, plot_name, farmer_id, scheme) VALUES
(1, 'Blok A-12 Kebun Utara', 1, 'BeliPutus'),
(2, 'Blok B-04 Kebun Selatan', 2, 'PreFinance'),
(3, 'CR007002', 3, 'ProfitSharing'),
(4, 'Plot A-01', 4, 'ProfitSharing');

INSERT INTO `collectors` (id, collector_name, kth_id) VALUES
(1, 'Collector Sumberjaya', 1),
(2, 'Collector Lampung', 2);

-- Vendors
INSERT INTO `vendors` (id, vendor_name, contact_person, phone, email, npwp, bank_name, bank_account, beneficiary_name, category, status) VALUES
(1, 'CV Tani Makmur', 'Pak Joko', '081234567890', 'tani@makmur.id', '01.234.567.8-901.000', 'BCA', '1234567890', 'CV Tani Makmur', 'Saprodi', 'Aktif'),
(2, 'PT Alat Pertanian', 'Bu Rina', '081298765432', 'sales@alattani.id', '02.345.678.9-012.000', 'Mandiri', '9876543210', 'PT Alat Pertanian', 'Equipment', 'Aktif');

-- -----------------------------------------------------------------------------
-- Approval routes — per entity, per document type.
-- Source: Dokumentasi_Role_Approval_Procurement.pdf (2026-08-01), sections 4 & 5.
--
-- Routes are entity-specific because the Project Manager differs per PT
-- (SNBS = Edo Santeyo, JNBS = Eren Nur Efendi). seedApprovalSteps() prefers an
-- entity's own routes and only falls back to entity_id IS NULL rows.
--
-- Roles: 1=Field Admin  2=Project Manager  3=Procurement
--        4=Finance Manager  5=Finance Staff  6=Director
--
-- Note the deliberate PO vs PayReq asymmetry: on a PO the Finance Manager only
-- acknowledges and the Director gives final approval; on a PayReq the Finance
-- Manager approves and the Director drops to acknowledging. Spending commitments
-- are sanctioned by the Director; releasing cash needs a finance sign-off and the
-- Director merely needs to know. Do not "tidy" this into a uniform chain.
-- -----------------------------------------------------------------------------
INSERT INTO `approval_routes` (document_type, entity_id, step_order, step_label, role_id, min_amount, max_amount) VALUES
-- ---- SNBS (entity 1) ----
('PR',     1, 1, 'Requested',    1, NULL, NULL),
('PR',     1, 2, 'Approved',     2, NULL, NULL),
('PR',     1, 3, 'Acknowledged', 4, NULL, NULL),
('PO',     1, 1, 'Requested',    3, NULL, NULL),
('PO',     1, 2, 'Approved',     2, NULL, NULL),
('PO',     1, 3, 'Acknowledged', 4, NULL, NULL),
('PO',     1, 4, 'Approved',     6, NULL, NULL),
('PayReq', 1, 1, 'Requested',    3, NULL, NULL),
('PayReq', 1, 2, 'Approved',     2, NULL, NULL),
('PayReq', 1, 3, 'Approved',     4, NULL, NULL),
('PayReq', 1, 4, 'Acknowledged', 6, NULL, NULL),
-- ---- JNBS (entity 2) ----
('PR',     2, 1, 'Requested',    1, NULL, NULL),
('PR',     2, 2, 'Approved',     2, NULL, NULL),
('PR',     2, 3, 'Acknowledged', 4, NULL, NULL),
('PO',     2, 1, 'Requested',    3, NULL, NULL),
('PO',     2, 2, 'Approved',     2, NULL, NULL),
('PO',     2, 3, 'Acknowledged', 4, NULL, NULL),
('PO',     2, 4, 'Approved',     6, NULL, NULL),
('PayReq', 2, 1, 'Requested',    3, NULL, NULL),
('PayReq', 2, 2, 'Approved',     2, NULL, NULL),
('PayReq', 2, 3, 'Approved',     4, NULL, NULL),
('PayReq', 2, 4, 'Acknowledged', 6, NULL, NULL);
-- PayReq step 5 (Payment Process) is intentionally NOT a route row: it is cash
-- execution, not approval. POST /api/payment-requests/:id/pay writes it, and both
-- Finance Manager and Finance Staff may call that endpoint.

-- Reorder levels are seeded in db/seed_saprodi.sql — they reference sapropdi rows,
-- which do not exist yet at this point in the script.

-- Budgets (contoh)
INSERT INTO `budgets` (entity_id, period, budget_code_id, sub_category, budget_amount) VALUES
(1, '2026', 3, 'Fertilizer & Pesticide', 500000000),
(1, '2026', 1, 'Equipment',              200000000),
(2, '2026', 3, 'Fertilizer & Pesticide', 350000000);
