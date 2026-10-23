-- =============================================================================
-- Agro Supply Chain — Seed data (minimal, for dashboard prototype)
-- Run AFTER schema.sql:  mysql -u root -p agro_supply < db/seed.sql
--
-- All passwords below are bcrypt($2y$) of "password".
-- =============================================================================
USE `agro_supply`;

-- Real bcrypt($2y$, cost 12) of "password" — verified, not a placeholder. The
-- value that stood here before was a hand-made lookalike that matched nothing, so
-- a database seeded straight from this file could not be logged into at all.
-- scripts/dbReset.js overwrites this line with a freshly computed hash; loading
-- the file with the mysql client does not, which is why it has to be valid here.
SET @PW := '$2y$12$Lr1i7GB267U0dF97snB5YezDZC2W155ZZSvik59rvMmRc45/GJDA6'; -- "password"

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
(8, 'ADMIN',           'Admin',           1, NOW(), NOW()),
-- Runs a warehouse and nothing else: no purchase requests, no purchasing,
-- no KTH. Entity-bound, like the Field Admin they sit beside.
(9, 'WAREHOUSE_STAFF', 'Pegawai Gudang', 0, NOW(), NOW()),
-- HR at WLI. Files the two payment requests that never come from procurement —
-- the farmer reimbursement paid through a KTH, and the expense somebody laid out —
-- and approves nothing. Cross-entity: one of them serves every PT.
(10, 'HR', 'HR', 1, NOW(), NOW()),
-- Group / HQ. Reads every PT like the Admin and changes nothing in the operational
-- modules; signs the Director and HQ stages of the Fund Request when listed in
-- fund_request_signers. No Settings access — that stays with the Admin.
(11, 'HQ', 'HQ', 1, NOW(), NOW());

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
(12, 4, 11, 'Sven Koenig',           'sven.koenig',       'sven.koenig@nbsv.earth',       @PW, '[HQ] Group COO', 1, NOW(), NOW()),
(13, 4, 11, 'Paul Schuller',         'paul.schuller',     'paul.schuller@nbsv.earth',     @PW, '[HQ] Director',  1, NOW(), NOW()),
(14, 3, 8, 'Cindra Veranita',        'cindra.veranita',   'cindra.veranita@wli.earth',    @PW, 'Admin',       1, NOW(), NOW()),
-- Director of WLI — co-signs the Director stage of every Fund Request.
(15, 3, 11, 'Arim',                  'arim',              'arim@wli.earth',               @PW, '[WLI] Director', 1, NOW(), NOW());

-- Fund Request signers (Director stage: both must sign; then HQ: both must sign).
INSERT INTO `fund_request_signers` (stage, user_id, entity_id, title, sort_order, is_active, created_at, updated_at) VALUES
('director', 9,  NULL, '[IDN] Director (Entity)', 1, 1, NOW(), NOW()),
('director', 15, NULL, '[WLI] Director',          2, 1, NOW(), NOW()),
('hq',       12, NULL, '[HQ] Group COO',          1, 1, NOW(), NOW()),
('hq',       13, NULL, '[HQ] Director',           2, 1, NOW(), NOW());

-- Master lookups
-- Budget codes and finance dimensions — 260929_SPV_Budget Codes Master File.xlsx (sheet COA).
INSERT INTO `budget_codes` (id, code, name, main_account, sub_account, sort_order, is_active) VALUES
(1, '01-Operational Expenditures - Commission-Offtake', 'Commission-Offtake', 'Operational Expenditures', 'Commission-Offtake', 1, 1),
(2, '01-Operational Expenditures - Delivery Costs-Non-Offtake', 'Delivery Costs-Non-Offtake', 'Operational Expenditures', 'Delivery Costs-Non-Offtake', 2, 1),
(3, '01-Operational Expenditures - Delivery Costs-Offtake', 'Delivery Costs-Offtake', 'Operational Expenditures', 'Delivery Costs-Offtake', 3, 1),
(4, '01-Operational Expenditures - Labour-Non Offtake', 'Labour-Non Offtake', 'Operational Expenditures', 'Labour-Non Offtake', 4, 1),
(5, '01-Operational Expenditures - Labour-Offtake', 'Labour-Offtake', 'Operational Expenditures', 'Labour-Offtake', 5, 1),
(6, '01-Operational Expenditures - Maintenance', 'Maintenance', 'Operational Expenditures', 'Maintenance', 6, 1),
(7, '01-Operational Expenditures - Material-Non-Offtake', 'Material-Non-Offtake', 'Operational Expenditures', 'Material-Non-Offtake', 7, 1),
(8, '01-Operational Expenditures - Material-Offtake', 'Material-Offtake', 'Operational Expenditures', 'Material-Offtake', 8, 1),
(9, '01-Operational Expenditures - Profit Sharing', 'Profit Sharing', 'Operational Expenditures', 'Profit Sharing', 9, 1),
(10, '01-Operational Expenditures - Purchase-Offtake', 'Purchase-Offtake', 'Operational Expenditures', 'Purchase-Offtake', 10, 1),
(11, '01-Operational Expenditures - Rental Expenses - Building', 'Rental Expenses - Building', 'Operational Expenditures', 'Rental Expenses - Building', 11, 1),
(12, '01-Operational Expenditures - Socialisation Cost', 'Socialisation Cost', 'Operational Expenditures', 'Socialisation Cost', 12, 1),
(13, '02-Investment Expenditures - Building Costs', 'Building Costs', 'Investment Expenditures', 'Building Costs', 13, 1),
(14, '02-Investment Expenditures - Fixed Asset - Office Equipment', 'Fixed Asset - Office Equipment', 'Investment Expenditures', 'Fixed Asset - Office Equipment', 14, 1),
(15, '02-Investment Expenditures - Fixed Asset - PP&E', 'Fixed Asset - PP&E', 'Investment Expenditures', 'Fixed Asset - PP&E', 15, 1),
(16, '02-Investment Expenditures - Fixed Asset - Vehicle', 'Fixed Asset - Vehicle', 'Investment Expenditures', 'Fixed Asset - Vehicle', 16, 1),
(17, '03-Financing Expenditures - Injection - Capital', 'Injection - Capital', 'Financing Expenditures', 'Injection - Capital', 17, 1),
(18, '03-Financing Expenditures - Injection - Equity', 'Injection - Equity', 'Financing Expenditures', 'Injection - Equity', 18, 1),
(19, '03-Financing Expenditures - Injection - Loan', 'Injection - Loan', 'Financing Expenditures', 'Injection - Loan', 19, 1),
(20, '04-Personnel Expenditures - Compensation', 'Compensation', 'Personnel Expenditures', 'Compensation', 20, 1),
(21, '04-Personnel Expenditures - Net Salary', 'Net Salary', 'Personnel Expenditures', 'Net Salary', 21, 1),
(22, '04-Personnel Expenditures - Religious Allowance', 'Religious Allowance', 'Personnel Expenditures', 'Religious Allowance', 22, 1),
(23, '04-Personnel Expenditures - Social Security', 'Social Security', 'Personnel Expenditures', 'Social Security', 23, 1),
(24, '05-Travel Expenditures - Rental Expenses - Car/Bike Rental', 'Rental Expenses - Car/Bike Rental', 'Travel Expenditures', 'Rental Expenses - Car/Bike Rental', 24, 1),
(25, '05-Travel Expenditures - Travel Expenses - Accommodation', 'Travel Expenses - Accommodation', 'Travel Expenditures', 'Travel Expenses - Accommodation', 25, 1),
(26, '05-Travel Expenditures - Travel Expenses - Bus/Travel Ticket', 'Travel Expenses - Bus/Travel Ticket', 'Travel Expenditures', 'Travel Expenses - Bus/Travel Ticket', 26, 1),
(27, '05-Travel Expenditures - Travel Expenses - Flight Ticket', 'Travel Expenses - Flight Ticket', 'Travel Expenditures', 'Travel Expenses - Flight Ticket', 27, 1),
(28, '05-Travel Expenditures - Travel Expenses - Food/Drink Consumption With External', 'Travel Expenses - Food/Drink Consumption With External', 'Travel Expenditures', 'Travel Expenses - Food/Drink Consumption With External', 28, 1),
(29, '05-Travel Expenditures - Travel Expenses - Gasoline', 'Travel Expenses - Gasoline', 'Travel Expenditures', 'Travel Expenses - Gasoline', 29, 1),
(30, '05-Travel Expenditures - Travel Expenses - Per Diem', 'Travel Expenses - Per Diem', 'Travel Expenditures', 'Travel Expenses - Per Diem', 30, 1),
(31, '05-Travel Expenditures - Travel Expenses - Travel-Related Cost', 'Travel Expenses - Travel-Related Cost', 'Travel Expenditures', 'Travel Expenses - Travel-Related Cost', 31, 1),
(32, '06-Administrative Expenditures - Bank Fee/Charge', 'Bank Fee/Charge', 'Administrative Expenditures', 'Bank Fee/Charge', 32, 1),
(33, '06-Administrative Expenditures - Internal Cash Out', 'Internal Cash Out', 'Administrative Expenditures', 'Internal Cash Out', 33, 1),
(34, '06-Administrative Expenditures - License', 'License', 'Administrative Expenditures', 'License', 34, 1),
(35, '06-Administrative Expenditures - Medical Support', 'Medical Support', 'Administrative Expenditures', 'Medical Support', 35, 1),
(36, '06-Administrative Expenditures - Office Expenses - Cleaning Service', 'Office Expenses - Cleaning Service', 'Administrative Expenditures', 'Office Expenses - Cleaning Service', 36, 1),
(37, '06-Administrative Expenditures - Office Expenses - Equipments', 'Office Expenses - Equipments', 'Administrative Expenditures', 'Office Expenses - Equipments', 37, 1),
(38, '06-Administrative Expenditures - Office Expenses - Supplies', 'Office Expenses - Supplies', 'Administrative Expenditures', 'Office Expenses - Supplies', 38, 1),
(39, '06-Administrative Expenditures - Office Expenses - Utilities', 'Office Expenses - Utilities', 'Administrative Expenditures', 'Office Expenses - Utilities', 39, 1),
(40, '06-Administrative Expenditures - Other G&A', 'Other G&A', 'Administrative Expenditures', 'Other G&A', 40, 1),
(41, '06-Administrative Expenditures - Team Events', 'Team Events', 'Administrative Expenditures', 'Team Events', 41, 1),
(42, '06-Administrative Expenditures - Training', 'Training', 'Administrative Expenditures', 'Training', 42, 1),
(43, '06-Administrative Expenditures - Vehicle Administration', 'Vehicle Administration', 'Administrative Expenditures', 'Vehicle Administration', 43, 1),
(44, '07-External Services - Audit', 'Audit', 'External Services', 'Audit', 44, 1),
(45, '07-External Services - Consulting', 'Consulting', 'External Services', 'Consulting', 45, 1),
(46, '07-External Services - Service Fee Affiliate Companies', 'Service Fee Affiliate Companies', 'External Services', 'Service Fee Affiliate Companies', 46, 1),
(47, '07-External Services - Tax/Legal Advise', 'Tax/Legal Advise', 'External Services', 'Tax/Legal Advise', 47, 1),
(48, '08-Tax Expenditures - Income Tax - Expenses', 'Income Tax - Expenses', 'Tax Expenditures', 'Income Tax - Expenses', 48, 1),
(49, '08-Tax Expenditures - Income Tax Article 21', 'Income Tax Article 21', 'Tax Expenditures', 'Income Tax Article 21', 49, 1),
(50, '08-Tax Expenditures - Income Tax Article 23', 'Income Tax Article 23', 'Tax Expenditures', 'Income Tax Article 23', 50, 1),
(51, '08-Tax Expenditures - Income Tax Article 4 (2)', 'Income Tax Article 4 (2)', 'Tax Expenditures', 'Income Tax Article 4 (2)', 51, 1);

INSERT INTO `finance_dimensions` (dim_type, name, sort_order, is_active) VALUES
('cash_flow_type', 'Cash Inflow', 1, 1),
('cash_flow_type', 'Cash Outflow', 2, 1),
('budget_purpose', 'Overhead', 1, 1),
('budget_purpose', 'Operational Non-Offtake', 2, 1),
('budget_purpose', 'Operational Offtake', 3, 1),
('profit_center', 'Social Forestry - Secured - East Lampung', 1, 1),
('profit_center', 'Social Forestry - Secured - KUPS Sumber Jaya', 2, 1),
('profit_center', 'Social Forestry - Secured - Tulungagung', 3, 1),
('budget_inflow', 'Bank Interest', 1, 1),
('budget_inflow', 'Injection', 2, 1),
('budget_inflow', 'Other Income', 3, 1),
('budget_inflow', 'Sales-Cavendish Banana', 4, 1),
('budget_inflow', 'Sales-Cocoa', 5, 1),
('budget_inflow', 'Sales-Coffee', 6, 1),
('budget_inflow', 'Services', 7, 1);

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
('PayReq', 2, 4, 'Acknowledged', 6, NULL, NULL),
-- ---- Reimbursement: the same chain as a PayReq, filed by the Field Admin ----
-- Nothing is procured, so Procurement does not raise it; Field Admin is who deals
-- with the KTH and its farmers. Steps 2-4 are deliberately identical to PayReq,
-- and scripts/migrateReimbursement2026-08.js derives them from the PayReq rows
-- for exactly that reason.
('Reimbursement', 1, 1, 'Requested',    1, NULL, NULL),
('Reimbursement', 1, 2, 'Approved',     2, NULL, NULL),
('Reimbursement', 1, 3, 'Approved',     4, NULL, NULL),
('Reimbursement', 1, 4, 'Acknowledged', 6, NULL, NULL),
('Reimbursement', 2, 1, 'Requested',    1, NULL, NULL),
('Reimbursement', 2, 2, 'Approved',     2, NULL, NULL),
('Reimbursement', 2, 3, 'Approved',     4, NULL, NULL),
('Reimbursement', 2, 4, 'Acknowledged', 6, NULL, NULL),
-- ---- Expense: paying back somebody who spent their own money ----------------
-- Same chain again, and filed by the Field Admin for the same reason: they are
-- the one out of pocket. It is a separate document type from Reimbursement only
-- because that one reaches a farmer and this one reaches a member of staff, and a
-- chain shared between them would make the two impossible to tell apart on the
-- timeline.
('Expense', 1, 1, 'Requested',    1, NULL, NULL),
('Expense', 1, 2, 'Approved',     2, NULL, NULL),
('Expense', 1, 3, 'Approved',     4, NULL, NULL),
('Expense', 1, 4, 'Acknowledged', 6, NULL, NULL),
('Expense', 2, 1, 'Requested',    1, NULL, NULL),
('Expense', 2, 2, 'Approved',     2, NULL, NULL),
('Expense', 2, 3, 'Approved',     4, NULL, NULL),
('Expense', 2, 4, 'Acknowledged', 6, NULL, NULL);
-- PayReq step 5 (Payment Process) is intentionally NOT a route row: it is cash
-- execution, not approval. POST /api/payment-requests/:id/pay writes it, and both
-- Finance Manager and Finance Staff may call that endpoint.

-- Reorder levels are seeded in db/seed_saprodi.sql — they reference sapropdi rows,
-- which do not exist yet at this point in the script.

-- No budget rows: since 2026-10 the budget is the approved Fund Request lines
-- (input once). The `budgets` table is legacy and nothing writes it any more.
