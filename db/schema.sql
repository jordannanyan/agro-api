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
  -- The KTH's cut of the SAME base the farmer's share is taken from, not a slice
  -- of the company's half. Ledger "Buku Besar - SJ - Banana", column N, reads
  -- `P * 7/30` where P is the farmer's 30% — i.e. 7% of the base, leaving the
  -- company 63%. AML (JNBS) has no KTH cut: farmer 50, company 50.
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
  `document_type`  ENUM('PR','PO','PayReq') NOT NULL,
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
CREATE TABLE `budget_codes` (
  `id`         INT AUTO_INCREMENT PRIMARY KEY,
  `code`       VARCHAR(60) NOT NULL UNIQUE,   -- 1_Investment .. 6_Rent
  `name`       VARCHAR(150) NULL,
  `is_active`  TINYINT(1) NOT NULL DEFAULT 1,
  `created_at` DATETIME NULL,
  `updated_at` DATETIME NULL
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
  `entities_id`        INT NULL,
  `username`           VARCHAR(150) NULL UNIQUE,
  `password`           VARCHAR(255) NULL,
  `created_at`         DATETIME NULL,
  `updated_at`         DATETIME NULL,
  CONSTRAINT `fk_kth_entity` FOREIGN KEY (`entities_id`) REFERENCES `entities`(`id`) ON DELETE CASCADE
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
  `category`         VARCHAR(80) NULL,
  `status`           VARCHAR(40) NOT NULL DEFAULT 'Aktif',
  `created_at`       DATETIME NULL,
  `updated_at`       DATETIME NULL
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
  `order_qty`   DECIMAL(15,3) NOT NULL DEFAULT 0,
  `unit_price`  DECIMAL(15,2) NOT NULL DEFAULT 0,
  `total`       DECIMAL(18,2) GENERATED ALWAYS AS (`order_qty` * `unit_price`) STORED,
  CONSTRAINT `fk_poi_po`     FOREIGN KEY (`po_id`)      REFERENCES `purchase_orders`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_poi_priitem` FOREIGN KEY (`pr_item_id`) REFERENCES `purchase_request_items`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE `purchase_order_extra_costs` (
  `id`          INT AUTO_INCREMENT PRIMARY KEY,
  `po_id`       INT NOT NULL,
  `description` VARCHAR(255) NOT NULL,
  `amount`      DECIMAL(18,2) NOT NULL DEFAULT 0,
  CONSTRAINT `fk_poec_po` FOREIGN KEY (`po_id`) REFERENCES `purchase_orders`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE `payment_requests` (
  `id`                  INT AUTO_INCREMENT PRIMARY KEY,
  `payreq_number`       VARCHAR(60) NOT NULL UNIQUE,
  -- The reference a person types into the transfer remark at the bank, issued
  -- the moment the approval chain completes. It is what links this request to a
  -- line on the statement, so it is short and carries a check character.
  `payment_code`        VARCHAR(16) NULL UNIQUE,
  `payment_code_issued_at` DATETIME NULL,
  `purchase_request_id` INT NULL,
  `purchase_order_id`   INT NULL,
  `entity_id`           INT NOT NULL,
  `budget_code_id`      INT NULL,
  `reason`              TEXT NULL,
  `person_in_charge`    VARCHAR(150) NULL,
  `activity_date`       DATE NULL,
  `estimated_pay_date`  DATE NULL,
  `released_pay_date`   DATE NULL,
  `request_type`        VARCHAR(80) NULL,
  `reference_no`        VARCHAR(100) NULL,
  `amount`              DECIMAL(18,2) NOT NULL DEFAULT 0,
  `bank_name`           VARCHAR(80) NULL,
  `bank_account`        VARCHAR(60) NULL,
  `beneficiary_name`    VARCHAR(150) NULL,
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
  CONSTRAINT `fk_payreq_budget` FOREIGN KEY (`budget_code_id`)      REFERENCES `budget_codes`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_payreq_method` FOREIGN KEY (`payment_method_id`)   REFERENCES `payment_methods`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_payreq_paidby` FOREIGN KEY (`paid_by_user_id`)     REFERENCES `users`(`id`) ON DELETE SET NULL
  -- NOTE: "PR or PO required" is enforced in the API (routes/paymentRequests.ts).
  -- A CHECK constraint was intentionally omitted for MySQL/MariaDB portability.
) ENGINE=InnoDB;

-- -----------------------------------------------------------------------------
-- CLUSTER: Dokumen Generic (polymorphic doc_type + doc_id)
-- -----------------------------------------------------------------------------
CREATE TABLE `document_approvals` (
  `id`            INT AUTO_INCREMENT PRIMARY KEY,
  `document_type` ENUM('PR','PO','PayReq') NOT NULL,
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

CREATE TABLE `document_attachments` (
  `id`            INT AUTO_INCREMENT PRIMARY KEY,
  `document_type` ENUM('PR','PO','PayReq') NOT NULL,
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
  `document_type` ENUM('PR','PO','PayReq') NOT NULL,
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
  CONSTRAINT `fk_pfi_purchasing` FOREIGN KEY (`purchasing_id`)     REFERENCES `purchasing`(`id`) ON DELETE SET NULL,
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
