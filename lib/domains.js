// Domain price check (Hostinger API) and automatic purchase.
// Prices are shown/charged in EGP; Hostinger lists them in USD cents, so
// USD_EGP_RATE (set in .env) converts them.

const BASE = (process.env.HOSTINGER_BASE_URL || "https://developers.hostinger.com").replace(/\/$/, "");

/** How many monthly payments the first-year domain price is split across. */
export const DOMAIN_PARTS = 2;

export const domainsEnabled = () =>
    Boolean(process.env.HOSTINGER_API_TOKEN && Number(process.env.USD_EGP_RATE) > 0);

async function hostinger(path, { method = "GET", body } = {}) {
    const res = await fetch(BASE + path, {
        method,
        headers: {
            Authorization: `Bearer ${process.env.HOSTINGER_API_TOKEN}`,
            Accept: "application/json",
            "Content-Type": "application/json"
        },
        body: body ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    if (!res.ok) {
        const err = new Error(`Hostinger ${res.status}`);
        err.status = res.status;
        err.details = data;
        throw err;
    }
    return data;
}

/* ───────── price list (cached: Hostinger rate-limits availability checks) ───────── */
let catalogCache = { at: 0, items: [] };

async function catalog() {
    if (Date.now() - catalogCache.at < 6 * 60 * 60 * 1000 && catalogCache.items.length) return catalogCache.items;
    const data = await hostinger("/api/billing/v1/catalog?category=DOMAIN");
    const items = Array.isArray(data) ? data : data.data || [];
    catalogCache = { at: Date.now(), items };
    return items;
}

/** One-year price for an extension, in USD cents, plus the catalog item id. */
async function yearPrice(tld) {
    const slug = tld.replace(/\./g, "-");
    const wanted = new RegExp(`domain-${slug}-[a-z]{3}-1y$`, "i");
    for (const item of await catalog()) {
        for (const p of item.prices || []) {
            if (wanted.test(String(p.id || ""))) {
                const cents = Number(p.first_period_price ?? p.price);
                const currency = String(p.currency || "USD").toUpperCase();
                if (Number.isFinite(cents) && cents > 0) return { itemId: p.id, cents, currency };
            }
        }
    }
    return null;
}

/* ───────── quote ───────── */
const quoteCache = new Map();

function splitDomain(domain) {
    const i = domain.indexOf(".");
    return { name: domain.slice(0, i), tld: domain.slice(i + 1) };
}

/**
 * Is the domain free, and what does one year cost?
 * Returns { available, domain, tld, itemId, usdCents, yearlyEgp, partEgp }
 * or throws an Error with .userMessage for the customer.
 */
export async function quoteDomain(domain, { fresh = false } = {}) {
    const cached = quoteCache.get(domain);
    if (!fresh && cached && Date.now() - cached.at < 5 * 60 * 1000) return cached.quote;

    const { name, tld } = splitDomain(domain);
    const fail = (userMessage, status = 400) => Object.assign(new Error(userMessage), { userMessage, status });

    let availability;
    try {
        availability = await hostinger("/api/domains/v1/availability", {
            method: "POST",
            body: { domain: name, tlds: [tld], with_alternatives: false }
        });
    } catch (err) {
        if (err.status === 429) throw fail("Lots of people are checking domains right now. Try again in a minute.", 429);
        console.error("Hostinger availability failed:", err.message, err.details || "");
        throw fail("We couldn't check that domain right now. Try again shortly.", 503);
    }

    const list = Array.isArray(availability) ? availability : availability.data || [];
    const entry = list.find(r => String(r.domain).toLowerCase() === domain);
    if (!entry) throw fail(`We can't check .${tld} domains automatically. Leave the field empty and I'll arrange it with you.`);

    if (!entry.is_available) {
        const quote = { available: false, domain, tld };
        quoteCache.set(domain, { at: Date.now(), quote });
        return quote;
    }

    let price;
    try { price = await yearPrice(tld); } catch (err) {
        console.error("Hostinger catalog failed:", err.message, err.details || "");
        throw fail("We couldn't get the domain price right now. Try again shortly.", 503);
    }
    if (!price) throw fail(`We can't price .${tld} domains automatically. Leave the field empty and I'll arrange it with you.`);

    let egp;
    if (price.currency === "EGP") egp = price.cents / 100;
    else if (price.currency === "USD") egp = (price.cents / 100) * Number(process.env.USD_EGP_RATE);
    else throw fail("We can't price that domain automatically.");

    const markup = Number(process.env.DOMAIN_MARKUP_PERCENT || 0);
    const yearlyEgp = Math.ceil(egp * (1 + markup / 100));
    const maxUsd = Number(process.env.MAX_DOMAIN_USD || 50);
    if (price.currency === "USD" && price.cents / 100 > maxUsd) {
        throw fail("That domain is too expensive to order automatically. Leave the field empty and I'll arrange it with you.");
    }

    const quote = {
        available: true,
        domain,
        tld,
        itemId: price.itemId,
        usdCents: price.currency === "USD" ? price.cents : null,
        yearlyEgp,
        partEgp: Math.ceil(yearlyEgp / DOMAIN_PARTS)
    };
    quoteCache.set(domain, { at: Date.now(), quote });
    return quote;
}

/* ───────── buy ───────── */
export async function purchaseDomain({ domain, itemId }) {
    const body = { domain, item_id: itemId };
    if (process.env.HOSTINGER_PAYMENT_METHOD_ID) body.payment_method_id = Number(process.env.HOSTINGER_PAYMENT_METHOD_ID);
    return hostinger("/api/domains/v1/portfolio", { method: "POST", body });
}
