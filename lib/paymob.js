import crypto from "node:crypto";
import { CURRENCY } from "./config.js";

const BASE = process.env.PAYMOB_BASE_URL || "https://accept.paymob.com";

export const gatewayEnabled = () =>
    Boolean(process.env.PAYMOB_SECRET_KEY && process.env.PAYMOB_PUBLIC_KEY && process.env.PAYMOB_INTEGRATION_ID);

async function request(url, options) {
    const res = await fetch(url, options);
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text }; }
    if (!res.ok) {
        const err = new Error(`Paymob ${res.status}`);
        err.details = body;
        throw err;
    }
    return body;
}

/**
 * Starts a monthly subscription. The customer is sent to Paymob's hosted page
 * where they type their card ONCE (3DS). Paymob then charges it every month.
 * Card details never touch this server.
 */
export async function createSubscriptionCheckout({ order, customer, planId, notificationUrl, redirectionUrl }) {
    if (!planId) {
        throw new Error(`No Paymob subscription plan id set for the "${order.plan}" plan (see .env).`);
    }

    const [first, ...rest] = customer.name.trim().split(/\s+/);
    const amountCents = (order.first_amount ?? order.monthly_amount) * 100;
    const na = "NA";

    const body = {
        amount: amountCents,
        currency: CURRENCY,
        payment_methods: [Number(process.env.PAYMOB_INTEGRATION_ID)],
        subscription_plan_id: Number(planId),
        // Lets the recurring amount follow this first payment (plan + domain fee).
        use_transaction_amount: order.domain_fee > 0,
        items: [{
            name: `ADAM WEB ${order.plan} plan (monthly)`,
            amount: amountCents,
            description: order.domain_fee > 0 ? `Plan + first-year domain ${order.domain} (part 1 of 2)` : "Website plan",
            quantity: 1
        }],
        billing_data: {
            first_name: first || na,
            last_name: rest.join(" ") || na,
            email: customer.email,
            phone_number: customer.phone,
            apartment: na, floor: na, street: na, building: na,
            shipping_method: na, postal_code: na, city: na, country: "EG", state: na
        },
        customer: { first_name: first || na, last_name: rest.join(" ") || na, email: customer.email },
        special_reference: order.ref,
        extras: { ref: order.ref },
        notification_url: notificationUrl,
        redirection_url: redirectionUrl
    };

    const data = await request(`${BASE}/v1/intention/`, {
        method: "POST",
        headers: { Authorization: `Token ${process.env.PAYMOB_SECRET_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify(body)
    });

    return {
        intentionId: String(data.id ?? ""),
        orderId: String(data.intention_order_id ?? ""),
        url: `${BASE}/unifiedcheckout/?publicKey=${encodeURIComponent(process.env.PAYMOB_PUBLIC_KEY)}&clientSecret=${encodeURIComponent(data.client_secret)}`
    };
}

/** Cancels a subscription on Paymob's side (stops future card charges). */
export async function cancelSubscription(subscriptionId) {
    if (!process.env.PAYMOB_API_KEY) throw new Error("PAYMOB_API_KEY is not set.");
    const auth = await request(`${BASE}/api/auth/tokens`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: process.env.PAYMOB_API_KEY })
    });
    return request(`${BASE}/api/acceptance/subscriptions/${encodeURIComponent(subscriptionId)}/cancel`, {
        method: "POST",
        headers: { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" }
    });
}

// Field order Paymob uses for the transaction-callback HMAC.
const HMAC_FIELDS = [
    "amount_cents", "created_at", "currency", "error_occured", "has_parent_transaction", "id",
    "integration_id", "is_3d_secure", "is_auth", "is_capture", "is_refunded", "is_standalone_payment",
    "is_voided", "order.id", "owner", "pending", "source_data.pan", "source_data.sub_type",
    "source_data.type", "success"
];

const pick = (obj, dotted) => dotted.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);

export function verifyHmac(obj, received) {
    const secret = process.env.PAYMOB_HMAC_SECRET;
    if (!secret || !received || !obj) return false;
    const message = HMAC_FIELDS.map(f => {
        const v = pick(obj, f);
        return v === undefined || v === null ? "" : String(v);
    }).join("");
    const expected = crypto.createHmac("sha512", secret).update(message).digest("hex");
    const a = Buffer.from(expected);
    const b = Buffer.from(String(received).toLowerCase());
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Asks Paymob directly for a transaction, so a callback can be trusted. */
export async function inquireTransaction(transactionId) {
    if (!process.env.PAYMOB_API_KEY) throw new Error("PAYMOB_API_KEY is not set.");
    const auth = await request(`${BASE}/api/auth/tokens`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: process.env.PAYMOB_API_KEY })
    });
    return request(`${BASE}/api/acceptance/transactions/${encodeURIComponent(transactionId)}`, {
        headers: { Authorization: `Bearer ${auth.token}` }
    });
}

/** After the domain is paid off, lower the recurring amount to the plain plan price. */
export async function updateSubscriptionAmount(subscriptionId, amountEgp) {
    if (!process.env.PAYMOB_API_KEY) throw new Error("PAYMOB_API_KEY is not set.");
    const auth = await request(`${BASE}/api/auth/tokens`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: process.env.PAYMOB_API_KEY })
    });
    return request(`${BASE}/api/acceptance/subscriptions/${encodeURIComponent(subscriptionId)}`, {
        method: "PUT",
        headers: { Authorization: `Bearer ${auth.token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ amount_cents: amountEgp * 100 })
    });
}
