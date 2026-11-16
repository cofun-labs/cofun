-- The credit ledger, laid out again so each fact is stored once (#469). Amounts are integer
-- micro-credits (1 credit = 1,000,000; 1 US dollar = 1000 credits), times are ms since the epoch, and
-- user ids are Clerk user ids. Rows are never changed or deleted: a grant is written once, and what
-- happens to it later (credits spent from it, its purchase taken back) is a row of its own.
--
-- Nothing is stored that can be worked out from the rest: what is left of a grant is its amount less
-- what was spent from it (`spend_grants`), a balance is what is left of the grants that still count,
-- and what a spend's grants did not cover was forgiven. Columns of named values (`source`, `kind`,
-- `reason`, `outcome`) have no CHECK here, so a new value needs no rebuild: the worker writes them
-- (src/credits.ts), and checks `source` and `reason` with its schemas when it reads them.
--
-- The tables before this one held only test data, so they are dropped, not copied.

DROP TABLE grants;
DROP TABLE model_calls;
DROP TABLE revoked_payments;

-- Credits a user was given: the weekly free grant (`free`), credits an admin granted by hand
-- (`manual`), or credits bought (`purchase`). A grant counts until `expires_at`, or until its
-- purchase was taken back (`grant_revocations`), and for nothing after.
CREATE TABLE grants (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL,
  source TEXT NOT NULL,
  amount INTEGER NOT NULL CHECK (amount > 0),
  granted_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > granted_at)
);

-- A user's grants that still count, in the order they are spent; and the lazy free grant's check.
CREATE INDEX grants_by_user ON grants (user_id, expires_at);
-- A user's grants in the order they were given, for the history the side panel shows.
CREATE INDEX grants_by_user_granted ON grants (user_id, granted_at);
-- Totals granted over a period, across users.
CREATE INDEX grants_by_time ON grants (granted_at);

-- A grant made by hand: the Clerk user id of the admin who made it. Written with its grant.
CREATE TABLE manual_grants (
  id INTEGER PRIMARY KEY,
  grant_id INTEGER NOT NULL UNIQUE REFERENCES grants (id),
  granted_by TEXT NOT NULL
);

-- A grant bought through Stripe Checkout: the Stripe PaymentIntent id of the payment. Written with its
-- grant. Unique, so a payment that is reported twice grants once.
CREATE TABLE purchases (
  id INTEGER PRIMARY KEY,
  grant_id INTEGER NOT NULL UNIQUE REFERENCES grants (id),
  payment TEXT NOT NULL UNIQUE
);

-- A purchase taken back after a refund or a dispute (`reason`): from `created_at` on, its grant counts
-- for nothing. What was spent from it stays spent; what was left of it then is what was taken back.
-- A grant is taken back once: the first reason stays.
CREATE TABLE grant_revocations (
  id INTEGER PRIMARY KEY,
  grant_id INTEGER NOT NULL UNIQUE REFERENCES grants (id),
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- One row per spend of credits, whatever it cost (0 included): who spent, from which product
-- (`notico`, another extension's name, or `unknown`), on what (`kind`: `model_call`), what it cost
-- at the prices of that moment, and when it was charged. What is particular to each kind is in its
-- own table (`model_calls`), pointing at its spend.
CREATE TABLE spends (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL,
  product TEXT NOT NULL,
  kind TEXT NOT NULL,
  micro_credits INTEGER NOT NULL CHECK (micro_credits >= 0),
  created_at INTEGER NOT NULL
);

-- A user's spends over a period.
CREATE INDEX spends_by_user ON spends (user_id, created_at);
-- Spends and what they cost over a period, across users.
CREATE INDEX spends_by_time ON spends (created_at);

-- What a spend took from each grant: the grants that still counted when it was charged, the one that
-- expires first first, each up to what was left of it. What they did not cover was forgiven, so a
-- spend's rows add up to its cost or less (none when it cost nothing or nothing was left). Written
-- with its spend.
CREATE TABLE spend_grants (
  id INTEGER PRIMARY KEY,
  spend_id INTEGER NOT NULL REFERENCES spends (id),
  grant_id INTEGER NOT NULL REFERENCES grants (id),
  micro_credits INTEGER NOT NULL CHECK (micro_credits > 0),
  UNIQUE (spend_id, grant_id)
);

-- What was spent from a grant, read for every balance: the sum is read from the index alone.
CREATE INDEX spend_grants_by_grant ON spend_grants (grant_id, micro_credits);

-- A call the worker made to the model, however it ended: answered, stopped by the user, broken off,
-- or failed. A question answered with tools makes one call per round trip. Requests the worker
-- refused (no credits, a bad request) never reached the model and have no row. No message or reply
-- content is kept. It ended when its spend was charged (`spends.created_at`).
CREATE TABLE model_calls (
  id INTEGER PRIMARY KEY,
  spend_id INTEGER NOT NULL UNIQUE REFERENCES spends (id),
  model TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  stream INTEGER NOT NULL CHECK (stream IN (0, 1)),
  -- How the call ended: ok, incomplete (the stream ended early), cancelled (the client stopped
  -- reading), stream_error, provider_error, internal, or the code of the error that ended it.
  outcome TEXT NOT NULL,
  -- Why the model stopped: stop, length, content_filter, tool_calls, other, or empty when unknown.
  finish_reason TEXT NOT NULL,
  prompt_tokens INTEGER NOT NULL CHECK (prompt_tokens >= 0),
  -- The part of the prompt tokens the model read from its cache.
  cached_tokens INTEGER NOT NULL CHECK (cached_tokens >= 0),
  completion_tokens INTEGER NOT NULL CHECK (completion_tokens >= 0),
  -- 1 when the call was cut short before the model reported its totals, so the tokens are the
  -- estimate it was charged by.
  estimated INTEGER NOT NULL CHECK (estimated IN (0, 1))
);
