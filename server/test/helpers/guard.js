// The test suite may only ever talk to the throwaway local MySQL started by
// test/db/start-test-mysql.sh. Anything else (a dev mirror, production) is
// refused before a single query runs.
export const TEST_DB_HOST = '127.0.0.1';
export const TEST_DB_PORT = '33306';

export function assertTestDb(env = process.env) {
  const ok = env.DB_HOST === TEST_DB_HOST
    && String(env.DB_PORT) === TEST_DB_PORT
    && /_test$/.test(String(env.DB_NAME || ''));
  if (!ok) {
    throw new Error(
      `refusing to run tests against ${env.DB_HOST}:${env.DB_PORT}/${env.DB_NAME}; ` +
      `tests only use ${TEST_DB_HOST}:${TEST_DB_PORT}/*_test`
    );
  }
}
