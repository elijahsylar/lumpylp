// Performance harness (relaunch item 8). Runs the real API against the
// production-scale synthetic DB (lumpylp_scale_test, built with
//   node test/db/setup.js --db=lumpylp_scale_test --tracks=650000),
// times each endpoint end to end, records every SQL statement it runs and
// EXPLAINs them (full scans / filesorts flagged).
//
//   node test/perf/perf.js [--runs=30] [--buffer-pool-mb=32] [--json=out.json]
// --buffer-pool-mb resizes the test server's InnoDB buffer pool first (prod's
// managed DB has 32 MB); it is restored to 1024 MB afterwards.
process.env.LUMPYLP_TEST_DB_NAME = 'lumpylp_scale_test';
// Connect as the local test root: db/grants.sql starts with REVOKE ALL, so
// each run of the functional suite re-scopes lumpylp_app to lumpylp_test.
// Query speed doesn't depend on the user; privileges are tested elsewhere.
process.env.LUMPYLP_TEST_DB_USER = 'root';
process.env.LUMPYLP_TEST_DB_PASS = '';
process.env.RATE_LIMITS = JSON.stringify({ api: 1e9, search: 1e9, stream: 1e9, discover: 1e9 });
const { startApp } = await import('../helpers/app.js');
const mysql = (await import('mysql2/promise')).default;
const fs = await import('node:fs');

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, '').split('='); return [k, v ?? true]; }));
const RUNS = Number(args.runs || 30);
const root = await mysql.createConnection({ host: '127.0.0.1', port: 33306, user: 'root', password: '', database: 'lumpylp_scale_test' });
if (args['buffer-pool-mb']) await root.query(`SET GLOBAL innodb_buffer_pool_size = ${Number(args['buffer-pool-mb']) * 1048576}`);
const [[bp]] = await root.query('SELECT @@innodb_buffer_pool_size/1048576 AS mb');

// Fixture values that exist in the scale DB.
const [[artist]] = await root.query(`SELECT t.artist_name FROM tracks t JOIN artists a ON a.name = t.artist_name AND a.source = t.source WHERE t.is_live = 1 AND t.source = 'jamendo' LIMIT 1`);
const [[lump]] = await root.query(`SELECT id FROM user_lumps LIMIT 1`);
const [[one]] = await root.query(`SELECT id FROM tracks WHERE is_live = 1 ORDER BY id DESC LIMIT 1`);
await root.query(`INSERT IGNORE INTO geocode_cache (\`query\`, display_name, lat, lng) VALUES ('portland', 'Portland, Oregon', 45.515200, -122.678400)`);

const ENDPOINTS = [
  ['list fresh', '/api/tracks'],
  ['list heap', '/api/tracks?sort=heap'],
  ['list alpha', '/api/tracks?sort=alpha'],
  ['list genre (heap)', '/api/tracks?genre=rock'],
  ['list genre fresh', '/api/tracks?genre=rock&sort=fresh'],
  ['list artist', `/api/tracks?artist=${encodeURIComponent(artist.artist_name)}`],
  ['list page 400', '/api/tracks?page=400'],
  ['top all', '/api/tracks/top'],
  ['top week', '/api/tracks/top?window=week'],
  ['random', '/api/tracks/random'],
  ['shuffle 50', '/api/tracks/shuffle?n=50'],
  ['shuffle genre', '/api/tracks/shuffle?genre=rock&n=50'],
  ['shuffle artist', `/api/tracks/shuffle?artist=${encodeURIComponent(artist.artist_name)}`],
  ['shuffle location', '/api/tracks/shuffle?lat=45.5152&lng=-122.6784&radius=50&n=50'],
  ['search word', '/api/search?q=river'],
  ['search two words', '/api/search?q=river%20stone'],
  ['search short', '/api/search?q=ri'],
  ['search stopword', '/api/search?q=the'],
  ['search + source', '/api/search?q=river&source=archive'],
  ['search title sort', '/api/search?q=ember&sort=title_asc'],
  ['track detail', `/api/tracks/${one.id}`],
  ['lump detail', `/api/lumps/${lump.id}`],
  ['artists', '/api/artists'],
  ['artist by name', `/api/artists/by-name/${encodeURIComponent(artist.artist_name)}`],
  ['genres', '/api/genres'],
  ['stats', '/api/stats'],
  ['discover top cities', '/api/discover/top-cities'],
  ['discover cities', '/api/discover/cities?q=portland&radius=50'],
];

const { setQueryObserver } = await import('../../db.js');
const app = await startApp();
const results = [];
for (const [name, path] of ENDPOINTS) {
  const seen = new Map();
  setQueryObserver((sql, params) => { if (/^\s*(SELECT|\(SELECT)/i.test(sql)) seen.set(sql, params); });
  const first = await fetch(app.base + path);
  await first.text();
  setQueryObserver(null);
  const times = [];
  for (let i = 0; i < RUNS; i++) {
    const t0 = performance.now();
    const r = await fetch(app.base + path);
    await r.text();
    times.push(performance.now() - t0);
    if (r.status >= 400) { times.push(Infinity); break; }
  }
  times.sort((a, b) => a - b);
  const pct = (p) => times[Math.min(times.length - 1, Math.floor(p * times.length))];
  const flags = [];
  for (const [sql, params] of seen) {
    try {
      const [plan] = await root.query(`EXPLAIN ${sql}`, params);
      for (const row of plan) {
        // <derivedN> tables are the capped-count subqueries (bounded at 10,001).
        if (row.type === 'ALL' && Number(row.rows) > 5000 && !/^<derived/.test(row.table)) flags.push(`full scan ${row.table} (~${row.rows} rows)`);
        if (/filesort/i.test(row.Extra || '') && Number(row.rows) > 5000) flags.push(`filesort ${row.table} (~${row.rows} rows)`);
      }
    } catch (e) { flags.push(`explain failed: ${e.message.slice(0, 60)}`); }
  }
  results.push({ name, path, status: first.status, p50: Math.round(pct(0.5)), p95: Math.round(pct(0.95)), flags: [...new Set(flags)] });
}
await app.close();
if (args['buffer-pool-mb']) await root.query('SET GLOBAL innodb_buffer_pool_size = 1073741824');
await root.end();

console.log(`buffer pool ${Math.round(bp.mb)} MB, ${RUNS} runs per endpoint (warm), times in ms`);
console.log('endpoint'.padEnd(22), 'status', 'p50'.padStart(6), 'p95'.padStart(6), ' flags');
for (const r of results) console.log(r.name.padEnd(22), String(r.status).padEnd(6), String(r.p50).padStart(6), String(r.p95).padStart(6), ' ' + r.flags.join('; '));
const slow = results.filter((r) => r.p95 >= 200 || r.status >= 400);
console.log(`\n${results.length - slow.length}/${results.length} endpoints with p95 < 200 ms and no error`);
if (args.json) fs.writeFileSync(args.json, JSON.stringify({ bufferPoolMb: Math.round(bp.mb), runs: RUNS, results }, null, 2));
process.exit(slow.length ? 1 : 0);
