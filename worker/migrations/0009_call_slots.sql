-- How many model calls one user has going at once. A call the worker lets in takes a slot, written
-- with the check that let it in (src/credits.ts); the slot is free again once the call's own
-- `model_calls` row names it, which is written when the call is charged, however it ended. A slot
-- whose call was never charged (a worker that went away mid-call) stops counting at `expires_at`.
-- Rows are never changed or deleted, like the rest of the ledger: whether a slot is taken is worked
-- out from the rows each time.
CREATE TABLE call_slots (
  id INTEGER PRIMARY KEY,
  user_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL CHECK (expires_at > started_at)
);

-- A user's slots that may still be taken.
CREATE INDEX call_slots_by_user ON call_slots (user_id, expires_at);

-- The slot a model call took. NULL for calls charged before slots existed.
ALTER TABLE model_calls ADD COLUMN slot_id INTEGER REFERENCES call_slots (id);

-- Whether a slot's call was charged.
CREATE INDEX model_calls_by_slot ON model_calls (slot_id) WHERE slot_id IS NOT NULL;

-- `model_calls.outcome` has one more value from here on: `abandoned` (the client fell too far behind
-- a stream the model finished, which is charged its totals).
