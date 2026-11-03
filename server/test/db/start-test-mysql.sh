#!/bin/bash
# Start a throwaway, user-level MySQL server for the test suite.
# - Data lives outside the repo (default /tmp/lumpylp-testdb-<uid>; the Ubuntu AppArmor
#   profile for mysqld allows /tmp but not home directories), never in git.
# - Listens on 127.0.0.1:33306 only, plus a private socket. No sudo needed.
# - Stop it with test/db/stop-test-mysql.sh (kills the exact PID from the pid file).
set -euo pipefail
DIR=${LUMPYLP_TESTDB_DIR:-/tmp/lumpylp-testdb-$(id -u)}
PORT=33306
MYSQLD=${MYSQLD:-/usr/sbin/mysqld}
mkdir -p "$DIR"
chmod 700 "$DIR"
if [ -f "$DIR/mysqld.pid" ] && kill -0 "$(cat "$DIR/mysqld.pid")" 2>/dev/null; then
  echo "test mysqld already running (pid $(cat "$DIR/mysqld.pid"))"
  exit 0
fi
if [ ! -d "$DIR/data/mysql" ]; then
  "$MYSQLD" --no-defaults --initialize-insecure --datadir="$DIR/data" --user="$(whoami)" > "$DIR/init.log" 2>&1
fi
"$MYSQLD" --no-defaults --daemonize \
  --datadir="$DIR/data" --user="$(whoami)" \
  --port="$PORT" --bind-address=127.0.0.1 --mysqlx=OFF \
  --socket="$DIR/mysqld.sock" --pid-file="$DIR/mysqld.pid" \
  --log-error="$DIR/error.log" --skip-log-bin \
  --innodb-buffer-pool-size=${TESTDB_BUFFER_POOL:-1G} --innodb-buffer-pool-chunk-size=${TESTDB_BUFFER_CHUNK:-128M} --max-connections=200 \
  --sql-mode=ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION \
  > "$DIR/start.log" 2>&1
for _ in $(seq 60); do
  [ -S "$DIR/mysqld.sock" ] && mysqladmin --no-defaults --socket="$DIR/mysqld.sock" -uroot ping >/dev/null 2>&1 && break
  sleep 0.5
done
echo "test mysqld running (pid $(cat "$DIR/mysqld.pid")) on 127.0.0.1:$PORT"
