// Rows planted BEFORE migrations 015+ run, shaped like the production cases
// those migrations must handle, plus near-misses they must leave alone.
// Tests look them up by these external_ids.
import fs from 'node:fs';

const listFile = new URL('../../data/pd78s-1926-identifiers.txt', import.meta.url);
export const PD1926_IDS = fs.readFileSync(listFile, 'utf8').split('\n')
  .map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

export const PLANTED = {
  dead: ['fx-dead-1:01 a', 'fx-dead-2:01 b', 'fx-dead-3:01 c'],
  jukebox: ['jukebox-990001', 'jukebox-990002'],
  afc: ['990003', '990004'],
  musopenEA: ['fx-ea-1', 'fx-ea-2'],
  musopenEAnotPD: ['fx-ea-ccby'],
  musopenOther: ['fx-mus-ok'],
  pd1926: [`${PD1926_IDS[0]}:01 side a`, `${PD1926_IDS[1]}:01 side a`, `${PD1926_IDS[1]}:02 side b`],
  pd1925: ['fx-1925-USA-Archives-ok:01 side a'],
  subjects1926: [`${PD1926_IDS[2]}:01 track`],
  wikiPD: ['File:Fx Wiki Default PD.ogg'],
  wikiCC: ['File:Fx Wiki CC BY-SA.ogg'],
  jamendoCC: ['880001'],
  jamendoOK: ['880002'],
};

const base = (o) => ({
  title: 'Planted Fixture', artist_name: 'Fixture Performer', genre: null, duration_seconds: 200,
  stream_url: 'https://archive.org/download/fixture/x.mp3', download_url: null, artwork_url: null,
  license: 'public-domain', is_dead: 0, dead_checked_at: null, dead_status_code: null, ...o,
});

export function plantedRows() {
  const rows = [];
  for (const id of PLANTED.dead) rows.push(base({ external_id: id, source: 'archive_netlabels', license: 'cc-by', is_dead: 1, dead_checked_at: new Date('2026-05-20T00:00:00Z'), dead_status_code: 404 }));
  for (const id of PLANTED.jukebox) rows.push(base({ external_id: id, source: 'loc_jukebox', duration_seconds: null }));
  for (const id of PLANTED.afc) rows.push(base({ external_id: id, source: 'loc_jukebox', duration_seconds: null }));
  for (const id of PLANTED.musopenEA) rows.push(base({ external_id: id, source: 'musopen', artist_name: 'Vienna Symphony (European Archive)' }));
  for (const id of PLANTED.musopenEAnotPD) rows.push(base({ external_id: id, source: 'musopen', artist_name: 'European Archive Players', license: 'cc-by' }));
  for (const id of PLANTED.musopenOther) rows.push(base({ external_id: id, source: 'musopen', artist_name: 'Musopen Symphony' }));
  for (const id of PLANTED.pd1926) rows.push(base({ external_id: id, source: 'archive_pd78s', genre: 'pre-1929' }));
  for (const id of PLANTED.pd1925) rows.push(base({ external_id: id, source: 'archive_pd78s', genre: 'pre-1929' }));
  for (const id of PLANTED.subjects1926) rows.push(base({ external_id: id, source: 'archive_subjects', license: 'cc-by-sa' }));
  for (const id of PLANTED.wikiPD) rows.push(base({ external_id: id, source: 'wikimedia' }));
  for (const id of PLANTED.wikiCC) rows.push(base({ external_id: id, source: 'wikimedia', license: 'cc-by-sa' }));
  for (const id of PLANTED.jamendoCC) rows.push(base({ external_id: id, source: 'jamendo', license: 'CC' }));
  for (const id of PLANTED.jamendoOK) rows.push(base({ external_id: id, source: 'jamendo', license: 'cc-by' }));
  return rows;
}

export async function plant(conn) {
  const rows = plantedRows();
  const cols = Object.keys(rows[0]);
  await conn.query(`INSERT INTO tracks (${cols.join(',')}) VALUES ?`, [rows.map((r) => cols.map((c) => r[c]))]);
}
