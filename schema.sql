-- Clutch D1 Database Schema
-- Run once via: wrangler d1 execute clutch-db --file=schema.sql

CREATE TABLE IF NOT EXISTS prices (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  device_type TEXT NOT NULL,   -- 'iphone', 'ipad', 'macbook', 'samsung', 'console', 'watch', 'airpods'
  brand       TEXT NOT NULL,   -- 'Apple', 'Samsung', 'Sony', 'Microsoft', 'Nintendo'
  model       TEXT NOT NULL,   -- 'iPhone 15 Pro', 'Galaxy S24', 'PS5', etc.
  storage     TEXT,            -- '128GB', '256GB', '512GB', '1TB' — NULL for consoles/watches
  condition   TEXT NOT NULL,   -- 'Excellent', 'Good', 'Fair'
  sellcell_price  INTEGER,     -- payout in cents, NULL if not found
  backmarket_price INTEGER,    -- payout in cents, NULL if not found
  offer_price INTEGER NOT NULL, -- the lower of the two (what we offer), in cents
  updated_at  TEXT NOT NULL    -- ISO timestamp of last scrape
);

CREATE INDEX IF NOT EXISTS idx_prices_lookup
  ON prices (device_type, model, storage, condition);

-- Leads table (mirrors the artifact db, backup copy)
CREATE TABLE IF NOT EXISTS leads (
  id         TEXT PRIMARY KEY,
  name       TEXT,
  email      TEXT,
  phone      TEXT,
  device     TEXT,
  condition  TEXT,
  notes      TEXT,
  status     TEXT DEFAULT 'New',
  created_at TEXT
);

-- Config / meta
CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT
);

INSERT OR IGNORE INTO config (key, value) VALUES ('last_scrape', NULL);
INSERT OR IGNORE INTO config (key, value) VALUES ('min_payout_cents', '5000'); -- $50 minimum
