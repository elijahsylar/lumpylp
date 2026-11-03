#!/bin/bash
# Apply migration 016 (drop pending_signups and the Stripe columns on users)
# only after writing a root-only dump of those tables.
#
# Usage (production, as root on the server):
#   sudo bash run-migration-016.sh --defaults-file=/root/lumpylp-doadmin.cnf [--db=lumpylp]
# The defaults file is a root-only (600) MySQL option file for the managed DB's
# admin user ([client] host/port/user/password/ssl-ca); passwords never appear
# on a command line or in output.
#
# The dump goes to /root/lumpylp-predrop-<timestamp>/ (dir 700, files 600):
# pending_signups (predrop.sql) and users' id + Stripe columns (users-stripe-columns.tsv).
# Tests pass --dump-root and LUMPYLP_ALLOW_NONROOT=1 to run without root.
set -euo pipefail
umask 077
DEFAULTS=""; DB="lumpylp"; DUMP_ROOT="/root"
for a in "$@"; do
  case $a in
    --defaults-file=*) DEFAULTS=${a#*=} ;;
    --db=*) DB=${a#*=} ;;
    --dump-root=*) DUMP_ROOT=${a#*=} ;;
    *) echo "unknown argument: $a"; exit 2 ;;
  esac
done
[ -n "$DEFAULTS" ] && [ -r "$DEFAULTS" ] || { echo "need --defaults-file=<readable option file>"; exit 2; }
if [ "$(id -u)" != 0 ] && [ "${LUMPYLP_ALLOW_NONROOT:-}" != 1 ]; then echo "run as root"; exit 2; fi
HERE=$(cd "$(dirname "$0")" && pwd)
MIGRATION="$HERE/../migrations/016_relaunch_drop_stripe.sql"
[ -f "$MIGRATION" ] || { echo "missing $MIGRATION"; exit 2; }
M=(mysql --defaults-file="$DEFAULTS")

HAS_PENDING=$("${M[@]}" -N -B -e "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema='$DB' AND table_name='pending_signups'")
HAS_COLS=$("${M[@]}" -N -B -e "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema='$DB' AND table_name='users' AND column_name IN ('stripe_customer_id','stripe_payment_intent_id','signup_method','coupon_code_used')")
if [ "$HAS_PENDING" = 0 ] && [ "$HAS_COLS" = 0 ]; then echo "already applied; nothing to do"; exit 0; fi

OUT="$DUMP_ROOT/lumpylp-predrop-$(date +%Y%m%d-%H%M%S)"
install -d -m 700 "$OUT"
# Only what is being dropped (review R19): the whole pending_signups table,
# and from users just the id plus the four Stripe columns, not emails or
# password hashes. Keep the dump only as long as you need it (see the report).
: > "$OUT/predrop.sql"; chmod 600 "$OUT/predrop.sql"
if [ "$HAS_PENDING" != 0 ]; then
  mysqldump --defaults-file="$DEFAULTS" --single-transaction --no-tablespaces --set-gtid-purged=OFF \
    "$DB" pending_signups >> "$OUT/predrop.sql"
  grep -q 'CREATE TABLE `pending_signups`' "$OUT/predrop.sql" || { echo "dump lacks pending_signups; NOT applying the migration"; exit 1; }
fi
if [ "$HAS_COLS" != 0 ]; then
  "${M[@]}" --batch "$DB" -e "SELECT id, stripe_customer_id, stripe_payment_intent_id, signup_method, coupon_code_used FROM users" > "$OUT/users-stripe-columns.tsv"
  chmod 600 "$OUT/users-stripe-columns.tsv"
  head -1 "$OUT/users-stripe-columns.tsv" | grep -q stripe_customer_id || { echo "users column export failed; NOT applying the migration"; exit 1; }
fi
[ -s "$OUT/predrop.sql" ] || [ -s "$OUT/users-stripe-columns.tsv" ] || { echo "nothing was dumped; NOT applying the migration"; exit 1; }
echo "dump written to $OUT (dir mode $(stat -c %a "$OUT")):"; ls -l "$OUT"

"${M[@]}" "$DB" < "$MIGRATION"
echo "migration 016 applied to $DB"
