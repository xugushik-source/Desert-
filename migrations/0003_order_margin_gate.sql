CREATE TABLE IF NOT EXISTS vendor_terms(
 vendor_id TEXT PRIMARY KEY REFERENCES vendors(id),seller_payout_bps INTEGER NOT NULL CHECK(seller_payout_bps BETWEEN 0 AND 10000),
 expenses TEXT NOT NULL,evidence TEXT NOT NULL,actor TEXT NOT NULL REFERENCES users(id),at TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS order_pricing_checks(
 order_id TEXT PRIMARY KEY REFERENCES orders(id),vendor_id TEXT NOT NULL REFERENCES vendors(id),terms_version INTEGER NOT NULL,
 revenue INTEGER NOT NULL,expenses TEXT NOT NULL,net INTEGER NOT NULL,required_net INTEGER NOT NULL,
 CHECK(net>=required_net)
);
