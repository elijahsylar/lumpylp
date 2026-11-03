// Import FIRST in tests of indexer-side scripts (sweep, dedupe, unhide): the
// app pool then connects as lumpylp_indexer, the user those scripts run as.
process.env.LUMPYLP_TEST_DB_USER = 'lumpylp_indexer';
process.env.LUMPYLP_TEST_DB_PASS = 'indexer-test-only';
