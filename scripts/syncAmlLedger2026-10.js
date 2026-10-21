// -----------------------------------------------------------------------------
// Sync: AML banana — purchasing / processing / selling follow the ledger (2026-10)
//
// The AML chain came in once, by bulk import on 2026-08-10 (Data Operation
// import_output_v2), from an older copy of "Buku Besar - AML - Banana". Since then:
//
//   - the ledger kept going (DO 113–120: deliveries 13 Aug – 19 Oct 2026) and none
//     of it reached the system;
//   - that import kept only the FIRST Delivery of a Delivery Order. The ledger has
//     since split those DOs, and the dropped deliveries (DO 9–14, 20–21, 62–63,
//     105) are missing, two of them as empty 0-kg sales (PO16, PO57);
//   - the DO numbers shifted, so `BAN-AML-PO113` in the system is DO 112 in the
//     ledger; and delivered volume was stored without the reject.
//
// The ledger ("AML - Data Entry Banana") is the reference. Per Delivery Order:
//   one processing batch `BAN-AML-PO<DO>` holding exactly that DO's purchases,
//   volume_input = Σ purchase kg, volume_output = offtake + reject,
//   one sale: accepted = Offtake Volume, delivered = offtake + reject,
//   price = Offtake Value / Offtake Volume (as the first import did),
//   processing cost = "Total Processing Cost invoiced to Offtaker".
// Purchases: plot + date + kg, price = Purchase Price (the final price),
//   receipt_invoice `BAN-AML-<DO>`, grade Not Categorized, warehouse AML, paid.
//
// Nothing is deleted. Existing rows are matched and updated in place (ids kept,
// so the loan repayments tied to purchases stay attached); what the ledger has
// and the system lacks is inserted. A system row the ledger does not have is
// listed, never removed.
//
// A negative reject in the ledger (DO 114, 117, 120 — weighing corrections)
// would make delivered < accepted; delivered is then set to accepted and listed.
//
// Run the loan-repayment backfill afterwards so the new purchases get theirs:
//   node scripts/backfillAmlRepayments2026-10.js --ledger <xlsx> --apply
//
// Idempotent, dry-run by default; --apply writes everything in one transaction.
//
// Usage:
//   node scripts/syncAmlLedger2026-10.js --ledger <AML xlsx> [--verbose]
//   node scripts/syncAmlLedger2026-10.js --ledger <AML xlsx> --apply
// -----------------------------------------------------------------------------
require('dotenv').config();
const mysql = require('mysql2/promise');

const APPLY = process.argv.includes('--apply');
const VERBOSE = process.argv.includes('--verbose');
const li = process.argv.indexOf('--ledger');
const LEDGER = li > 0 ? process.argv[li + 1] : null;
const DB = process.env.DB_NAME || 'agro_supply';
const log = (...a) => console.log(...a);
if (!LEDGER) { console.error('Usage: --ledger <AML ledger .xlsx> [--apply] [--verbose]'); process.exit(2); }

// The constants the first import used (import_output_v2/_scripts/v2_2_transactions.py).
const COMM_BANANA = 2, WH_AML = 2, GRADE_UNCAT = 8, ENTITY_JNBS = 3;
// `GE007002-OGA` in the ledger is plot GE007002, grade A — the same reading
// migratePaybackRates2026-10.js gives the price database. A plot that really
// carries the suffix in its name (Arifin's CR033005-OGA) is matched as itself.
const GRADE_SUFFIX = { OGA: 'A', OGB: 'B', OGC: 'C', OGNG: 'Non-Grade' };
const SHEET = 'AML - Data Entry Banana';

const r2 = (n) => Math.round(n * 100) / 100;
const r3 = (n) => Math.round(n * 1000) / 1000;
const same = (a, b, eps) => Math.abs(Number(a) - Number(b)) < eps;
const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function cellValue(v) {
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('result' in v) return v.result;
    if ('richText' in v) return v.richText.map((t) => t.text).join('');
    if ('text' in v) return v.text;
  }
  return v;
}
const ymd = (d) => (d instanceof Date && !isNaN(d) ? d.toISOString().slice(0, 10) : null);

async function readLedger(file) {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);
  const ws = wb.getWorksheet(SHEET);
  if (!ws) throw new Error(`Sheet "${SHEET}" tidak ada`);
  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const H = {};
  ws.getRow(1).eachCell((c, n) => { H[norm(cellValue(c.value))] = n; });
  const need = ['Date', 'Delivery Order Number', 'Process', 'Plot ID', 'Purchase Volume', 'Purchase Price',
    'Offtaker Name', 'Volume Reject', 'Offtake Volume', 'Offtake Value',
    'Total Processing Cost invoiced to Offtaker'];
  for (const h of need) if (!H[h]) throw new Error(`Kolom "${h}" tidak ditemukan`);
  const purchases = [], deliveries = [], problems = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const g = (h) => cellValue(row.getCell(H[h]).value);
    const proc = String(g('Process') || '').trim();
    if (proc !== 'Purchasing' && proc !== 'Delivery') return;
    const date = ymd(g('Date'));
    const doNo = Number(g('Delivery Order Number'));
    if (!date || !doNo) { problems.push(`baris ${n}: ${proc} tanpa tanggal/DO — dilewati`); return; }
    if (proc === 'Purchasing') {
      const qty = r3(Number(g('Purchase Volume')) || 0);
      if (qty <= 0) { problems.push(`baris ${n}: pembelian volume 0 — dilewati`); return; }
      purchases.push({ line: n, date, doNo, plot: String(g('Plot ID') || '').trim().toUpperCase(), qty,
        price: r2(Number(g('Purchase Price')) || 0) });
    } else {
      deliveries.push({ line: n, date, doNo, offtaker: String(g('Offtaker Name') || '').trim(),
        acc: r3(Number(g('Offtake Volume')) || 0), rej: r3(Number(g('Volume Reject')) || 0),
        value: r2(Number(g('Offtake Value')) || 0),
        cost: r2(Number(g('Total Processing Cost invoiced to Offtaker')) || 0) });
    }
  });
  return { purchases, deliveries, problems };
}

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root', password: process.env.DB_PASSWORD || '',
    database: DB, dateStrings: true,
  });
  log(`\n=== Sinkron AML (pisang) dengan buku besar — database ${DB} ===`);
  log(APPLY ? 'MODE: APPLY (satu transaksi)\n' : 'MODE: DRY RUN (tidak menulis apa pun)\n');

  const L = await readLedger(LEDGER);
  log(`  buku besar: ${L.purchases.length} pembelian, ${L.deliveries.length} pengiriman, `
    + `${new Set(L.purchases.map((p) => p.doNo)).size} DO`);

  // ---------------------------------------------------------------- lookups
  const [plots] = await conn.query('SELECT id, plot_name FROM plot');
  const plotId = new Map(plots.map((p) => [String(p.plot_name).trim().toUpperCase(), p.id]));
  const [grades] = await conn.query('SELECT id, grade_name FROM grade');
  const gradeId = new Map(grades.map((g) => [g.grade_name, g.id]));
  // Ledger plot code → { plot id, grade id, the name the plot has in the system }.
  const resolvePlot = (code) => {
    if (plotId.has(code)) return { id: plotId.get(code), grade: GRADE_UNCAT, name: code };
    const m = code.match(/^(.+)-(OGA|OGB|OGC|OGNG)$/);
    if (m && plotId.has(m[1]) && gradeId.has(GRADE_SUFFIX[m[2]])) {
      return { id: plotId.get(m[1]), grade: gradeId.get(GRADE_SUFFIX[m[2]]), name: m[1] };
    }
    return null;
  };
  const [offs] = await conn.query('SELECT id, offtaker_name, entities_id FROM offtaker');
  const offByName = new Map();
  for (const o of offs) {
    const k = normName(o.offtaker_name);
    // Prefer an offtaker already filed under JNBS when two share a name.
    if (!offByName.has(k) || o.entities_id === ENTITY_JNBS) offByName.set(k, o.id);
  }
  const [dbPur] = await conn.query(
    `SELECT p.id, p.date, UPPER(TRIM(pl.plot_name)) AS plot, p.grade_id, p.quantity, p.price_per_unit, p.receipt_invoice
     FROM purchasing p JOIN plot pl ON pl.id = p.plot_id
     WHERE p.receipt_invoice LIKE 'BAN-AML-%' AND p.commodities_id = ? ORDER BY p.id`, [COMM_BANANA]);
  const [dbProc] = await conn.query(
    `SELECT pr.id, pr.processing_code, pr.date, pr.volume_input, pr.volume_output, pr.total_processing_cost,
            s.id AS sell_id, s.date AS sell_date, s.delivered_volume, s.accepted_volume, s.price_per_unit,
            s.offtaker_id, o.offtaker_name
     FROM processing pr LEFT JOIN selling s ON s.processing_id = pr.id
     LEFT JOIN offtaker o ON o.id = s.offtaker_id
     WHERE pr.processing_code LIKE 'BAN-AML-PO%' ORDER BY pr.id`);

  const notes = [...L.problems];
  const plan = { purInsert: [], purUpdate: [], procInsert: [], procUpdate: [], sellInsert: [], sellUpdate: [],
    offInsert: new Map(), relink: 0 };

  // ---------------------------------------------------------------- purchases
  const pool = new Map();
  for (const p of dbPur) {
    const k = `${p.date}|${p.plot}|${p.grade_id}|${r3(Number(p.quantity))}`;
    if (!pool.has(k)) pool.set(k, []);
    pool.get(k).push(p);
  }
  const usedPur = new Set();
  const unmatched = [];
  for (const lp of L.purchases) {
    lp.res = resolvePlot(lp.plot);
    if (!lp.res) continue;
    const c = (pool.get(`${lp.date}|${lp.res.name}|${lp.res.grade}|${lp.qty}`) || []).find((p) => !usedPur.has(p.id));
    if (c) { usedPur.add(c.id); lp.dbId = c.id; lp.db = c; } else unmatched.push(lp);
  }
  // Same plot and day, one leftover row each side, kilos differ → the ledger's kilos.
  for (const lp of unmatched) {
    if (!lp.res) continue;
    const cands = dbPur.filter((p) => !usedPur.has(p.id) && p.date === lp.date && p.plot === lp.res.name
      && p.grade_id === lp.res.grade);
    const ledgerSame = unmatched.filter((x) => x.res && x.date === lp.date && x.plot === lp.plot && !x.dbId);
    if (cands.length === 1 && ledgerSame.length === 1) {
      usedPur.add(cands[0].id); lp.dbId = cands[0].id; lp.db = cands[0];
      notes.push(`purchasing #${cands[0].id} ${lp.plot} ${lp.date}: kg ${Number(cands[0].quantity)} → ${lp.qty} (buku besar baris ${lp.line})`);
    }
  }
  for (const lp of L.purchases) {
    if (!lp.res) {
      notes.push(`baris ${lp.line}: plot "${lp.plot}" tidak ada di sistem — dilewati`); lp.skip = true; continue;
    }
    const invoice = `BAN-AML-${lp.doNo}`;
    if (!lp.dbId) { plan.purInsert.push(lp); continue; }
    const d = lp.db;
    const ch = {};
    if (!same(d.quantity, lp.qty, 0.0005)) ch.quantity = lp.qty;
    if (!same(d.price_per_unit, lp.price, 0.005)) ch.price_per_unit = lp.price;
    if (d.receipt_invoice !== invoice) ch.receipt_invoice = invoice;
    if (Object.keys(ch).length) plan.purUpdate.push({ id: d.id, ch, line: lp.line });
  }
  const dbOnlyPur = dbPur.filter((p) => !usedPur.has(p.id));

  // ---------------------------------------------------------------- batches & sales
  const usedProc = new Set();
  const byDo = new Map();
  for (const lp of L.purchases) if (!lp.skip) {
    if (!byDo.has(lp.doNo)) byDo.set(lp.doNo, []);
    byDo.get(lp.doNo).push(lp);
  }
  const findProc = (dl) => {
    // 1) same sale date and accepted kilos
    let c = dbProc.find((p) => !usedProc.has(p.id) && p.sell_id && p.sell_date === dl.date
      && same(p.accepted_volume, dl.acc, 0.01));
    // 2) the empty sales the first import left behind: same date and buyer
    if (!c) c = dbProc.find((p) => !usedProc.has(p.id) && p.sell_id && p.sell_date === dl.date
      && Number(p.accepted_volume) === 0
      && (normName(p.offtaker_name) === normName(dl.offtaker) || !p.offtaker_id));
    return c || null;
  };
  for (const dl of L.deliveries.sort((a, b) => a.doNo - b.doNo)) {
    const pur = byDo.get(dl.doNo) || [];
    if (!pur.length) { notes.push(`DO ${dl.doNo}: pengiriman tanpa pembelian — dilewati`); continue; }
    let offId = offByName.get(normName(dl.offtaker)) ?? null;
    if (!offId && dl.offtaker) {
      if (!plan.offInsert.has(normName(dl.offtaker))) plan.offInsert.set(normName(dl.offtaker), dl.offtaker);
      offId = `new:${normName(dl.offtaker)}`;
    }
    let delivered = r3(dl.acc + dl.rej);
    if (delivered < dl.acc) {
      notes.push(`DO ${dl.doNo}: reject negatif (${dl.rej}) di buku besar — terkirim disamakan dengan diterima ${dl.acc}`);
      delivered = dl.acc;
    }
    const want = {
      code: `BAN-AML-PO${dl.doNo}`, date: dl.date, vin: r3(pur.reduce((s, p) => s + p.qty, 0)),
      vout: delivered, cost: dl.cost, acc: dl.acc, delivered,
      price: dl.acc ? r2(dl.value / dl.acc) : 0, offId, pur, doNo: dl.doNo,
    };
    const ex = findProc(dl);
    if (!ex) { plan.procInsert.push(want); continue; }
    usedProc.add(ex.id);
    want.procId = ex.id; want.sellId = ex.sell_id;
    const pch = {};
    if (ex.processing_code !== want.code) pch.processing_code = want.code;
    if (ex.date !== want.date) pch.date = want.date;
    if (!same(ex.volume_input, want.vin, 0.0005)) pch.volume_input = want.vin;
    if (!same(ex.volume_output, want.vout, 0.0005)) pch.volume_output = want.vout;
    if (!same(ex.total_processing_cost, want.cost, 0.005)) pch.total_processing_cost = want.cost;
    const sch = {};
    if (ex.sell_date !== want.date) sch.date = want.date;
    if (!same(ex.accepted_volume, want.acc, 0.0005)) sch.accepted_volume = want.acc;
    if (!same(ex.delivered_volume, want.delivered, 0.0005)) sch.delivered_volume = want.delivered;
    if (!same(ex.price_per_unit, want.price, 0.005)) sch.price_per_unit = want.price;
    if (String(ex.offtaker_id ?? '') !== String(offId ?? '')) sch.offtaker_id = offId;
    plan.procUpdate.push({ ...want, pch, sch });
  }
  const dbOnlyProc = dbProc.filter((p) => !usedProc.has(p.id));

  // Batch membership: the links each matched batch must end up with.
  const [links] = await conn.query(
    `SELECT pp.processing_id, pp.purchasing_id FROM processing_purchasings pp
     JOIN processing pr ON pr.id = pp.processing_id WHERE pr.processing_code LIKE 'BAN-AML-PO%'`);
  const linkOf = new Map();
  for (const l of links) {
    if (!linkOf.has(l.processing_id)) linkOf.set(l.processing_id, new Set());
    linkOf.get(l.processing_id).add(l.purchasing_id);
  }
  for (const u of plan.procUpdate) {
    const want = new Set(u.pur.filter((p) => p.dbId).map((p) => p.dbId));
    const have = linkOf.get(u.procId) || new Set();
    u.relink = want.size !== have.size || [...want].some((id) => !have.has(id))
      || u.pur.some((p) => !p.dbId) || u.pur.some((p) => p.dbId && plan.purUpdate.some((x) => x.id === p.dbId && x.ch.quantity));
    if (u.relink) plan.relink++;
  }

  // ---------------------------------------------------------------- report
  const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
  log(`\n  Pembelian: cocok ${usedPur.size} · baru ${plan.purInsert.length} `
    + `(${r3(sum(plan.purInsert, (p) => p.qty)).toLocaleString('id-ID')} kg) · diperbarui ${plan.purUpdate.length}`);
  const fields = {};
  plan.purUpdate.forEach((u) => Object.keys(u.ch).forEach((k) => { fields[k] = (fields[k] || 0) + 1; }));
  if (plan.purUpdate.length) log(`     kolom diperbarui: ${JSON.stringify(fields)}`);
  log(`  Batch + penjualan: cocok ${plan.procUpdate.length} (diperbarui ${plan.procUpdate.filter((u) => Object.keys(u.pch).length || Object.keys(u.sch).length || u.relink).length}, `
    + `susunan setoran berubah ${plan.relink}) · baru ${plan.procInsert.length}`);
  for (const p of plan.procInsert) {
    log(`     + DO ${p.doNo} ${p.date} ${p.pur.length} setoran ${p.vin} kg → diterima ${p.acc} kg @ ${p.price}`);
  }
  if (plan.offInsert.size) log(`  Offtaker baru: ${[...plan.offInsert.values()].join(', ')}`);
  if (VERBOSE) {
    for (const u of plan.procUpdate) {
      if (Object.keys(u.pch).length || Object.keys(u.sch).length) {
        log(`     ~ ${u.code} (processing #${u.procId}): ${JSON.stringify({ ...u.pch, ...u.sch })}`);
      }
    }
  }
  if (dbOnlyPur.length) {
    log(`\n  ! ${dbOnlyPur.length} pembelian di sistem tidak ada di buku besar (dibiarkan):`);
    dbOnlyPur.forEach((p) => log(`     #${p.id} ${p.date} ${p.plot} ${p.quantity} kg ${p.receipt_invoice}`));
  }
  if (dbOnlyProc.length) {
    log(`\n  ! ${dbOnlyProc.length} batch di sistem tidak ada di buku besar (dibiarkan):`);
    dbOnlyProc.forEach((p) => log(`     #${p.id} ${p.processing_code} ${p.sell_date} ${p.accepted_volume} kg`));
  }
  if (notes.length) { log(`\n  Catatan (${notes.length}):`); notes.forEach((n) => log(`   - ${n}`)); }

  // ---------------------------------------------------------------- apply
  if (!APPLY) { log('\nDRY RUN — jalankan dengan --apply untuk menulis.'); await conn.end(); return; }

  await conn.beginTransaction();
  try {
    const now = new Date();
    const newOff = new Map();
    for (const [k, name] of plan.offInsert) {
      const [r] = await conn.query(
        'INSERT INTO offtaker (offtaker_name, entities_id, created_at, updated_at) VALUES (?,?,?,?)',
        [name, ENTITY_JNBS, now, now]);
      newOff.set(`new:${k}`, r.insertId);
    }
    const off = (v) => (typeof v === 'string' && v.startsWith('new:') ? newOff.get(v) : v);

    for (const u of plan.purUpdate) {
      const keys = Object.keys(u.ch);
      await conn.query(`UPDATE purchasing SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
        [...keys.map((k) => u.ch[k]), now, u.id]);
      if (u.ch.receipt_invoice) {
        await conn.query('UPDATE pre_finance_installments SET reference_no = ? WHERE purchasing_id = ?',
          [u.ch.receipt_invoice, u.id]);
      }
    }
    for (const lp of plan.purInsert) {
      const [r] = await conn.query(
        `INSERT INTO purchasing (plot_id, supplier_type, commodities_id, grade_id, warehouse_id, receipt_invoice,
           date, quantity, price_per_unit, payment_status, is_process, created_at, updated_at)
         VALUES (?, 'farmer', ?, ?, ?, ?, ?, ?, ?, 'paid', 0, ?, ?)`,
        [lp.res.id, COMM_BANANA, lp.res.grade, WH_AML, `BAN-AML-${lp.doNo}`,
          lp.date, lp.qty, lp.price, now, now]);
      lp.dbId = r.insertId;
    }
    const setLinks = async (procId, pur) => {
      await conn.query('DELETE FROM processing_purchasings WHERE processing_id = ?', [procId]);
      for (const p of pur) {
        await conn.query('DELETE FROM processing_purchasings WHERE purchasing_id = ?', [p.dbId]);
        await conn.query(
          'INSERT INTO processing_purchasings (processing_id, purchasing_id, volume_contributed) VALUES (?,?,?)',
          [procId, p.dbId, p.qty]);
        await conn.query('UPDATE purchasing SET is_process = 1 WHERE id = ?', [p.dbId]);
      }
    };
    // Codes first move out of the way, so a renumbered batch never shares a code
    // with the one it is being renamed after, even for a moment.
    for (const u of plan.procUpdate) {
      if (u.pch.processing_code) await conn.query('UPDATE processing SET processing_code = CONCAT(processing_code, ?) WHERE id = ?', ['~', u.procId]);
    }
    for (const u of plan.procUpdate) {
      const keys = Object.keys(u.pch);
      if (keys.length) {
        await conn.query(`UPDATE processing SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
          [...keys.map((k) => u.pch[k]), now, u.procId]);
      }
      const sk = Object.keys(u.sch);
      if (sk.length) {
        await conn.query(`UPDATE selling SET ${sk.map((k) => `\`${k}\` = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
          [...sk.map((k) => (k === 'offtaker_id' ? off(u.sch[k]) : u.sch[k])), now, u.sellId]);
      }
    }
    for (const u of plan.procUpdate) if (u.relink) await setLinks(u.procId, u.pur);
    for (const p of plan.procInsert) {
      const [r] = await conn.query(
        `INSERT INTO processing (processing_code, date, commodities_id, warehouse_id, volume_input, volume_output,
           total_processing_cost, status, created_at, updated_at) VALUES (?,?,?,?,?,?,?, 'closed', ?, ?)`,
        [p.code, p.date, COMM_BANANA, WH_AML, p.vin, p.vout, p.cost, now, now]);
      await setLinks(r.insertId, p.pur);
      await conn.query(
        `INSERT INTO selling (processing_id, offtaker_id, warehouse_id, date, delivered_volume, accepted_volume,
           price_per_unit, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?)`,
        [r.insertId, off(p.offId), WH_AML, p.date, p.delivered, p.acc, p.price, now, now]);
    }
    await conn.commit();
    log('\nSelesai — semua perubahan ditulis dalam satu transaksi.');
  } catch (e) {
    await conn.rollback();
    throw e;
  }
  await conn.end();
})().catch((e) => { console.error(e); process.exit(1); });
