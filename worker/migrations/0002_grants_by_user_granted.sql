-- A user's grants in the order they were given, for the history the side panel shows a page at a
-- time, newest first (GET /v1/credits/grants). `grants_by_user` orders a user's grants by when they
-- expire, which is not the order they were given in once grants last different lengths of time (a
-- grant by hand for 30 days, a free week), so without this index every page would read and sort all
-- of the user's grants.
CREATE INDEX grants_by_user_granted ON grants (user_id, granted_at);
