// Migrate land + tree data from the legacy DB (db_traceability) into agro_supply.
// Upserts by primary key, preserving IDs. Run AFTER `npm run db:reset`.
//
//   1. Import the legacy dump into a `db_traceability` database on the same server:
//        mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS db_traceability"
//        mysql -u root -p db_traceability < "path/to/db_traceability.sql"
//   2. node scripts/migrateFromLegacy.js
//
// Env: DB_HOST/DB_PORT/DB_USER/DB_PASSWORD (from .env), DB_NAME (target, default agro_supply),
//      LEGACY_DB (source, default db_traceability).
require('dotenv').config();
const mysql = require('mysql2/promise');

const TARGET = process.env.DB_NAME || 'agro_supply';
const SOURCE = process.env.LEGACY_DB || 'db_traceability';

// Order matters (FK): entities → kth → farmers → plot → polygon/trees → tree_monitoring.
const TABLES = [
  { name: 'commodities', cols: ['id', 'commodities_name', 'created_at', 'updated_at'] },
  { name: 'grade', cols: ['id', 'grade_name', 'created_at', 'updated_at'] },
  { name: 'sapropdi', cols: ['id', 'sapropdi_name', 'unit', 'created_at', 'updated_at'] },
  { name: 'entities', cols: ['id', 'entities_name', 'location', 'username', 'is_superadmin', 'password', 'created_at', 'updated_at'] },
  { name: 'offtaker', cols: ['id', 'offtaker_name', 'location', 'entities_id', 'created_at', 'updated_at'] },
  { name: 'kth', cols: ['id', 'kth_name', 'address', 'regency', 'partnership_period', 'entities_id', 'username', 'password', 'created_at', 'updated_at'] },
  { name: 'warehouse', cols: ['id', 'warehouse_name', 'address', 'kth_id', 'created_at', 'updated_at'] },
  { name: 'farmers', cols: ['id', 'farmer_name', 'number_of_children', 'date_of_birth', 'previous_income', 'address', 'kth_id', 'password', 'no_hp', 'nik', 'no_rek', 'foto', 'pre_finance', 'created_at', 'updated_at'] },
  { name: 'plot', cols: ['id', 'plot_name', 'land_area', 'number_of_plants', 'exp_cin_plants', 'latitude', 'longitude', 'polygon', 'farmer_id', 'created_at', 'updated_at'] },
  { name: 'plot_polygon_points', cols: ['id', 'plot_id', 'seq', 'latitude', 'longitude', 'photo_path', 'captured_at', 'accuracy_m', 'source', 'created_at', 'updated_at'] },
  { name: 'trees', cols: ['id', 'plot_id', 'farmer_id', 'tree_name', 'species', 'planting_date', 'qr_code', 'photo_path', 'latitude', 'longitude', 'accuracy_m', 'created_at', 'updated_at'] },
  { name: 'tree_monitoring', cols: ['id', 'tree_id', 'measured_at', 'circumference_cm', 'health_status', 'health_desc', 'photo_path', 'latitude', 'longitude', 'accuracy_m', 'recorded_by_kth_id', 'created_at', 'updated_at'] },
  { name: 'distributed_sapropdi', cols: ['id', 'date', 'plot_id', 'commodities_id', 'sapropdi_id', 'quantity', 'price_per_unit', 'total_price', 'upload_proof', 'created_at', 'updated_at'] },
];

async function run() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    multipleStatements: true,
  });

  // Verify source exists.
  const [dbs] = await conn.query('SHOW DATABASES LIKE ?', [SOURCE]);
  if (!dbs.length) {
    console.error(`✗ Source DB \`${SOURCE}\` not found. Import the legacy dump first (see header of this file).`);
    process.exit(1);
  }

  await conn.query('SET FOREIGN_KEY_CHECKS = 0');
  for (const t of TABLES) {
    // Skip tables that don't exist in the source.
    const [exists] = await conn.query(
      'SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = ? AND table_name = ?',
      [SOURCE, t.name]
    );
    if (!exists[0].n) { console.log(`- skip ${t.name} (not in source)`); continue; }

    const colList = t.cols.map((c) => `\`${c}\``).join(', ');
    const updates = t.cols.filter((c) => c !== 'id').map((c) => `\`${c}\` = VALUES(\`${c}\`)`).join(', ');
    const sql =
      `INSERT INTO \`${TARGET}\`.\`${t.name}\` (${colList}) ` +
      `SELECT ${colList} FROM \`${SOURCE}\`.\`${t.name}\` ` +
      (updates ? `ON DUPLICATE KEY UPDATE ${updates}` : '');
    const [r] = await conn.query(sql);
    console.log(`✓ ${t.name}: ${r.affectedRows} rows upserted`);
  }
  await conn.query('SET FOREIGN_KEY_CHECKS = 1');

  // Map legacy farmer.pre_finance flag → plot.scheme enum (scheme lives on the plot now).
  const [r] = await conn.query(
    `UPDATE \`${TARGET}\`.plot p JOIN \`${TARGET}\`.farmers f ON f.id = p.farmer_id
     SET p.scheme = 'PreFinance' WHERE f.pre_finance = 1`
  );
  console.log(`✓ scheme: ${r.affectedRows} plots set to PreFinance (from farmer.pre_finance)`);

  await conn.end();
  console.log('✓ Legacy migration complete.');
}

run().catch((e) => { console.error('✗ migration failed:', e.message); process.exit(1); });
