-- Web searches are charged in credits (#474): each search is a spend of its own
-- (`spends.kind` = 'web_search'), beside the model calls and the renders.

-- A search the worker sent to the search provider, however it ended. What it cost, which product
-- asked, and when it was charged are on its spend; what is particular to a search is here. Requests
-- the worker refused (a bad query, a rate limit, no credits) never reached the provider and have no
-- row. No query and no result is kept.
CREATE TABLE web_searches (
  id INTEGER PRIMARY KEY,
  spend_id INTEGER NOT NULL UNIQUE REFERENCES spends (id),
  -- How the search ended: ok, or why it gave no results (search_failed, search_busy, search_unavailable).
  outcome TEXT NOT NULL,
  -- How many results went back to the client.
  results INTEGER NOT NULL CHECK (results >= 0)
);
