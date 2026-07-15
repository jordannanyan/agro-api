-- =============================================================================
-- Agro Supply Chain — Database Schema (clean build)
-- Matches the revised class diagram (API-Spreadsheet/class_diagram).
-- Engine: MySQL 8 / MariaDB 10.4+. Charset utf8mb4.
--
-- Run:  mysql -u root -p < db/schema.sql
-- (Drops & recreates the `agro_supply` database — clean install.)
-- =============================================================================

DROP DATABASE IF EXISTS `agro_supply`;
CREATE DATABASE `agro_supply` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE `agro_supply`;

SET FOREIGN_KEY_CHECKS = 0;

-- -----------------------------------------------------------------------------
-- CLUSTER: Auth & Approval
-- -----------------------------------------------------------------------------
CREATE TABLE `entities` (
  `id`             INT AUTO_INCREMENT PRIMARY KEY,
  `entities_name`  VARCHAR(150) NOT NULL,
  `location`       VARCHAR(150) NULL,
  `username`       VARCHAR(100) NOT NULL UNIQUE,
  `password`       VARCHAR(255) NOT NULL,
  `is_superadmin`  TINYINT(1) NOT NULL DEFAULT 0,
  `created_at`     DATETIME NULL,
  `updated_at`     DATETIME NULL
) ENGINE=InnoDB;

CREATE TABLE `roles` (
  `id`               INT AUTO_INCREMENT PRIMARY KEY,
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
  CONSTRAINT `fk_users_role`   FOREIGN KEY (`role_id`)   REFERENCES `roles`(`id`)
) ENGINE=InnoDB;

-- Approval routing config (per document type, per entity, per step).
CREATE TABLE `approval_routes` (
  `id`             INT AUTO_INCREMENT PRIMARY KEY,
  `document_type`  ENUM('PR','PO','PayReq') NOT NULL,
  `entity_id`      INT NULL,                          -- NULL = berlaku semua entitas
  `step_order`     INT NOT NULL,
  `step_label`     ENUM('Requested','Approved','Acknowledged') NOT NULL,
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

CREATE TABLE `sapropdi` (
  `id`            INT AUTO_INCREMENT PRIMARY KEY,
  `sapropdi_name` VARCHAR(150) NOT NULL,
  `unit_id`       INT NULL,
  `created_at`    DATETIME NULL,
  `updated_at`    DATETIME NULL,
  CONSTRAINT `fk_sapropdi_unit` FOREIGN KEY (`unit_id`) REFERENCES `units`(`id`) ON DELETE SET NULL
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
  `entities_id`   INT NULL,
  `created_at`    DATETIME NULL,
  `updated_at`    DATETIME NULL,
  CONSTRAINT `fk_offtaker_entity` FOREIGN KEY (`entities_id`) REFERENCES `entities`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

-- -----------------------------------------------------------------------------
-- CLUSTER: Traceability Core (KTH / Farmers / Plots / Collectors)
-- -----------------------------------------------------------------------------
CREATE TABLE `kth` (
  `id`          INT AUTO_INCREMENT PRIMARY KEY,
  `kth_name`    VARCHAR(150) NOT NULL,
  `entities_id` INT NOT NULL,
  `username`    VARCHAR(100) NULL UNIQUE,
  `password`    VARCHAR(255) NULL,
  `created_at`  DATETIME NULL,
  `updated_at`  DATETIME NULL,
  CONSTRAINT `fk_kth_entity` FOREIGN KEY (`entities_id`) REFERENCES `entities`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE `warehouse` (
  `id`             INT AUTO_INCREMENT PRIMARY KEY,
  `warehouse_name` VARCHAR(150) NOT NULL,
  `kth_id`         INT NULL,
  `created_at`     DATETIME NULL,
  `updated_at`     DATETIME NULL,
  CONSTRAINT `fk_warehouse_kth` FOREIGN KEY (`kth_id`) REFERENCES `kth`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE `farmers` (
  `id`          INT AUTO_INCREMENT PRIMARY KEY,
  `farmer_name` VARCHAR(150) NOT NULL,
  `nik`         VARCHAR(32) NULL UNIQUE,
  `kth_id`      INT NOT NULL,
  `password`    VARCHAR(255) NULL,
  `photo`       VARCHAR(255) NULL,
  `created_at`  DATETIME NULL,
  `updated_at`  DATETIME NULL,
  CONSTRAINT `fk_farmers_kth` FOREIGN KEY (`kth_id`) REFERENCES `kth`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Kategori/scheme melekat di plot (satu plot = satu skema).
CREATE TABLE `plot` (
  `id`         INT AUTO_INCREMENT PRIMARY KEY,
  `plot_name`  VARCHAR(150) NOT NULL,
  `farmer_id`  INT NOT NULL,
  `scheme`     ENUM('BeliPutus','PreFinance','ProfitSharing') NOT NULL DEFAULT 'BeliPutus',
  `created_at` DATETIME NULL,
  `updated_at` DATETIME NULL,
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
  `created_at`       DATETIME NULL,
  `updated_at`       DATETIME NULL,
  CONSTRAINT `fk_selling_processing` FOREIGN KEY (`processing_id`) REFERENCES `processing`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_selling_offtaker`   FOREIGN KEY (`offtaker_id`)   REFERENCES `offtaker`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_selling_warehouse`  FOREIGN KEY (`warehouse_id`)  REFERENCES `warehouse`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

-- -----------------------------------------------------------------------------
-- CLUSTER: Traceability GIS (dipertahankan untuk Map Monitoring)
-- -----------------------------------------------------------------------------
CREATE TABLE `trees` (
  `id`           INT AUTO_INCREMENT PRIMARY KEY,
  `plot_id`      INT NOT NULL,
  `tree_code`    VARCHAR(80) NULL,
  `commodities_id` INT NULL,
  `latitude`     DECIMAL(10,7) NULL,
  `longitude`    DECIMAL(10,7) NULL,
  `planted_date` DATE NULL,
  `photo`        VARCHAR(255) NULL,
  `created_at`   DATETIME NULL,
  `updated_at`   DATETIME NULL,
  CONSTRAINT `fk_trees_plot`      FOREIGN KEY (`plot_id`)        REFERENCES `plot`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_trees_commodity` FOREIGN KEY (`commodities_id`) REFERENCES `commodities`(`id`) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE `tree_monitoring` (
  `id`         INT AUTO_INCREMENT PRIMARY KEY,
  `tree_id`    INT NOT NULL,
  `monitor_date` DATE NOT NULL,
  `height_cm`  DECIMAL(10,2) NULL,
  `diameter_cm` DECIMAL(10,2) NULL,
  `health_status` VARCHAR(60) NULL,
  `note`       TEXT NULL,
  `photo`      VARCHAR(255) NULL,
  `created_at` DATETIME NULL,
  `updated_at` DATETIME NULL,
  CONSTRAINT `fk_treemon_tree` FOREIGN KEY (`tree_id`) REFERENCES `trees`(`id`) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE `plot_polygon_points` (
  `id`         INT AUTO_INCREMENT PRIMARY KEY,
  `plot_id`    INT NOT NULL,
  `seq`        INT NOT NULL DEFAULT 0,
  `latitude`   DECIMAL(10,7) NOT NULL,
  `longitude`  DECIMAL(10,7) NOT NULL,
  `photo`      VARCHAR(255) NULL,
  `created_at` DATETIME NULL,
  `updated_at` DATETIME NULL,
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
  `created_at`          DATETIME NULL,
  `updated_at`          DATETIME NULL,
  CONSTRAINT `fk_payreq_pr`     FOREIGN KEY (`purchase_request_id`) REFERENCES `purchase_requests`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_payreq_po`     FOREIGN KEY (`purchase_order_id`)   REFERENCES `purchase_orders`(`id`) ON DELETE SET NULL,
  CONSTRAINT `fk_payreq_entity` FOREIGN KEY (`entity_id`)           REFERENCES `entities`(`id`),
  CONSTRAINT `fk_payreq_budget` FOREIGN KEY (`budget_code_id`)      REFERENCES `budget_codes`(`id`) ON DELETE SET NULL,
  CONSTRAINT `chk_payreq_source` CHECK (`purchase_request_id` IS NOT NULL OR `purchase_order_id` IS NOT NULL)
) ENGINE=InnoDB;

-- -----------------------------------------------------------------------------
-- CLUSTER: Dokumen Generic (polymorphic doc_type + doc_id)
-- -----------------------------------------------------------------------------
CREATE TABLE `document_approvals` (
  `id`            INT AUTO_INCREMENT PRIMARY KEY,
  `document_type` ENUM('PR','PO','PayReq') NOT NULL,
  `document_id`   INT NOT NULL,
  `step_order`    INT NOT NULL,
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
  `quantity`            DECIMAL(15,3) NULL,
  `unit_id`             INT NULL,
  `price_per_unit`      DECIMAL(15,2) NULL,
  `total_amount`        DECIMAL(18,2) NOT NULL DEFAULT 0,
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
  CONSTRAINT `fk_pfd_shipuser`  FOREIGN KEY (`shipped_by_user_id`)  REFERENCES `users`(`id`) ON DELETE SET NULL
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

CREATE TABLE `profit_sharing` (
  `id`             INT AUTO_INCREMENT PRIMARY KEY,
  `period`         VARCHAR(20) NOT NULL,
  `farmer_id`      INT NOT NULL,
  `plot_id`        INT NULL,
  `commodities_id` INT NULL,
  `total_revenue`     DECIMAL(18,2) NOT NULL DEFAULT 0,
  `total_investment`  DECIMAL(18,2) NOT NULL DEFAULT 0,
  `net_profit`     DECIMAL(18,2) GENERATED ALWAYS AS (`total_revenue` - `total_investment`) STORED,
  `pct_farmer`     DECIMAL(5,2) NOT NULL DEFAULT 0,
  `pct_company`    DECIMAL(5,2) NOT NULL DEFAULT 0,
  `value_farmer`   DECIMAL(18,2) NOT NULL DEFAULT 0,
  `value_company`  DECIMAL(18,2) NOT NULL DEFAULT 0,
  `status`         VARCHAR(40) NOT NULL DEFAULT 'Draft',
  `created_at`     DATETIME NULL,
  `updated_at`     DATETIME NULL,
  CONSTRAINT `fk_ps_farmer`    FOREIGN KEY (`farmer_id`)      REFERENCES `farmers`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_ps_plot`      FOREIGN KEY (`plot_id`)        REFERENCES `plot`(`id`) ON DELETE SET NULL,
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
