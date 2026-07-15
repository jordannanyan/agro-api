// Generate a Laravel-compatible bcrypt ($2y$) hash.
// Usage: node scripts/hash.js "password"
const bcrypt = require('bcryptjs');
const plain = process.argv[2] || 'password';
const hash = bcrypt.hashSync(plain, 12).replace(/^\$2[abxy]\$/, '$2y$');
console.log(hash);
