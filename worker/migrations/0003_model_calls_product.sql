-- Which product each model call came from: `notico`, another extension's name, or `unknown` when
-- the session token's origin (its `azp`) maps to no product (see PRODUCTS in wrangler.jsonc). Every
-- call before this column existed came from Notico, the only product then. The worker always names
-- the product when it records a call; the default only fills in the rows that were already there.
-- Credits stay one balance per user across products, so `grants` has no product.
ALTER TABLE model_calls ADD COLUMN product TEXT NOT NULL DEFAULT 'notico';
