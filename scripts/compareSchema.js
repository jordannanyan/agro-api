// Compare two database schemas, object by object.
//
// Exists to hold the invariant stated at the top of db/schema.sql: a clean install
// from db/*.sql must produce exactly the schema a migrated production database
// has. That drifted once — `stock_out` and two `pre_finance_distributions` columns
// lived only in the migration scripts, so every fresh environment came up without
// the warehouse's outgoing side, and the recomputed stock view silently read short.
//
// Usage:
//   node scripts/compareSchema.js <db_a> <db_b>
//   node scripts/compareSchema.js agro_fresh agro_migrated
//
// Typical check before a release:
//   1. build A from db/schema.sql + seed.sql + seed_saprodi.sql + views.sql
//   2. build B the same way, then run every scripts/migrate*.js --apply on it
//   3. node scripts/compareSchema.js A B     → must print "IDENTICAL"
//
// Connection comes from .env (DB_HOST/DB_PORT/DB_USER/DB_PASSWORD).
require('dotenv').config();
const mysql = require('mysql2/promise');

const [A, B] = process.argv.slice(2);
if (!A || !B) {
  console.error('Usage: node scripts/compareSchema.js <db_a> <db_b>');
  process.exit(2);
}

/** One comparable line per object, so a plain set difference is the whole report. */
const QUERIES = {
  'objects': `SELECT CONCAT(IF(TABLE_TYPE = 'VIEW', 'view ', 'table '), TABLE_NAME) AS line
              FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`,
  'columns': `SELECT CONCAT(TABLE_NAME, '.', COLUMN_NAME, ' ', COLUMN_TYPE, ' ',
                     IS_NULLABLE, ' ', IFNULL(COLUMN_DEFAULT, 'NULL'), ' ', EXTRA) AS line
              FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = ?`,
  'foreign keys': `SELECT CONCAT(k.TABLE_NAME, '.', k.COLUMN_NAME, ' -> ',
                          k.REFERENCED_TABLE_NAME, '.', k.REFERENCED_COLUMN_NAME,
                          ' (', k.CONSTRAINT_NAME, ', ON DELETE ', r.DELETE_RULE, ')') AS line
                   FROM information_schema.KEY_COLUMN_USAGE k
                   JOIN information_schema.REFERENTIAL_CONSTRAINTS r
                     ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
                   WHERE k.CONSTRAINT_SCHEMA = ?`,
  'indexes': `SELECT CONCAT(TABLE_NAME, '.', INDEX_NAME, ' (',
                     GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX), ')',
                     IF(NON_UNIQUE, '', ' UNIQUE')) AS line
              FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = ?
              GROUP BY TABLE_NAME, INDEX_NAME, NON_UNIQUE`,
};

(async () => {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
  });

  for (const db of [A, B]) {
    const [r] = await conn.query(
      'SELECT COUNT(*) AS n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [db]);
    if (!r[0].n) { console.error(`✗ database "${db}" does not exist.`); process.exit(2); }
  }

  const lines = async (sql, db) =>
    (await conn.query(sql, [db]))[0].map((r) => r.line).sort();

  let diffs = 0;
  for (const [label, sql] of Object.entries(QUERIES)) {
    const a = await lines(sql, A);
    const b = await lines(sql, B);
    const onlyA = a.filter((x) => !b.includes(x));
    const onlyB = b.filter((x) => !a.includes(x));
    diffs += onlyA.length + onlyB.length;
    console.log(`\n== ${label} ==  ${A}: ${a.length} · ${B}: ${b.length}`);
    if (!onlyA.length && !onlyB.length) { console.log('   identical'); continue; }
    for (const x of onlyA) console.log(`   only in ${A}: ${x}`);
    for (const x of onlyB) console.log(`   only in ${B}: ${x}`);
  }

  // View bodies, with the schema name normalised so the comparison is about the
  // query rather than which database it happens to live in.
  const views = async (db) => Object.fromEntries(
    (await conn.query(
      'SELECT TABLE_NAME, VIEW_DEFINITION FROM information_schema.VIEWS WHERE TABLE_SCHEMA = ?', [db]))[0]
      .map((r) => [r.TABLE_NAME,
        String(r.VIEW_DEFINITION).split('`' + db + '`').join('`DB`').replace(/\s+/g, ' ')]));
  const va = await views(A), vb = await views(B);
  console.log('\n== view definitions ==');
  for (const name of [...new Set([...Object.keys(va), ...Object.keys(vb)])].sort()) {
    if (va[name] === vb[name]) { console.log(`   identical: ${name}`); continue; }
    diffs++;
    console.log(`   DIFFERENT: ${name}`);
    console.log(`     ${A}: ${(va[name] || '(missing)').slice(0, 400)}`);
    console.log(`     ${B}: ${(vb[name] || '(missing)').slice(0, 400)}`);
  }

  await conn.end();
  console.log(diffs === 0
    ? `\n✓ IDENTICAL — ${A} and ${B} describe the same schema.`
    : `\n✗ ${diffs} difference(s). A clean install is not the same as a migrated database.`);
  process.exit(diffs ? 1 : 0);
})().catch((e) => { console.error('✗ compare failed:', e.message); process.exit(2); });
