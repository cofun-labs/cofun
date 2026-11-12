-- Credits, for every user: every grant they were given, and every model call they made with what it
-- cost them. Amounts are integer micro-credits (1 credit = 1,000,000; 1 US dollar = 1000 credits),
-- times are ms since the epoch, and user ids are Clerk user ids. Rows are never deleted: an expired
-- grant stays as the record of what the user was given, and a model call as the record of what was
-- asked of the model and what it cost.
--
-- What a user owes (debt) is not stored as a number of its own. It is what model calls cost beyond
-- the user's grants, less what grants paid back: sum(model_calls.owed) - sum(grants.repaid). A grant pays back debt out of
-- its amount first, so its `left` starts at amount - repaid.

CREATE TABLE grants (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL,
  -- The weekly free grant, or credits an admin granted by hand.
  source TEXT NOT NULL CHECK (source IN ('free', 'manual')),
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
  CHECK ((source = 'manual') = (granted_by IS NOT NULL))
);

-- A user's grants that still count, in the order they are spent; and the lazy free grant's check.
CREATE INDEX grants_by_user ON grants (user_id, expires_at);
-- Totals granted over a period, across users.
CREATE INDEX grants_by_time ON grants (granted_at);

-- One row per call the worker made to the model, however it ended: answered, stopped by the user,
-- broken off, or failed, with what it cost. A question answered with tools makes one call per round
-- trip. Requests the worker refused (no credits, a bad request) never reached the model and have no
-- row. No message or reply content is kept.
CREATE TABLE model_calls (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL,
  model TEXT NOT NULL,
  -- When the model was called, and when the call ended (the reply was sent, or the stream ended).
  started_at INTEGER NOT NULL,
  ended_at INTEGER NOT NULL CHECK (ended_at >= started_at),
  stream INTEGER NOT NULL CHECK (stream IN (0, 1)),
  -- How the call ended: ok, incomplete (the stream ended early), cancelled (the client stopped
  -- reading), stream_error, provider_error, or internal.
  outcome TEXT NOT NULL,
  -- Why the model stopped: stop, length, content_filter, tool_calls, other, or empty when unknown.
  finish_reason TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL CHECK (prompt_tokens >= 0),
  -- The part of the prompt tokens the model read from its cache.
  cached_tokens INTEGER NOT NULL CHECK (cached_tokens >= 0),
  completion_tokens INTEGER NOT NULL CHECK (completion_tokens >= 0),
  -- 1 when the call was cut short before the model reported its totals, so the tokens are the
  -- estimate it was charged by.
  estimated INTEGER NOT NULL CHECK (estimated IN (0, 1)),
  -- What the call cost, taken from the user's grants when it ended, at the prices of that moment.
  -- 0 for a call that cost nothing.
  micro_credits INTEGER NOT NULL CHECK (micro_credits >= 0),
  -- The part of the cost the user's grants did not cover: owed, and paid back by the next grants.
  owed INTEGER NOT NULL CHECK (owed >= 0 AND owed <= micro_credits)
);

-- A user's calls over a period.
CREATE INDEX model_calls_by_user ON model_calls (user_id, started_at);
-- Calls and what they cost over a period, across users.
CREATE INDEX model_calls_by_time ON model_calls (started_at);
-- What a user owes, read on every chat request: only the calls that left something owed (one per
-- overdraft, not one per call).
CREATE INDEX model_calls_owed ON model_calls (user_id, owed) WHERE owed > 0;
