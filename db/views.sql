-- =============================================================================
-- Agro Supply Chain — SQL Views (stok terhitung, outstanding, budget actual)
-- Run AFTER schema.sql:  mysql -u root -p agro_supply < db/views.sql
-- =============================================================================
USE `agro_supply`;

-- Stok saprodi TERHITUNG per gudang:
--   Σ(stock_in_items.received_qty) − Σ(pre_finance_distributions.quantity, type=Saprodi)
DROP VIEW IF EXISTS `v_saprodi_stock`;
CREATE VIEW `v_saprodi_stock` AS
SELECT
  w.id                        AS warehouse_id,
  w.warehouse_name            AS warehouse_name,
  s.id                        AS sapropdi_id,
  s.sapropdi_name             AS sapropdi_name,
  COALESCE(si.total_in, 0)    AS total_in,
  COALESCE(dist.total_out, 0) AS total_out,
  COALESCE(si.total_in, 0) - COALESCE(dist.total_out, 0) AS remaining
FROM warehouse w
CROSS JOIN sapropdi s
LEFT JOIN (
  SELECT si.warehouse_id, sii.sapropdi_id, SUM(sii.received_qty) AS total_in
  FROM stock_in si
  JOIN stock_in_items sii ON sii.stock_in_id = si.id
  WHERE sii.sapropdi_id IS NOT NULL
  GROUP BY si.warehouse_id, sii.sapropdi_id
) si ON si.warehouse_id = w.id AND si.sapropdi_id = s.id
LEFT JOIN (
  SELECT pfd.sapropdi_id, SUM(pfd.quantity) AS total_out
  FROM pre_finance_distributions pfd
  JOIN pre_finance_types t ON t.id = pfd.pre_finance_type_id
  WHERE pfd.sapropdi_id IS NOT NULL AND t.type_name = 'Saprodi'
  GROUP BY pfd.sapropdi_id
) dist ON dist.sapropdi_id = s.id
WHERE si.total_in IS NOT NULL OR dist.total_out IS NOT NULL;

-- Outstanding petani per pre-finance type:
--   Σ distributions.total_amount(type=T) − Σ installment_details.amount(type=T)
DROP VIEW IF EXISTS `v_pre_finance_outstanding`;
CREATE VIEW `v_pre_finance_outstanding` AS
SELECT
  f.id            AS farmer_id,
  f.farmer_name   AS farmer_name,
  t.id            AS pre_finance_type_id,
  t.type_name     AS type_name,
  COALESCE(d.dist_total, 0) AS distributed_total,
  COALESCE(p.paid_total, 0) AS paid_total,
  COALESCE(d.dist_total, 0) - COALESCE(p.paid_total, 0) AS outstanding
FROM farmers f
CROSS JOIN pre_finance_types t
LEFT JOIN (
  SELECT farmer_id, pre_finance_type_id, SUM(total_amount) AS dist_total
  FROM pre_finance_distributions
  GROUP BY farmer_id, pre_finance_type_id
) d ON d.farmer_id = f.id AND d.pre_finance_type_id = t.id
LEFT JOIN (
  SELECT i.farmer_id, det.pre_finance_type_id, SUM(det.amount) AS paid_total
  FROM pre_finance_installments i
  JOIN pre_finance_installment_details det ON det.installment_id = i.id
  GROUP BY i.farmer_id, det.pre_finance_type_id
) p ON p.farmer_id = f.id AND p.pre_finance_type_id = t.id
WHERE d.dist_total IS NOT NULL OR p.paid_total IS NOT NULL;

-- Budget actual = realisasi PO (grand-ish via items) per entity/period/budget_code.
-- Simplified: actual = Σ purchase_order_items.total for POs of the entity+budget_code,
-- grouped by YEAR(order_date). Prototype-level operational report (bukan GL).
DROP VIEW IF EXISTS `v_budget_actual`;
CREATE VIEW `v_budget_actual` AS
SELECT
  po.entity_id                 AS entity_id,
  CAST(YEAR(po.order_date) AS CHAR) COLLATE utf8mb4_unicode_ci AS period,
  po.budget_code_id            AS budget_code_id,
  SUM(poi.total)               AS actual_amount
FROM purchase_orders po
JOIN purchase_order_items poi ON poi.po_id = po.id
WHERE po.budget_code_id IS NOT NULL
GROUP BY po.entity_id, YEAR(po.order_date), po.budget_code_id;
