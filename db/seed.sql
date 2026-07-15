-- =============================================================================
-- Agro Supply Chain — Seed data (minimal, for dashboard prototype)
-- Run AFTER schema.sql:  mysql -u root -p agro_supply < db/seed.sql
--
-- All passwords below are bcrypt($2y$) of "password".
-- =============================================================================
USE `agro_supply`;

SET @PW := '$2y$12$e0MYzXyjpJS7Pd0RVvHwHe1DYQyDzYqZ0zK7Yy8mQF3q8m9pC1yfa'; -- "password"

-- Entities (2 PT)
INSERT INTO `entities` (id, entities_name, location, username, password, is_superadmin, created_at, updated_at) VALUES
(1, 'PT Sumatra Nature Based Solutions (SNBS)', 'Bengkulu', 'snbs',  @PW, 1, NOW(), NOW()),
(2, 'PT Jhonlin Nature Based Solutions (JNBS)', 'Lampung',  'jnbs',  @PW, 0, NOW(), NOW());

-- Roles (5 staff roles)
INSERT INTO `roles` (id, role_name, is_cross_entity, created_at, updated_at) VALUES
(1, 'Intern',   0, NOW(), NOW()),
(2, 'PM',       0, NOW(), NOW()),
(3, 'Head',     0, NOW(), NOW()),
(4, 'Finance',  1, NOW(), NOW()),
(5, 'Director', 1, NOW(), NOW());

-- Users (staff login)
INSERT INTO `users` (id, entity_id, role_id, name, username, email, password, position, is_active, created_at, updated_at) VALUES
(1, 1, 4, 'Ahmad Fauzi',     'finance01',  'finance01@agro.id',  @PW, 'Finance Officer', 1, NOW(), NOW()),
(2, 1, 1, 'Dika Pratama',    'intern01',   'intern01@agro.id',   @PW, 'Intern',          1, NOW(), NOW()),
(3, 2, 2, 'Sari Indah',      'pm01',       'pm01@agro.id',       @PW, 'Project Manager', 1, NOW(), NOW()),
(4, 2, 3, 'Budi Santoso',    'head01',     'head01@agro.id',     @PW, 'Head of Ops',     1, NOW(), NOW()),
(5, NULL, 5, 'Direktur Utama','director01', 'director01@agro.id', @PW, 'Director',        1, NOW(), NOW());

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
(9, 'Hari', 'hari'), (10, 'Trip', 'trip'), (11, 'Bulan', 'bln'), (12, 'Meter', 'm'), (13, 'Roll', 'roll'), (14, 'Unit', 'unit');

INSERT INTO `payment_methods` (id, method_name, is_active) VALUES
(1, 'Cash', 1), (2, 'Transfer', 1), (3, 'Giro', 1);

INSERT INTO `pre_finance_types` (id, type_name, is_active) VALUES
(1, 'Saprodi', 1), (2, 'Labor', 1), (3, 'Transport', 1), (4, 'Other', 1);

INSERT INTO `sapropdi` (id, sapropdi_name, unit_id) VALUES
(1, 'NPK Fertilizer 16-16-16', 1),
(2, 'KCL (Potassium Chloride)', 1),
(3, 'Pestisida Organik A', 3),
(4, 'Urea Fertilizer 46%', 1),
(5, 'Organic Fertilizer', 1);

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

-- Approval routes (contoh SNBS): Intern(Requested) -> PM(Approved) -> Head(Acknowledged)
INSERT INTO `approval_routes` (document_type, entity_id, step_order, step_label, role_id, min_amount, max_amount) VALUES
('PR', NULL, 1, 'Requested',    1, NULL, NULL),
('PR', NULL, 2, 'Approved',     2, NULL, NULL),
('PR', NULL, 3, 'Acknowledged', 3, NULL, NULL),
('PR', NULL, 4, 'Approved',     5, 50000000, NULL),  -- Director hanya jika >= 50jt
('PO', NULL, 1, 'Requested',    2, NULL, NULL),
('PO', NULL, 2, 'Approved',     3, NULL, NULL),
('PO', NULL, 3, 'Approved',     4, NULL, NULL),
('PayReq', NULL, 1, 'Requested', 3, NULL, NULL),
('PayReq', NULL, 2, 'Approved',  4, NULL, NULL);

-- Reorder levels
INSERT INTO `saprodi_reorder_levels` (warehouse_id, sapropdi_id, min_stock, reorder_qty, is_active) VALUES
(1, 1, 2000, 3000, 1),
(1, 4, 3000, 4000, 1),
(2, 3, 1000, 1500, 1);

-- Budgets (contoh)
INSERT INTO `budgets` (entity_id, period, budget_code_id, sub_category, budget_amount) VALUES
(1, '2026', 3, 'Fertilizer & Pesticide', 500000000),
(1, '2026', 1, 'Equipment',              200000000),
(2, '2026', 3, 'Fertilizer & Pesticide', 350000000);
