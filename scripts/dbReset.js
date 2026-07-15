// Reset the database: run schema.sql, seed.sql, views.sql in order.
// Fixes the seed password hash to a real bcrypt($2y$) of "password" at runtime.
// Usage: node scripts/dbReset.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');

async function run() {
  const dir = path.resolve(__dirname, '..', 'db');
  const schema = fs.readFileSync(path.join(dir, 'schema.sql'), 'utf8');
  let seed = fs.readFileSync(path.join(dir, 'seed.sql'), 'utf8');
  const views = fs.readFileSync(path.join(dir, 'views.sql'), 'utf8');

  // Replace the seed @PW placeholder with a freshly computed valid hash of "password".
  const pw = bcrypt.hashSync('password', 12).replace(/^\$2[abxy]\$/, '$2y$');
  seed = seed.replace(/SET @PW := '[^']*';/, `SET @PW := '${pw}';`);

  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    multipleStatements: true,
  });

  console.log('→ Running schema.sql ...');
  await conn.query(schema);
  console.log('→ Running seed.sql ...');
  await conn.query(seed);
  console.log('→ Running views.sql ...');
  await conn.query(views);
  await conn.end();
  console.log('✓ Database reset complete. Login: finance01 / password');
}

run().catch((e) => { console.error('✗ db reset failed:', e.message); process.exit(1); });
