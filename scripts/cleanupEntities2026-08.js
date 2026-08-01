// -----------------------------------------------------------------------------
// Data cleanup following the 2026-08 role migration.
//
// Fixes what migrateRoles2026-08.js could not decide on its own:
//   1. missing staff — bambang.triatmaja and edo.santeyo were never created
//   2. JNBS split across two entities — merge into the one holding the data
//   3. "Admin Super" treated as an operational PT
//   4. ten dummy accounts still active, now holding real financial authority
//   5. approval rows left behind by deleted documents
//   6. FSF Palangka Raya removal — the programme has ended
//
// Usage:
//   node scripts/cleanupEntities2026-08.js           # dry run: report only
//   node scripts/cleanupEntities2026-08.js --apply   # write
//
// BACK UP FIRST, and take a COMPLETE dump:
//   mysqldump -u agro -p agro_supply > backup.sql
// A phpMyAdmin export that omits `plot` and `trees` is not a usable backup.
// -----------------------------------------------------------------------------
require('dotenv').config();
const crypto = require('crypto');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

const APPLY = process.argv.includes('--apply');
const DB = process.env.DB_NAME || 'agro_supply';

const log = (...a) => console.log(...a);
const step = (n, t) => log(`\n── ${n}. ${t}`);

// Staff the role migration reported as "existing" but never actually created.
const MISSING_STAFF = [
  { name: 'Bambang Triatmaja',    username: 'bambang.triatmaja', email: 'bambang.triatmaja@snbs.earth',
    role: 'FIELD_ADMIN',     entityUsername: 'snbs456', position: 'Field Admin — stok masuk & stok keluar' },
  { name: 'Edo Santeyo Lensiyus', username: 'edo.santeyo',       email: 'edo.santeyo@snbs.earth',
    role: 'PROJECT_MANAGER', entityUsername: 'snbs456', position: 'Project Manager SNBS' },
  { name: 'Elma Aryanti',         username: 'elma.aryanti',      email: 'elma.aryanti@snbs.earth',
    role: 'FIELD_ADMIN',     entityUsername: 'snbs456', position: 'Field Admin — buku besar (pembelian & penjualan)' },
];

const DUMMY_USERNAMES = [
  'snbs_intern', 'snbs_pm', 'snbs_head', 'snbs_finance', 'snbs_director',
  'jnbs_intern', 'jnbs_pm', 'jnbs_head', 'jnbs_finance', 'jnbs_director',
];

async function tableExists(conn, table) {
  const [r] = await conn.query(
    'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? LIMIT 1', [DB, table]);
  return r.length > 0;
}

async function count(conn, sql, args = []) {
  const [r] = await conn.query(sql, args);
  return Number(r[0]?.n ?? 0);
}

async function run() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: DB,
    multipleStatements: true,
  });

  log(APPLY ? '▶ APPLY mode — the database will be modified.' : '▶ DRY RUN — nothing will be written.');
  log(`  database: ${DB}`);

  const [roleRows] = await conn.query('SELECT id, role_code FROM roles WHERE role_code IS NOT NULL');
  const roleId = Object.fromEntries(roleRows.map((r) => [r.role_code, r.id]));
  const [entRows] = await conn.query('SELECT id, username, entities_name, entity_type FROM entities');
  const entityByUsername = Object.fromEntries(entRows.map((e) => [e.username, e]));

  const generated = [];

  // -- 1. missing staff -------------------------------------------------------
  step(1, 'staff the role migration skipped');
  for (const s of MISSING_STAFF) {
    const [ex] = await conn.query(
      'SELECT id, name FROM users WHERE username = ? OR email = ? LIMIT 1', [s.username, s.email]);
    if (ex.length) { log(`   · ${s.name} already present (id ${ex[0].id})`); continue; }

    const ent = entityByUsername[s.entityUsername];
    if (!ent) { log(`   ! entity ${s.entityUsername} not found — skipping ${s.name}`); continue; }
    if (!roleId[s.role]) { log(`   ! role ${s.role} not found — skipping ${s.name}`); continue; }

    const plain = crypto.randomBytes(9).toString('base64url');
    generated.push({ username: s.username, password: plain, name: s.name });
    log(`   + ${s.name} (${s.username}) → ${s.role} @ ${ent.entities_name}`);
    if (APPLY) {
      await conn.query(
        `INSERT INTO users (entity_id, role_id, name, username, email, password, position, is_active, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, NOW(), NOW())`,
        [ent.id, roleId[s.role], s.name, s.username, s.email,
         bcrypt.hashSync(plain, 12).replace(/^\$2[abxy]\$/, '$2y$'), s.position]
      );
    }
  }

  // -- 2. merge the two JNBS entities ----------------------------------------
  step(2, 'merge JNBS');
  // Keep the entity that owns the data. Moving a handful of user rows is far
  // cheaper — and far less risky — than relocating KTH, farmers, plots and trees.
  const keep = entityByUsername['jnbs123'];   // "JNBS" (Yogyakarta) — holds KTH AML
  const drop = entityByUsername['jnbs'];      // "PT Java Nature Based Solutions (JNBS)" — holds only staff

  if (!keep || !drop) {
    log('   · nothing to merge (one of the two JNBS entities is already gone)');
  } else {
    const kthKeep = await count(conn, 'SELECT COUNT(*) n FROM kth WHERE entities_id = ?', [keep.id]);
    const kthDrop = await count(conn, 'SELECT COUNT(*) n FROM kth WHERE entities_id = ?', [drop.id]);
    log(`   keep  #${keep.id} "${keep.entities_name}" — ${kthKeep} KTH`);
    log(`   drop  #${drop.id} "${drop.entities_name}" — ${kthDrop} KTH`);
    if (kthDrop > kthKeep) {
      log('   ! the entity marked for removal owns more KTH than the one kept — ABORTING this step.');
    } else {
      // Everything that points at the entity being removed.
      const moves = [
        ['users', 'entity_id'], ['budgets', 'entity_id'], ['approval_routes', 'entity_id'],
        ['purchase_requests', 'entity_id'], ['purchase_orders', 'entity_id'],
        ['payment_requests', 'entity_id'], ['kth', 'entities_id'], ['offtaker', 'entities_id'],
      ];
      for (const [table, col] of moves) {
        if (!(await tableExists(conn, table))) continue;
        const n = await count(conn, `SELECT COUNT(*) n FROM \`${table}\` WHERE \`${col}\` = ?`, [drop.id]);
        if (!n) continue;
        log(`   ~ ${table}: ${n} row(s) → entity ${keep.id}`);
        if (APPLY) {
          // approval_routes would collide on (document_type, entity, step_order):
          // the kept entity already has its own set, so drop the duplicates instead.
          if (table === 'approval_routes') {
            await conn.query('DELETE FROM approval_routes WHERE entity_id = ?', [drop.id]);
          } else {
            await conn.query(`UPDATE \`${table}\` SET \`${col}\` = ? WHERE \`${col}\` = ?`, [keep.id, drop.id]);
          }
        }
      }
      log(`   ~ rename entity ${keep.id} → "PT Java Nature Based Solutions (JNBS)"`);
      log(`   - delete entity ${drop.id}`);
      log(`     (login username stays "${keep.username}" — changing it would break the land+tree app)`);
      if (APPLY) {
        await conn.query(
          "UPDATE entities SET entities_name = 'PT Java Nature Based Solutions (JNBS)', updated_at = NOW() WHERE id = ?",
          [keep.id]);
        await conn.query('DELETE FROM entities WHERE id = ?', [drop.id]);
      }
    }
  }

  // -- 3. Admin Super is not an operational PT -------------------------------
  step(3, 'reclassify "Admin Super"');
  const adminSuper = entityByUsername['admin_super'];
  if (!adminSuper) log('   · not present');
  else {
    const routes = await count(conn, 'SELECT COUNT(*) n FROM approval_routes WHERE entity_id = ?', [adminSuper.id]);
    const pos = await count(conn, 'SELECT COUNT(*) n FROM purchase_orders WHERE entity_id = ?', [adminSuper.id]);
    log(`   ~ entity ${adminSuper.id} → entity_type = System`);
    log(`   - ${routes} approval route(s) removed (a system account files no purchases)`);
    if (pos) log(`   ! ${pos} purchase order(s) are filed against it — reassign them to a real PT by hand.`);
    if (APPLY) {
      await conn.query("UPDATE entities SET entity_type = 'System', updated_at = NOW() WHERE id = ?", [adminSuper.id]);
      await conn.query('DELETE FROM approval_routes WHERE entity_id = ?', [adminSuper.id]);
    }
  }

  // -- 4. dummy accounts ------------------------------------------------------
  step(4, 'deactivate the seeded dummy accounts');
  // The role migration remapped these: snbs_head/jnbs_head became Procurement,
  // *_finance became Finance Manager, *_director became Director. Ten accounts
  // whose password is literally "password" now hold real financial authority.
  // They are deactivated rather than deleted — document_approvals.user_id points
  // at them, and that is audit history.
  const [dummies] = await conn.query(
    `SELECT u.id, u.username, u.is_active, r.role_name
     FROM users u LEFT JOIN roles r ON r.id = u.role_id
     WHERE u.username IN (${DUMMY_USERNAMES.map(() => '?').join(',')})`, DUMMY_USERNAMES);
  const active = dummies.filter((d) => d.is_active);
  for (const d of active) log(`   ~ ${d.username.padEnd(15)} (${d.role_name}) → inactive`);
  log(`   ${active.length} account(s) ${APPLY ? 'deactivated' : 'would be deactivated'}, ${dummies.length - active.length} already inactive`);
  if (APPLY && active.length) {
    await conn.query(
      `UPDATE users SET is_active = 0, updated_at = NOW() WHERE id IN (${active.map(() => '?').join(',')})`,
      active.map((d) => d.id));
  }

  // -- 5. approval rows for documents that no longer exist --------------------
  step(5, 'orphaned approval / activity rows');
  const DOC_TABLE = { PR: 'purchase_requests', PO: 'purchase_orders', PayReq: 'payment_requests' };
  for (const [docType, table] of Object.entries(DOC_TABLE)) {
    for (const child of ['document_approvals', 'document_activities']) {
      const n = await count(conn,
        `SELECT COUNT(*) n FROM ${child} c
         LEFT JOIN ${table} d ON d.id = c.document_id
         WHERE c.document_type = ? AND d.id IS NULL`, [docType]);
      if (!n) continue;
      log(`   - ${child}: ${n} row(s) for ${docType} documents that were deleted`);
      if (APPLY) {
        await conn.query(
          `DELETE c FROM ${child} c
           LEFT JOIN ${table} d ON d.id = c.document_id
           WHERE c.document_type = ? AND d.id IS NULL`, [docType]);
      }
    }
  }

  // -- 6. FSF Palangka Raya ---------------------------------------------------
  step(6, 'FSF Palangka Raya');
  const fsf = entityByUsername['fsf123'];
  if (!fsf) log('   · not present');
  else {
    // entities → kth → farmers all cascade, so spell out the blast radius.
    const [kths] = await conn.query('SELECT id, kth_name FROM kth WHERE entities_id = ?', [fsf.id]);
    const kthIds = kths.map((k) => k.id);
    let farmers = [];
    if (kthIds.length) {
      const [f] = await conn.query(
        `SELECT id, farmer_name FROM farmers WHERE kth_id IN (${kthIds.map(() => '?').join(',')})`, kthIds);
      farmers = f;
    }
    log(`   entity ${fsf.id} "${fsf.entities_name}" cascades to:`);
    log(`     ${kths.length} KTH: ${kths.map((k) => k.kth_name).join(', ') || '—'}`);
    log(`     ${farmers.length} farmer(s): ${farmers.map((f) => f.farmer_name).join(', ') || '—'}`);

    // Land and tree records are the one thing here that cannot be reconstructed.
    // As of the 2026-08-02 dump there are none, but refuse to guess if that changed.
    const farmerIds = farmers.map((f) => f.id);
    let land = 0;
    for (const [table, col] of [['plot', 'farmer_id'], ['trees', 'farmer_id']]) {
      if (!farmerIds.length || !(await tableExists(conn, table))) continue;
      const n = await count(conn,
        `SELECT COUNT(*) n FROM \`${table}\` WHERE \`${col}\` IN (${farmerIds.map(() => '?').join(',')})`, farmerIds);
      log(`     ${n} ${table} row(s)`);
      land += n;
    }

    // entities → kth → farmers cascades; these three references do not, so a
    // stray document would abort the DELETE halfway. Report instead of crashing.
    const blockers = [];
    for (const [table, col] of [['budgets', 'entity_id'], ['purchase_orders', 'entity_id'],
      ['payment_requests', 'entity_id'], ['purchase_requests', 'entity_id']]) {
      if (!(await tableExists(conn, table))) continue;
      const n = await count(conn, `SELECT COUNT(*) n FROM \`${table}\` WHERE \`${col}\` = ?`, [fsf.id]);
      if (n) blockers.push(`${table} (${n})`);
    }

    if (land) {
      log(`   ! ${land} plot/tree row(s) hang off this entity — ABORTING. Land data is not reproducible;`);
      log('     move those farmers to another KTH first, then re-run.');
    } else if (blockers.length) {
      log(`   ! still referenced by ${blockers.join(', ')} — ABORTING. Reassign or delete those first.`);
    } else {
      log(`   - deleting entity ${fsf.id}, its KTH and its farmers`);
      if (APPLY) {
        await conn.query('DELETE FROM approval_routes WHERE entity_id = ?', [fsf.id]);
        await conn.query('UPDATE users SET entity_id = NULL WHERE entity_id = ?', [fsf.id]);
        await conn.query('DELETE FROM entities WHERE id = ?', [fsf.id]);
      }
    }
  }

  // -- summary ----------------------------------------------------------------
  step(7, 'documents still mid-flight');
  // These were seeded from the OLD matrix and keep their old, shorter chain.
  const [inflight] = await conn.query(
    `SELECT da.document_type, da.document_id, COUNT(*) steps
     FROM document_approvals da
     WHERE da.status = 'Pending'
     GROUP BY da.document_type, da.document_id`);
  if (!inflight.length) log('   · none');
  for (const d of inflight) {
    log(`   · ${d.document_type} #${d.document_id}: ${d.steps} pending step(s) — follows the pre-2026-08 chain`);
  }
  log('   These finish under the old rules. Cancel and re-file them if they must follow the new flow.');

  if (generated.length) {
    log('\n── Generated passwords — record these now, they are not stored anywhere:');
    for (const g of generated) log(`   ${g.username.padEnd(20)} ${g.password}   (${g.name})`);
  }

  await conn.end();
  log(APPLY ? '\n✓ Cleanup applied.' : '\n✓ Dry run complete — re-run with --apply to write.');
}

run().catch((e) => { console.error('\n✗ Cleanup failed:', e.message); process.exit(1); });
