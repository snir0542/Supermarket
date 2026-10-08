CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS chains (
  chain_id   text PRIMARY KEY,
  name       text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stores (
  id           serial PRIMARY KEY,
  chain_id     text NOT NULL REFERENCES chains(chain_id),
  sub_chain_id text NOT NULL DEFAULT '0',
  store_id     text NOT NULL,
  name         text,
  address      text,
  city         text,            -- raw: a name or a CBS city code, depends on the chain
  zip          text,
  is_online    boolean NOT NULL DEFAULT false, -- StoreType=2 in the Stores file
  search_text  text,            -- normalized name + address + city, for area filtering
  UNIQUE (chain_id, sub_chain_id, store_id)
);
ALTER TABLE stores ADD COLUMN IF NOT EXISTS is_online boolean NOT NULL DEFAULT false;
CREATE INDEX IF NOT EXISTS stores_search_trgm ON stores USING gin (search_text gin_trgm_ops);

-- one row per real-world product; gtin is NULL for products that only exist under chain internal codes
CREATE TABLE IF NOT EXISTS products (
  id        serial PRIMARY KEY,
  gtin      text UNIQUE,        -- canonical 13 digits (zero padded)
  name      text NOT NULL,
  name_norm text NOT NULL,
  size_key  text,               -- e.g. "200g", "1500ml"
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS products_name_trgm ON products USING gin (name_norm gin_trgm_ops);

-- how each chain refers to a product
CREATE TABLE IF NOT EXISTS chain_items (
  chain_id     text NOT NULL REFERENCES chains(chain_id),
  item_code    text NOT NULL,
  product_id   integer NOT NULL REFERENCES products(id),
  raw_name     text NOT NULL,
  manufacturer text,
  match_method text NOT NULL,   -- gtin | chain-code | fuzzy | new
  match_score  real,
  needs_review boolean NOT NULL DEFAULT false,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chain_id, item_code)
);
CREATE INDEX IF NOT EXISTS chain_items_product ON chain_items (product_id);
CREATE INDEX IF NOT EXISTS chain_items_review ON chain_items (needs_review) WHERE needs_review;

-- latest known price per store + item
CREATE TABLE IF NOT EXISTS current_prices (
  store_pk         integer NOT NULL REFERENCES stores(id),
  chain_id         text NOT NULL,
  item_code        text NOT NULL,
  price            numeric(10,2) NOT NULL,
  unit_price       numeric(10,2),
  price_updated_at timestamptz,
  observed_at      timestamptz NOT NULL,
  PRIMARY KEY (store_pk, item_code)
);
CREATE INDEX IF NOT EXISTS current_prices_chain_item ON current_prices (chain_id, item_code);

-- append-only: a row is added only when the price is new or changed
CREATE TABLE IF NOT EXISTS price_history (
  id         bigserial PRIMARY KEY,
  store_pk   integer NOT NULL REFERENCES stores(id),
  chain_id   text NOT NULL,
  item_code  text NOT NULL,
  price      numeric(10,2) NOT NULL,
  valid_from timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS price_history_lookup ON price_history (chain_id, item_code, valid_from);

CREATE TABLE IF NOT EXISTS ingest_runs (
  id             bigserial PRIMARY KEY,
  chain_id       text NOT NULL,
  store_id       text NOT NULL,   -- "<subChainId>-<storeId>"
  file_name      text NOT NULL,
  file_time      timestamptz,
  items_total    integer NOT NULL,
  items_invalid  integer NOT NULL,
  gtin_matched   integer NOT NULL,
  fuzzy_matched  integer NOT NULL,
  new_products   integer NOT NULL,
  needs_review   integer NOT NULL,
  price_changes  integer NOT NULL,
  status         text NOT NULL,   -- ok | warning | failed
  issues         text[] NOT NULL DEFAULT '{}',
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ingest_runs_file ON ingest_runs (file_name);
CREATE INDEX IF NOT EXISTS ingest_runs_store ON ingest_runs (chain_id, store_id, created_at DESC);

-- PromoFull: latest promotion snapshot per store (fully replaced on each store ingest).
CREATE TABLE IF NOT EXISTS promotions (
  id             bigserial PRIMARY KEY,
  store_pk       integer NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  chain_id       text NOT NULL,
  promotion_id   text NOT NULL,
  description    text,
  club_id        text NOT NULL DEFAULT '0',
  club_name      text,
  starts_at      timestamptz,
  ends_at        timestamptz,
  allow_multiple boolean NOT NULL DEFAULT false,
  is_coupon      boolean NOT NULL DEFAULT false,
  file_name      text NOT NULL,
  observed_at    timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS promotions_store ON promotions (store_pk);
CREATE INDEX IF NOT EXISTS promotions_club ON promotions (chain_id, club_id);

CREATE TABLE IF NOT EXISTS promotion_items (
  promotion_pk        bigint NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  item_code           text NOT NULL,
  item_type           integer,
  is_gift             boolean NOT NULL DEFAULT false,
  min_qty             real,
  max_qty             real,
  discount_rate       real,
  discounted_price    numeric(10,2),
  min_purchase_amount numeric(10,2),
  is_weighted         boolean NOT NULL DEFAULT false,
  PRIMARY KEY (promotion_pk, item_code)
);
CREATE INDEX IF NOT EXISTS promotion_items_lookup ON promotion_items (item_code);
