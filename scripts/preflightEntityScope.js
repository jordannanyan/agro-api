// Pre-flight check before deploying entity-scoped lists.
//
// Every list in the app is filtered by the PT that owns the row. A row that
// cannot be traced to one — a KTH with no entity, a farmer with no KTH, a
// purchase with no plot, collector or warehouse — simply stops appearing for
// staff bound to a single PT. Nothing is lost, but somebody will report "my data
// is gone", so it is worth knowing the number before the deploy rather than after.
//
// Read-only: it writes nothing and locks nothing.
//
// Usage (on the server, from /var/www/agro-api):
//   node scripts/preflightEntityScope.js
//
// Credentials come from .env, the same ones the API uses — no password prompt, so
// it is safe to paste together with other commands.
require('dotenv').config();
const mysql = require('mysql2/promise');

/** Rows whose PT cannot be determined; each becomes invisible to bound staff. */
const ORPHAN_CHECKS = [
  ['KTH tanpa entitas', 'SELECT COUNT(*) AS n FROM kth WHERE entities_id IS NULL'],
  ['Petani tanpa KTH', 'SELECT COUNT(*) AS n FROM farmers WHERE kth_id IS NULL'],
  ['Petani dengan KTH tanpa entitas',
   'SELECT COUNT(*) AS n FROM farmers f JOIN kth k ON k.id = f.kth_id WHERE k.entities_id IS NULL'],
  ['Plot tanpa petani', 'SELECT COUNT(*) AS n FROM plot WHERE farmer_id IS NULL'],
  ['Gudang tanpa KTH', 'SELECT COUNT(*) AS n FROM warehouse WHERE kth_id IS NULL'],
  ['Collector tanpa KTH', 'SELECT COUNT(*) AS n FROM collectors WHERE kth_id IS NULL'],
  ['Purchasing tak terlacak ke PT', `
    SELECT COUNT(*) AS n FROM purchasing p
    LEFT JOIN plot       pl ON pl.id = p.plot_id
    LEFT JOIN farmers    f  ON f.id  = pl.farmer_id
    LEFT JOIN collectors c  ON c.id  = p.collector_id
    LEFT JOIN warehouse  w  ON w.id  = p.warehouse_id
    LEFT JOIN kth        k  ON k.id  = COALESCE(f.kth_id, c.kth_id, w.kth_id)
    WHERE k.entities_id IS NULL`],
  ['Processing tak terlacak ke PT', `
    SELECT COUNT(*) AS n FROM processing pr
    LEFT JOIN warehouse w ON w.id = pr.warehouse_id
    LEFT JOIN kth k ON k.id = COALESCE(w.kth_id, (
      SELECT COALESCE(cf.kth_id, cc.kth_id, cw.kth_id)
      FROM processing_purchasings pp
      JOIN purchasing        cpu ON cpu.id = pp.purchasing_id
      LEFT JOIN plot         cpl ON cpl.id = cpu.plot_id
      LEFT JOIN farmers      cf  ON cf.id  = cpl.farmer_id
      LEFT JOIN collectors   cc  ON cc.id  = cpu.collector_id
      LEFT JOIN warehouse    cw  ON cw.id  = cpu.warehouse_id
      WHERE pp.processing_id = pr.id
      ORDER BY pp.volume_contributed DESC LIMIT 1))
    WHERE k.entities_id IS NULL`],
  ['Selling tak terlacak ke PT', `
    SELECT COUNT(*) AS n FROM selling s
    LEFT JOIN processing spr ON spr.id = s.processing_id
    LEFT JOIN warehouse  w   ON w.id   = COALESCE(s.warehouse_id, spr.warehouse_id)
    LEFT JOIN kth k ON k.id = COALESCE(w.kth_id, (
      SELECT COALESCE(cf.kth_id, cc.kth_id, cw.kth_id)
      FROM processing_purchasings pp
      JOIN purchasing        cpu ON cpu.id = pp.purchasing_id
      LEFT JOIN plot         cpl ON cpl.id = cpu.plot_id
      LEFT JOIN farmers      cf  ON cf.id  = cpl.farmer_id
      LEFT JOIN collectors   cc  ON cc.id  = cpu.collector_id
      LEFT JOIN warehouse    cw  ON cw.id  = cpu.warehouse_id
      WHERE pp.processing_id = spr.id
      ORDER BY pp.volume_contributed DESC LIMIT 1))
    WHERE k.entities_id IS NULL`],
  ['Distribusi (barang keluar) tak terlacak ke PT', `
    SELECT COUNT(*) AS n FROM pre_finance_distributions d
    WHERE COALESCE(
      (SELECT fk.entities_id FROM farmers f JOIN kth fk ON fk.id = f.kth_id WHERE f.id = d.farmer_id),
      (SELECT wk.entities_id FROM warehouse w JOIN kth wk ON wk.id = w.kth_id WHERE w.id = d.warehouse_id)
    ) IS NULL`],
  ['Stock in tanpa PT', `
    SELECT COUNT(*) AS n FROM stock_in si
    WHERE (SELECT wk.entities_id FROM warehouse w JOIN kth wk ON wk.id = w.kth_id
            WHERE w.id = si.warehouse_id) IS NULL`],
  ['Stock out tanpa PT', `
    SELECT COUNT(*) AS n FROM stock_out so
    WHERE (SELECT wk.entities_id FROM warehouse w JOIN kth wk ON wk.id = w.kth_id
            WHERE w.id = so.warehouse_id) IS NULL`],
];

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'agro_supply',
  });
  console.log(`▶ Pre-flight scope check — database ${process.env.DB_NAME || 'agro_supply'} (read-only)\n`);

  let total = 0;
  for (const [label, sql] of ORPHAN_CHECKS) {
    let n;
    try {
      n = Number((await conn.query(sql))[0][0].n);
    } catch (e) {
      // A table missing here means the database predates a migration; say which.
      console.log(`  ?   ${label.padEnd(46)} — dilewati: ${e.message}`);
      continue;
    }
    total += n;
    console.log(`  ${n ? '!' : 'ok'}  ${label.padEnd(46)} ${n}`);
  }

  // Bound roles must have an entity, or they see everything instead of their own PT.
  const [loose] = await conn.query(`
    SELECT u.id, u.name, u.username, r.role_code
    FROM users u JOIN roles r ON r.id = u.role_id
    WHERE u.is_active = 1 AND r.is_cross_entity = 0 AND u.entity_id IS NULL`);
  console.log('');
  if (loose.length) {
    console.log(`  !   ${loose.length} user terikat entitas tapi entity_id NULL — mereka akan melihat SEMUA entitas:`);
    for (const u of loose) console.log(`        #${u.id} ${u.name} (${u.username}, ${u.role_code})`);
  } else {
    console.log('  ok  Semua user terikat entitas sudah punya entity_id.');
  }

  await conn.end();
  console.log(total === 0 && loose.length === 0
    ? '\n✓ Bersih — aman lanjut deploy.'
    : `\n! ${total} baris tak terlacak${loose.length ? ` + ${loose.length} user tanpa entitas` : ''}.`
      + '\n  Baris itu akan hilang dari layar pegawai yang terikat entitas (admin NBSV tetap melihatnya).'
      + '\n  Lengkapi relasinya lebih dulu, atau lanjut sadar risikonya.');
})().catch((e) => { console.error('✗ pre-flight gagal:', e.message); process.exit(2); });
