-- Relaunch G1 (2026-10-25): admin role and token revocation.
--
-- role: 'admin' unlocks /api/admin/*; checked from the DB on every request
--   (middleware/auth.js requireAdmin). Grant with db/grant-admin.sql.
-- token_version: carried in the JWT as `tv`; bumping it (password change,
--   admin reset) invalidates every existing token for that user.
--
-- No USE statement: the runner selects the database (prod: lumpylp;
-- tests: lumpylp_test).
ALTER TABLE users
  ADD COLUMN role ENUM('user','admin') NOT NULL DEFAULT 'user' AFTER username,
  ADD COLUMN token_version INT UNSIGNED NOT NULL DEFAULT 0 AFTER role;
