-- Pages rendered in Browser Run are charged in credits (#464): each render is a spend of its own
-- (`spends.kind` = 'web_render'), beside the model calls (`model_call`).

-- A page the worker had Browser Run render, however it ended. What it cost, which product asked,
-- and when it was charged are on its spend; what is particular to a render is here. Requests the
-- worker refused (a bad address, a rate limit, no credits) never reached Browser Run and have no row.
-- No address and no page content is kept.
CREATE TABLE web_renders (
  id INTEGER PRIMARY KEY,
  spend_id INTEGER NOT NULL UNIQUE REFERENCES spends (id),
  -- How the render ended: ok, no_text (rendered, but it shows no text), or render_failed.
  outcome TEXT NOT NULL,
  -- The browser time Browser Run reported for it (X-Browser-Ms-Used), what it bills; the time the
  -- render took when it reported none.
  browser_ms INTEGER NOT NULL CHECK (browser_ms >= 0)
);
