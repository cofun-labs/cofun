-- Credits: every grant and every charge, for every user. Amounts are integer micro-credits
-- (1 credit = 1,000,000; 1 US dollar = 1000 credits), times are ms since the epoch, and user ids
-- are Clerk user ids. Rows are never deleted: an expired grant stays as the record of what the user
-- was given, and a charge as the record of what they spent.
--
-- What a user owes (debt) is not stored as a number of its own. It is what charges did not cover,
-- less what grants paid back: sum(charges.owed) - sum(grants.repaid). A grant pays back debt out of
-- its amount first, so its `left` starts at amount - repaid.

CREATE TABLE grants (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL,
  -- The weekly free grant, or credits an admin granted by hand.
  source TEXT NOT NULL CHECK (source IN ('free', 'manual')),
  amount INTEGER NOT NULL CHECK (amount > 0),
  -- The part of the amount that paid back debt when the grant was made.
  repaid INTEGER NOT NULL CHECK (repaid >= 0 AND repaid <= amount),
  -- What is left to spend. Charges take from it with relative updates.
  left INTEGER NOT NULL CHECK (left >= 0 AND left <= amount - repaid),
  granted_at INTEGER NOT NULL,
  -- The grant counts until this moment, and for nothing after it.
  expires_at INTEGER NOT NULL CHECK (expires_at > granted_at),
  -- For a grant made by hand: the Clerk user id of the admin who made it.
  granted_by TEXT,
  CHECK ((source = 'manual') = (granted_by IS NOT NULL))
);

-- A user's grants that still count, in the order they are spent; and the lazy free grant's check.
CREATE INDEX grants_by_user ON grants (user_id, expires_at);
-- Totals granted over a period, across users.
CREATE INDEX grants_by_time ON grants (granted_at);

-- One row per model call that was charged. A question answered with tools has one row per model call.
CREATE TABLE charges (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL,
  at INTEGER NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL CHECK (prompt_tokens >= 0),
  -- The part of the prompt tokens the model read from its cache.
  cached_tokens INTEGER NOT NULL CHECK (cached_tokens >= 0),
  completion_tokens INTEGER NOT NULL CHECK (completion_tokens >= 0),
  -- What the call cost.
  micro_credits INTEGER NOT NULL CHECK (micro_credits > 0),
  -- The part of the cost the user's grants did not cover: owed, and paid back by the next grants.
  owed INTEGER NOT NULL CHECK (owed >= 0 AND owed <= micro_credits)
);

-- A user's charges over a period, and what they owe.
CREATE INDEX charges_by_user ON charges (user_id, at);
-- Totals spent over a period, across users.
CREATE INDEX charges_by_time ON charges (at);
