-- מצב מקומי (SQLite): אותה סכמה לוגית כמו schema.sql של Postgres, בלי pg_trgm.
-- חיפוש מטושטש נעשה בתהליך (src/normalize/trigramIndex.ts). תאריכים נשמרים כ-ISO UTC.
CREATE TABLE IF NOT EXISTS chains (
  chain_id   TEXT PRIMARY KEY,
  name       TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS stores (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id     TEXT NOT NULL REFERENCES chains(chain_id),
  sub_chain_id TEXT NOT NULL DEFAULT '0',
  store_id     TEXT NOT NULL,
  name         TEXT,
  address      TEXT,
  city         TEXT,
  zip          TEXT,
  is_online    INTEGER NOT NULL DEFAULT 0,
  search_text  TEXT,
  UNIQUE (chain_id, sub_chain_id, store_id)
);

CREATE TABLE IF NOT EXISTS products (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  gtin      TEXT UNIQUE,
  name      TEXT NOT NULL,
  name_norm TEXT NOT NULL,
  size_key  TEXT
);

CREATE TABLE IF NOT EXISTS chain_items (
  chain_id     TEXT NOT NULL REFERENCES chains(chain_id),
  item_code    TEXT NOT NULL,
  product_id   INTEGER NOT NULL REFERENCES products(id),
  raw_name     TEXT NOT NULL,
  manufacturer TEXT,
  match_method TEXT NOT NULL,
  match_score  REAL,
  needs_review INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (chain_id, item_code)
);
CREATE INDEX IF NOT EXISTS chain_items_product ON chain_items (product_id);

CREATE TABLE IF NOT EXISTS current_prices (
  store_pk         INTEGER NOT NULL REFERENCES stores(id),
  chain_id         TEXT NOT NULL,
  item_code        TEXT NOT NULL,
  price            REAL NOT NULL,
  unit_price       REAL,
  price_updated_at TEXT,
  observed_at      TEXT NOT NULL,
  PRIMARY KEY (store_pk, item_code)
);
CREATE INDEX IF NOT EXISTS current_prices_chain_item ON current_prices (chain_id, item_code);

CREATE TABLE IF NOT EXISTS price_history (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  store_pk   INTEGER NOT NULL REFERENCES stores(id),
  chain_id   TEXT NOT NULL,
  item_code  TEXT NOT NULL,
  price      REAL NOT NULL,
  valid_from TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS price_history_lookup ON price_history (chain_id, item_code, valid_from);

CREATE TABLE IF NOT EXISTS ingest_runs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  chain_id       TEXT NOT NULL,
  store_id       TEXT NOT NULL,
  file_name      TEXT NOT NULL,
  file_time      TEXT,
  items_total    INTEGER NOT NULL,
  items_invalid  INTEGER NOT NULL,
  gtin_matched   INTEGER NOT NULL,
  fuzzy_matched  INTEGER NOT NULL,
  new_products   INTEGER NOT NULL,
  needs_review   INTEGER NOT NULL,
  price_changes  INTEGER NOT NULL,
  status         TEXT NOT NULL,
  issues         TEXT NOT NULL DEFAULT '[]',
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ingest_runs_file ON ingest_runs (file_name);
CREATE INDEX IF NOT EXISTS ingest_runs_store ON ingest_runs (chain_id, store_id, created_at DESC);

-- PromoFull: תמונת המבצעים העדכנית לכל חנות (מתחלפת במלואה בכל קליטה של החנות).
-- club_id = '0' מבצע לכולם; אחרת מבצע מועדון. התנאים נשמרים לכל פריט במבצע.
CREATE TABLE IF NOT EXISTS promotions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  store_pk       INTEGER NOT NULL REFERENCES stores(id) ON DELETE CASCADE,
  chain_id       TEXT NOT NULL,
  promotion_id   TEXT NOT NULL,
  description    TEXT,
  club_id        TEXT NOT NULL DEFAULT '0',
  club_name      TEXT,
  starts_at      TEXT,
  ends_at        TEXT,
  allow_multiple INTEGER NOT NULL DEFAULT 0,
  is_coupon      INTEGER NOT NULL DEFAULT 0,
  file_name      TEXT NOT NULL,
  observed_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS promotions_store ON promotions (store_pk);
CREATE INDEX IF NOT EXISTS promotions_club ON promotions (chain_id, club_id);

CREATE TABLE IF NOT EXISTS promotion_items (
  promotion_pk        INTEGER NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  item_code           TEXT NOT NULL,
  item_type           INTEGER,
  is_gift             INTEGER NOT NULL DEFAULT 0,
  min_qty             REAL,
  max_qty             REAL,
  discount_rate       REAL,
  discounted_price    REAL,
  min_purchase_amount REAL,
  is_weighted         INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (promotion_pk, item_code)
);
CREATE INDEX IF NOT EXISTS promotion_items_lookup ON promotion_items (item_code);
