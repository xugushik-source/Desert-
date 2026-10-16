-- Additive only. Prices/costs are integer currency minor units.
CREATE TABLE IF NOT EXISTS promotions(
 id TEXT PRIMARY KEY,vendor_id TEXT NOT NULL REFERENCES vendors(id),product_id TEXT NOT NULL REFERENCES products(id),
 kind TEXT NOT NULL CHECK(kind IN('DISCOUNT','GIFT')),titles TEXT NOT NULL,gift TEXT NOT NULL DEFAULT '{}',
 discount_bps INTEGER NOT NULL DEFAULT 0 CHECK(discount_bps BETWEEN 0 AND 9000),
 base_price INTEGER NOT NULL CHECK(base_price>=0),sale_price INTEGER NOT NULL CHECK(sale_price>=0),
 state TEXT NOT NULL DEFAULT 'PROPOSED' CHECK(state IN('PROPOSED','ACTIVE','STOPPED')),
 budget TEXT,created_by TEXT NOT NULL REFERENCES users(id),approved_by TEXT REFERENCES users(id),
 created_at TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_promotion ON promotions(product_id) WHERE state='ACTIVE';
CREATE INDEX IF NOT EXISTS promotions_vendor ON promotions(vendor_id,state);
CREATE TABLE IF NOT EXISTS settlements(
 order_id TEXT PRIMARY KEY REFERENCES orders(id),vendor_id TEXT NOT NULL REFERENCES vendors(id),
 revenue INTEGER NOT NULL CHECK(revenue>=0),expenses TEXT NOT NULL,total_expenses INTEGER NOT NULL CHECK(total_expenses>=0),
 net INTEGER NOT NULL,required_net INTEGER NOT NULL CHECK(required_net>=0),
 state TEXT NOT NULL CHECK(state IN('SHORTFALL','CLOSED')),evidence TEXT NOT NULL,
 actor TEXT NOT NULL REFERENCES users(id),at TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS settlement_vendor ON settlements(vendor_id,state);
