-- Phase 2C: store a vote weight per cast vote so we can switch the heap
-- algorithm to weighted sums later without re-deriving from sparse data.
-- For Phase 2C the actual sort still uses simple counts; weight is just
-- recorded at write time based on account age.
USE lumpylp;

ALTER TABLE votes
  ADD COLUMN weight DECIMAL(3,2) NOT NULL DEFAULT 1.00 AFTER direction;

-- The heap and top-of-the-top queries scan votes by updated_at for time
-- windows. Add an index so /api/tracks/top?window=week stays cheap as
-- vote volume grows.
ALTER TABLE votes
  ADD INDEX idx_votes_updated_at (updated_at);
