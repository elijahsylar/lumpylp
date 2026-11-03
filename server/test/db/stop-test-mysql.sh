#!/bin/bash
# Stop the test mysqld by the exact PID in its pid file.
set -euo pipefail
DIR=${LUMPYLP_TESTDB_DIR:-/tmp/lumpylp-testdb-$(id -u)}
[ -f "$DIR/mysqld.pid" ] || { echo "no pid file; not running"; exit 0; }
PID=$(cat "$DIR/mysqld.pid")
if kill -0 "$PID" 2>/dev/null; then
  kill "$PID"
  for _ in $(seq 60); do kill -0 "$PID" 2>/dev/null || break; sleep 0.5; done
fi
kill -0 "$PID" 2>/dev/null && { echo "pid $PID still running"; exit 1; }
echo "test mysqld (pid $PID) stopped"
