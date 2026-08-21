// -----------------------------------------------------------------------------
// Migration: close out the 2026-08 reconciliation (2026-08)
//
// Four unrelated leftovers from docs/rekonsiliasi-buku-besar-2026-08.md, put in
// one script because none of them is big enough to deploy on its own.
//
//   1. entities.payout_rule — which gate decides what a farmer may be paid.
//      The two ledgers do NOT agree, and both are in force:
//
//        SJ  (SNBS)  =IF((J-E-F-Q) > 0, (J-E-F-Q) * 0.3, 0)
//        AML (JNBS)  =IF((J-O) > 0, (K-Q), 0)
//
//      SJ nets the debt out of the base and pays 30% of what is left. AML uses
//      the debt only as a switch: once the plot's margin clears its debt, the
//      farmer's whole standing share becomes payable. Verified against the
//      sheets: AG1 → Rp 1.007.953,75, AG2 → 0, SM003002 → 0, all matching.
//
//   2. GW012009 / GW012010 — two coffee plots of Sukadi recorded in
//      JNBS Database.xlsx (loan no. 1080-1087, Rp 470.890) but sitting under
//      `Non KTH SJ` / SNBS. The other three Sukadi plots are under KTH AML.
//      There are two farmer rows for the man: #2500 (JNBS) and #71 (SNBS).
//      Only the two PLOTS move, to farmer #2500 — #71 also holds SJ087071 and
//      NONSJ0194 with 19 purchases against them, which stay with SNBS.
//
//   3. One labour-debt row worth Rp 600.000 that never imported, because its
//      `Starting Date` in ADM_Entry Hutang Tenaga Kerja reads as the text
//      `21/05/0206` — year 206. Suparno, KA014002, 6 workers x Rp 100.000,
//      21-27 May 2026. The workbook still needs fixing so a re-import does not
//      drop it again; this puts the money in the database meanwhile.
//
//   4. Schema drift that predates all of this: `fk_payreq_paidby`,
//      `fk_payreq_method` and `idx_sapropdi_category` are in db/schema.sql but
//      were never added to production by migratePaymentReconciliation2026-08.js,
//      so compareSchema.js could not print IDENTICAL. Neither FK has an orphan.
//
// Idempotent. Dry run by default.
//
// Usage:
//   node scripts/migrateCloseout2026-08.js            # dry run
//   node scripts/migrateCloseout2026-08.js --apply
// -----------------------------------------------------------------------------
require('dotenv').config();
const mysql = require('mysql2/promise');

const APPLY = process.argv.includes('--apply');
const DB = process.env.DB_NAME || 'agro_supply';
const log = (...a) => console.log(...a);

const SNBS = 1;
const JNBS = 3;
// The two coffee plots and the JNBS farmer row they belong with.
const MOVE_PLOTS = ['GW012009', 'GW012010'];
const rupiah = (n) => 'Rp ' + Number(n || 0).toLocaleString('id-ID', { maximumFractionDigits: 2 });

const one = async (conn, sql, args = []) => {
  const [r] = await conn.query(sql, args);
  return r[0] || {};
};

async function hasColumn(conn, table, column) {
  const [r] = await conn.query(
    `SELECT 1 FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1`, [DB, table, column]);
  return r.length > 0;
}

async function hasConstraint(conn, name) {
  const [r] = await conn.query(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
     WHERE CONSTRAINT_SCHEMA = ? AND CONSTRAINT_NAME = ? LIMIT 1`, [DB, name]);
  return r.length > 0;
}

async function hasIndex(conn, table, name) {
  const [r] = await conn.query(
    `SELECT 1 FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1`, [DB, table, name]);
  return r.length > 0;
}

async function run() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: DB,
  });

  log(APPLY ? '▶ APPLY mode — the database will be modified.' : '▶ DRY RUN — nothing will be written.');
  log(`  database: ${DB}`);

  // -- 1. payout_rule -----------------------------------------------------
  log('\n1) entities.payout_rule — aturan penghalang pembayaran per PT');
  if (await hasColumn(conn, 'entities', 'payout_rule')) {
    log('   · entities.payout_rule already present');
  } else {
    log("   + entities.payout_rule ENUM('Gate','NetSurplus') NOT NULL DEFAULT 'Gate'");
    if (APPLY) {
      await conn.query(
        "ALTER TABLE `entities` ADD COLUMN `payout_rule` ENUM('Gate','NetSurplus') NOT NULL DEFAULT 'Gate' AFTER `profit_share_kth_pct`");
    }
  }
  if (APPLY || await hasColumn(conn, 'entities', 'payout_rule')) {
    const [before] = await conn.query(
      'SELECT id, entities_name, payout_rule FROM entities WHERE id IN (?, ?)', [SNBS, JNBS]);
    for (const e of before) log(`   · ${e.entities_name}: ${e.payout_rule}`);
    if (APPLY) {
      await conn.query("UPDATE entities SET payout_rule = 'NetSurplus', updated_at = NOW() WHERE id = ?", [SNBS]);
      await conn.query("UPDATE entities SET payout_rule = 'Gate', updated_at = NOW() WHERE id = ?", [JNBS]);
      const [after] = await conn.query(
        'SELECT entities_name, payout_rule FROM entities WHERE id IN (?, ?)', [SNBS, JNBS]);
      for (const e of after) log(`   → ${e.entities_name}: ${e.payout_rule}`);
    }
  } else {
    log("   ~ SNBS Lampung → NetSurplus  ·  JNBS → Gate");
  }

  // -- 2. Two coffee plots back to JNBS -----------------------------------
  log('\n2) GW012009 / GW012010 pindah ke JNBS');
  const target = await one(conn,
    `SELECT f.id FROM farmers f JOIN kth k ON k.id = f.kth_id
      WHERE f.farmer_name = 'Sukadi' AND k.entities_id = ? LIMIT 1`, [JNBS]);
  if (!target.id) throw new Error('petani Sukadi di JNBS tidak ditemukan — dibatalkan');

  const [moving] = await conn.query(
    `SELECT p.id, p.plot_name, p.farmer_id, k.entities_id
       FROM plot p JOIN farmers f ON f.id = p.farmer_id JOIN kth k ON k.id = f.kth_id
      WHERE p.plot_name IN (?)`, [MOVE_PLOTS]);
  const todo = moving.filter((p) => Number(p.farmer_id) !== Number(target.id));
  if (!todo.length) {
    log(`   · kedua lahan sudah di petani #${target.id} (JNBS) — tidak ada yang diubah`);
  } else {
    const ids = todo.map((p) => p.id);
    const debt = await one(conn,
      `SELECT COUNT(*) n, COALESCE(SUM(total_amount), 0) v
         FROM pre_finance_distributions WHERE plot_id IN (?)`, [ids]);
    for (const p of todo) log(`   ~ ${p.plot_name}  petani #${p.farmer_id} → #${target.id}`);
    log(`   ~ ${debt.n} baris utang ikut pindah (${rupiah(debt.v)})`);
    if (APPLY) {
      await conn.query('UPDATE plot SET farmer_id = ?, updated_at = NOW() WHERE id IN (?)', [target.id, ids]);
      // The distribution rows carry farmer_id of their own; keep it in step.
      await conn.query(
        'UPDATE pre_finance_distributions SET farmer_id = ?, updated_at = NOW() WHERE plot_id IN (?)',
        [target.id, ids]);
    }
  }

  // -- 3. The labour row the date typo dropped ----------------------------
  log('\n3) Baris tenaga kerja KA014002 yang tidak terimpor');
  const DESC = 'Hutang tenaga kerja 2026-05-21 s/d 2026-05-27';
  const plot = await one(conn, "SELECT id, farmer_id FROM plot WHERE plot_name = 'KA014002' LIMIT 1");
  if (!plot.id) throw new Error('lahan KA014002 tidak ditemukan — dibatalkan');
  // That week's description is shared by six other plots, so the check has to be
  // scoped to this plot or the row would never be inserted.
  const exists = await one(conn,
    'SELECT COUNT(*) n FROM pre_finance_distributions WHERE description = ? AND plot_id = ?',
    [DESC, plot.id]);
  if (Number(exists.n)) {
    log('   · sudah ada — tidak ada yang ditambahkan');
  } else {
    // Copy the shape of the plot's other labour rows rather than guessing.
    const like = await one(conn,
      `SELECT warehouse_id, commodities_id, unit_id FROM pre_finance_distributions d
        WHERE d.plot_id = ? AND d.pre_finance_type_id = 2 ORDER BY d.date DESC LIMIT 1`, [plot.id]);
    log(`   + ${DESC}  6 orang × Rp 100.000 = ${rupiah(600000)}`);
    if (APPLY) {
      await conn.query(
        `INSERT INTO pre_finance_distributions
           (pre_finance_type_id, date, farmer_id, plot_id, commodities_id, warehouse_id,
            quantity, unit_id, price_per_unit, total_amount, counts_as_debt, description,
            created_at, updated_at)
         VALUES (2, '2026-05-21', ?, ?, ?, ?, 6, ?, 100000, 600000, 1, ?, NOW(), NOW())`,
        [plot.farmer_id, plot.id, like.commodities_id ?? null, like.warehouse_id ?? null,
         like.unit_id ?? null, DESC]);
    }
  }

  // -- 4. Schema drift that predates this work ----------------------------
  log('\n4) Drift skema lama');
  const drift = [
    { kind: 'fk', name: 'fk_payreq_paidby', table: 'payment_requests',
      check: `SELECT COUNT(*) n FROM payment_requests
               WHERE paid_by_user_id IS NOT NULL
                 AND paid_by_user_id NOT IN (SELECT id FROM users)`,
      ddl: 'ALTER TABLE `payment_requests` ADD CONSTRAINT `fk_payreq_paidby` '
         + 'FOREIGN KEY (`paid_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL' },
    { kind: 'fk', name: 'fk_payreq_method', table: 'payment_requests',
      check: `SELECT COUNT(*) n FROM payment_requests
               WHERE payment_method_id IS NOT NULL
                 AND payment_method_id NOT IN (SELECT id FROM payment_methods)`,
      ddl: 'ALTER TABLE `payment_requests` ADD CONSTRAINT `fk_payreq_method` '
         + 'FOREIGN KEY (`payment_method_id`) REFERENCES `payment_methods`(`id`) ON DELETE SET NULL' },
    { kind: 'index', name: 'idx_sapropdi_category', table: 'sapropdi',
      ddl: 'ALTER TABLE `sapropdi` ADD INDEX `idx_sapropdi_category` (`category`)' },
  ];
  for (const d of drift) {
    const present = d.kind === 'fk'
      ? await hasConstraint(conn, d.name)
      : await hasIndex(conn, d.table, d.name);
    if (present) { log(`   · ${d.name} already present`); continue; }
    if (d.check) {
      const orphan = Number((await one(conn, d.check)).n);
      if (orphan) throw new Error(`${d.name}: ${orphan} baris menggantung — dibatalkan`);
    }
    log(`   + ${d.name}`);
    if (APPLY) await conn.query(d.ddl);
  }

  // -- Result -------------------------------------------------------------
  const jnbs = await one(conn, `
    SELECT COALESCE(SUM(d.total_amount), 0) v FROM pre_finance_distributions d
      JOIN plot p ON p.id = d.plot_id JOIN farmers f ON f.id = p.farmer_id
      JOIN kth k ON k.id = f.kth_id
     WHERE k.entities_id = ? AND d.counts_as_debt = 1`, [JNBS]);
  log(`\n   utang JNBS ${APPLY ? 'sesudah' : 'sebelum'}: ${rupiah(jnbs.v)}`);
  log('   (sebelum rangkaian ini Rp 794.386.511; +470.890 pindahan +600.000 baris baru');
  log('    → sasaran Rp 795.457.401)');

  await conn.end();
  log(APPLY
    ? '\n✓ Migration applied.'
    : '\n✓ Dry run complete — re-run with --apply to write.');
}

run().catch((e) => { console.error('\n✗ Migration failed:', e.message); process.exit(1); });
