#!/bin/bash
# Create or reset the least-privilege DB users from server/db/grants.sql.
# Usage (on the server, as root):
#   sudo bash apply-grants.sh --defaults-file=/root/lumpylp-doadmin.cnf --db=lumpylp \
#        --app-password-file=/root/lumpylp-app.pw --indexer-password-file=/root/lumpylp-indexer.pw
# Password files are root-only (600) and are generated on the server, e.g.
#   (umask 077; openssl rand -base64 33 | tr -dc 'A-Za-z0-9' | head -c 32 > /root/lumpylp-app.pw)
# The SQL with real passwords is piped to mysql on stdin; it is never written
# to disk or printed.
set -euo pipefail
umask 077
DEFAULTS=""; DB="lumpylp"; HOST="%"; APPF=""; IDXF=""
for a in "$@"; do
  case $a in
    --defaults-file=*) DEFAULTS=${a#*=} ;;
    --db=*) DB=${a#*=} ;;
    --host=*) HOST=${a#*=} ;;
    --app-password-file=*) APPF=${a#*=} ;;
    --indexer-password-file=*) IDXF=${a#*=} ;;
    *) echo "unknown argument: $a"; exit 2 ;;
  esac
done
for f in "$DEFAULTS" "$APPF" "$IDXF"; do [ -r "$f" ] || { echo "missing or unreadable: $f"; exit 2; }; done
for f in "$APPF" "$IDXF"; do grep -qE '^[A-Za-z0-9]{24,}$' "$f" || { echo "$f must hold 24+ letters/digits"; exit 2; }; done
HERE=$(cd "$(dirname "$0")" && pwd)
APP=$(cat "$APPF"); IDX=$(cat "$IDXF")
sed -e "s/{{DB_NAME}}/$DB/g" -e "s/{{HOST}}/$HOST/g" \
    -e "s/{{APP_PASSWORD}}/$APP/g" -e "s/{{INDEXER_PASSWORD}}/$IDX/g" "$HERE/../db/grants.sql" \
  | mysql --defaults-file="$DEFAULTS"
unset APP IDX
echo "grants applied for lumpylp_app and lumpylp_indexer on $DB"
mysql --defaults-file="$DEFAULTS" -N -B -e "SHOW GRANTS FOR 'lumpylp_app'@'$HOST'; SHOW GRANTS FOR 'lumpylp_indexer'@'$HOST'" | sed 's/IDENTIFIED BY .*//'
