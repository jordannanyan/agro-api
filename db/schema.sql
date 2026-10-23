-- =============================================================================
-- Agro Supply Chain — Database Schema (clean build)
-- Matches the revised class diagram (API-Spreadsheet/class_diagram).
-- Engine: MySQL 8 / MariaDB 10.4+. Charset utf8mb4.
--
-- Run:  mysql -u root -p < db/schema.sql
-- (Drops & recreates the `agro_supply` database — clean install.)
--
-- INVARIANT: a clean install from db/*.sql must produce exactly the schema a
-- migrated production database has. Whenever a script under scripts/migrate*.js
-- adds a table, column, key or view, the same change belongs here (or in
-- views.sql) in the same release — otherwise a new environment silently comes up
-- missing a feature. This drifted once already: `stock_out` and the two
-- `pre_finance_distributions` columns existed only in the migration, so a fresh
-- install had no outgoing side to its warehouse at all.
--
-- To check: build one database from db/*.sql, another from db/*.sql + every
-- migration, and compare information_schema (tables, columns, keys, views).
-- =============================================================================

DROP DATABASE IF EXISTS `agro_supply`;
CREATE DATABASE `agro_supply` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE `agro_supply`;

SET FOREIGN_KEY_CHECKS = 0;

-- -----------------------------------------------------------------------------
-- CLUSTER: Auth & Approval
-- -----------------------------------------------------------------------------
-- `entity_type` separates the operational PTs (SNBS, JNBS — they own land, plots, trees)
-- from org units that only hold staff: WLI (Support: Procurement & Finance) and
-- NBSV (System: Super Admin & Admin). GET /api/entities returns Operational only by
-- default so the land+tree and Flutter apps keep seeing exactly what they saw before.
CREATE TABLE `entities` (
  `id`             INT AUTO_INCREMENT PRIMARY KEY,
  `entities_name`  VARCHAR(150) NOT NULL,
  `location`       VARCHAR(150) NULL,
  `username`       VARCHAR(100) NOT NULL UNIQUE,
  `password`       VARCHAR(255) NOT NULL,
  `is_superadmin`  TINYINT(1) NOT NULL DEFAULT 0,
  `entity_type`    ENUM('Operational','Support','System') NOT NULL DEFAULT 'Operational',
  -- Default farmer share for ProfitSharing plots under this PT, e.g. 50.00.
  -- Only the farmer's half is stored; the company's is 100 minus it, so the two
  -- can never contradict each other. A settlement copies the value in force at
  -- the time into `profit_sharing`, so changing it here never rewrites history.
  `profit_share_farmer_pct` DECIMAL(5,2) NULL,
  -- The KTH's cut OF THE COMPANY'S PORTION, not of the base: SNBS's 7% is 7% of
  -- the 70% left after the farmer's 30%, i.e. 4.9% of the margin, leaving the
  -- company 65.1%. That is how sheet `SJ - Data Entry Banana` divides every one
  -- of its 15 Delivery rows (BE 30.00 / BD 4.90 / BC 65.10). The plain 7% in
  -- `SJ - Farmer Database` column N is 7% of the DISTRIBUTABLE amount — margin
  -- already net of labour and material — a different base, not a different rate.
  -- AML (JNBS) has no KTH cut: farmer 50, company 50.
  `profit_share_kth_pct`    DECIMAL(5,2) NULL,
  -- Which gate decides what a farmer may actually be paid. The two operational
  -- ledgers disagree and both are in force:
  --   NetSurplus (SJ)  IF((margin - debt - already paid) > 0, that x pct, 0)
  --   Gate       (AML) IF((margin - debt) > 0, standing share - already paid, 0)
  -- SJ nets the debt out of the base and pays a percentage of what is left; AML
  -- uses the debt only as a switch and then pays the whole standing share.
  `payout_rule`             ENUM('Gate','NetSurplus') NOT NULL DEFAULT 'Gate',
  -- Cost rates the ledgers charge against a delivery before anything is shared.
  -- AML bills harvesting on the volume bought (Rp 1.125/kg); SJ bills it on the
  -- volume shipped (Rp 950/kg, its harvesting + washing lines). PNBP is Rp 30 per
  -- kg bought in both. Saprodi and land cost are deliberately NOT here: the
  -- ledgers treat them as the farmer's debt, which gates payout instead.
  `harvest_cost_per_kg`     DECIMAL(15,2) NULL,
  `harvest_cost_basis`      ENUM('Purchase','Offtake') NOT NULL DEFAULT 'Purchase',
  `pnbp_per_kg`             DECIMAL(15,2) NULL,
  `created_at`     DATETIME NULL,
  `updated_at`     DATETIME NULL,
  KEY `idx_entities_type` (`entity_type`)
) ENGINE=InnoDB;

-- `role_code` is the stable slug the CODE compares against (requireRole, RBAC checks).
-- `role_name` is a display label users may freely rename in Settings without breaking anything.
CREATE TABLE `roles` (
  `id`               INT AUTO_INCREMENT PRIMARY KEY,
  `role_code`        VARCHAR(40) NOT NULL UNIQUE,
  `role_name`        VARCHAR(80) NOT NULL UNIQUE,
  `is_cross_entity`  TINYINT(1) NOT NULL DEFAULT 0,
  `created_at`       DATETIME NULL,
  `updated_at`       DATETIME NULL
) ENGINE=InnoDB;

-- Staff login (Intern / PM / Head / Finance / Director). entity_id NULL = lintas-entitas.
CREATE TABLE `users` (
  `id`          INT AUTO_INCREMENT PRIMARY KEY,
  `entity_id`   INT NULL,
  `role_id`     INT NOT NULL,
  `name`        VARCHAR(150) NOT NULL,
  `username`    VARCHAR(100) NOT NULL UNIQUE,
  `email`       VARCHAR(150) NULL,
  `password`    VARCHAR(255) NOT NULL,
  `position`    VARCHAR(120) NULL,
  `is_active`   TINYINT(1) NOT NULL DEFAULT 1,
  `created_at`  DATETIME NULL,
  `updated_at`  DATETIME NULL,
  CONSTRAINT `fk_users_entity` FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_users_role`   FOREIGN KEY (`role_id`)   REFERENCES `roles`(`id`),
  -- Login accepts username OR email, so email must be unique and indexed too.
  UNIQUE KEY `uq_users_email` (`email`)
) ENGINE=InnoDB;

-- Approval routing config (per document type, per entity, per step).
CREATE TABLE `approval_routes` (
  `id`             INT AUTO_INCREMENT PRIMARY KEY,
  `document_type`  ENUM('PR','PO','PayReq','Reimbursement','Expense') NOT NULL,
  `entity_id`      INT NULL,                          -- NULL = berlaku semua entitas
  `step_order`     INT NOT NULL,
  -- 'Payment' is the cash-execution step (PayReq step 5). It is not an approval:
  -- it is written by POST /api/payment-requests/:id/pay, and it is excluded when
  -- deriving the document's own status.
  `step_label`     ENUM('Requested','Approved','Acknowledged','Payment') NOT NULL,
  `role_id`        INT NOT NULL,
  `min_amount`     DECIMAL(18,2) NULL,
  `max_amount`     DECIMAL(18,2) NULL,
  `created_at`     DATETIME NULL,
  `updated_at`     DATETIME NULL,
  CONSTRAINT `fk_aproute_entity` FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_aproute_role`   FOREIGN KEY (`role_id`)   REFERENCES `roles`(`id`)
) ENGINE=InnoDB;

-- -----------------------------------------------------------------------------
-- CLUSTER: Master Lookup (normalisasi)
-- -----------------------------------------------------------------------------
-- The banks a transfer can be sent to, keyed by the code Kopra by Mandiri expects
-- in a bulk-transfer file (an 8-character BIC, e.g. CENAIDJA for BCA).
--
-- A normalised list rather than the free text it replaces: `bank_name` held
-- whatever somebody typed — "BCA", "Bank BCA", "bca" — and none of those can be
-- turned into a code the bank will accept. Rows are seeded from Mandiri's own
-- published list (db/seed_banks.sql), so the code is never keyed by hand.
--
-- `is_self` marks Bank Mandiri: a transfer there is In-House and carries no
-- beneficiary bank code at all, which is what decides the FT service on export.
CREATE TABLE `banks` (
  `id`         INT AUTO_INCREMENT PRIMARY KEY,
  `bank_code`  VARCHAR(11) NOT NULL UNIQUE,   -- BIC, e.g. CENAIDJA
  `bank_name`  VARCHAR(150) NOT NULL,
  `is_self`    TINYINT(1) NOT NULL DEFAULT 0,
  `is_active`  TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NULL,
  `updated_at` DATETIME NULL
) ENGINE=InnoDB;

-- The PTs' own Mandiri accounts — the ones a Kopra bulk transfer debits.
--
-- A table rather than a column on `entities` because a PT runs several: SNBS pays
-- from an operational account and trades cacao and banana from two more. Which one
-- a transfer leaves from is a real decision somebody makes per file, and a single
-- column would have quietly made it for them.
--
-- `account_no` is unique across every entity: an account belongs to one PT, and the
-- same number appearing twice is a typo, not a shared account.
CREATE TABLE `company_bank_accounts` (
  `id`           INT AUTO_INCREMENT PRIMARY KEY,
  `entity_id`    INT NOT NULL,
  `label`        VARCHAR(60) NOT NULL,          -- OPERATIONAL, TRADING CACAO, ...
  `account_no`   VARCHAR(40) NOT NULL UNIQUE,
  `account_name` VARCHAR(150) NULL,
  -- The one an export starts on when nobody has chosen. At most one per entity is
  -- meaningful; the API keeps it that way rather than a constraint MySQL cannot express.
  `is_default`   TINYINT(1) NOT NULL DEFAULT 0,
  `is_active`    TINYINT(1) NOT NULL DEFAULT 1,
  `created_at`   DATETIME NULL,
  `updated_at`   DATETIME NULL,
  CONSTRAINT `fk_cba_entity` FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON DELETE CASCADE,
  KEY `idx_cba_entity` (`entity_id`)
) ENGINE=InnoDB;

-- Budget codes = the "Budget Outflow" chart of the SPV Budget Codes Master File
-- (260929_SPV_Budget Codes Master File.xlsx, sheet COA). `code` is the combined
-- label the sheet uses — "01-Operational Expenditures - Material-Non-Offtake" —
-- and `main_account` / `sub_account` are its two halves, kept apart so screens can
-- cascade Main → Sub the way the Fund Request does. The older 1_Investment …
-- 9_Tax codes stay as inactive rows: documents that already point at them keep
-- saying what they said.
CREATE TABLE `budget_codes` (
  `id`           INT AUTO_INCREMENT PRIMARY KEY,
  `code`         VARCHAR(160) NOT NULL UNIQUE,
  `name`         VARCHAR(150) NULL,
  `main_account` VARCHAR(80) NULL,
  `sub_account`  VARCHAR(120) NULL,
  `sort_order`   INT NOT NULL DEFAULT 0,
  `is_active`    TINYINT(1) NOT NULL DEFAULT 1,
  `created_at`   DATETIME NULL,
  `updated_at`   DATETIME NULL
) ENGINE=InnoDB;

-- The other lists of the same master file: Budget Purpose, Profit Center, Budget
-- Inflow and Cash Flow Type. One table because each is a plain name list that
-- Finance maintains, and none carries anything the others do not.
CREATE TABLE `finance_dimensions` (
  `id`         INT AUTO_INCREMENT PRIMARY KEY,
  `dim_type`   ENUM('budget_purpose','profit_center','budget_inflow','cash_flow_type') NOT NULL,
  `name`       VARCHAR(150) NOT NULL,
  `sort_order` INT NOT NULL DEFAULT 0,
  `is_active`  TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NULL,
  `updated_at` DATETIME NULL,
  UNIQUE KEY `uq_findim` (`dim_type`, `name`)
) ENGINE=InnoDB;

CREATE TABLE `units` (
  `id`         INT AUTO_INCREMENT PRIMARY KEY,
  `unit_name`  VARCHAR(40) NOT NULL UNIQUE,   -- Kg, Liter, Pcs, ...
  `symbol`     VARCHAR(16) NULL,
  `created_at` DATETIME NULL,
  `updated_at` DATETIME NULL
) ENGINE=InnoDB;

CREATE TABLE `payment_methods` (
  `id`          INT AUTO_INCREMENT PRIMARY KEY,
  `method_name` VARCHAR(40) NOT NULL UNIQUE,  -- Cash, Transfer, Giro
  `is_active`   TINYINT(1) NOT NULL DEFAULT 1,
  `created_at`  DATETIME NULL,
  `updated_at`  DATETIME NULL
) ENGINE=InnoDB;

CREATE TABLE `pre_finance_types` (
  `id`         INT AUTO_INCREMENT PRIMARY KEY,
  `type_name`  VARCHAR(60) NOT NULL UNIQUE,   -- Saprodi, Labor, Transport, Other
  `is_active`  TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NULL,
  `updated_at` DATETIME NULL
) ENGINE=InnoDB;

-- `item_code` (BA001, UR006, …) is the real unique key for a saprodi item.
-- `short_code` is the 2-letter prefix and is deliberately NOT unique: MA is shared by
-- Mango / Manure / Manzate / Machine Sprayer, BA by Banana / Bambu / Balsa / Bayclin.
-- `legacy_no` keeps the original spreadsheet row number, which has gaps (3 -> 5, …).
CREATE TABLE `sapropdi` (
  `id`            INT AUTO_INCREMENT PRIMARY KEY,
  `item_code`     VARCHAR(16) NULL UNIQUE,
  `short_code`    VARCHAR(4) NULL,
  `category`      ENUM('Seedlings','Fertilizer','Herbicide','Insecticide','Fungicide','Equipment','Others') NULL,
  `legacy_no`     INT NULL,
  `sapropdi_name` VARCHAR(150) NOT NULL,
  `unit_id`       INT NULL,
  `unit`          VARCHAR(60) NULL,
  `created_at`    DATETIME NULL,
  `updated_at`    DATETIME NULL,
  CONSTRAINT `fk_sapropdi_unit` FOREIGN KEY (`unit_id`) REFERENCES `units`(`id`) ON DELETE SET NULL,
  KEY `idx_sapropdi_category` (`category`)
) ENGINE=InnoDB;

CREATE TABLE `commodities` (
  `id`               INT AUTO_INCREMENT PRIMARY KEY,
  `commodities_name` VARCHAR(120) NOT NULL,
  `created_at`       DATETIME NULL,
  `updated_at`       DATETIME NULL
) ENGINE=InnoDB;

CREATE TABLE `grade` (
  `id`         INT AUTO_INCREMENT PRIMARY KEY,
  `grade_name` VARCHAR(60) NOT NULL,
  `created_at` DATETIME NULL,
  `updated_at` DATETIME NULL
) ENGINE=InnoDB;

CREATE TABLE `offtaker` (
  `id`            INT AUTO_INCREMENT PRIMARY KEY,
  `offtaker_name` VARCHAR(150) NOT NULL,
  `location`      VARCHAR(255) NULL,
  `entities_id`   INT NULL,
  `created_at`    DATETIME NULL,
  `updated_at`    DATETIME NULL,
  CONSTRAINT `fk_offtaker_entity` FOREIGN KEY (`entities_id`) REFERENCES `entities`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

-- -----------------------------------------------------------------------------
-- CLUSTER: Traceability Core (KTH / Farmers / Plots / Collectors)
-- -----------------------------------------------------------------------------
CREATE TABLE `kth` (
  `id`                 INT AUTO_INCREMENT PRIMARY KEY,
  `kth_name`           VARCHAR(255) NULL,
  `address`            VARCHAR(255) NULL,
  `regency`            VARCHAR(255) NULL,
  `partnership_period` VARCHAR(255) NULL,
  -- The account a reimbursement is transferred to. Farmers have `no_rek`; the KTH
  -- had nothing, so the account was typed afresh on every document that needed it.
  `bank_name`          VARCHAR(80) NULL,
  `bank_account`       VARCHAR(60) NULL,
  `bank_account_name`  VARCHAR(150) NULL,
  -- Which bank, as a code a transfer file can carry. `bank_name` above stays as the
  -- label people already recognise; this is what the export reads.
  `bank_id`            INT NULL,
  `entities_id`        INT NULL,
  `username`           VARCHAR(150) NULL UNIQUE,
  `password`           VARCHAR(255) NULL,
  `created_at`         DATETIME NULL,
  `updated_at`         DATETIME NULL,
  CONSTRAINT `fk_kth_entity` FOREIGN KEY (`entities_id`) REFERENCES `entities`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_kth_bank`   FOREIGN KEY (`bank_id`)     REFERENCES `banks`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE `warehouse` (
  `id`             INT AUTO_INCREMENT PRIMARY KEY,
  `warehouse_name` VARCHAR(150) NOT NULL,
  `address`        VARCHAR(255) NULL,
  `kth_id`         INT NULL,
  `created_at`     DATETIME NULL,
  `updated_at`     DATETIME NULL,
  CONSTRAINT `fk_warehouse_kth` FOREIGN KEY (`kth_id`) REFERENCES `kth`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE `farmers` (
  `id`                 INT AUTO_INCREMENT PRIMARY KEY,
  `farmer_name`        VARCHAR(255) NULL,
  `number_of_children` INT NULL,
  `date_of_birth`      DATE NULL,
  `previous_income`    DOUBLE NULL,
  `address`            VARCHAR(255) NULL,
  `kth_id`             INT NULL,
  `password`           VARCHAR(255) NULL,
  `no_hp`              VARCHAR(20) NULL,
  `nik`                VARCHAR(20) NULL,
  `no_rek`             VARCHAR(50) NULL,
  `foto`               VARCHAR(255) NULL,
  `pre_finance`        TINYINT(1) NULL,
  `created_at`         DATETIME NULL,
  `updated_at`         DATETIME NULL,
  CONSTRAINT `fk_farmers_kth` FOREIGN KEY (`kth_id`) REFERENCES `kth`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Kategori/scheme melekat di plot (satu plot = satu skema).
CREATE TABLE `plot` (
  `id`               INT AUTO_INCREMENT PRIMARY KEY,
  `plot_name`        VARCHAR(255) NULL,
  `land_area`        DECIMAL(10,2) NULL,
  `number_of_plants` INT NULL,
  `exp_cin_plants`   INT NULL,
  `latitude`         DECIMAL(10,6) NULL,
  `longitude`        DECIMAL(10,6) NULL,
  `polygon`          GEOMETRY NULL,
  `farmer_id`        INT NULL,
  `scheme`           ENUM('BeliPutus','PreFinance','ProfitSharing') NOT NULL DEFAULT 'BeliPutus',
  -- The ledger's `Inside KTH SJ` column. A plot outside the farmer group earns no
  -- KTH cut when its share of a sale is worked out.
  `inside_kth`       TINYINT(1) NOT NULL DEFAULT 1,
  `created_at`       DATETIME NULL,
  `updated_at`       DATETIME NULL,
  CONSTRAINT `fk_plot_farmer` FOREIGN KEY (`farmer_id`) REFERENCES `farmers`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE `collectors` (
  `id`             INT AUTO_INCREMENT PRIMARY KEY,
  `collector_name` VARCHAR(150) NOT NULL,
  `kth_id`         INT NULL,
  `created_at`     DATETIME NULL,
  `updated_at`     DATETIME NULL,
  CONSTRAINT `fk_collectors_kth` FOREIGN KEY (`kth_id`) REFERENCES `kth`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE `collector_farmers` (
  `id`           INT AUTO_INCREMENT PRIMARY KEY,
  `collector_id` INT NOT NULL,
  `farmer_id`    INT NOT NULL,
  `is_active`    TINYINT(1) NOT NULL DEFAULT 1,
  `joined_date`  DATE NULL,
  CONSTRAINT `fk_cf_collector` FOREIGN KEY (`collector_id`) REFERENCES `collectors`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_cf_farmer`    FOREIGN KEY (`farmer_id`)    REFERENCES `farmers`(`id`) ON DELETE CASCADE,
  UNIQUE KEY `uq_collector_farmer` (`collector_id`, `farmer_id`)
) ENGINE=InnoDB;

-- Purchasing: scheme diturunkan dari plot; price_per_unit DEFAULT 0 (0 utk ProfitSharing).
CREATE TABLE `purchasing` (
  `id`              INT AUTO_INCREMENT PRIMARY KEY,
  `plot_id`         INT NULL,
  `collector_id`    INT NULL,
  `supplier_type`   ENUM('farmer','collector') NOT NULL DEFAULT 'farmer',
  `commodities_id`  INT NOT NULL,
  `grade_id`        INT NULL,
  `warehouse_id`    INT NULL,
  `receipt_invoice` VARCHAR(100) NULL,
  `date`            DATE NOT NULL,
  `quantity`        DECIMAL(15,3) NOT NULL DEFAULT 0,
  `price_per_unit`  DECIMAL(15,2) NOT NULL DEFAULT 0,   -- 0 utk ProfitSharing
  `total_value`     DECIMAL(18,2) GENERATED ALWAYS AS (`quantity` * `price_per_unit`) STORED,
  `payment_status`  ENUM('paid','unpaid') NOT NULL DEFAULT 'unpaid',
  `is_process`      TINYINT(1) NOT NULL DEFAULT 0,
  `invoice_file`    VARCHAR(255) NULL,
  `payment_proof`   VARCHAR(255) NULL,
  `created_at`      DATETIME NULL,
  `updated_at`      DATETIME NULL,
  CONSTRAINT `fk_purchasing_plot`      FOREIGN KEY (`plot_id`)        REFERENCES `plot`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_purchasing_collector` FOREIGN KEY (`collector_id`)   REFERENCES `collectors`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_purchasing_commodity` FOREIGN KEY (`commodities_id`) REFERENCES `commodities`(`id`),
  CONSTRAINT `fk_purchasing_grade`     FOREIGN KEY (`grade_id`)       REFERENCES `grade`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_purchasing_warehouse` FOREIGN KEY (`warehouse_id`)   REFERENCES `warehouse`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE `processing` (
  `id`                    INT AUTO_INCREMENT PRIMARY KEY,
  `processing_code`       VARCHAR(60) NOT NULL,
  `date`                  DATE NOT NULL,
  `commodities_id`        INT NOT NULL,
  `warehouse_id`          INT NULL,
  `volume_input`          DECIMAL(15,3) NOT NULL DEFAULT 0,
  `volume_output`         DECIMAL(15,3) NOT NULL DEFAULT 0,
  -- Processing is priced per kilo of what goes IN — the work is done on the
  -- material received, and the loss is carried by whoever owns the batch. When
  -- this is set, `total_processing_cost` is derived from it (per_kg x
  -- volume_input) and never typed by hand. NULL means the older behaviour: a
  -- lump sum entered directly, which is how every imported batch was recorded.
  `processing_cost_per_kg` DECIMAL(15,2) NULL,
  `total_processing_cost` DECIMAL(18,2) NOT NULL DEFAULT 0,
  `status`                ENUM('open','processing','closed') NOT NULL DEFAULT 'open',
  `created_at`            DATETIME NULL,
  `updated_at`            DATETIME NULL,
  CONSTRAINT `fk_processing_commodity` FOREIGN KEY (`commodities_id`) REFERENCES `commodities`(`id`),
  CONSTRAINT `fk_processing_warehouse` FOREIGN KEY (`warehouse_id`)   REFERENCES `warehouse`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE `processing_purchasings` (
  `id`                 INT AUTO_INCREMENT PRIMARY KEY,
  `processing_id`      INT NOT NULL,
  `purchasing_id`      INT NOT NULL,
  `volume_contributed` DECIMAL(15,3) NOT NULL DEFAULT 0,
  CONSTRAINT `fk_pp_processing` FOREIGN KEY (`processing_id`) REFERENCES `processing`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_pp_purchasing` FOREIGN KEY (`purchasing_id`) REFERENCES `purchasing`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE `selling` (
  `id`               INT AUTO_INCREMENT PRIMARY KEY,
  `processing_id`    INT NOT NULL,
  `offtaker_id`      INT NULL,
  `warehouse_id`     INT NULL,
  `date`             DATE NOT NULL,
  `delivered_volume` DECIMAL(15,3) NOT NULL DEFAULT 0,
  `accepted_volume`  DECIMAL(15,3) NOT NULL DEFAULT 0,
  `rejected_volume`  DECIMAL(15,3) GENERATED ALWAYS AS (`delivered_volume` - `accepted_volume`) STORED,
  `price_per_unit`   DECIMAL(15,2) NOT NULL DEFAULT 0,
  `total_revenue`    DECIMAL(18,2) GENERATED ALWAYS AS (`accepted_volume` * `price_per_unit`) STORED,
  -- Overrides the selling PT's default farmer share for this one sale. NULL =
  -- use `entities.profit_share_farmer_pct`.
  `profit_share_farmer_pct` DECIMAL(5,2) NULL,
  `created_at`       DATETIME NULL,
  `updated_at`       DATETIME NULL,
  CONSTRAINT `fk_selling_processing` FOREIGN KEY (`processing_id`) REFERENCES `processing`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_selling_offtaker`   FOREIGN KEY (`offtaker_id`)   REFERENCES `offtaker`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_selling_warehouse`  FOREIGN KEY (`warehouse_id`)  REFERENCES `warehouse`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

-- Costs that belong to one sale — freight, sorting, loading. They are document
-- lines: deleting the sale deletes them. Land costs are the opposite (they stand
-- on their own and outlive any single sale), which is why those stay in
-- `profit_sharing_investments` rather than here. Reuses `pre_finance_types` as
-- the category master instead of introducing a second taxonomy.
CREATE TABLE `selling_costs` (
  `id`                  INT AUTO_INCREMENT PRIMARY KEY,
  `selling_id`          INT NOT NULL,
  `pre_finance_type_id` INT NULL,
  `description`         VARCHAR(255) NULL,
  `amount`              DECIMAL(18,2) NOT NULL DEFAULT 0,
  `created_at`          DATETIME NULL,
  `updated_at`          DATETIME NULL,
  KEY `idx_sc_selling` (`selling_id`),
  CONSTRAINT `fk_sc_selling` FOREIGN KEY (`selling_id`)          REFERENCES `selling`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_sc_type`    FOREIGN KEY (`pre_finance_type_id`) REFERENCES `pre_finance_types`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

-- -----------------------------------------------------------------------------
-- CLUSTER: Traceability GIS (dipertahankan untuk Map Monitoring)
-- -----------------------------------------------------------------------------
CREATE TABLE `trees` (
  `id`           INT AUTO_INCREMENT PRIMARY KEY,
  `plot_id`      INT NOT NULL,
  `farmer_id`    INT NULL,
  `tree_name`    VARCHAR(255) NULL,
  `species`      VARCHAR(255) NULL,
  `planting_date` DATE NULL,
  `qr_code`      VARCHAR(255) NULL,
  `photo_path`   VARCHAR(255) NULL,
  `latitude`     DECIMAL(10,6) NULL,
  `longitude`    DECIMAL(10,6) NULL,
  `accuracy_m`   DECIMAL(10,2) NULL,
  `created_at`   DATETIME NULL,
  `updated_at`   DATETIME NULL,
  CONSTRAINT `fk_trees_plot`   FOREIGN KEY (`plot_id`)   REFERENCES `plot`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_trees_farmer` FOREIGN KEY (`farmer_id`) REFERENCES `farmers`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE `tree_monitoring` (
  `id`               INT AUTO_INCREMENT PRIMARY KEY,
  `tree_id`          INT NOT NULL,
  `measured_at`      DATETIME NOT NULL,
  `circumference_cm` DECIMAL(10,2) NULL,
  `health_status`    ENUM('Sehat','Tidak Sehat','Mati') NOT NULL DEFAULT 'Sehat',
  `health_desc`      TEXT NULL,
  `photo_path`       VARCHAR(255) NULL,
  `latitude`         DECIMAL(10,6) NULL,
  `longitude`        DECIMAL(10,6) NULL,
  `accuracy_m`       DECIMAL(6,1) NULL,
  `recorded_by_kth_id` INT NULL,
  `created_at`       DATETIME NULL,
  `updated_at`       DATETIME NULL,
  CONSTRAINT `fk_treemon_tree` FOREIGN KEY (`tree_id`) REFERENCES `trees`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_treemon_kth`  FOREIGN KEY (`recorded_by_kth_id`) REFERENCES `kth`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE `plot_polygon_points` (
  `id`          INT AUTO_INCREMENT PRIMARY KEY,
  `plot_id`     INT NOT NULL,
  `seq`         INT NOT NULL DEFAULT 0,
  `latitude`    DECIMAL(10,6) NOT NULL,
  `longitude`   DECIMAL(10,6) NOT NULL,
  `photo_path`  VARCHAR(512) NULL,
  `captured_at` DATETIME NULL,
  `accuracy_m`  DECIMAL(10,2) NULL,
  `source`      ENUM('mobile','web','import') NOT NULL DEFAULT 'mobile',
  `created_at`  DATETIME NULL,
  `updated_at`  DATETIME NULL,
  CONSTRAINT `fk_ppp_plot` FOREIGN KEY (`plot_id`) REFERENCES `plot`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- -----------------------------------------------------------------------------
-- CLUSTER: Procurement (PR -> PO? -> PayReq)
-- -----------------------------------------------------------------------------
CREATE TABLE `vendors` (
  `id`               INT AUTO_INCREMENT PRIMARY KEY,
  `vendor_name`      VARCHAR(150) NOT NULL,
  `contact_person`   VARCHAR(120) NULL,
  `phone`            VARCHAR(40) NULL,
  `email`            VARCHAR(150) NULL,
  `address`          TEXT NULL,
  `npwp`             VARCHAR(40) NULL,
  `bank_name`        VARCHAR(80) NULL,
  `bank_account`     VARCHAR(60) NULL,
  `beneficiary_name` VARCHAR(150) NULL,
  -- Which bank, as a code a transfer file can carry; see `banks`.
  `bank_id`          INT NULL,
  `category`         VARCHAR(80) NULL,
  `status`           VARCHAR(40) NOT NULL DEFAULT 'Aktif',
  `created_at`       DATETIME NULL,
  `updated_at`       DATETIME NULL,
  CONSTRAINT `fk_vendors_bank` FOREIGN KEY (`bank_id`) REFERENCES `banks`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE `purchase_requests` (
  `id`                   INT AUTO_INCREMENT PRIMARY KEY,
  `pr_number`            VARCHAR(60) NOT NULL UNIQUE,
  `entity_id`            INT NOT NULL,
  `requested_by_user_id` INT NULL,
  `request_date`         DATE NOT NULL,
  `date_required`        DATE NULL,
  `status`               ENUM('Draft','Pending','Approved','Rejected','Revision') NOT NULL DEFAULT 'Draft',
  `grand_total`          DECIMAL(18,2) NOT NULL DEFAULT 0,
  `created_at`           DATETIME NULL,
  `updated_at`           DATETIME NULL,
  CONSTRAINT `fk_pr_entity` FOREIGN KEY (`entity_id`)            REFERENCES `entities`(`id`),
  CONSTRAINT `fk_pr_user`   FOREIGN KEY (`requested_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE `purchase_request_items` (
  `id`             INT AUTO_INCREMENT PRIMARY KEY,
  `pr_id`          INT NOT NULL,
  `budget_code_id` INT NULL,
  `sapropdi_id`    INT NULL,                 -- NULL jika non-saprodi
  `description`    VARCHAR(255) NOT NULL,
  `unit_id`        INT NULL,
  `quantity`       DECIMAL(15,3) NOT NULL DEFAULT 0,
  `unit_cost`      DECIMAL(15,2) NOT NULL DEFAULT 0,
  `total_cost`     DECIMAL(18,2) GENERATED ALWAYS AS (`quantity` * `unit_cost`) STORED,
  CONSTRAINT `fk_pri_pr`       FOREIGN KEY (`pr_id`)          REFERENCES `purchase_requests`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_pri_budget`   FOREIGN KEY (`budget_code_id`) REFERENCES `budget_codes`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_pri_sapropdi` FOREIGN KEY (`sapropdi_id`)    REFERENCES `sapropdi`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_pri_unit`     FOREIGN KEY (`unit_id`)        REFERENCES `units`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE `purchase_orders` (
  `id`                  INT AUTO_INCREMENT PRIMARY KEY,
  `po_number`           VARCHAR(60) NOT NULL UNIQUE,
  `purchase_request_id` INT NULL,
  `vendor_id`           INT NOT NULL,
  `entity_id`           INT NOT NULL,
  `budget_code_id`      INT NULL,
  `order_date`          DATE NOT NULL,
  `due_date`            DATE NULL,
  `payment_terms`       VARCHAR(120) NULL,
  `delivery_address`    TEXT NULL,
  `is_tax_included`     TINYINT(1) NOT NULL DEFAULT 0,
  `tax_rate`            DECIMAL(5,2) NOT NULL DEFAULT 11.00,
  `status`              VARCHAR(40) NOT NULL DEFAULT 'Draft',
  `created_at`          DATETIME NULL,
  `updated_at`          DATETIME NULL,
  CONSTRAINT `fk_po_pr`     FOREIGN KEY (`purchase_request_id`) REFERENCES `purchase_requests`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_po_vendor` FOREIGN KEY (`vendor_id`)           REFERENCES `vendors`(`id`),
  CONSTRAINT `fk_po_entity` FOREIGN KEY (`entity_id`)           REFERENCES `entities`(`id`),
  CONSTRAINT `fk_po_budget` FOREIGN KEY (`budget_code_id`)      REFERENCES `budget_codes`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE `purchase_order_items` (
  `id`          INT AUTO_INCREMENT PRIMARY KEY,
  `po_id`       INT NOT NULL,
  `pr_item_id`  INT NULL,
  -- Copied from the request item this line came from. A request carries a code per
  -- item and an order must keep them: a request spanning two budgets used to
  -- collapse into the order's single code the moment it became an order. Stored
  -- rather than read through `pr_item_id` so that re-coding a request later cannot
  -- rewrite what an order was approved with.
  `budget_code_id` INT NULL,
  `order_qty`   DECIMAL(15,3) NOT NULL DEFAULT 0,
  `unit_price`  DECIMAL(15,2) NOT NULL DEFAULT 0,
  `total`       DECIMAL(18,2) GENERATED ALWAYS AS (`order_qty` * `unit_price`) STORED,
  CONSTRAINT `fk_poi_po`     FOREIGN KEY (`po_id`)      REFERENCES `purchase_orders`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_poi_priitem` FOREIGN KEY (`pr_item_id`) REFERENCES `purchase_request_items`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_poi_budget`  FOREIGN KEY (`budget_code_id`) REFERENCES `budget_codes`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE `purchase_order_extra_costs` (
  `id`          INT AUTO_INCREMENT PRIMARY KEY,
  `po_id`       INT NOT NULL,
  `description` VARCHAR(255) NOT NULL,
  `amount`      DECIMAL(18,2) NOT NULL DEFAULT 0,
  CONSTRAINT `fk_poec_po` FOREIGN KEY (`po_id`) REFERENCES `purchase_orders`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- -----------------------------------------------------------------------------
-- CLUSTER: Fund Request (2026-10) — the monthly funding request per PT, laid out
-- like "Example_Fund_Request_-_Aug_2026.xlsx" and the Ledger template:
--
--   Section 1  1.1 bank balances · 1.2 shifted items · 1.3 = 1.1 − 1.2
--              1.4 new / forecasted items (overhead, operational, offtake in/out)
--              1.5 = 1.3 − overhead − operational + offtake net
--              1.6 minimum balances (negative) · 1.7 others
--              1.8 fund request = IF(1.5+1.6+1.7 > 0, 0, −(1.5+1.6+1.7))
--   Section 2  per trading commodity: bank − shifted − new + minimum → its own request
--   Approval   Requested (PM) → Prepared (Finance) → every Director signer → every HQ signer
--
-- INPUT ONCE: the approved budget lines of these documents ARE the budget. There
-- is no second place to type a budget, and Actual is never typed against them
-- either — it is the Paid payment requests that point at a line
-- (payment_requests.fund_request_line_id), plus what Finance books by hand for
-- spending that never passes through a payment request (salaries, bank charges).
-- -----------------------------------------------------------------------------
CREATE TABLE `fund_requests` (
  `id`                  INT AUTO_INCREMENT PRIMARY KEY,
  `fr_number`           VARCHAR(40) NOT NULL UNIQUE,      -- FR-2026-08-SNBS
  `entity_id`           INT NOT NULL,
  `period`              CHAR(7) NOT NULL,                  -- YYYY-MM
  `fx_date`             DATE NULL,
  `last_update`         DATE NULL,
  `prev_update`         DATE NULL,
  `balance_date`        DATE NULL,
  -- IDR per one unit of the currency, as of fx_date.
  `rate_eur`            DECIMAL(15,4) NOT NULL DEFAULT 0,
  `rate_usd`            DECIMAL(15,4) NOT NULL DEFAULT 0,
  `rate_sgd`            DECIMAL(15,4) NOT NULL DEFAULT 0,
  -- 'requested' is the working state: the sections are being filled in. A
  -- rejection sends the document back here (rejected_* say by whom and why).
  `stage`               ENUM('requested','prepared','director_approved','hq_approved') NOT NULL DEFAULT 'requested',
  `prepared_at`         DATETIME NULL,
  `prepared_by_user_id` INT NULL,
  `approved_at`         DATETIME NULL,
  `rejected_at`         DATETIME NULL,
  `rejected_by_user_id` INT NULL,
  `reject_note`         TEXT NULL,
  -- Set once every remaining budget of this month has been shifted or saved in the
  -- next month's request. Nothing changes after that.
  `closed_at`           DATETIME NULL,
  -- Section 4 — funding pattern.
  `funding_wli_pct`     DECIMAL(6,4) NOT NULL DEFAULT 0.2000,
  `funding_entity_pct`  DECIMAL(6,4) NOT NULL DEFAULT 0.8000,
  `processing_fee_sgd`  DECIMAL(12,2) NOT NULL DEFAULT 35,
  `funding_label`       ENUM('[Loan]','[Equity]') NOT NULL DEFAULT '[Loan]',
  `created_by_user_id`  INT NULL,
  `created_at`          DATETIME NULL,
  `updated_at`          DATETIME NULL,
  -- One document per PT per month, which is what lets every role work on the same one.
  UNIQUE KEY `uq_fr_entity_period` (`entity_id`, `period`),
  CONSTRAINT `fk_fr_entity`   FOREIGN KEY (`entity_id`)           REFERENCES `entities`(`id`),
  CONSTRAINT `fk_fr_prepared` FOREIGN KEY (`prepared_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_fr_rejected` FOREIGN KEY (`rejected_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_fr_creator`  FOREIGN KEY (`created_by_user_id`)  REFERENCES `users`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

-- Named groups of 1.4 ("1.0 Personnel Costs", "1.0 Own-managed Plantation"…), the
-- offtake groups of 1.4 and the commodity blocks of Section 2. `owner_role` is who
-- fills the group in: HR the personnel costs, the PM operations and offtake,
-- Finance everything else.
CREATE TABLE `fund_request_groups` (
  `id`              INT AUTO_INCREMENT PRIMARY KEY,
  `fund_request_id` INT NOT NULL,
  `area`            ENUM('overhead','operational','offtake','trading') NOT NULL,
  `label`           VARCHAR(200) NOT NULL,
  `owner_role`      ENUM('finance','hr','pm') NOT NULL DEFAULT 'finance',
  `sort_order`      INT NOT NULL DEFAULT 0,
  `created_at`      DATETIME NULL,
  `updated_at`      DATETIME NULL,
  CONSTRAINT `fk_frg_fr` FOREIGN KEY (`fund_request_id`) REFERENCES `fund_requests`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE `fund_request_lines` (
  `id`              INT AUTO_INCREMENT PRIMARY KEY,
  `fund_request_id` INT NOT NULL,
  `group_id`        INT NULL,
  --   bank_balance 1.1 · shifted 1.2 · new_item 1.4 · offtake_in/out 1.4 offtake
  --   min_balance 1.6 · others 1.7 · trading_* the four tables of a Section 2 block
  `section`         ENUM('bank_balance','shifted','new_item','offtake_in','offtake_out','min_balance','others',
                         'trading_bank','trading_shifted','trading_new','trading_min') NOT NULL,
  `kind`            ENUM('overhead','operational') NULL,   -- 1.2 shifted only
  `description`     VARCHAR(500) NOT NULL DEFAULT '',
  -- The amount in its own currency; IDR is derived with the document's rates.
  -- Bank balances can be SGD; budget lines are IDR.
  `currency`        ENUM('IDR','SGD','USD','EUR') NOT NULL DEFAULT 'IDR',
  `amount`          DECIMAL(18,2) NOT NULL DEFAULT 0,
  -- The budget dimensions of the Excel "Budget Detail" sheet.
  `budget_code_id`    INT NULL,
  `reason`            VARCHAR(500) NULL,
  `link`              VARCHAR(500) NULL,
  `filter_tag`        VARCHAR(80) NULL,
  `period_to_be_paid` VARCHAR(40) NULL,
  `activities`        VARCHAR(150) NULL,
  `species`           VARCHAR(60) NULL,
  `profit_center_id`  INT NULL,
  -- Spending that never passes through a payment request (salaries paid by the
  -- bank, bank charges). Finance books it here; everything else is the Paid
  -- payment requests pointing at this line.
  `actual_manual`      DECIMAL(18,2) NULL,
  `actual_manual_note` VARCHAR(255) NULL,
  `finance_note`      VARCHAR(500) NULL,
  `pm_note`           VARCHAR(500) NULL,
  -- A 1.2 line created from last month's remaining points at the line it came from.
  `source_line_id`    INT NULL,
  -- On a budget line of an approved month: what became of its remaining budget when
  -- the next month's request processed it. shifted + saving = the remaining then.
  `remaining_shifted`      DECIMAL(18,2) NULL,
  `remaining_saving`       DECIMAL(18,2) NULL,
  `remaining_processed_at` DATETIME NULL,
  `sort_order`         INT NOT NULL DEFAULT 0,
  `created_by_user_id` INT NULL,
  `updated_by_user_id` INT NULL,
  `created_at`         DATETIME NULL,
  `updated_at`         DATETIME NULL,
  KEY `ix_frl_fr_section` (`fund_request_id`, `section`),
  CONSTRAINT `fk_frl_fr`     FOREIGN KEY (`fund_request_id`)  REFERENCES `fund_requests`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_frl_group`  FOREIGN KEY (`group_id`)         REFERENCES `fund_request_groups`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_frl_budget` FOREIGN KEY (`budget_code_id`)   REFERENCES `budget_codes`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_frl_pc`     FOREIGN KEY (`profit_center_id`) REFERENCES `finance_dimensions`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_frl_source` FOREIGN KEY (`source_line_id`)   REFERENCES `fund_request_lines`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_frl_cby`    FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_frl_uby`    FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

-- Who signs the Director and HQ stages. Every active signer of a stage must sign
-- before it closes (template: Rizky + Arim, then Sven + Paul). entity_id NULL = all PTs.
CREATE TABLE `fund_request_signers` (
  `id`         INT AUTO_INCREMENT PRIMARY KEY,
  `stage`      ENUM('director','hq') NOT NULL,
  `user_id`    INT NOT NULL,
  `entity_id`  INT NULL,
  `title`      VARCHAR(120) NULL,
  `sort_order` INT NOT NULL DEFAULT 0,
  `is_active`  TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NULL,
  `updated_at` DATETIME NULL,
  UNIQUE KEY `uq_frsigner` (`stage`, `user_id`, `entity_id`),
  CONSTRAINT `fk_frs_user`   FOREIGN KEY (`user_id`)   REFERENCES `users`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_frs_entity` FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE `fund_request_signatures` (
  `id`              INT AUTO_INCREMENT PRIMARY KEY,
  `fund_request_id` INT NOT NULL,
  `stage`           ENUM('director','hq') NOT NULL,
  `user_id`         INT NOT NULL,
  `note`            VARCHAR(500) NULL,
  `signed_at`       DATETIME NOT NULL,
  UNIQUE KEY `uq_frsig` (`fund_request_id`, `stage`, `user_id`),
  CONSTRAINT `fk_frsig_fr`   FOREIGN KEY (`fund_request_id`) REFERENCES `fund_requests`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_frsig_user` FOREIGN KEY (`user_id`)         REFERENCES `users`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Progress of each owner's part, so Finance can see what is still being filled in.
CREATE TABLE `fund_request_sections` (
  `id`                 INT AUTO_INCREMENT PRIMARY KEY,
  `fund_request_id`    INT NOT NULL,
  `section_key`        ENUM('personnel','overhead_other','operational','offtake','finance_core') NOT NULL,
  `status`             ENUM('not_started','in_progress','done') NOT NULL DEFAULT 'not_started',
  `updated_by_user_id` INT NULL,
  `updated_at`         DATETIME NULL,
  UNIQUE KEY `uq_frsec` (`fund_request_id`, `section_key`),
  CONSTRAINT `fk_frsec_fr`   FOREIGN KEY (`fund_request_id`)    REFERENCES `fund_requests`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_frsec_user` FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

-- Section 3.1 — moving budget between lines of an approved month. The total never
-- changes; a line's budget = amount + approved movements in − out.
CREATE TABLE `fund_request_reallocations` (
  `id`                   INT AUTO_INCREMENT PRIMARY KEY,
  `fund_request_id`      INT NOT NULL,
  `to_line_id`           INT NOT NULL,
  `total`                DECIMAL(18,2) NOT NULL DEFAULT 0,
  `reason`               VARCHAR(500) NOT NULL,
  `status`               ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  `requested_by_user_id` INT NULL,
  `requested_at`         DATETIME NULL,
  `decided_by_user_id`   INT NULL,
  `decided_at`           DATETIME NULL,
  `decide_note`          VARCHAR(500) NULL,
  CONSTRAINT `fk_frr_fr`   FOREIGN KEY (`fund_request_id`)      REFERENCES `fund_requests`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_frr_to`   FOREIGN KEY (`to_line_id`)           REFERENCES `fund_request_lines`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_frr_req`  FOREIGN KEY (`requested_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_frr_dec`  FOREIGN KEY (`decided_by_user_id`)   REFERENCES `users`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE `fund_request_realloc_lines` (
  `id`               INT AUTO_INCREMENT PRIMARY KEY,
  `reallocation_id`  INT NOT NULL,
  `from_line_id`     INT NOT NULL,
  `amount`           DECIMAL(18,2) NOT NULL DEFAULT 0,
  CONSTRAINT `fk_frrl_r`    FOREIGN KEY (`reallocation_id`) REFERENCES `fund_request_reallocations`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_frrl_from` FOREIGN KEY (`from_line_id`)    REFERENCES `fund_request_lines`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE `fund_request_comments` (
  `id`              INT AUTO_INCREMENT PRIMARY KEY,
  `fund_request_id` INT NOT NULL,
  `line_id`         INT NOT NULL,
  `user_id`         INT NULL,
  `body`            TEXT NOT NULL,
  `created_at`      DATETIME NULL,
  `edited_at`       DATETIME NULL,
  KEY `ix_frc_line` (`line_id`),
  CONSTRAINT `fk_frc_fr`   FOREIGN KEY (`fund_request_id`) REFERENCES `fund_requests`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_frc_line` FOREIGN KEY (`line_id`)         REFERENCES `fund_request_lines`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_frc_user` FOREIGN KEY (`user_id`)         REFERENCES `users`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE `fund_request_activities` (
  `id`              INT AUTO_INCREMENT PRIMARY KEY,
  `fund_request_id` INT NOT NULL,
  `user_id`         INT NULL,
  `section_key`     VARCHAR(30) NULL,
  `action`          VARCHAR(500) NOT NULL,
  `created_at`      DATETIME NULL,
  KEY `ix_fra_fr` (`fund_request_id`, `id`),
  CONSTRAINT `fk_fra_fr`   FOREIGN KEY (`fund_request_id`) REFERENCES `fund_requests`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_fra_user` FOREIGN KEY (`user_id`)         REFERENCES `users`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE `payment_requests` (
  `id`                  INT AUTO_INCREMENT PRIMARY KEY,
  `payreq_number`       VARCHAR(60) NOT NULL UNIQUE,
  -- The reference a person types into the transfer remark at the bank, issued
  -- the moment the approval chain completes. It is what links this request to a
  -- line on the statement, so it is short and carries a check character.
  `payment_code`        VARCHAR(16) NULL UNIQUE,
  `payment_code_issued_at` DATETIME NULL,
  -- Three kinds of payment request share this table, because everything around one
  -- is what the others need: the chain, the code, the statement matching, the
  -- attachments.
  --
  --   Procurement   settles a PR or a PO — something was bought from a vendor.
  --   Reimbursement pays FARMERS through their KTH. See `reimbursement_items`.
  --   Expense       pays back somebody who spent their own money — a Field Admin
  --                 out in the field, usually. No purchase document behind it and
  --                 no KTH either; the lines are what was spent on, in
  --                 `payment_request_items`.
  --
  -- The last two are both "reimbursements" in plain speech, which is exactly why
  -- they are named apart here: one reaches a farmer, the other reaches a member of
  -- staff, and confusing them puts money in the wrong account.
  `payreq_kind`         ENUM('Procurement','Reimbursement','Expense') NOT NULL DEFAULT 'Procurement',
  `purchase_request_id` INT NULL,
  `purchase_order_id`   INT NULL,
  `entity_id`           INT NOT NULL,
  `kth_id`              INT NULL,      -- Reimbursement only: whose account is paid
  `budget_code_id`      INT NULL,
  -- The Fund Request budget line this payment realises. Paid requests pointing at a
  -- line are that line's Actual (see the Fund Request cluster above).
  `fund_request_line_id` INT NULL,
  `reason`              TEXT NULL,
  `person_in_charge`    VARCHAR(150) NULL,
  -- Who filed it. Without this, guardDelete could only fall back to "whoever holds
  -- the requester role", which let one Field Admin discard another's draft.
  `requested_by_user_id` INT NULL,
  `activity_date`       DATE NULL,
  `estimated_pay_date`  DATE NULL,
  `released_pay_date`   DATE NULL,
  `request_type`        VARCHAR(80) NULL,
  `reference_no`        VARCHAR(100) NULL,
  `amount`              DECIMAL(18,2) NOT NULL DEFAULT 0,
  `bank_name`           VARCHAR(80) NULL,
  `bank_account`        VARCHAR(60) NULL,
  `beneficiary_name`    VARCHAR(150) NULL,
  -- Which bank the beneficiary account is at, as a code a Kopra transfer file can
  -- carry. Copied onto the document rather than read through the vendor or KTH: the
  -- account details are already snapshotted here, and a file exported next month
  -- must reproduce the transfer that was approved, not the vendor's current bank.
  `bank_id`             INT NULL,
  -- Set the moment a Kopra bulk-transfer file carrying this request is downloaded.
  -- It is not a payment — only the statement settles one — but it does say the
  -- instruction has left the building, which is what stops the same approved
  -- request being exported twice into two transfers.
  `exported_at`         DATETIME NULL,
  `exported_by_user_id` INT NULL,
  `status`              VARCHAR(40) NOT NULL DEFAULT 'Draft',
  -- Payment execution (step 5). Written by POST /api/payment-requests/:id/pay,
  -- which only Finance Manager / Finance Staff may call, and only once the
  -- Director's Acknowledged step is done.
  `payment_method_id`   INT NULL,
  `paid_by_user_id`     INT NULL,
  `created_at`          DATETIME NULL,
  `updated_at`          DATETIME NULL,
  CONSTRAINT `fk_payreq_pr`     FOREIGN KEY (`purchase_request_id`) REFERENCES `purchase_requests`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_payreq_po`     FOREIGN KEY (`purchase_order_id`)   REFERENCES `purchase_orders`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_payreq_entity` FOREIGN KEY (`entity_id`)           REFERENCES `entities`(`id`),
  CONSTRAINT `fk_payreq_kth`    FOREIGN KEY (`kth_id`)              REFERENCES `kth`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_payreq_requester` FOREIGN KEY (`requested_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_payreq_budget` FOREIGN KEY (`budget_code_id`)      REFERENCES `budget_codes`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_payreq_frline` FOREIGN KEY (`fund_request_line_id`) REFERENCES `fund_request_lines`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_payreq_method` FOREIGN KEY (`payment_method_id`)   REFERENCES `payment_methods`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_payreq_paidby` FOREIGN KEY (`paid_by_user_id`)     REFERENCES `users`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_payreq_bank`   FOREIGN KEY (`bank_id`)             REFERENCES `banks`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_payreq_exportedby` FOREIGN KEY (`exported_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL
  -- NOTE: "PR or PO required" is enforced in the API (routes/paymentRequests.ts).
  -- A CHECK constraint was intentionally omitted for MySQL/MariaDB portability.
) ENGINE=InnoDB;

-- What an Expense payment request is claiming back, line by line.
--
-- Deliberately plain: a description and an amount. Somebody paid for fuel, a
-- courier and a meal out of their own pocket, and the receipts go on as
-- attachments — the lines exist so the total is derived from its parts rather
-- than typed, the same rule the KTH reimbursement follows.
CREATE TABLE `payment_request_items` (
  `id`                 INT AUTO_INCREMENT PRIMARY KEY,
  `payment_request_id` INT NOT NULL,
  `description`        VARCHAR(255) NOT NULL,
  `amount`             DECIMAL(18,2) NOT NULL DEFAULT 0,
  `created_at`         DATETIME NULL,
  `updated_at`         DATETIME NULL,
  KEY `idx_pri_payreq` (`payment_request_id`),
  CONSTRAINT `fk_pri_payreq` FOREIGN KEY (`payment_request_id`)
    REFERENCES `payment_requests`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- The farmers one reimbursement settles, and how much each is owed.
--
-- The money moves once, to the KTH's account; this is the breakdown that says who
-- it was for. `payment_requests.amount` is the sum of these rows and is derived
-- from them by the API, never typed — a header that disagrees with its own lines
-- is a payment nobody can account for.
--
-- `farmer_name` is a snapshot rather than a join: farmers get renamed and deleted,
-- and a payment record has to keep saying who was paid.
-- One line of a reimbursement: one person, paid for one kind of work, on one
-- account.
--
-- Shaped from the form the field admins actually file (see
-- docs/reimbursement.md). Two facts share a line and must not be confused:
--
--   * `farmer_id` / `farmer_name` — **who is paid**. A daily worker, usually, and
--     often not a registered farmer at all, which is why `farmer_id` is nullable
--     and the name is stored rather than joined: a record of who was paid has to
--     keep saying so after a rename or a deletion.
--   * `on_behalf_*` — **whose land or loan the work was on**. This is the farmer
--     the cost belongs to (Mr. Mustari, Mr. Suparno), not the person holding the
--     hoe. It is what makes the by-scheme recap possible.
--
-- The same person may appear on several lines — one worker maintains three
-- farmers' land in a week, and collapsing that into one line would destroy the
-- only record of which loan each part belongs to.
--
-- `rate` x `days` is **not** forced to equal `amount`, and must never be: the real
-- documents carry weeks where one of four days was paid at half rate, so the
-- amount is the authority and rate/days/dates describe how it was arrived at.
CREATE TABLE `reimbursement_items` (
  `id`                 INT AUTO_INCREMENT PRIMARY KEY,
  `payment_request_id` INT NOT NULL,
  `farmer_id`          INT NULL,
  `farmer_name`        VARCHAR(255) NOT NULL,
  -- What kind of cost this is. The by-scheme recap groups on it, and it is the
  -- column that says whether a line is somebody's debt or the company's own wage
  -- bill. Recording only — nothing here posts to a farmer's outstanding or to
  -- profit sharing automatically (decision of 2026-09-18).
  `category`           ENUM('DailyWorker','LabourLoanPreFinance','LabourLoanProfitSharing')
                       NOT NULL DEFAULT 'DailyWorker',
  `on_behalf_farmer_id` INT NULL,
  `on_behalf_name`     VARCHAR(255) NULL,
  `description`        VARCHAR(255) NULL,
  `rate`               DECIMAL(15,2) NULL,
  `work_days`          DECIMAL(6,2) NULL,
  -- Free text on purpose: "06, 07, 08, 10, 11, 12 August" is how the attendance
  -- sheet reads, and turning it into rows would be a timesheet module nobody asked
  -- for.
  `work_dates`         VARCHAR(255) NULL,
  `amount`             DECIMAL(18,2) NOT NULL DEFAULT 0,
  -- The worker's own account, copied off the KTH's invoice. The transfer still
  -- goes to the KTH in one sum; this is here because the invoice lists it and a
  -- query about who was actually paid what should not need the paper.
  `recipient_bank_name`    VARCHAR(80) NULL,
  `recipient_bank_account` VARCHAR(60) NULL,
  `created_at`         DATETIME NULL,
  `updated_at`         DATETIME NULL,
  KEY `idx_ri_category` (`payment_request_id`, `category`),
  CONSTRAINT `fk_ri_payreq` FOREIGN KEY (`payment_request_id`) REFERENCES `payment_requests`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_ri_farmer` FOREIGN KEY (`farmer_id`)          REFERENCES `farmers`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_ri_behalf` FOREIGN KEY (`on_behalf_farmer_id`) REFERENCES `farmers`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

-- -----------------------------------------------------------------------------
-- CLUSTER: Dokumen Generic (polymorphic doc_type + doc_id)
-- -----------------------------------------------------------------------------
CREATE TABLE `document_approvals` (
  `id`            INT AUTO_INCREMENT PRIMARY KEY,
  `document_type` ENUM('PR','PO','PayReq','Reimbursement','Expense') NOT NULL,
  `document_id`   INT NOT NULL,
  `step_order`    INT NOT NULL,
  `step_label`    ENUM('Requested','Approved','Acknowledged','Payment') NULL,
  `role_id`       INT NULL,
  `user_id`       INT NULL,                  -- NULL sebelum ditindak
  `name`          VARCHAR(150) NULL,
  `position`      VARCHAR(120) NULL,
  `action_date`   DATE NULL,
  `note`          TEXT NULL,
  `status`        ENUM('Pending','Approved','Rejected','Revision') NOT NULL DEFAULT 'Pending',
  `created_at`    DATETIME NULL,
  `updated_at`    DATETIME NULL,
  CONSTRAINT `fk_docappr_role` FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_docappr_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL,
  KEY `idx_docappr_doc` (`document_type`, `document_id`)
) ENGINE=InnoDB;

-- Files hanging off a document. The type/id pair is deliberately loose: anything
-- addressable can carry attachments, including a single LINE of a document.
--
-- 'StockInItem' points at `stock_in_items.id`, not at the stock-in itself. A
-- receiving clerk photographs each item as it comes off the truck, and a photo that
-- cannot say which item it is of answers nothing. The delivery note is the opposite
-- — one sheet covers the whole shipment — so that goes on 'StockIn'.
CREATE TABLE `document_attachments` (
  `id`            INT AUTO_INCREMENT PRIMARY KEY,
  `document_type` ENUM('PR','PO','PayReq','Reimbursement','Expense',
                       'StockIn','StockInItem','StockOut','StockOpname') NOT NULL,
  `document_id`   INT NOT NULL,
  `category`      VARCHAR(80) NULL,
  `subcategory`   VARCHAR(80) NULL,
  `file_path`     VARCHAR(255) NOT NULL,
  `created_at`    DATETIME NULL,
  `updated_at`    DATETIME NULL,
  KEY `idx_docatt_doc` (`document_type`, `document_id`)
) ENGINE=InnoDB;

CREATE TABLE `document_activities` (
  `id`            INT AUTO_INCREMENT PRIMARY KEY,
  `document_type` ENUM('PR','PO','PayReq','Reimbursement','Expense',
                       'StockIn','StockInItem','StockOut','StockOpname') NOT NULL,
  `document_id`   INT NOT NULL,
  `action`        VARCHAR(120) NOT NULL,
  `user_id`       INT NULL,
  `note`          TEXT NULL,
  `created_at`    DATETIME NULL,
  CONSTRAINT `fk_docact_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL,
  KEY `idx_docact_doc` (`document_type`, `document_id`)
) ENGINE=InnoDB;

-- -----------------------------------------------------------------------------
-- CLUSTER: Gudang (stok saprodi TERHITUNG; Stock In via PO, keluar via Distribusi)
-- -----------------------------------------------------------------------------
CREATE TABLE `stock_in` (
  `id`                   INT AUTO_INCREMENT PRIMARY KEY,
  `stock_in_number`      VARCHAR(60) NOT NULL UNIQUE,
  `purchase_order_id`    INT NULL,
  `stock_in_date`        DATE NOT NULL,
  `warehouse_id`         INT NOT NULL,
  `received_by_user_id`  INT NULL,
  `delivery_note_no`     VARCHAR(100) NULL,
  `supplier_delivery_date` DATE NULL,
  `vehicle_number`       VARCHAR(40) NULL,
  `status`               VARCHAR(40) NOT NULL DEFAULT 'Draft',
  `notes`                TEXT NULL,
  `created_at`           DATETIME NULL,
  `updated_at`           DATETIME NULL,
  CONSTRAINT `fk_stockin_po`   FOREIGN KEY (`purchase_order_id`)   REFERENCES `purchase_orders`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_stockin_wh`   FOREIGN KEY (`warehouse_id`)        REFERENCES `warehouse`(`id`),
  CONSTRAINT `fk_stockin_user` FOREIGN KEY (`received_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE `stock_in_items` (
  `id`             INT AUTO_INCREMENT PRIMARY KEY,
  `stock_in_id`    INT NOT NULL,
  `po_item_id`     INT NULL,
  `sapropdi_id`    INT NULL,
  `received_qty`   DECIMAL(15,3) NOT NULL DEFAULT 0,
  `item_condition` ENUM('Good','Damaged','Shortage') NOT NULL DEFAULT 'Good',
  `remarks`        TEXT NULL,
  CONSTRAINT `fk_sii_stockin`  FOREIGN KEY (`stock_in_id`) REFERENCES `stock_in`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_sii_poitem`   FOREIGN KEY (`po_item_id`)  REFERENCES `purchase_order_items`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_sii_sapropdi` FOREIGN KEY (`sapropdi_id`) REFERENCES `sapropdi`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE `saprodi_reorder_levels` (
  `id`           INT AUTO_INCREMENT PRIMARY KEY,
  `warehouse_id` INT NOT NULL,
  `sapropdi_id`  INT NOT NULL,
  `min_stock`    DECIMAL(15,3) NOT NULL DEFAULT 0,
  `reorder_qty`  DECIMAL(15,3) NOT NULL DEFAULT 0,
  `is_active`    TINYINT(1) NOT NULL DEFAULT 1,
  `created_at`   DATETIME NULL,
  `updated_at`   DATETIME NULL,
  CONSTRAINT `fk_srl_wh`       FOREIGN KEY (`warehouse_id`) REFERENCES `warehouse`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_srl_sapropdi` FOREIGN KEY (`sapropdi_id`)  REFERENCES `sapropdi`(`id`) ON DELETE CASCADE,
  UNIQUE KEY `uq_wh_sapropdi` (`warehouse_id`, `sapropdi_id`)
) ENGINE=InnoDB;

-- Stock Out header. The lines live in `pre_finance_distributions` (below), because
-- the farmer's outstanding balance is computed from that table and moving them
-- would change every debt figure; this groups rows that already had to exist.
--
-- Added to production by scripts/migrateStockOut2026-08.js. It is repeated here so
-- a clean install matches a migrated database — without it the whole warehouse
-- module is missing its outgoing side.
CREATE TABLE `stock_out` (
  `id`                INT AUTO_INCREMENT PRIMARY KEY,
  `stock_out_number`  VARCHAR(60) NOT NULL,
  `stock_out_date`    DATE NOT NULL,
  `warehouse_id`      INT NOT NULL,
  `issued_by_user_id` INT NULL,
  `notes`             TEXT NULL,
  `created_at`        DATETIME NULL,
  `updated_at`        DATETIME NULL,
  UNIQUE KEY `uq_stock_out_number` (`stock_out_number`),
  KEY `fk_so_warehouse` (`warehouse_id`),
  KEY `fk_so_user` (`issued_by_user_id`),
  CONSTRAINT `fk_so_warehouse` FOREIGN KEY (`warehouse_id`)      REFERENCES `warehouse`(`id`),
  CONSTRAINT `fk_so_user`      FOREIGN KEY (`issued_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

-- -----------------------------------------------------------------------------
-- Stok opname — menghitung fisik, lalu membandingkannya dengan angka sistem.
--
-- Stok di sistem ini TERHITUNG (v_saprodi_stock = masuk − keluar), bukan disimpan.
-- Opname tidak mengubahnya: ia mencatat berapa yang sebenarnya ada di rak, berapa
-- kata sistem waktu itu, dan berapa selisihnya. Keputusan 2026-09-29 — selisihnya
-- ditindaklanjuti lewat dokumen gudang yang biasa, bukan dengan menimpa angkanya,
-- supaya setiap perubahan stok tetap punya dokumen yang menjelaskannya.
--
-- `system_qty` DISIMPAN, bukan dihitung ulang saat dibaca. Angka terhitung itu
-- terus bergerak; sebuah hitungan bulan lalu harus tetap bisa mengatakan apa kata
-- sistem PADA HARI ITU, kalau tidak selisihnya berubah sendiri setiap ada barang
-- masuk dan dokumennya berhenti berarti.
--
-- Satu gudang satu opname per 30 hari; aturan itu dijaga API (routes/stockOpname.ts).
-- -----------------------------------------------------------------------------
CREATE TABLE `stock_opname` (
  `id`                 INT AUTO_INCREMENT PRIMARY KEY,
  `opname_number`      VARCHAR(60) NOT NULL UNIQUE,
  `opname_date`        DATE NOT NULL,
  `warehouse_id`       INT NOT NULL,
  `counted_by_user_id` INT NULL,
  `notes`              TEXT NULL,
  -- Terisi kalau selisihnya dipakai untuk membetulkan catatan stok. Opname yang
  -- hanya dicatat membiarkannya NULL, dan itu keadaan bakunya: menyesuaikan stok
  -- adalah tindakan tersendiri yang dipilih orang, bukan akibat dari menghitung.
  `applied_at`         DATETIME NULL,
  `applied_by_user_id` INT NULL,
  -- Menyesuaikan stok butuh persetujuan Project Manager PT pemilik gudang
  -- (2026-10-22). Draft = baru dicatat; Pending = diajukan, menunggu PM;
  -- Approved = PM setuju dan stok disesuaikan saat itu juga (applied_* = PM);
  -- Rejected = PM menolak, bisa diperbaiki lalu diajukan lagi.
  `approval_status`      ENUM('Draft','Pending','Approved','Rejected') NOT NULL DEFAULT 'Draft',
  `submitted_by_user_id` INT NULL,
  `submitted_at`         DATETIME NULL,
  `reviewed_by_user_id`  INT NULL,
  `reviewed_at`          DATETIME NULL,
  `review_note`          TEXT NULL,
  `created_at`         DATETIME NULL,
  `updated_at`         DATETIME NULL,
  KEY `ix_opname_wh_date` (`warehouse_id`, `opname_date`),
  CONSTRAINT `fk_opname_wh`   FOREIGN KEY (`warehouse_id`)       REFERENCES `warehouse`(`id`),
  CONSTRAINT `fk_opname_user` FOREIGN KEY (`counted_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_opname_applier` FOREIGN KEY (`applied_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_opname_submitter` FOREIGN KEY (`submitted_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_opname_reviewer`  FOREIGN KEY (`reviewed_by_user_id`)  REFERENCES `users`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE `stock_opname_items` (
  `id`               INT AUTO_INCREMENT PRIMARY KEY,
  `stock_opname_id`  INT NOT NULL,
  `sapropdi_id`      INT NOT NULL,
  -- Apa kata sistem saat dihitung, disimpan sebagai potret. Lihat catatan di atas.
  `system_qty`       DECIMAL(15,3) NOT NULL DEFAULT 0,
  `counted_qty`      DECIMAL(15,3) NOT NULL DEFAULT 0,
  -- Berapa yang benar-benar ditambahkan ke stok saat opname diterapkan. NULL
  -- selama belum diterapkan. Disimpan, bukan dihitung ulang: ia harus tetap
  -- menjelaskan angka stok hari ini walaupun barisnya kelak diedit.
  `adjustment`       DECIMAL(15,3) NULL,
  `unit_id`          INT NULL,
  `remarks`          VARCHAR(255) NULL,
  `created_at`       DATETIME NULL,
  `updated_at`       DATETIME NULL,
  UNIQUE KEY `uq_opname_item` (`stock_opname_id`, `sapropdi_id`),
  CONSTRAINT `fk_opname_item_head` FOREIGN KEY (`stock_opname_id`) REFERENCES `stock_opname`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_opname_item_sap`  FOREIGN KEY (`sapropdi_id`)     REFERENCES `sapropdi`(`id`),
  CONSTRAINT `fk_opname_item_unit` FOREIGN KEY (`unit_id`)         REFERENCES `units`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

-- -----------------------------------------------------------------------------
-- CLUSTER: Pre-Finance (Distribusi saprodi = utang petani, dilunasi via cicilan)
-- -----------------------------------------------------------------------------
CREATE TABLE `pre_finance_distributions` (
  `id`                  INT AUTO_INCREMENT PRIMARY KEY,
  `pre_finance_type_id` INT NOT NULL,
  `date`                DATE NOT NULL,
  `farmer_id`           INT NOT NULL,
  `plot_id`             INT NULL,
  `commodities_id`      INT NULL,
  `sapropdi_id`         INT NULL,                 -- khusus Saprodi
  -- Which warehouse the goods left, and the Stock Out document they left on.
  -- Both were added to production by the 2026-08 warehouse migrations; a saprodi
  -- line without a warehouse cannot be subtracted from any stock, which is the
  -- drift `warehouse_id` was introduced to end.
  `warehouse_id`        INT NULL,
  `stock_out_id`        INT NULL,
  `quantity`            DECIMAL(15,3) NULL,
  `unit_id`             INT NULL,
  `price_per_unit`      DECIMAL(15,2) NULL,
  `total_amount`        DECIMAL(18,2) NOT NULL DEFAULT 0,
  -- Whether this issue also counts as farmer debt. Normally it does. It is 0 for
  -- the 1.066 SNBS Profit Sharing rows imported from the Cavendish `Stock card`,
  -- whose cost is already booked in `profit_sharing_investments` as the
  -- `Daily Update` material column — counting both made SNBS debt 77% too large.
  -- The rows themselves must stay: `v_saprodi_stock` subtracts them to get stock.
  `counts_as_debt`      TINYINT(1) NOT NULL DEFAULT 1,
  `description`         TEXT NULL,
  `upload_proof`        VARCHAR(255) NULL,
  `shipped_at`          DATETIME NULL,            -- "barang dikirim" (pengganti Stock Out)
  `shipped_by_user_id`  INT NULL,
  `delivery_proof`      VARCHAR(255) NULL,
  `created_at`          DATETIME NULL,
  `updated_at`          DATETIME NULL,
  CONSTRAINT `fk_pfd_type`      FOREIGN KEY (`pre_finance_type_id`) REFERENCES `pre_finance_types`(`id`),
  CONSTRAINT `fk_pfd_farmer`    FOREIGN KEY (`farmer_id`)           REFERENCES `farmers`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_pfd_plot`      FOREIGN KEY (`plot_id`)             REFERENCES `plot`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_pfd_commodity` FOREIGN KEY (`commodities_id`)      REFERENCES `commodities`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_pfd_sapropdi`  FOREIGN KEY (`sapropdi_id`)         REFERENCES `sapropdi`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_pfd_unit`      FOREIGN KEY (`unit_id`)             REFERENCES `units`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_pfd_shipuser`  FOREIGN KEY (`shipped_by_user_id`)  REFERENCES `users`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_pfd_warehouse` FOREIGN KEY (`warehouse_id`)        REFERENCES `warehouse`(`id`) ON DELETE SET NULL,
  -- RESTRICT: the lines are farmer debt, so a Stock Out cannot take them with it.
  CONSTRAINT `fk_pfd_stock_out` FOREIGN KEY (`stock_out_id`)        REFERENCES `stock_out`(`id`) ON DELETE RESTRICT
) ENGINE=InnoDB;

CREATE TABLE `pre_finance_installments` (
  `id`                INT AUTO_INCREMENT PRIMARY KEY,
  `purchasing_id`     INT NULL,
  `farmer_id`         INT NOT NULL,
  `date`              DATE NOT NULL,
  `payment_method_id` INT NULL,
  `reference_no`      VARCHAR(100) NULL,
  `upload_proof`      VARCHAR(255) NULL,
  `total_payment`     DECIMAL(18,2) NOT NULL DEFAULT 0,   -- = SUM(details)
  `notes`             TEXT NULL,
  `created_at`        DATETIME NULL,
  `updated_at`        DATETIME NULL,
  -- A repayment with a purchasing is the deduction taken from that delivery
  -- (AML ledger: `Repayment Farmer Loan`). One delivery, one deduction — and it
  -- goes with the delivery: a deleted delivery was never paid out, so nothing was
  -- deducted from it either. NULL is a cash repayment made outside a delivery.
  UNIQUE KEY `uq_pfi_purchasing` (`purchasing_id`),
  CONSTRAINT `fk_pfi_purchasing` FOREIGN KEY (`purchasing_id`)     REFERENCES `purchasing`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_pfi_farmer`     FOREIGN KEY (`farmer_id`)         REFERENCES `farmers`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_pfi_method`     FOREIGN KEY (`payment_method_id`) REFERENCES `payment_methods`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE `pre_finance_installment_details` (
  `id`                  INT AUTO_INCREMENT PRIMARY KEY,
  `installment_id`      INT NOT NULL,
  `pre_finance_type_id` INT NOT NULL,
  `amount`              DECIMAL(18,2) NOT NULL DEFAULT 0,
  CONSTRAINT `fk_pfid_installment` FOREIGN KEY (`installment_id`)      REFERENCES `pre_finance_installments`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_pfid_type`        FOREIGN KEY (`pre_finance_type_id`) REFERENCES `pre_finance_types`(`id`),
  UNIQUE KEY `uq_installment_type` (`installment_id`, `pre_finance_type_id`)
) ENGINE=InnoDB;

-- Rupiah per kilo deducted from a pre-finance farmer's delivery to pay back the
-- loan — the ledger's `AML - Purchase Price Database`. A rate holds from its
-- `effective_date` until the plot's next one. `grade_id` NULL applies to every
-- grade; a graded row (the ledger's `-OGA`/`-OGB`… plot suffixes) wins over it
-- on the same date.
--
-- `full_price` is what a kilo is worth before the deduction. The purchase itself
-- keeps the FINAL price (full − payback), as every imported delivery already does,
-- so purchasing value + repayment = what the company spent on the fruit.
CREATE TABLE `payback_rates` (
  `id`             INT AUTO_INCREMENT PRIMARY KEY,
  `plot_id`        INT NOT NULL,
  `grade_id`       INT NULL,
  `effective_date` DATE NOT NULL,
  `full_price`     DECIMAL(15,2) NULL,
  `saprodi_per_kg` DECIMAL(15,2) NOT NULL DEFAULT 0,
  `labor_per_kg`   DECIMAL(15,2) NOT NULL DEFAULT 0,
  `notes`          VARCHAR(255) NULL,
  `created_at`     DATETIME NULL,
  `updated_at`     DATETIME NULL,
  CONSTRAINT `fk_pbr_plot`  FOREIGN KEY (`plot_id`)  REFERENCES `plot`(`id`) ON DELETE CASCADE,
  -- RESTRICT: a graded rate whose grade vanished would silently start applying
  -- to every grade.
  -- NB: MySQL treats NULLs as distinct, so this key does not stop two ungraded
  -- rates for the same plot and date; the API and the importer check for that.
  CONSTRAINT `fk_pbr_grade` FOREIGN KEY (`grade_id`) REFERENCES `grade`(`id`) ON DELETE RESTRICT,
  UNIQUE KEY `uq_payback_rate` (`plot_id`, `grade_id`, `effective_date`)
) ENGINE=InnoDB;

-- -----------------------------------------------------------------------------
-- CLUSTER: Profit Sharing (Operational Cost -> Purchasing -> Selling -> bagi hasil)
-- -----------------------------------------------------------------------------
CREATE TABLE `profit_sharing_investments` (
  `id`                  INT AUTO_INCREMENT PRIMARY KEY,
  `period`              VARCHAR(20) NOT NULL,     -- e.g. 2026-05
  `farmer_id`           INT NOT NULL,
  `plot_id`             INT NULL,
  `pre_finance_type_id` INT NULL,                 -- Saprodi/Labour/Transport/Others
  `quantity`            DECIMAL(15,3) NULL,
  `unit_id`             INT NULL,
  `amount`              DECIMAL(18,2) NOT NULL DEFAULT 0,
  `description`         TEXT NULL,
  `created_at`          DATETIME NULL,
  `updated_at`          DATETIME NULL,
  CONSTRAINT `fk_psi_farmer` FOREIGN KEY (`farmer_id`)           REFERENCES `farmers`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_psi_plot`   FOREIGN KEY (`plot_id`)             REFERENCES `plot`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_psi_type`   FOREIGN KEY (`pre_finance_type_id`) REFERENCES `pre_finance_types`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_psi_unit`   FOREIGN KEY (`unit_id`)             REFERENCES `units`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

-- One settled row per (sale, plot). The unit is the plot, not the farmer: the
-- scheme is a property of the plot, and one farmer may hold a Beli Putus plot and
-- a Profit Sharing plot at the same time.
--
-- Every figure here is a SNAPSHOT taken when the settlement was made. The four
-- cost columns are stored rather than recomputed so that a later edit to a cost
-- sheet, a price, or an entity's percentage cannot silently restate a settlement
-- that has already been paid out.
CREATE TABLE `profit_sharing` (
  `id`             INT AUTO_INCREMENT PRIMARY KEY,
  `period`         VARCHAR(20) NOT NULL,
  `selling_id`     INT NULL,                  -- NULL = legacy row entered before per-sale settlement
  `farmer_id`      INT NOT NULL,
  `plot_id`        INT NULL,
  `commodities_id` INT NULL,
  `volume_share`   DECIMAL(15,3) NOT NULL DEFAULT 0,   -- kg this plot put into the batch
  `share_pct`      DECIMAL(9,6) NOT NULL DEFAULT 0,    -- volume_share / batch volume, x100
  -- The three costs the ledgers subtract before sharing. Together they are
  -- `total_investment`; the saprodi/land columns below are recorded for the
  -- payout gate but are NOT part of the margin.
  `cost_purchase`  DECIMAL(18,2) NOT NULL DEFAULT 0,
  `cost_harvest`   DECIMAL(18,2) NOT NULL DEFAULT 0,
  `cost_pnbp`      DECIMAL(18,2) NOT NULL DEFAULT 0,
  `total_revenue`     DECIMAL(18,2) NOT NULL DEFAULT 0,
  `cost_processing`   DECIMAL(18,2) NOT NULL DEFAULT 0,  -- shared, per kg
  `cost_selling`      DECIMAL(18,2) NOT NULL DEFAULT 0,  -- shared, per kg
  `cost_saprodi`      DECIMAL(18,2) NOT NULL DEFAULT 0,  -- this plot only
  `cost_land`         DECIMAL(18,2) NOT NULL DEFAULT 0,  -- this plot only
  `total_investment`  DECIMAL(18,2) NOT NULL DEFAULT 0,  -- sum of the four above
  `net_profit`     DECIMAL(18,2) GENERATED ALWAYS AS (`total_revenue` - `total_investment`) STORED,
  `pct_farmer`     DECIMAL(5,2) NOT NULL DEFAULT 0,
  `pct_company`    DECIMAL(5,2) NOT NULL DEFAULT 0,
  -- Effective share of the margin, so the three add up to 100 and each value is
  -- its percentage of `net_profit`. The KTH's agreed rate is a cut of the
  -- company's portion (`entities.profit_share_kth_pct`), so SNBS's 7% of the
  -- remaining 70% is stored here as 4.90.
  `pct_kth`        DECIMAL(5,2) NOT NULL DEFAULT 0,
  `value_farmer`   DECIMAL(18,2) NOT NULL DEFAULT 0,
  `value_company`  DECIMAL(18,2) NOT NULL DEFAULT 0,
  `value_kth`      DECIMAL(18,2) NOT NULL DEFAULT 0,
  -- Running balance each party carries AFTER this settlement — the source
  -- model's "Cumulative PETANI / SNBS / KTH" rows. A loss is shared by the same
  -- percentages as a profit, so a bad harvest lands in the farmer's balance
  -- rather than being absorbed entirely by the company; money is paid out only
  -- while the balance is positive.
  `cum_farmer`     DECIMAL(18,2) NOT NULL DEFAULT 0,
  `cum_company`    DECIMAL(18,2) NOT NULL DEFAULT 0,
  `cum_kth`        DECIMAL(18,2) NOT NULL DEFAULT 0,
  `status`         VARCHAR(40) NOT NULL DEFAULT 'Draft',
  `created_at`     DATETIME NULL,
  `updated_at`     DATETIME NULL,
  -- A sale may only be settled once per plot. MariaDB allows repeated NULLs, so
  -- the legacy hand-entered rows are unaffected.
  UNIQUE KEY `uq_ps_selling_plot` (`selling_id`, `plot_id`),
  CONSTRAINT `fk_ps_farmer`    FOREIGN KEY (`farmer_id`)      REFERENCES `farmers`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_ps_plot`      FOREIGN KEY (`plot_id`)        REFERENCES `plot`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_ps_selling`   FOREIGN KEY (`selling_id`)     REFERENCES `selling`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_ps_commodity` FOREIGN KEY (`commodities_id`) REFERENCES `commodities`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

-- -----------------------------------------------------------------------------
-- CLUSTER: Finance (budget vs actual = view)
-- -----------------------------------------------------------------------------
-- LEGACY (2026-10): the manual budget. Superseded by the approved Fund Request
-- lines — the budget is entered once, in the Fund Request — and no screen or
-- endpoint writes it any more. Kept so the rows already in it stay readable.
CREATE TABLE `budgets` (
  `id`             INT AUTO_INCREMENT PRIMARY KEY,
  `entity_id`      INT NOT NULL,
  `period`         VARCHAR(20) NOT NULL,          -- e.g. 2026 or 2026-Q2
  `budget_code_id` INT NOT NULL,
  `sub_category`   VARCHAR(120) NULL,
  `budget_amount`  DECIMAL(18,2) NOT NULL DEFAULT 0,
  `notes`          TEXT NULL,
  `created_at`     DATETIME NULL,
  `updated_at`     DATETIME NULL,
  CONSTRAINT `fk_budget_entity` FOREIGN KEY (`entity_id`)      REFERENCES `entities`(`id`),
  CONSTRAINT `fk_budget_code`   FOREIGN KEY (`budget_code_id`) REFERENCES `budget_codes`(`id`)
) ENGINE=InnoDB;

-- -----------------------------------------------------------------------------
-- Bank statement reconciliation
--
-- Transfers are executed by a person in the bank's own channel; agro-api never
-- moves money. So a payment is not "done" because somebody pressed a button here —
-- it is done when it appears on the bank statement. These two tables hold the
-- statement as uploaded and what each line was matched against, which is the only
-- mechanism that can detect the divergences manual execution allows: a different
-- amount, a payment never made, or money that left with nothing authorising it.
--
-- Design: mandiri-quickbooks-reconciliation-plan.html §0.4–0.5. The Mandiri API
-- feed replaces the upload later; the matching engine is written against these
-- tables either way.
-- -----------------------------------------------------------------------------
CREATE TABLE `bank_statement_imports` (
  `id`                  INT AUTO_INCREMENT PRIMARY KEY,
  `file_name`           VARCHAR(255) NOT NULL,
  `file_path`           VARCHAR(255) NULL,          -- kept for audit: the file as uploaded
  `file_hash`           CHAR(64) NULL,              -- sha256 of the upload: the same file twice is refused
  `uploaded_by_user_id` INT NULL,
  `period_start`        DATE NULL,
  `period_end`          DATE NULL,
  `total_rows`          INT NOT NULL DEFAULT 0,
  `paid_count`          INT NOT NULL DEFAULT 0,     -- payment requests settled by this file
  `mismatch_count`      INT NOT NULL DEFAULT 0,     -- code found, amount disagreed
  `unmatched_count`     INT NOT NULL DEFAULT 0,     -- no code, or a code nobody issued
  `duplicate_count`     INT NOT NULL DEFAULT 0,     -- lines already seen in an earlier upload
  `note`                VARCHAR(255) NULL,
  `created_at`          DATETIME NULL,
  `updated_at`          DATETIME NULL,
  KEY `idx_bsi_file_hash` (`file_hash`),
  CONSTRAINT `fk_bsi_user` FOREIGN KEY (`uploaded_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE `bank_statement_lines` (
  `id`                 INT AUTO_INCREMENT PRIMARY KEY,
  `import_id`          INT NOT NULL,
  `row_no`             INT NULL,                    -- the file's own "No" column
  `tx_date`            DATE NULL,
  `remark`             TEXT NULL,
  `amount_in`          DECIMAL(18,2) NOT NULL DEFAULT 0,
  `amount_out`         DECIMAL(18,2) NOT NULL DEFAULT 0,
  `balance`            DECIMAL(18,2) NULL,
  -- Fingerprint of the line's own content. Statement exports overlap, so the same
  -- transfer arrives again in the next upload; this is how it is recognised.
  `line_hash`          CHAR(40) NOT NULL,
  `detected_code`      VARCHAR(16) NULL,
  `payment_request_id` INT NULL,
  -- matched | matched_with_fee | amount_mismatch | code_unknown | no_code
  -- | already_paid | not_approved | duplicate | incoming
  `match_status`       VARCHAR(30) NOT NULL,
  `fee_amount`         DECIMAL(18,2) NOT NULL DEFAULT 0,   -- shortfall absorbed as bank charge
  `match_note`         VARCHAR(255) NULL,
  `created_at`         DATETIME NULL,
  KEY `idx_bsl_hash` (`line_hash`),
  KEY `idx_bsl_status` (`match_status`),
  CONSTRAINT `fk_bsl_import` FOREIGN KEY (`import_id`)          REFERENCES `bank_statement_imports`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_bsl_payreq` FOREIGN KEY (`payment_request_id`) REFERENCES `payment_requests`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

-- -----------------------------------------------------------------------------
-- Auth token store (JWT is stateless; this table optionally supports revocation)
-- -----------------------------------------------------------------------------
-- -----------------------------------------------------------------------------
-- CLUSTER: Notifikasi
-- -----------------------------------------------------------------------------

-- What somebody needs to be told, once it has already happened.
--
-- Distinct from the approval inbox, which counts what is waiting for *you to act*.
-- These are the other half: a request you filed is approved, an order you have to
-- pay for is cleared, goods you will receive have been paid for. Nobody has to do
-- anything about them in this system — they have to know.
--
-- One row per recipient rather than one row plus a join table: read state is
-- per-person, the fan-out is a handful of rows, and a query for "my unread" stays
-- a single index lookup.
CREATE TABLE `notifications` (
  `id`            INT AUTO_INCREMENT PRIMARY KEY,
  `user_id`       INT NOT NULL,
  -- pr_approved | po_approved | payreq_paid | goods_in_transit
  `kind`          VARCHAR(40) NOT NULL,
  `title`         VARCHAR(160) NOT NULL,
  `body`          VARCHAR(500) NULL,
  -- What it is about, so the UI can link straight to it. Kept as loose columns
  -- rather than an FK per document type: a notification outlives the row it
  -- refers to, and a deleted draft must not delete the record that it happened.
  `document_type` VARCHAR(20) NULL,
  `document_id`   INT NULL,
  `link`          VARCHAR(200) NULL,
  `read_at`       DATETIME NULL,
  `created_at`    DATETIME NULL,
  KEY `idx_notif_user` (`user_id`, `read_at`, `id`),
  CONSTRAINT `fk_notif_user` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE `personal_access_tokens` (
  `id`             BIGINT AUTO_INCREMENT PRIMARY KEY,
  `tokenable_type` VARCHAR(80) NOT NULL,
  `tokenable_id`   INT NOT NULL,
  `name`           VARCHAR(120) NULL,
  `jti`            VARCHAR(64) NOT NULL UNIQUE,   -- JWT id; delete row = revoke
  `expires_at`     DATETIME NULL,
  `last_used_at`   DATETIME NULL,
  `created_at`     DATETIME NULL,
  KEY `idx_pat_tokenable` (`tokenable_type`, `tokenable_id`)
) ENGINE=InnoDB;

SET FOREIGN_KEY_CHECKS = 1;
