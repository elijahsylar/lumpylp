// Shared env loading for the API, the indexer and maintenance scripts.
//
//   NODE_ENV=test        -> load nothing (tests set process.env themselves).
//   NODE_ENV=production  -> the role's production file in server/ (then the
//                           project root):
//                             role api     (default)  .env.production
//                             role indexer            .env.indexer.production
//   otherwise (local dev)-> .env (project root, then server/).
//
// The role comes from LUMPYLP_ROLE. Indexer-side commands on the server run
// as: NODE_ENV=production LUMPYLP_ROLE=indexer node <script>. They connect as
// lumpylp_indexer (db/grants.sql), which the API never gets, and refuse to
// start as lumpylp_app or doadmin (review R4).
// A production env file is never loaded unless NODE_ENV=production.
import dotenv from 'dotenv';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function envCandidates({ nodeEnv = process.env.NODE_ENV, role = process.env.LUMPYLP_ROLE || 'api' } = {}) {
  if (nodeEnv === 'test') return [];
  if (nodeEnv === 'production') {
    const name = role === 'indexer' ? '.env.indexer.production' : '.env.production';
    return [path.join(serverDir, name), path.join(serverDir, '..', name)];
  }
  return [path.join(serverDir, '..', '.env'), path.join(serverDir, '.env')];
}

export function loadEnv(tag = 'env', opts = {}) {
  for (const p of envCandidates(opts)) {
    if (fs.existsSync(p)) {
      dotenv.config({ path: p });
      if (tag) console.log(`[${tag}] loaded env from ${p}`);
      return p;
    }
  }
  return null;
}

// Indexer-side entry points call this before touching the DB.
export function assertIndexerUser(env = process.env) {
  if (env.NODE_ENV !== 'production') return;
  if (env.DB_USER !== 'lumpylp_indexer') {
    throw new Error(`indexer-side scripts must connect as lumpylp_indexer (got ${env.DB_USER || 'nobody'}); ` +
      'run with NODE_ENV=production LUMPYLP_ROLE=indexer and server/.env.indexer.production');
  }
}
