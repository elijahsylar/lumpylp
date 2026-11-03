// Fixture access to the local test database as its root user (local only,
// 127.0.0.1:33306). The app under test uses its own pool from db.js.
import './env.js';
import mysql from 'mysql2/promise';
import { assertTestDb } from './guard.js';

let conn = null;

export async function admin() {
  assertTestDb();
  if (!conn) {
    conn = await mysql.createConnection({
      host: '127.0.0.1', port: 33306, user: 'root', password: '',
      database: process.env.DB_NAME, multipleStatements: true, charset: 'utf8mb4',
    });
  }
  return conn;
}

export async function q(sql, params = []) {
  const [rows] = await (await admin()).query(sql, params);
  return rows;
}

export async function closeAdmin() {
  if (conn) { await conn.end(); conn = null; }
}

let seq = 0;
// Insert a track with sensible defaults; returns its id.
export async function insertTrack(fields = {}) {
  seq += 1;
  const t = {
    external_id: `fixture-${process.pid}-${Date.now()}-${seq}`,
    source: 'archive_netlabels',
    title: `Fixture Track ${seq}`,
    artist_name: `Fixture Artist ${seq}`,
    genre: 'ambient',
    duration_seconds: 180,
    stream_url: `https://archive.org/download/fixture-${seq}/track.mp3`,
    download_url: `https://archive.org/download/fixture-${seq}/track.mp3`,
    license: 'cc-by',
    ...fields,
  };
  const cols = Object.keys(t);
  const res = await q(
    `INSERT INTO tracks (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`,
    cols.map((c) => t[c])
  );
  return res.insertId;
}

// Create a user directly (fixtures) and return { id, username, token }.
// The password is hashed at low cost for speed; login still verifies it.
export async function makeUser({ username, email, password = 'correct horse battery', role = 'user' } = {}) {
  const bcrypt = (await import('bcrypt')).default;
  seq += 1;
  username = username || `user${process.pid}x${seq}`;
  email = email || `${username}@example.test`;
  const hash = await bcrypt.hash(password, 4);
  const cols = await q(`SHOW COLUMNS FROM users LIKE 'role'`);
  const res = cols.length
    ? await q(`INSERT INTO users (email, username, password_hash, role) VALUES (?, ?, ?, ?)`, [email, username, hash, role])
    : await q(`INSERT INTO users (email, username, password_hash, paid_at) VALUES (?, ?, ?, NOW())`, [email, username, hash]);
  const [row] = await q(`SELECT * FROM users WHERE id = ?`, [res.insertId]);
  const { signToken } = await import('../../middleware/auth.js');
  return { id: res.insertId, username, email, password, token: signToken(row) };
}
