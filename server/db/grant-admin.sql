-- Make one existing user an admin (relaunch item 1). Run by hand as the
-- managed DB's admin user; set the username first:
--   SET @username = 'the-username';
--   SOURCE grant-admin.sql;
-- Demote with the same statement and role 'user'. There is no API for roles.
UPDATE users SET role = 'admin' WHERE username = @username;
SELECT id, username, role FROM users WHERE username = @username;
