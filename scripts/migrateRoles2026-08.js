// -----------------------------------------------------------------------------
// Migration: role & approval-flow revision (2026-08)
// Source: Dokumentasi_Role_Approval_Procurement.pdf
//
// Brings a POPULATED database up to the new model without dropping anything:
//   1. entities   — add entity_type; add WLI (Support) and NBSV (System)
//   2. roles      — add role_code; rename/expand the 6 old roles into the 8 new ones
//   3. users      — add unique email index; upsert the 14 real staff accounts
//   4. sapropdi   — add item_code / short_code / category / legacy_no
//   5. approval_routes — replace with the per-entity matrix from the PDF
//   6. document_approvals — add step_label; backfill it for existing rows
//   7. payment_requests   — add payment_method_id / paid_by_user_id
//   8. backfill document statuses that got stuck on Pending
//
// Every DDL step is idempotent, so the script can be re-run safely.
//
// Usage:
//   node scripts/migrateRoles2026-08.js            # dry run: report only
//   node scripts/migrateRoles2026-08.js --apply    # actually write
//   node scripts/migrateRoles2026-08.js --apply --passwords   # + generate passwords
//
// BACK UP THE DATABASE FIRST:
//   mysqldump -u root -p agro_supply > backup-before-roles-2026-08.sql
// -----------------------------------------------------------------------------
require('dotenv').config();
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const APPLY = process.argv.includes('--apply');
const GEN_PASSWORDS = process.argv.includes('--passwords');
const DB = process.env.DB_NAME || 'agro_supply';

const log = (...a) => console.log(...a);
const step = (n, t) => log(`\n── ${n}. ${t}`);

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

// Old role_name -> new { code, name }. The 6 legacy roles map onto the new set;
// FINANCE_STAFF and SUPER_ADMIN have no legacy equivalent and are created fresh.
const ROLE_MIGRATION = {
  Intern:   { code: 'FIELD_ADMIN',     name: 'Field Admin',     cross: 0 },
  PM:       { code: 'PROJECT_MANAGER', name: 'Project Manager', cross: 0 },
  Head:     { code: 'PROCUREMENT',     name: 'Procurement',     cross: 1 },
  Finance:  { code: 'FINANCE_MANAGER', name: 'Finance Manager', cross: 1 },
  Director: { code: 'DIRECTOR',        name: 'Director',        cross: 1 },
  Admin:    { code: 'ADMIN',           name: 'Admin',           cross: 1 },
};

const NEW_ROLES = [
  { code: 'FIELD_ADMIN',     name: 'Field Admin',     cross: 0 },
  { code: 'PROJECT_MANAGER', name: 'Project Manager', cross: 0 },
  { code: 'PROCUREMENT',     name: 'Procurement',     cross: 1 },
  { code: 'FINANCE_MANAGER', name: 'Finance Manager', cross: 1 },
  { code: 'FINANCE_STAFF',   name: 'Finance Staff',   cross: 1 },
  { code: 'DIRECTOR',        name: 'Director',        cross: 1 },
  { code: 'SUPER_ADMIN',     name: 'Super Admin',     cross: 1 },
  { code: 'ADMIN',           name: 'Admin',           cross: 1 },
];

// entity_username -> entity_type. SNBS/JNBS keep the default 'Operational'.
const SUPPORT_ENTITIES = [
  { username: 'wli',  name: 'WLI',  type: 'Support' },
  { username: 'nbsv', name: 'NBSV', type: 'System' },
];

// The 14 staff accounts. `entity` is matched by entities.username; null = cross-entity.
const STAFF = [
  { name: 'Elma Aryanti',           username: 'elma.aryanti',      email: 'elma.aryanti@snbs.earth',      role: 'FIELD_ADMIN',     entity: 'snbs', position: 'Field Admin — buku besar (pembelian & penjualan)' },
  { name: 'Bambang Triatmaja',      username: 'bambang.triatmaja', email: 'bambang.triatmaja@snbs.earth', role: 'FIELD_ADMIN',     entity: 'snbs', position: 'Field Admin — stok masuk & stok keluar' },
  { name: 'Alfina Octa Shabilla',   username: 'alfina.octa',       email: 'alfina.octa@jnbs.earth',       role: 'FIELD_ADMIN',     entity: 'jnbs', position: 'Field Admin — buku besar & stok masuk/keluar' },
  { name: 'Edo Santeyo Lensiyus',   username: 'edo.santeyo',       email: 'edo.santeyo@snbs.earth',       role: 'PROJECT_MANAGER', entity: 'snbs', position: 'Project Manager SNBS' },
  { name: 'Eren Nur Efendi',        username: 'eren.efendi',       email: 'eren.efendi@jnbs.earth',       role: 'PROJECT_MANAGER', entity: 'jnbs', position: 'Project Manager JNBS' },
  { name: 'Putri Gandini',          username: 'putri.gandini',     email: 'putri.gandini@wli.earth',      role: 'PROCUREMENT',     entity: 'wli',  position: 'Procurement — membuat PO & Payment Request' },
  { name: 'Nyi Arum S',             username: 'nyi.arum',          email: 'nyi.arum@wli.earth',           role: 'FINANCE_MANAGER', entity: 'wli',  position: 'Director WLI (Plt. Finance Manager)' },
  { name: 'Saskia Vianacika',       username: 'saskia.vianacika',  email: 'saskia.vianacika@wli.earth',   role: 'FINANCE_STAFF',   entity: 'wli',  position: 'Finance Staff — input pembayaran' },
  { name: 'M. Rizky Sudirman',      username: 'rizky.sudirman',    email: 'rizky.sudirman@snbs.earth',    role: 'DIRECTOR',        entity: null,   position: 'Director SNBS / JNBS' },
  { name: 'Jordan Nanyan',          username: 'jordan.nanyan',     email: 'jordan.nanyan@nbsv.earth',     role: 'SUPER_ADMIN',     entity: 'nbsv', position: 'Super Admin' },
  { name: 'Pinky Kathlea Diatmiko', username: 'pinky.kathlea',     email: 'pinky.kathlea@nbsv.earth',     role: 'ADMIN',           entity: 'nbsv', position: 'Admin' },
  { name: 'Sven Koenig',            username: 'sven.koenig',       email: 'sven.koenig@nbsv.earth',       role: 'ADMIN',           entity: 'nbsv', position: 'Admin' },
  { name: 'Paul Schuller',          username: 'paul.schuller',     email: 'paul.schuller@nbsv.earth',     role: 'ADMIN',           entity: 'nbsv', position: 'Admin' },
  { name: 'Cindra Veranita',        username: 'cindra.veranita',   email: 'cindra.veranita@wli.earth',    role: 'ADMIN',           entity: 'wli',  position: 'Admin' },
];

// Approval matrix, applied to every Operational entity.
// Note the PO/PayReq asymmetry: on a PO the Finance Manager acknowledges and the
// Director approves; on a PayReq the Finance Manager approves and the Director
// acknowledges. That is intentional — see the PDF, section 5.
const ROUTES = [
  ['PR',     1, 'Requested',    'FIELD_ADMIN'],
  ['PR',     2, 'Approved',     'PROJECT_MANAGER'],
  ['PR',     3, 'Acknowledged', 'FINANCE_MANAGER'],
  ['PO',     1, 'Requested',    'PROCUREMENT'],
  ['PO',     2, 'Approved',     'PROJECT_MANAGER'],
  ['PO',     3, 'Acknowledged', 'FINANCE_MANAGER'],
  ['PO',     4, 'Approved',     'DIRECTOR'],
  ['PayReq', 1, 'Requested',    'PROCUREMENT'],
  ['PayReq', 2, 'Approved',     'PROJECT_MANAGER'],
  ['PayReq', 3, 'Approved',     'FINANCE_MANAGER'],
  ['PayReq', 4, 'Acknowledged', 'DIRECTOR'],
];

// ---------------------------------------------------------------------------
// Schema helpers (idempotent)
// ---------------------------------------------------------------------------
async function hasColumn(conn, table, column) {
  const [r] = await conn.query(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`,
    [DB, table, column]
  );
  return r.length > 0;
}

async function hasIndex(conn, table, index) {
  const [r] = await conn.query(
    `SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`,
    [DB, table, index]
  );
  return r.length > 0;
}

async function addColumn(conn, table, column, ddl) {
  if (await hasColumn(conn, table, column)) {
    log(`   · ${table}.${column} already present`);
    return;
  }
  log(`   + ${table}.${column}`);
  if (APPLY) await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN ${ddl}`);
}

// ---------------------------------------------------------------------------
async function run() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: DB,
    multipleStatements: true,
  });

  log(APPLY ? '▶ APPLY mode — the database will be modified.' : '▶ DRY RUN — nothing will be written. Re-run with --apply.');
  log(`  database: ${DB}`);

  const generated = [];

  // -- 1. entities -----------------------------------------------------------
  step(1, 'entities — entity_type + WLI/NBSV');
  await addColumn(conn, 'entities', 'entity_type',
    `\`entity_type\` ENUM('Operational','Support','System') NOT NULL DEFAULT 'Operational' AFTER \`is_superadmin\``);
  if (!(await hasIndex(conn, 'entities', 'idx_entities_type'))) {
    log('   + index idx_entities_type');
    if (APPLY) await conn.query('ALTER TABLE `entities` ADD KEY `idx_entities_type` (`entity_type`)');
  }

  const pwPlaceholder = bcrypt.hashSync(crypto.randomBytes(18).toString('base64'), 12).replace(/^\$2[abxy]\$/, '$2y$');
  for (const e of SUPPORT_ENTITIES) {
    const [ex] = await conn.query('SELECT id FROM entities WHERE username = ? LIMIT 1', [e.username]);
    if (ex.length) {
      log(`   · entity ${e.name} exists → set entity_type = ${e.type}`);
      if (APPLY) await conn.query('UPDATE entities SET entity_type = ? WHERE id = ?', [e.type, ex[0].id]);
    } else {
      log(`   + entity ${e.name} (${e.type})`);
      if (APPLY) {
        await conn.query(
          `INSERT INTO entities (entities_name, username, password, is_superadmin, entity_type, created_at, updated_at)
           VALUES (?, ?, ?, 0, ?, NOW(), NOW())`,
          [e.name, e.username, pwPlaceholder, e.type]
        );
      }
    }
  }

  // -- 2. roles --------------------------------------------------------------
  step(2, 'roles — role_code + the 8 roles');
  await addColumn(conn, 'roles', 'role_code', '`role_code` VARCHAR(40) NULL AFTER `id`');

  // Stamp codes onto the legacy rows first, so existing users.role_id keeps working.
  for (const [oldName, def] of Object.entries(ROLE_MIGRATION)) {
    const [ex] = await conn.query('SELECT id, role_code FROM roles WHERE role_name = ? LIMIT 1', [oldName]);
    if (!ex.length) continue;
    log(`   ~ role "${oldName}" → ${def.code} / "${def.name}"`);
    if (APPLY) {
      await conn.query(
        'UPDATE roles SET role_code = ?, role_name = ?, is_cross_entity = ?, updated_at = NOW() WHERE id = ?',
        [def.code, def.name, def.cross, ex[0].id]
      );
    }
  }
  // Then add anything still missing (FINANCE_STAFF, SUPER_ADMIN, or a fresh install).
  for (const r of NEW_ROLES) {
    const [ex] = await conn.query('SELECT id FROM roles WHERE role_code = ? LIMIT 1', [r.code]);
    if (ex.length) continue;
    log(`   + role ${r.code} / "${r.name}"`);
    if (APPLY) {
      await conn.query(
        'INSERT INTO roles (role_code, role_name, is_cross_entity, created_at, updated_at) VALUES (?, ?, ?, NOW(), NOW())',
        [r.code, r.name, r.cross]
      );
    }
  }
  if (APPLY) {
    // Only enforce NOT NULL/UNIQUE once every row has a code.
    const [nulls] = await conn.query('SELECT COUNT(*) c FROM roles WHERE role_code IS NULL');
    if (nulls[0].c === 0 && !(await hasIndex(conn, 'roles', 'role_code'))) {
      log('   + roles.role_code → NOT NULL UNIQUE');
      await conn.query('ALTER TABLE `roles` MODIFY `role_code` VARCHAR(40) NOT NULL, ADD UNIQUE KEY `role_code` (`role_code`)');
    } else if (nulls[0].c > 0) {
      log(`   ! ${nulls[0].c} role(s) still have no role_code — left nullable; assign them manually.`);
    }
  }

  // -- 3. users --------------------------------------------------------------
  step(3, 'users — unique email + the 14 staff accounts');
  const [dupEmail] = await conn.query(
    'SELECT email, COUNT(*) c FROM users WHERE email IS NOT NULL GROUP BY email HAVING c > 1');
  if (dupEmail.length) {
    log(`   ! duplicate emails found (${dupEmail.map((d) => d.email).join(', ')}) — resolve these before the unique index can be added.`);
  } else if (!(await hasIndex(conn, 'users', 'uq_users_email'))) {
    log('   + unique index users.email (login accepts username OR email)');
    if (APPLY) await conn.query('ALTER TABLE `users` ADD UNIQUE KEY `uq_users_email` (`email`)');
  }

  const [roleRows] = await conn.query('SELECT id, role_code FROM roles WHERE role_code IS NOT NULL');
  const roleId = Object.fromEntries(roleRows.map((r) => [r.role_code, r.id]));
  const [entRows] = await conn.query('SELECT id, username FROM entities');
  const entityId = Object.fromEntries(entRows.map((e) => [e.username, e.id]));

  for (const s of STAFF) {
    const rid = roleId[s.role];
    const eid = s.entity ? entityId[s.entity] ?? null : null;
    if (!rid) { log(`   ! role ${s.role} missing — skipping ${s.name}`); continue; }
    if (s.entity && !eid) { log(`   ! entity ${s.entity} missing — skipping ${s.name}`); continue; }

    const [ex] = await conn.query(
      'SELECT id FROM users WHERE username = ? OR email = ? LIMIT 1', [s.username, s.email]);
    if (ex.length) {
      log(`   ~ ${s.name} (${s.username}) → ${s.role}`);
      if (APPLY) {
        await conn.query(
          `UPDATE users SET name = ?, username = ?, email = ?, role_id = ?, entity_id = ?, position = ?,
                            is_active = 1, updated_at = NOW() WHERE id = ?`,
          [s.name, s.username, s.email, rid, eid, s.position, ex[0].id]
        );
      }
    } else {
      const plain = GEN_PASSWORDS ? crypto.randomBytes(9).toString('base64url') : 'password';
      const hash = bcrypt.hashSync(plain, 12).replace(/^\$2[abxy]\$/, '$2y$');
      generated.push({ name: s.name, username: s.username, email: s.email, password: plain });
      log(`   + ${s.name} (${s.username}) → ${s.role}`);
      if (APPLY) {
        await conn.query(
          `INSERT INTO users (entity_id, role_id, name, username, email, password, position, is_active, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, NOW(), NOW())`,
          [eid, rid, s.name, s.username, s.email, hash, s.position]
        );
      }
    }
  }

  // -- 4. sapropdi -----------------------------------------------------------
  step(4, 'sapropdi — item_code / short_code / category / legacy_no');
  await addColumn(conn, 'sapropdi', 'item_code',  '`item_code` VARCHAR(16) NULL AFTER `id`');
  await addColumn(conn, 'sapropdi', 'short_code', '`short_code` VARCHAR(4) NULL AFTER `item_code`');
  await addColumn(conn, 'sapropdi', 'category',
    "`category` ENUM('Seedlings','Fertilizer','Herbicide','Insecticide','Fungicide','Equipment','Others') NULL AFTER `short_code`");
  await addColumn(conn, 'sapropdi', 'legacy_no',  '`legacy_no` INT NULL AFTER `category`');
  if (!(await hasIndex(conn, 'sapropdi', 'item_code'))) {
    log('   + unique index sapropdi.item_code');
    if (APPLY) await conn.query('ALTER TABLE `sapropdi` ADD UNIQUE KEY `item_code` (`item_code`)');
  }
  log('   → then load the 48 items:  mysql -u root -p ' + DB + ' < db/seed_saprodi.sql');
  log('     (INSERT ... ON DUPLICATE KEY UPDATE on item_code — existing rows and their FKs are preserved)');

  // Pre-existing rows are never deleted, because pre_finance_distributions,
  // stock_in_items, purchase_request_items and saprodi_reorder_levels point at their
  // ids. That does mean an item can end up listed twice (an old "Urea Fertilizer 46%"
  // beside the new UR006 UREA), so report which ones need a human decision.
  if (await hasColumn(conn, 'sapropdi', 'item_code')) {
    const [orphans] = await conn.query(
      `SELECT s.id, s.sapropdi_name,
              (SELECT COUNT(*) FROM purchase_request_items   WHERE sapropdi_id = s.id) AS pr_items,
              (SELECT COUNT(*) FROM stock_in_items           WHERE sapropdi_id = s.id) AS stock_items,
              (SELECT COUNT(*) FROM pre_finance_distributions WHERE sapropdi_id = s.id) AS prefin,
              (SELECT COUNT(*) FROM saprodi_reorder_levels   WHERE sapropdi_id = s.id) AS reorder
       FROM sapropdi s WHERE s.item_code IS NULL`);
    if (orphans.length) {
      log(`   ! ${orphans.length} pre-existing saprodi row(s) have no item_code and will sit alongside the 48:`);
      for (const o of orphans) {
        const refs = Number(o.pr_items) + Number(o.stock_items) + Number(o.prefin) + Number(o.reorder);
        log(`       #${o.id} "${o.sapropdi_name}" — ${refs} reference(s)` +
          (refs === 0 ? '  → safe to delete' : '  → repoint references, or give it its own item_code'));
      }
    }
  }

  // -- 5. approval_routes ----------------------------------------------------
  step(5, 'approval_routes — per-entity matrix');

  // Label historic approval rows BEFORE the routes are replaced: the label is derived
  // from the route that produced the row, and the old and new matrices assign
  // different roles to the same step (old PR step 3 = Head, new = Finance Manager).
  // Once the old rows are gone that link is unrecoverable.
  await addColumn(conn, 'document_approvals', 'step_label',
    "`step_label` ENUM('Requested','Approved','Acknowledged','Payment') NULL AFTER `step_order`");
  if (APPLY) {
    const [byRole] = await conn.query(
      `UPDATE document_approvals da
       JOIN approval_routes ar
         ON ar.document_type = da.document_type AND ar.step_order = da.step_order AND ar.role_id = da.role_id
       SET da.step_label = ar.step_label
       WHERE da.step_label IS NULL`);
    log(`   ~ labelled ${byRole.affectedRows} historic row(s) from the old routes`);
  }

  if (APPLY) {
    await conn.query(
      "ALTER TABLE `approval_routes` MODIFY `step_label` ENUM('Requested','Approved','Acknowledged','Payment') NOT NULL");
  }
  const [operational] = await conn.query(
    "SELECT id, entities_name FROM entities WHERE entity_type = 'Operational' ORDER BY id");
  log(`   operational entities: ${operational.map((e) => e.entities_name).join(', ') || '(none)'}`);
  const [oldRoutes] = await conn.query('SELECT COUNT(*) c FROM approval_routes');
  log(`   - removing ${oldRoutes[0].c} existing route row(s)`);
  if (APPLY) await conn.query('DELETE FROM approval_routes');
  for (const e of operational) {
    for (const [doc, order, label, code] of ROUTES) {
      if (!roleId[code]) continue;
      if (APPLY) {
        await conn.query(
          `INSERT INTO approval_routes (document_type, entity_id, step_order, step_label, role_id, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, NOW(), NOW())`,
          [doc, e.id, order, label, roleId[code]]
        );
      }
    }
    log(`   + ${ROUTES.length} routes for ${e.entities_name}`);
  }

  // -- 6. document_approvals -------------------------------------------------
  step(6, 'document_approvals — label whatever the first pass missed');
  if (APPLY) {
    // Second pass: anything still unlabelled kept the same position but changed role
    // between the two matrices, so fall back to the label the new route gives that
    // position. For a legacy PR that means step 3 is still "Acknowledged" — only the
    // role behind it moved from Head to Finance Manager.
    const [byPosition] = await conn.query(
      `UPDATE document_approvals da
       JOIN (SELECT document_type, step_order, MIN(step_label) AS step_label
             FROM approval_routes GROUP BY document_type, step_order) ar
         ON ar.document_type = da.document_type AND ar.step_order = da.step_order
       SET da.step_label = ar.step_label
       WHERE da.step_label IS NULL`);
    log(`   ~ labelled ${byPosition.affectedRows} further row(s) by position`);
    const [left] = await conn.query('SELECT COUNT(*) c FROM document_approvals WHERE step_label IS NULL');
    log(`   ${left[0].c} approval row(s) still unlabelled` +
      (left[0].c ? ' — they are still counted towards document status (the NULL-safe comparison covers them).' : ''));
  }

  // -- 7. payment_requests ---------------------------------------------------
  step(7, 'payment_requests — payment execution columns');
  await addColumn(conn, 'payment_requests', 'payment_method_id', '`payment_method_id` INT NULL AFTER `status`');
  await addColumn(conn, 'payment_requests', 'paid_by_user_id',   '`paid_by_user_id` INT NULL AFTER `payment_method_id`');

  // -- 8. stuck document statuses -------------------------------------------
  step(8, 'backfill document statuses stuck on Pending');
  const DOC_TABLE = { PR: 'purchase_requests', PO: 'purchase_orders', PayReq: 'payment_requests' };
  let fixed = 0;
  for (const [docType, table] of Object.entries(DOC_TABLE)) {
    const [docs] = await conn.query(
      `SELECT d.id, d.status,
              SUM(da.status = 'Approved') AS approved,
              SUM(da.status = 'Rejected') AS rejected,
              SUM(da.status = 'Revision') AS revision,
              COUNT(*) AS total
       FROM ${table} d
       JOIN document_approvals da
         ON da.document_type = ? AND da.document_id = d.id
        AND COALESCE(da.step_label, '') <> 'Payment'
       GROUP BY d.id, d.status`,
      [docType]
    );
    for (const d of docs) {
      let want;
      if (Number(d.rejected) > 0) want = 'Rejected';
      else if (Number(d.revision) > 0) want = 'Revision';
      else if (Number(d.approved) === Number(d.total)) want = 'Approved';
      else want = 'Pending';
      if (d.status === want || d.status === 'Draft' || d.status === 'Paid') continue;
      log(`   ~ ${docType} #${d.id}: ${d.status} → ${want}`);
      fixed++;
      if (APPLY) await conn.query(`UPDATE ${table} SET status = ?, updated_at = NOW() WHERE id = ?`, [want, d.id]);
    }
  }
  log(`   ${fixed} document status(es) ${APPLY ? 'corrected' : 'would be corrected'}`);

  // -- summary ---------------------------------------------------------------
  if (generated.length && GEN_PASSWORDS) {
    log('\n── Generated passwords — record these now, they are not stored anywhere:');
    for (const g of generated) log(`   ${g.username.padEnd(20)} ${g.password}   (${g.name})`);
  } else if (generated.length) {
    log(`\n   ${generated.length} new account(s) created with the password "password".`);
    log('   Re-run with --passwords for per-user random passwords instead.');
  }

  await conn.end();
  log(APPLY ? '\n✓ Migration applied.' : '\n✓ Dry run complete — re-run with --apply to write.');
}

run().catch((e) => { console.error('\n✗ Migration failed:', e.message); process.exit(1); });
