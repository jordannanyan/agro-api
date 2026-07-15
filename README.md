# Agro Supply Chain API

TypeScript + Express + MySQL (mysql2, raw SQL) backend for the **Agro Supply Chain Dashboard**.
Clean database built from the revised class diagram. Auth via **JWT**.

Mirrors the conventions of the older `api-ts` (per-route files, `{ message, data }` responses,
Laravel method-spoofing `?_method=PUT`), but uses JWT instead of Sanctum tokens and a fresh schema.

## Stack
- Node + Express 4 + TypeScript
- MySQL 8 / MariaDB via `mysql2/promise` (no ORM)
- `jsonwebtoken` (JWT), `bcryptjs` ($2y$), `multer` + `sharp` (uploads)

## Setup
```bash
npm install
cp .env.example .env          # adjust DB creds / JWT_SECRET
npm run db:reset              # creates DB `agro_supply`, runs schema + seed + views
npm run dev                  # http://localhost:3002
```
`db:reset` computes a real bcrypt hash for the seed users at runtime.
Default staff login: **finance01 / password** (also intern01, pm01, head01, director01).

## Auth
```
POST /api/login            { username, password }            → { token, user }   # staff
POST /api/login/kth        { username, password }
POST /api/login/farmer     { nik, password }
GET  /api/me                                                (Bearer token)
POST /api/logout
```
Send `Authorization: Bearer <token>` on every other request.

## Endpoints (by module)

### Master data (full CRUD)
`/api/entities` · `/api/roles` · `/api/users` · `/api/budget-codes` · `/api/units` ·
`/api/payment-methods` · `/api/pre-finance-types` · `/api/sapropdi` · `/api/commodities` ·
`/api/grades` · `/api/offtakers` · `/api/kth` · `/api/warehouses` · `/api/collectors` ·
`/api/vendors` · `/api/approval-routes` · `/api/reorder-levels` · `/api/budgets`

### Traceability
- `/api/farmers`, `/api/plots` — plot carries `scheme` (BeliPutus | PreFinance | ProfitSharing)
- `/api/purchasing` — **scheme is derived from the selected plot**; ProfitSharing → price defaults to 0
- `/api/processing` (with contributing purchasings), `/api/selling`

### Map / GIS
`/api/trees` · `/api/tree-monitorings` · `/api/polygon-points` · `/api/map` (combined plot+polygon+trees)

### Procurement (PR → PO? → PayReq)
- `/api/purchase-requests` (+ items, auto approval steps)
- `/api/purchase-orders` (+ items, **extra costs**, PPN/tax totals)
- `/api/payment-requests` (source PR or PO; `route` = direct | via_po)
- `/api/stock-in` (+ items; receiving of PO goods)
- `/api/documents/:type/:id/(approvals|attachments|activities)` — polymorphic doc layer
  - `POST /api/documents/:type/:id/approvals/:stepId/action { action: approve|reject|revision }`

### Warehouse (calculated stock, saprodi only)
- `/api/warehouse-stock/inventory` — from `v_saprodi_stock`
- `/api/warehouse-stock/stock-card?sapropdi_id=` — IN/OUT movements + running balance
- `/api/warehouse-stock/reorder` — items at/below minimum

### Pre-Finance
- `/api/pre-finance/distributions` (+ `POST /:id/ship` = "barang dikirim")
- `/api/pre-finance/installments` (+ per-type breakdown details)
- `/api/pre-finance/outstanding` (+ `/summary`) — from `v_pre_finance_outstanding`

### Profit Sharing
- `/api/profit-sharing/investments` (Operational Cost)
- `/api/profit-sharing/shares` (final P/L + split)
- `/api/profit-sharing/revenue` — selling under ProfitSharing scheme
- `/api/profit-sharing/pl` — revenue − investment per period/farmer

### Finance & Dashboard
- `/api/finance/budget-monitoring`, `/api/finance/actual` — budget vs actual (operational, no GL)
- `/api/dashboard/executive` — KPIs, purchasing-by-scheme, 6-month trend

## Notes
- Stock is **calculated** (no balance tables). Stock Out / Stock Opname intentionally absent.
- Generated columns: `purchasing.total_value`, `selling.total_revenue/rejected_volume`,
  `*_items.total_cost/total`, `profit_sharing.net_profit`.
- The DB schema lives in `db/schema.sql`, views in `db/views.sql`, seed in `db/seed.sql`.
