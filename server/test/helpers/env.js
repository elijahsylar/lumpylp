// Imported first by every test file and by test/db/setup.js. Pins the test
// environment before any app module reads process.env, so no developer .env
// or production env file can leak in (db.js and lib/env.js load nothing when
// NODE_ENV=test).
import { assertTestDb } from './guard.js';

process.env.NODE_ENV = 'test';
process.env.DB_HOST = '127.0.0.1';
process.env.DB_PORT = '33306';
process.env.DB_NAME = process.env.LUMPYLP_TEST_DB_NAME || 'lumpylp_test';
// The app under test connects as the least-privilege API user from
// db/grants.sql (created by test/db/setup.js with a local-only password).
process.env.DB_USER = process.env.LUMPYLP_TEST_DB_USER || 'lumpylp_app';
process.env.DB_PASS = process.env.LUMPYLP_TEST_DB_PASS ?? 'app-test-only';
process.env.DB_SSL_CA = '';
process.env.JWT_SECRET = 'test-only-jwt-secret-never-used-outside-the-test-suite';
process.env.JAMENDO_CLIENT_ID = '';
process.env.AUDIUS_BEARER_TOKEN = '';
process.env.AUDIUS_APP_NAME = 'LumpyLP-test';

// No test ever calls the real Cloudflare Turnstile endpoint: tests that need
// verification point this at a local stub; everything else gets a dead port.
process.env.TURNSTILE_VERIFY_URL = process.env.TURNSTILE_VERIFY_URL || 'http://127.0.0.1:9/siteverify';

assertTestDb();
