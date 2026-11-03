-- Relaunch G1 (2026-10-25): remove the Stripe paywall's data.
--
-- Funding is now a Stripe Payment Link that unlocks nothing; the server holds
-- no payment state. pending_signups held signups waiting on a Stripe webhook
-- (emails + bcrypt hashes of passwords typed for the paywall); the four users
-- columns recorded Stripe ids and the coupon used.
--
-- NOT REVERSIBLE for that data, by design. On production, do not run this file
-- directly: run scripts/run-migration-016.sh as root, which first writes a
-- root-only dump of pending_signups and users and refuses to drop anything
-- if the dump is missing or empty. paid_at is kept (nullable, unused) for history.
DROP TABLE IF EXISTS pending_signups;
ALTER TABLE users
  DROP COLUMN stripe_customer_id,
  DROP COLUMN stripe_payment_intent_id,
  DROP COLUMN signup_method,
  DROP COLUMN coupon_code_used;
