-- Credits bought through Stripe Checkout (#233) are grants of their own source, `purchase`. The CHECK
-- on `grants.source` allowed only `free` and `manual`, and SQLite cannot change a CHECK in place, so
-- the table is rebuilt: every row is copied as it is, with the same id, and the indexes are made
-- again. The new table has no list of sources in a CHECK: the worker's schema (`GrantSource` in
-- src/credits.ts) checks the source, so a later source needs no rebuild.
--
-- Two columns are new:
-- - `payment`: for a purchase, the Stripe payment it came from (its PaymentIntent id). Unique, so a
--   payment that is reported twice grants once: the second insert does nothing.
-- - `revoked`: why a purchase was taken back (`refund` or `dispute`), or null. Rows are never deleted:
--   taking a purchase back ends it at that moment, so `expires_at` is when it was taken back and
--   `left` what was taken back. What was already spent stays spent.

CREATE TABLE grants_new (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL,
  -- The weekly free grant (`free`), credits an admin granted by hand (`manual`), or credits bought
  -- (`purchase`).
  source TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  -- The part of the amount that paid back debt when the grant was made.
  repaid INTEGER NOT NULL CHECK (repaid >= 0 AND repaid <= amount),
  -- What is left to spend. Model calls take what they cost from it with relative updates.
  left INTEGER NOT NULL CHECK (left >= 0 AND left <= amount - repaid),
  granted_at INTEGER NOT NULL,
  -- The grant counts until this moment, and for nothing after it.
  expires_at INTEGER NOT NULL CHECK (expires_at > granted_at),
  -- For a grant made by hand: the Clerk user id of the admin who made it.
  granted_by TEXT,
  -- For a purchase: the Stripe PaymentIntent id of the payment it came from.
  payment TEXT,
  -- For a purchase that was taken back: why. It ended at `expires_at`.
  revoked TEXT CHECK (revoked IN ('refund', 'dispute')),
  CHECK ((source = 'manual') = (granted_by IS NOT NULL)),
  CHECK ((source = 'purchase') = (payment IS NOT NULL)),
  CHECK (revoked IS NULL OR source = 'purchase')
);

INSERT INTO grants_new (id, user_id, source, amount, repaid, left, granted_at, expires_at, granted_by)
SELECT id, user_id, source, amount, repaid, left, granted_at, expires_at, granted_by FROM grants;

DROP TABLE grants;
ALTER TABLE grants_new RENAME TO grants;

-- The indexes of 0001 and 0002, as they were.
CREATE INDEX grants_by_user ON grants (user_id, expires_at);
CREATE INDEX grants_by_time ON grants (granted_at);
CREATE INDEX grants_by_user_granted ON grants (user_id, granted_at);
-- One grant per payment. Rows without a payment hold null, and nulls never clash.
CREATE UNIQUE INDEX grants_by_payment ON grants (payment);

-- Payments refunded or disputed before they made a grant: Stripe's events arrive in any order, and
-- the payment's own event can arrive after its refund (say while the database was down). A payment
-- listed here never makes a grant. Rows are never deleted: each is the record of a refund or dispute
-- that had nothing to take back yet.
CREATE TABLE revoked_payments (
  -- The Stripe PaymentIntent id.
  payment TEXT PRIMARY KEY,
  revoked TEXT NOT NULL CHECK (revoked IN ('refund', 'dispute')),
  -- When the refund or dispute was handled.
  at INTEGER NOT NULL
);
