-- Which chat, and which question (turn) of it, each spend was for (#466): random ids the extension
-- makes, `X-Cofun-Chat-Id` (the session's own id) and `X-Cofun-Turn-Id` (one per question, the same
-- across all its model calls, renders, and searches). They say nothing about the content. NULL when
-- the request named none: the extension versions on the store before this send neither, and every
-- spend before this column existed has none.
ALTER TABLE spends ADD COLUMN chat_id TEXT;
ALTER TABLE spends ADD COLUMN turn_id TEXT;

-- A question's spends, and a chat's: what it made and what it cost in all.
CREATE INDEX spends_by_turn ON spends (turn_id) WHERE turn_id IS NOT NULL;
CREATE INDEX spends_by_chat ON spends (chat_id) WHERE chat_id IS NOT NULL;
