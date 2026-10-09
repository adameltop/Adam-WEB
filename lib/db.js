import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

const file = process.env.DB_PATH || "data/adamweb.db";
fs.mkdirSync(path.dirname(file), { recursive: true });

export const db = new Database(file);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// NOTE: card numbers are never stored here. Cards are entered on Paymob's
// secure page; we only keep the brand and last 4 digits Paymob reports back.
db.exec(`
CREATE TABLE IF NOT EXISTS customers (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    phone       TEXT NOT NULL,
    email       TEXT NOT NULL,
    business    TEXT NOT NULL,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS orders (
    id                     INTEGER PRIMARY KEY AUTOINCREMENT,
    ref                    TEXT NOT NULL UNIQUE,
    customer_id            INTEGER NOT NULL REFERENCES customers(id),
    plan                   TEXT NOT NULL,
    plan_price             INTEGER NOT NULL,
    domain                 TEXT,
    domain_fee             INTEGER NOT NULL DEFAULT 0,
    monthly_amount         INTEGER NOT NULL,
    status                 TEXT NOT NULL DEFAULT 'awaiting_payment',
    customer_notes         TEXT,
    admin_notes            TEXT,
    paymob_intention_id    TEXT,
    paymob_order_id        TEXT,
    paymob_subscription_id TEXT,
    created_at             TEXT NOT NULL DEFAULT (datetime('now')),
    activated_at           TEXT,
    cancelled_at           TEXT
);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE INDEX IF NOT EXISTS idx_orders_paymob_order ON orders(paymob_order_id);

CREATE TABLE IF NOT EXISTS payments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id    INTEGER NOT NULL REFERENCES orders(id),
    txn_id      TEXT NOT NULL UNIQUE,
    amount      INTEGER NOT NULL,      -- EGP
    success     INTEGER NOT NULL,
    pending     INTEGER NOT NULL DEFAULT 0,
    card_brand  TEXT,
    card_last4  TEXT,
    paid_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    kind        TEXT NOT NULL,
    payload     TEXT NOT NULL,
    received_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

export const STATUSES = ["in_progress", "awaiting_payment", "active", "payment_failed", "cancelled"];

// Add columns introduced after the first version (safe to run every start).
function addColumn(table, column, definition) {
    const has = db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column);
    if (!has) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
}
addColumn("orders", "first_amount", "INTEGER");
addColumn("orders", "domain_year_cost", "INTEGER NOT NULL DEFAULT 0");   // EGP, one year
addColumn("orders", "domain_usd_cents", "INTEGER");
addColumn("orders", "domain_item_id", "TEXT");
addColumn("orders", "domain_status", "TEXT NOT NULL DEFAULT 'none'");    // none | pending | purchasing | purchased | failed
addColumn("orders", "domain_error", "TEXT");
addColumn("orders", "domain_purchased_at", "TEXT");
addColumn("orders", "amount_fix_pending", "INTEGER NOT NULL DEFAULT 0");
addColumn("orders", "pay_token", "TEXT");
addColumn("orders", "pay_requested_at", "TEXT");
