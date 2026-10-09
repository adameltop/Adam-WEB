import "dotenv/config";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import helmet from "helmet";
import { rateLimit } from "express-rate-limit";

import { PLANS } from "./lib/config.js";
import { db, STATUSES } from "./lib/db.js";
import * as paymob from "./lib/paymob.js";
import * as domains from "./lib/domains.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, "");
const PROD = process.env.NODE_ENV === "production";

if (!process.env.ADMIN_PASSWORD || process.env.ADMIN_PASSWORD.length < 8) {
    console.error("Set ADMIN_PASSWORD (at least 8 characters) in .env before starting.");
    process.exit(1);
}
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
if (!process.env.SESSION_SECRET) console.warn("SESSION_SECRET not set: admin logins will reset on every restart.");

/* ───────── helpers ───────── */
const sha = v => crypto.createHash("sha256").update(String(v)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha(a), sha(b));
const sign = v => crypto.createHmac("sha256", SESSION_SECRET).update(v).digest("base64url");

function newRef() {
    const d = new Date();
    const stamp = String(d.getFullYear()).slice(2) + String(d.getMonth() + 1).padStart(2, "0") + String(d.getDate()).padStart(2, "0");
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let rand = "";
    for (const b of crypto.randomBytes(5)) rand += alphabet[b % alphabet.length];
    return `AW-${stamp}-${rand}`;
}

function normalizeDomain(raw) {
    return String(raw || "").trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
}
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

const clean = (v, max) => String(v ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, max);

/* ───────── app ───────── */
const app = express();
app.set("trust proxy", 1);
app.disable("x-powered-by");

const strictHelmet = helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'", "https://fonts.googleapis.com"],
            fontSrc: ["https://fonts.gstatic.com"],
            imgSrc: ["'self'", "data:"],
            connectSrc: ["'self'"],
            formAction: ["'self'"],
            frameAncestors: ["'none'"],
            upgradeInsecureRequests: PROD ? [] : null
        }
    }
});

// Your demo websites are static pages with their own code, so they get a relaxed policy.
const demoHelmet = helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false });

app.use((req, res, next) => (req.path.startsWith("/demos/") ? demoHelmet : strictHelmet)(req, res, next));

app.use(express.json({ limit: "20kb" }));

app.use(["/admin", "/api"], (req, res, next) => {
    res.set("X-Robots-Tag", "noindex, nofollow");
    res.set("Cache-Control", "no-store");
    next();
});

/* ───────── public API ───────── */
app.get("/api/config", (req, res) => {
    res.json({
        currency: "EGP",
        plans: Object.entries(PLANS).map(([key, p]) => ({ key, name: p.name, price: p.price })),
        domainPricing: domains.domainsEnabled(),
        domainParts: domains.DOMAIN_PARTS,
        gateway: paymob.gatewayEnabled()
    });
});

const quoteLimiter = rateLimit({ windowMs: 60 * 1000, limit: 8, standardHeaders: true, legacyHeaders: false,
    message: { error: "Too many domain checks. Wait a minute and try again." } });

app.post("/api/domain/quote", quoteLimiter, async (req, res) => {
    const domain = normalizeDomain(req.body?.domain);
    if (!domain || !DOMAIN_RE.test(domain)) return res.status(400).json({ error: "Enter a domain like yourbusiness.com." });
    if (!domains.domainsEnabled()) return res.json({ priced: false });
    try {
        const q = await domains.quoteDomain(domain);
        if (!q.available) return res.json({ priced: true, available: false, domain });
        res.json({ priced: true, available: true, domain, yearly: q.yearlyEgp, part: q.partEgp, parts: domains.DOMAIN_PARTS });
    } catch (err) {
        res.status(err.status || 500).json({ error: err.userMessage || "We couldn't check that domain right now." });
    }
});

const orderLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: true, legacyHeaders: false });

app.post("/api/orders", orderLimiter, async (req, res) => {
    const b = req.body || {};
    const errors = {};

    const plan = PLANS[b.plan];
    if (!plan) errors.plan = "Choose a plan.";

    const name = clean(b.name, 100);
    const phone = clean(b.phone, 30);
    const email = clean(b.email, 150).toLowerCase();
    const business = clean(b.business, 150);
    const notes = clean(b.notes, 1000);

    if (name.length < 2) errors.name = "Enter your full name.";
    if (phone.replace(/\D/g, "").length < 8) errors.phone = "Enter a phone number we can reach you on.";
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) errors.email = "Enter a valid email address, like name@example.com.";
    if (business.length < 2) errors.business = "Enter your business name.";

    let domain = normalizeDomain(b.domain);
    if (domain && !DOMAIN_RE.test(domain)) errors.domain = "Enter a domain like yourbusiness.com, or leave it empty.";

    if (Object.keys(errors).length) return res.status(400).json({ errors });

    // The server prices the domain itself. The browser's numbers are never trusted.
    let quote = null;
    if (domain && domains.domainsEnabled()) {
        try {
            quote = await domains.quoteDomain(domain);
            if (!quote.available) errors.domain = "That domain isn't available. Try another name or extension.";
        } catch (err) {
            errors.domain = err.userMessage || "We couldn't check that domain right now.";
        }
        if (Object.keys(errors).length) return res.status(400).json({ errors });
    }

    const part = quote ? quote.partEgp : 0;
    const monthly = plan.price;           // recurring price after the domain is paid off
    const first = plan.price + part;      // first DOMAIN_PARTS payments
    const ref = newRef();

    const created = db.transaction(() => {
        let customer = db.prepare("SELECT * FROM customers WHERE lower(email) = ? AND phone = ?").get(email, phone);
        if (customer) {
            db.prepare("UPDATE customers SET name = ?, business = ? WHERE id = ?").run(name, business, customer.id);
        } else {
            const r = db.prepare("INSERT INTO customers (name, phone, email, business) VALUES (?,?,?,?)").run(name, phone, email, business);
            customer = { id: r.lastInsertRowid, name, phone, email, business };
        }
        const r = db.prepare(`INSERT INTO orders (ref, customer_id, plan, plan_price, domain, domain_fee, monthly_amount, first_amount,
                                                  domain_year_cost, domain_usd_cents, domain_item_id, domain_status, customer_notes, status)
                              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,'in_progress')`).run(
            ref, customer.id, b.plan, plan.price, domain || null, part, monthly, first,
            quote ? quote.yearlyEgp : 0, quote?.usdCents ?? null, quote?.itemId ?? null, quote ? "pending" : "none", notes || null);
        return { customer, orderId: Number(r.lastInsertRowid) };
    })();

    // Nothing is charged here. You build the website first, then send the payment link.
    res.status(201).json({ ref, received: true });
});

app.get("/api/orders/:ref/status", (req, res) => {
    const row = db.prepare("SELECT status FROM orders WHERE ref = ?").get(req.params.ref);
    if (!row) return res.status(404).json({ error: "Order not found." });
    res.json({ status: row.status });
});

const logEvent = (kind, payload) => db.prepare("INSERT INTO events (kind, payload) VALUES (?, ?)").run(kind, JSON.stringify(payload));

/* ───────── payment link (sent by you when the website is finished) ───────── */
const payLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });

function orderForPayLink(ref, token) {
    const o = db.prepare("SELECT o.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.ref = ?").get(String(ref));
    if (!o || !o.pay_token || !safeEqual(String(token || ""), o.pay_token)) return null;
    return o;
}

app.get("/api/pay/:ref", payLimiter, (req, res) => {
    const o = orderForPayLink(req.params.ref, req.query.t);
    if (!o) return res.status(404).json({ error: "This payment link isn't valid." });
    res.json({
        status: o.status,
        name: o.customer_name,
        plan: PLANS[o.plan]?.name || o.plan,
        domain: o.domain,
        firstAmount: o.first_amount ?? o.monthly_amount,
        monthlyAmount: o.monthly_amount,
        domainFee: o.domain_fee,
        domainYearCost: o.domain_year_cost,
        parts: domains.DOMAIN_PARTS
    });
});

app.post("/api/pay/:ref", payLimiter, async (req, res) => {
    const o = orderForPayLink(req.params.ref, req.body?.t);
    if (!o) return res.status(404).json({ error: "This payment link isn't valid." });
    if (!["awaiting_payment", "payment_failed"].includes(o.status)) {
        return res.status(409).json({ error: o.status === "active" ? "This order is already paid." : "This order isn't ready for payment yet.", status: o.status });
    }
    if (!paymob.gatewayEnabled()) return res.status(503).json({ error: "Card payments aren't available right now. Please contact us." });

    try {
        const checkout = await paymob.createSubscriptionCheckout({
            order: o,
            customer: { name: o.customer_name, email: o.customer_email, phone: o.customer_phone },
            planId: PLANS[o.plan]?.paymobPlanId,
            notificationUrl: `${BASE_URL}/api/paymob/webhook?secret=${encodeURIComponent(process.env.PAYMOB_WEBHOOK_SECRET || "")}`,
            redirectionUrl: `${BASE_URL}/payment-result.html?ref=${o.ref}&t=${encodeURIComponent(o.pay_token)}`
        });
        db.prepare("UPDATE orders SET paymob_intention_id = ?, paymob_order_id = ? WHERE id = ?").run(checkout.intentionId, checkout.orderId, o.id);
        res.json({ checkoutUrl: checkout.url });
    } catch (err) {
        console.error("Paymob checkout failed:", err.message, err.details || "");
        logEvent("checkout_error", { ref: o.ref, message: err.message, details: err.details || null });
        res.status(502).json({ error: "We couldn't start the card payment. Please try again in a moment." });
    }
});

/* ───────── Paymob webhook ───────── */
const toBool = v => v === true || v === "true";

async function trustedTransaction(body, hmac) {
    const obj = body?.obj;
    if (!obj) return null;
    if (process.env.PAYMOB_HMAC_SECRET && hmac && paymob.verifyHmac(obj, hmac)) return obj;
    if (process.env.PAYMOB_API_KEY && obj.id) {
        try { return await paymob.inquireTransaction(obj.id); } catch (e) { console.error("Inquiry failed:", e.message); }
    }
    return null;
}

app.post("/api/paymob/webhook", async (req, res) => {
    const expected = process.env.PAYMOB_WEBHOOK_SECRET;
    if (!expected || !safeEqual(req.query.secret || "", expected)) return res.sendStatus(401);

    const body = req.body || {};
    const log = (kind) => db.prepare("INSERT INTO events (kind, payload) VALUES (?, ?)").run(kind, JSON.stringify(body).slice(0, 20000));

    const t = await trustedTransaction(body, req.query.hmac);
    if (!t) { log("webhook_unverified"); return res.sendStatus(401); }

    const claims = t.payment_key_claims || {};
    const subId = String(body.subscription_id ?? t.subscription_id ?? t.subscription?.id ?? "") || null;
    const ref = t.order?.merchant_order_id || claims.extra?.ref || claims.extra?.ref_number;

    const order =
        (ref && db.prepare("SELECT * FROM orders WHERE ref = ?").get(String(ref))) ||
        (t.order?.id && db.prepare("SELECT * FROM orders WHERE paymob_order_id = ?").get(String(t.order.id))) ||
        (subId && db.prepare("SELECT * FROM orders WHERE paymob_subscription_id = ?").get(subId));

    if (!order) { log("unmatched_transaction"); return res.sendStatus(200); }

    const success = toBool(t.success);
    const pending = toBool(t.pending);
    const src = t.source_data || {};

    const inserted = db.transaction(() => {
        const ins = db.prepare(`INSERT OR IGNORE INTO payments (order_id, txn_id, amount, success, pending, card_brand, card_last4)
                    VALUES (?,?,?,?,?,?,?)`).run(
            order.id, String(t.id), Math.round(Number(t.amount_cents || 0) / 100),
            success ? 1 : 0, pending ? 1 : 0, src.sub_type || null, src.pan ? String(src.pan).slice(-4) : null
        ).changes === 1;
        if (subId && !order.paymob_subscription_id) {
            db.prepare("UPDATE orders SET paymob_subscription_id = ? WHERE id = ?").run(subId, order.id);
        }
        if (t.order?.id && !order.paymob_order_id) {
            db.prepare("UPDATE orders SET paymob_order_id = ? WHERE id = ?").run(String(t.order.id), order.id);
        }
        if (order.status !== "cancelled" && !pending) {
            if (success) {
                db.prepare("UPDATE orders SET status = 'active', activated_at = COALESCE(activated_at, datetime('now')) WHERE id = ?").run(order.id);
            } else {
                db.prepare("UPDATE orders SET status = 'payment_failed' WHERE id = ?").run(order.id);
            }
        }
        return ins;
    })();

    log("transaction");
    res.sendStatus(200);

    // After answering Paymob: buy the domain / lower the amount when it's time.
    if (inserted && success && !pending) afterSuccessfulPayment(order.id).catch(e => console.error("afterSuccessfulPayment:", e));
});

/* ───────── after a successful payment ───────── */
async function buyDomain(orderId) {
    // Claim the purchase so it can only ever happen once per order.
    const claimed = db.prepare("UPDATE orders SET domain_status = 'purchasing', domain_error = NULL WHERE id = ? AND domain_status IN ('pending','failed')").run(orderId);
    if (claimed.changes !== 1) return { skipped: true };

    const o = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
    try {
        await domains.purchaseDomain({ domain: o.domain, itemId: o.domain_item_id });
        db.prepare("UPDATE orders SET domain_status = 'purchased', domain_purchased_at = datetime('now') WHERE id = ?").run(orderId);
        return { ok: true };
    } catch (err) {
        const msg = (err.details?.message || err.message || "Purchase failed").toString().slice(0, 300);
        console.error("Domain purchase failed:", o.ref, err.message, err.details || "");
        db.prepare("UPDATE orders SET domain_status = 'failed', domain_error = ? WHERE id = ?").run(msg, orderId);
        logEvent("domain_purchase_failed", { ref: o.ref, message: msg });
        return { error: msg };
    }
}

async function lowerAmount(orderId) {
    const o = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
    if (!o.paymob_subscription_id) { db.prepare("UPDATE orders SET amount_fix_pending = 1 WHERE id = ?").run(orderId); return { error: "No Paymob subscription id saved yet." }; }
    try {
        await paymob.updateSubscriptionAmount(o.paymob_subscription_id, o.monthly_amount);
        db.prepare("UPDATE orders SET amount_fix_pending = 0 WHERE id = ?").run(orderId);
        return { ok: true };
    } catch (err) {
        console.error("Amount update failed:", o.ref, err.message, err.details || "");
        db.prepare("UPDATE orders SET amount_fix_pending = 1 WHERE id = ?").run(orderId);
        logEvent("amount_update_failed", { ref: o.ref, message: err.message, details: err.details || null });
        return { error: "Paymob didn't accept the amount change." };
    }
}

async function afterSuccessfulPayment(orderId) {
    const o = db.prepare("SELECT * FROM orders WHERE id = ?").get(orderId);
    const paid = db.prepare("SELECT COUNT(*) n FROM payments WHERE order_id = ? AND success = 1").get(orderId).n;

    // First payment received: register the domain for one year.
    if (paid === 1 && o.domain_status === "pending" && process.env.AUTO_BUY_DOMAINS !== "false") {
        await buyDomain(orderId);
    }
    // Domain fully paid (2 parts): drop the recurring amount back to the plan price.
    if (paid === domains.DOMAIN_PARTS && o.domain_fee > 0) {
        await lowerAmount(orderId);
    }
}

/* ───────── admin auth ───────── */
const COOKIE = "adamweb_admin";

function readCookie(req, name) {
    const header = req.headers.cookie || "";
    for (const part of header.split(";")) {
        const [k, ...v] = part.trim().split("=");
        if (k === name) return v.join("=");
    }
    return null;
}

function isAdmin(req) {
    const token = readCookie(req, COOKIE);
    if (!token) return false;
    const [exp, sig] = token.split(".");
    if (!exp || !sig || Number(exp) < Date.now()) return false;
    return safeEqual(sig, sign(exp));
}

const requireAdmin = (req, res, next) => (isAdmin(req) ? next() : res.status(401).json({ error: "Not signed in." }));

const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false,
    message: { error: "Too many attempts. Try again in 15 minutes." } });

app.post("/api/admin/login", loginLimiter, (req, res) => {
    if (!safeEqual(req.body?.password || "", process.env.ADMIN_PASSWORD)) {
        return res.status(401).json({ error: "Wrong password." });
    }
    const exp = String(Date.now() + 12 * 60 * 60 * 1000);
    res.cookie(COOKIE, `${exp}.${sign(exp)}`, { httpOnly: true, sameSite: "strict", secure: PROD, maxAge: 12 * 60 * 60 * 1000, path: "/" });
    res.json({ ok: true });
});

app.post("/api/admin/logout", (req, res) => {
    res.clearCookie(COOKIE, { path: "/" });
    res.json({ ok: true });
});

app.get("/api/admin/me", requireAdmin, (req, res) => res.json({ ok: true }));

/* ───────── admin data ───────── */
const ORDER_SELECT = `
    SELECT o.*, c.name AS customer_name, c.email AS customer_email, c.phone AS customer_phone, c.business AS customer_business,
           (SELECT COALESCE(SUM(amount),0) FROM payments p WHERE p.order_id = o.id AND p.success = 1) AS total_paid,
           (SELECT COUNT(*) FROM payments p WHERE p.order_id = o.id AND p.success = 1) AS payments_count
    FROM orders o JOIN customers c ON c.id = o.customer_id`;

app.get("/api/admin/stats", requireAdmin, (req, res) => {
    const count = s => db.prepare("SELECT COUNT(*) n FROM orders WHERE status = ?").get(s).n;
    res.json({
        active: count("active"),
        in_progress: count("in_progress"),
        awaiting_payment: count("awaiting_payment"),
        payment_failed: count("payment_failed"),
        cancelled: count("cancelled"),
        mrr: db.prepare("SELECT COALESCE(SUM(monthly_amount),0) n FROM orders WHERE status = 'active'").get().n,
        collected: db.prepare("SELECT COALESCE(SUM(amount),0) n FROM payments WHERE success = 1").get().n,
        customers: db.prepare("SELECT COUNT(*) n FROM customers").get().n,
        domain_issues: db.prepare("SELECT COUNT(*) n FROM orders WHERE (domain_status = 'failed' OR amount_fix_pending = 1) AND status != 'cancelled'").get().n,
        unmatched: db.prepare("SELECT COUNT(*) n FROM events WHERE kind IN ('unmatched_transaction','webhook_unverified')").get().n,
        gateway: paymob.gatewayEnabled()
    });
});

app.get("/api/admin/orders", requireAdmin, (req, res) => {
    const where = [];
    const args = [];
    if (STATUSES.includes(req.query.status)) { where.push("o.status = ?"); args.push(req.query.status); }
    const q = clean(req.query.q, 100).toLowerCase();
    if (q) {
        where.push("(lower(c.name) LIKE ? OR lower(c.email) LIKE ? OR c.phone LIKE ? OR lower(c.business) LIKE ? OR lower(o.ref) LIKE ? OR lower(COALESCE(o.domain,'')) LIKE ?)");
        const like = `%${q}%`;
        args.push(like, like, like, like, like, like);
    }
    const sql = `${ORDER_SELECT} ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY o.id DESC LIMIT 500`;
    res.json(db.prepare(sql).all(...args));
});

app.get("/api/admin/orders/:id", requireAdmin, (req, res) => {
    const order = db.prepare(`${ORDER_SELECT} WHERE o.id = ?`).get(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found." });
    const payments = db.prepare("SELECT * FROM payments WHERE order_id = ? ORDER BY id DESC").all(order.id);
    res.json({ order, payments });
});

app.patch("/api/admin/orders/:id", requireAdmin, (req, res) => {
    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found." });
    const b = req.body || {};

    if (b.status !== undefined) {
        if (!STATUSES.includes(b.status)) return res.status(400).json({ error: "Unknown status." });
        db.prepare(`UPDATE orders SET status = ?, cancelled_at = CASE WHEN ? = 'cancelled' THEN COALESCE(cancelled_at, datetime('now')) ELSE NULL END WHERE id = ?`)
            .run(b.status, b.status, order.id);
    }
    if (b.admin_notes !== undefined) {
        db.prepare("UPDATE orders SET admin_notes = ? WHERE id = ?").run(clean(b.admin_notes, 2000) || null, order.id);
    }
    res.json({ ok: true });
});

app.post("/api/admin/orders/:id/cancel", requireAdmin, async (req, res) => {
    const order = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
    if (!order) return res.status(404).json({ error: "Order not found." });

    if (order.paymob_subscription_id) {
        try {
            await paymob.cancelSubscription(order.paymob_subscription_id);
        } catch (err) {
            console.error("Paymob cancel failed:", err.message, err.details || "");
            return res.status(502).json({
                error: "Paymob did not cancel the subscription. Cancel it in your Paymob dashboard, then set the status to Cancelled here."
            });
        }
    }
    db.prepare("UPDATE orders SET status = 'cancelled', cancelled_at = COALESCE(cancelled_at, datetime('now')) WHERE id = ?").run(order.id);
    res.json({ ok: true, paymob: Boolean(order.paymob_subscription_id) });
});

app.post("/api/admin/orders/:id/request-payment", requireAdmin, async (req, res) => {
    const o = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
    if (!o) return res.status(404).json({ error: "Order not found." });
    if (!["in_progress", "awaiting_payment", "payment_failed"].includes(o.status)) {
        return res.status(400).json({ error: "This order can't be sent for payment from its current status." });
    }
    if (!paymob.gatewayEnabled()) return res.status(400).json({ error: "Paymob isn't configured yet, so there's nothing to pay with." });

    // Re-check the domain right now: it may have been taken, or its price may have changed.
    if (o.domain && o.domain_status === "pending" && domains.domainsEnabled()) {
        try {
            const q = await domains.quoteDomain(o.domain, { fresh: true });
            if (!q.available) return res.status(409).json({ error: `${o.domain} is no longer available. Ask the customer for another domain.` });
            db.prepare("UPDATE orders SET domain_year_cost = ?, domain_fee = ?, first_amount = ?, domain_usd_cents = ?, domain_item_id = ? WHERE id = ?")
                .run(q.yearlyEgp, q.partEgp, o.plan_price + q.partEgp, q.usdCents ?? null, q.itemId, o.id);
        } catch (err) {
            return res.status(502).json({ error: (err.userMessage || "Couldn't re-check the domain price.") + " Try again in a minute." });
        }
    }

    const token = o.pay_token || crypto.randomBytes(24).toString("base64url");
    db.prepare("UPDATE orders SET pay_token = ?, pay_requested_at = COALESCE(pay_requested_at, datetime('now')), status = CASE WHEN status = 'in_progress' THEN 'awaiting_payment' ELSE status END WHERE id = ?").run(token, o.id);

    const fresh = db.prepare("SELECT first_amount, monthly_amount, domain_fee FROM orders WHERE id = ?").get(o.id);
    res.json({
        link: `${BASE_URL}/pay.html?ref=${o.ref}&t=${token}`,
        firstAmount: fresh.first_amount,
        monthlyAmount: fresh.monthly_amount,
        domainFee: fresh.domain_fee,
        parts: domains.DOMAIN_PARTS
    });
});

app.post("/api/admin/orders/:id/buy-domain", requireAdmin, async (req, res) => {
    const o = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
    if (!o) return res.status(404).json({ error: "Order not found." });
    if (!domains.domainsEnabled()) return res.status(400).json({ error: "Hostinger isn't configured." });
    if (!["pending", "failed"].includes(o.domain_status)) return res.status(400).json({ error: "This domain was already handled." });
    const hasPaid = db.prepare("SELECT COUNT(*) n FROM payments WHERE order_id = ? AND success = 1").get(o.id).n > 0;
    if (!hasPaid) return res.status(400).json({ error: "The customer hasn't paid yet." });
    const r = await buyDomain(o.id);
    if (r.error) return res.status(502).json({ error: "Hostinger didn't register the domain: " + r.error });
    res.json({ ok: true });
});

app.post("/api/admin/orders/:id/fix-amount", requireAdmin, async (req, res) => {
    const o = db.prepare("SELECT * FROM orders WHERE id = ?").get(req.params.id);
    if (!o) return res.status(404).json({ error: "Order not found." });
    const r = await lowerAmount(o.id);
    if (r.error) return res.status(502).json({ error: r.error + " Change the amount in your Paymob dashboard, then it's done." });
    res.json({ ok: true });
});

app.get("/api/admin/customers", requireAdmin, (req, res) => {
    res.json(db.prepare(`
        SELECT c.*,
               COUNT(o.id) AS orders_count,
               COALESCE(SUM(CASE WHEN o.status = 'active' THEN o.monthly_amount END), 0) AS monthly_active,
               COALESCE((SELECT SUM(p.amount) FROM payments p JOIN orders oo ON oo.id = p.order_id WHERE oo.customer_id = c.id AND p.success = 1), 0) AS total_paid
        FROM customers c LEFT JOIN orders o ON o.customer_id = c.id
        GROUP BY c.id ORDER BY c.id DESC LIMIT 500`).all());
});

app.get("/api/admin/export.csv", requireAdmin, (req, res) => {
    const rows = db.prepare(`${ORDER_SELECT} ORDER BY o.id DESC`).all();
    const cols = ["ref", "created_at", "status", "customer_name", "customer_business", "customer_email", "customer_phone",
        "plan", "plan_price", "domain", "domain_status", "domain_year_cost", "domain_fee", "first_amount", "monthly_amount", "total_paid", "payments_count", "activated_at", "cancelled_at", "customer_notes", "admin_notes"];
    // Prefix risky cells so spreadsheets don't run them as formulas.
    const cell = v => {
        let s = v == null ? "" : String(v);
        if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
        return `"${s.replace(/"/g, '""')}"`;
    };
    const csv = [cols.join(","), ...rows.map(r => cols.map(c => cell(r[c])).join(","))].join("\r\n");
    res.set("Content-Type", "text/csv; charset=utf-8");
    res.set("Content-Disposition", `attachment; filename="adamweb-orders-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send("\ufeff" + csv);
});

app.use("/api", (req, res) => res.status(404).json({ error: "Not found." }));

/* ───────── site ───────── */
// Demo websites: put them in ./demos or ./public/demos. Both work.
app.use("/demos", express.static(path.join(__dirname, "demos"), { extensions: ["html"] }));
app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));

app.listen(PORT, () => {
    console.log(`ADAM WEB running on ${BASE_URL}`);
    console.log(paymob.gatewayEnabled()
        ? "Card payments: Paymob is configured."
        : "Card payments: NOT configured yet. Orders are saved and shown in /admin, but no card is charged.");
    console.log(`Admin dashboard: ${BASE_URL}/admin/`);
});
