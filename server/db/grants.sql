-- Least-privilege MySQL users for LumpyLP (relaunch item 9).
--
-- Run once as the managed DB's admin user (doadmin) during a server rebuild,
-- through scripts/apply-grants.sh, which fills the placeholders from root-only
-- files and never echoes the passwords:
--   {{DB_NAME}}           database name (production: lumpylp)
--   {{HOST}}              allowed client host ('%' behind the DO trusted-sources list)
--   {{APP_PASSWORD}}      password for lumpylp_app
--   {{INDEXER_PASSWORD}}  password for lumpylp_indexer
-- Idempotent: re-running resets each user's privileges to exactly this list.
-- Migrations keep running as doadmin by hand; neither user can change schema.
--
-- When a migration adds a column the API writes, extend the column list here.

CREATE USER IF NOT EXISTS 'lumpylp_app'@'{{HOST}}' IDENTIFIED BY '{{APP_PASSWORD}}' REQUIRE SSL;
ALTER USER 'lumpylp_app'@'{{HOST}}' IDENTIFIED BY '{{APP_PASSWORD}}' REQUIRE SSL;
REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'lumpylp_app'@'{{HOST}}';

-- The API: reads everything; writes accounts, lumps and votes; on tracks it
-- may only update the vote counters and the admin hide columns (takedowns).
-- No INSERT or DELETE on tracks, no DDL.
GRANT SELECT ON `{{DB_NAME}}`.* TO 'lumpylp_app'@'{{HOST}}';
-- users: create accounts and update only the columns the API writes. Not
-- role (admins are granted by hand, db/grant-admin.sql) and no DELETE.
GRANT INSERT ON `{{DB_NAME}}`.`users` TO 'lumpylp_app'@'{{HOST}}';
GRANT UPDATE (theme, password_hash, token_version, updated_at) ON `{{DB_NAME}}`.`users` TO 'lumpylp_app'@'{{HOST}}';
GRANT INSERT, UPDATE, DELETE ON `{{DB_NAME}}`.`user_lumps` TO 'lumpylp_app'@'{{HOST}}';
GRANT INSERT, UPDATE, DELETE ON `{{DB_NAME}}`.`lump_tracks` TO 'lumpylp_app'@'{{HOST}}';
GRANT INSERT, UPDATE, DELETE ON `{{DB_NAME}}`.`votes` TO 'lumpylp_app'@'{{HOST}}';
GRANT INSERT, UPDATE ON `{{DB_NAME}}`.`geocode_cache` TO 'lumpylp_app'@'{{HOST}}';
GRANT UPDATE (upvotes, downvotes, hidden_at, hidden_reason, hidden_note, duplicate_of) ON `{{DB_NAME}}`.`tracks` TO 'lumpylp_app'@'{{HOST}}';
GRANT INSERT ON `{{DB_NAME}}`.`moderation_log` TO 'lumpylp_app'@'{{HOST}}';

CREATE USER IF NOT EXISTS 'lumpylp_indexer'@'{{HOST}}' IDENTIFIED BY '{{INDEXER_PASSWORD}}' REQUIRE SSL;
ALTER USER 'lumpylp_indexer'@'{{HOST}}' IDENTIFIED BY '{{INDEXER_PASSWORD}}' REQUIRE SSL;
REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'lumpylp_indexer'@'{{HOST}}';

-- Indexer, dead-link sweep, backfills and catalog maintenance scripts:
-- read and write the catalog; never read or change accounts; no DDL; no
-- DELETE on tracks (catalog rows are hidden, never deleted).
GRANT SELECT, INSERT, UPDATE ON `{{DB_NAME}}`.`tracks` TO 'lumpylp_indexer'@'{{HOST}}';
GRANT SELECT, INSERT, UPDATE ON `{{DB_NAME}}`.`artists` TO 'lumpylp_indexer'@'{{HOST}}';
GRANT SELECT, INSERT, UPDATE ON `{{DB_NAME}}`.`genres` TO 'lumpylp_indexer'@'{{HOST}}';
GRANT SELECT, INSERT, UPDATE ON `{{DB_NAME}}`.`geocode_cache` TO 'lumpylp_indexer'@'{{HOST}}';
-- Catalog maintenance scripts: dedupe (moves lump entries and votes to the
-- kept row, logs every change for --undo), unhide-pd-effective (logs).
GRANT SELECT, INSERT, UPDATE ON `{{DB_NAME}}`.`track_merge_log` TO 'lumpylp_indexer'@'{{HOST}}';
GRANT SELECT, INSERT, UPDATE, DELETE ON `{{DB_NAME}}`.`lump_tracks` TO 'lumpylp_indexer'@'{{HOST}}';
GRANT SELECT, INSERT, UPDATE, DELETE ON `{{DB_NAME}}`.`votes` TO 'lumpylp_indexer'@'{{HOST}}';
GRANT INSERT ON `{{DB_NAME}}`.`moderation_log` TO 'lumpylp_indexer'@'{{HOST}}';
-- Dedupe --undo checks that a lump or voter still exists: ids only, no account data.
GRANT SELECT (id) ON `{{DB_NAME}}`.`users` TO 'lumpylp_indexer'@'{{HOST}}';
GRANT SELECT (id) ON `{{DB_NAME}}`.`user_lumps` TO 'lumpylp_indexer'@'{{HOST}}';
