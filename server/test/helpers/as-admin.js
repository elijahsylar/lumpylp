// Import FIRST in a test that needs the app pool to connect as the local
// test database's root user instead of the least-privilege lumpylp_app
// (local only: helpers/guard.js still pins 127.0.0.1:33306 and a *_test name).
process.env.LUMPYLP_TEST_DB_USER = 'root';
process.env.LUMPYLP_TEST_DB_PASS = '';
