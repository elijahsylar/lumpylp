-- Phase 16.5a: additive schema for Stripe paywall.
--
-- Safe to apply anytime. Old code keeps working because every new
-- column is NULL-able (paid_at) or has a default (signup_method).
-- The destructive purge of existing users runs separately in 012b
-- AFTER the new signup flow is verified end-to-end.
--
-- Verification queries to run before/after applying:
--
--   SHOW COLUMNS FROM users
--     WHERE Field IN ('paid_at','stripe_customer_id',
--                     'stripe_payment_intent_id','signup_method',
--                     'coupon_code_used');
--   -- pre-apply: empty. post-apply: 5 rows.
--
--   SHOW TABLES LIKE 'pending_signups';
--   -- pre-apply: empty. post-apply: 1 row.
--
USE lumpylp;

ALTER TABLE users
  ADD COLUMN paid_at                  TIMESTAMP NULL DEFAULT NULL                       AFTER theme,
  ADD COLUMN stripe_customer_id       VARCHAR(64) NULL DEFAULT NULL                     AFTER paid_at,
  ADD COLUMN stripe_payment_intent_id VARCHAR(64) NULL DEFAULT NULL                     AFTER stripe_customer_id,
  ADD COLUMN signup_method            ENUM('paid','coupon','admin') NOT NULL DEFAULT 'paid' AFTER stripe_payment_intent_id,
  ADD COLUMN coupon_code_used         VARCHAR(64) NULL DEFAULT NULL                     AFTER signup_method;

-- pending_signups holds form data between signup-init and the Stripe
-- webhook callback. Rows past expires_at are stale; a future cron job
-- (TODO: phase 17) sweeps them. consumed_at is set by the webhook
-- handler so retried webhook deliveries are idempotent.
CREATE TABLE IF NOT EXISTS pending_signups (
  id                INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  stripe_session_id VARCHAR(128) NOT NULL UNIQUE,
  email             VARCHAR(255) NOT NULL,
  username          VARCHAR(50)  NOT NULL,
  password_hash     VARCHAR(255) NOT NULL,
  created_at        TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  expires_at        TIMESTAMP NOT NULL,
  consumed_at       TIMESTAMP NULL DEFAULT NULL,
  INDEX idx_pending_signups_session (stripe_session_id),
  INDEX idx_pending_signups_expires (expires_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
