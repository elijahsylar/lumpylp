-- Relaunch follow-up (2026-10-25, owner decision 6): hide rows whose license
-- we can't vouch for, with reason 'license_unverified'. Reversible (rows are
-- hidden, never deleted; licenses untouched).
--
-- 1. Wikimedia rows labelled public-domain (prod: 6,394 of 13,295). The old
--    resolver wrote 'public-domain' when a file carried no license metadata,
--    and the database doesn't record which rows got that fallback, so every
--    Wikimedia public-domain row is hidden. scripts/check-wikimedia-licenses.js
--    reads each file's Commons license (read-only) and lists the ones that can
--    be unhidden with scripts/hide-track.js <id> --unhide.
-- 2. Jamendo rows with the bare license 'CC' (prod: 4,322): 2005-08 tracks
--    whose specific Creative Commons license was never recorded.
--
-- Each step prints its count and aborts the whole migration (error 3141,
-- nothing committed) past a ceiling.
START TRANSACTION;

SELECT COUNT(*) INTO @n FROM tracks WHERE source = 'wikimedia' AND license = 'public-domain' AND hidden_at IS NULL;
SELECT 'wikimedia public-domain' AS step, @n AS rows_to_hide;
SET @guard = IF(@n > 7000, JSON_EXTRACT('ceiling exceeded: wikimedia public-domain', '$'), 0);
UPDATE tracks
   SET hidden_at = NOW(), hidden_reason = 'license_unverified',
       hidden_note = 'Wikimedia public-domain label may be the old resolver fallback; check the Commons license'
 WHERE source = 'wikimedia' AND license = 'public-domain' AND hidden_at IS NULL;

SELECT COUNT(*) INTO @n FROM tracks WHERE source = 'jamendo' AND license = 'CC' AND hidden_at IS NULL;
SELECT 'jamendo bare CC' AS step, @n AS rows_to_hide;
SET @guard = IF(@n > 4600, JSON_EXTRACT('ceiling exceeded: jamendo bare CC', '$'), 0);
UPDATE tracks
   SET hidden_at = NOW(), hidden_reason = 'license_unverified',
       hidden_note = 'Jamendo license recorded only as "CC"; exact license unknown'
 WHERE source = 'jamendo' AND license = 'CC' AND hidden_at IS NULL;

COMMIT;
