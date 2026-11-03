// Admin password reset (owner decision 1: no self-service reset at launch).
// Reads the new password from stdin (never argv, so it never lands in shell
// history or the process list), sets it, and bumps token_version so every
// existing session for that user is signed out.
//
//   NODE_ENV=production node scripts/admin-reset-password.js <username> < /path/to/new-password-file
// Run as a DB user that may UPDATE users (doadmin or lumpylp_app).
import bcrypt from 'bcrypt';

const username = process.argv[2];
if (!username) { console.error('usage: admin-reset-password.js <username> < password-file'); process.exit(2); }

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const password = Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
const bytes = Buffer.byteLength(password, 'utf8');
if (password.length < 8 || bytes > 72) { console.error('password must be 8 characters to 72 bytes'); process.exit(2); }

const { query, pool } = await import('../db.js');
const hash = await bcrypt.hash(password, 12);
const r = await query(
  `UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE username = ?`,
  [hash, username]
);
console.log(r.affectedRows ? `password reset for ${username}; existing sessions signed out` : `no user named ${username}`);
await pool.end();
process.exit(r.affectedRows ? 0 : 1);
