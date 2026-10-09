const $ = id => document.getElementById(id);

const STATUS_LABEL = {
    in_progress: "In progress",
    active: "Active",
    awaiting_payment: "Waiting for payment",
    payment_failed: "Payment failed",
    cancelled: "Cancelled"
};

const DOMAIN_LABEL = {
    none: "Not ordered",
    pending: "Will be bought after the first payment",
    purchasing: "Buying…",
    purchased: "Registered",
    failed: "Purchase failed"
};

const fmt = n => "EGP " + Number(n || 0).toLocaleString("en-US");
const date = s => (s ? new Date(s.replace(" ", "T") + "Z").toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" }) : "—");

/* Everything below uses textContent: customer input is never trusted as HTML. */
function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    Object.entries(props).forEach(([k, v]) => {
        if (k === "class") node.className = v;
        else if (k === "text") node.textContent = v;
        else node.setAttribute(k, v);
    });
    node.append(...children.filter(c => c != null));
    return node;
}

const badge = status => el("span", { class: `badge ${status}`, text: STATUS_LABEL[status] || status });

async function api(path, options = {}) {
    const res = await fetch(path, {
        ...options,
        headers: { "Content-Type": "application/json", ...(options.headers || {}) },
        body: options.body ? JSON.stringify(options.body) : undefined
    });
    if (res.status === 401 && !path.includes("/login")) { showLogin(); throw new Error("signed-out"); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || "Something went wrong."), { data });
    return data;
}

/* ───────── views ───────── */
function showLogin() {
    $("appView").hidden = true;
    $("drawer").hidden = true;
    $("loginView").hidden = false;
    $("password").focus();
}

async function showApp() {
    $("loginView").hidden = true;
    $("appView").hidden = false;
    await Promise.all([loadStats(), loadOrders(), loadCustomers()]);
}

$("loginForm").addEventListener("submit", async e => {
    e.preventDefault();
    $("loginError").textContent = "";
    try {
        await api("/api/admin/login", { method: "POST", body: { password: $("password").value } });
        $("password").value = "";
        showApp();
    } catch (err) {
        $("loginError").textContent = err.message;
    }
});

$("logoutBtn").addEventListener("click", async () => {
    await api("/api/admin/logout", { method: "POST" }).catch(() => {});
    showLogin();
});

document.querySelectorAll(".tab").forEach(tab => tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach(t => {
        t.classList.toggle("active", t === tab);
        t.setAttribute("aria-selected", String(t === tab));
    });
    $("ordersTab").hidden = tab.dataset.tab !== "orders";
    $("customersTab").hidden = tab.dataset.tab !== "customers";
}));

/* ───────── stats ───────── */
async function loadStats() {
    const s = await api("/api/admin/stats");
    const items = [
        [fmt(s.mrr), "Monthly recurring revenue"],
        [s.active, "Active subscriptions"],
        [s.in_progress, "In progress (not charged yet)"],
        [s.awaiting_payment, "Waiting for payment"],
        [s.payment_failed, "Payment failed"],
        [fmt(s.collected), "Collected so far"],
        [s.customers, "Customers"]
    ];
    $("stats").replaceChildren(...items.map(([value, label]) =>
        el("div", { class: "stat" }, el("strong", { text: String(value) }), el("span", { text: label }))));

    $("domainNotice").hidden = !s.domain_issues;
    if (s.domain_issues) $("domainNotice").textContent =
        `${s.domain_issues} order(s) need attention: a domain purchase failed or a subscription amount wasn't lowered. Open the order to fix it.`;

    $("gatewayNotice").hidden = s.gateway;
    $("unmatchedNotice").hidden = !s.unmatched;
    if (s.unmatched) $("unmatchedNotice").textContent =
        `${s.unmatched} payment notification(s) from Paymob couldn't be matched or verified. Check them in your Paymob dashboard.`;
}

/* ───────── orders ───────── */
let searchTimer;
$("search").addEventListener("input", () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadOrders, 250); });
$("statusFilter").addEventListener("change", loadOrders);

async function loadOrders() {
    const params = new URLSearchParams();
    if ($("search").value.trim()) params.set("q", $("search").value.trim());
    if ($("statusFilter").value) params.set("status", $("statusFilter").value);

    const rows = await api("/api/admin/orders?" + params);
    $("ordersEmpty").hidden = rows.length > 0;
    $("ordersEmpty").textContent = $("search").value || $("statusFilter").value
        ? "No orders match this search."
        : "No orders yet. They'll appear here as soon as someone checks out.";

    $("ordersBody").replaceChildren(...rows.map(o => {
        const tr = el("tr", { class: "click", tabindex: "0" },
            el("td", {}, el("strong", { text: o.customer_name }), el("small", { text: o.customer_business }), el("small", { text: o.ref })),
            el("td", { text: o.plan[0].toUpperCase() + o.plan.slice(1) }),
            el("td", {}, document.createTextNode(o.domain || "—"),
                o.domain ? el("small", { text: DOMAIN_LABEL[o.domain_status] || o.domain_status }) : null),
            el("td", { class: "num", text: fmt(o.monthly_amount) }),
            el("td", { class: "num", text: fmt(o.total_paid) }),
            el("td", {}, badge(o.status)),
            el("td", { text: date(o.created_at) }));
        tr.addEventListener("click", () => openOrder(o.id));
        tr.addEventListener("keydown", e => { if (e.key === "Enter") openOrder(o.id); });
        return tr;
    }));
}

/* ───────── customers ───────── */
async function loadCustomers() {
    const rows = await api("/api/admin/customers");
    $("customersEmpty").hidden = rows.length > 0;
    $("customersBody").replaceChildren(...rows.map(c => el("tr", {},
        el("td", {}, el("strong", { text: c.name }), el("small", { text: c.email })),
        el("td", { text: c.business }),
        el("td", { text: c.phone }),
        el("td", { class: "num", text: String(c.orders_count) }),
        el("td", { class: "num", text: fmt(c.monthly_active) }),
        el("td", { class: "num", text: fmt(c.total_paid) }))));
}


/* ───────── payment link ───────── */
function whatsappNumber(phone) {
    let d = phone.replace(/\D/g, "");
    if (d.startsWith("00")) d = d.slice(2);
    else if (d.startsWith("0")) d = "20" + d.slice(1);   // Egyptian local number
    return d;
}

function paymentMessage(o, info) {
    const money = fmt(info.firstAmount);
    const terms = info.domainFee > 0
        ? `${money} a month for the first ${info.parts} months (your domain is included), then ${fmt(info.monthlyAmount)} a month`
        : `${fmt(info.monthlyAmount)} a month`;
    return `Hi ${o.customer_name}, your website is ready! To start your plan (${terms}), pay securely by card here: ${info.link}`;
}

function paymentPanel(o, info) {
    const text = paymentMessage(o, info);
    const input = el("input", { type: "text", readonly: "readonly", "aria-label": "Payment link", value: info.link });
    input.className = "link-input";

    const copy = el("button", { class: "btn", type: "button", text: "Copy link" });
    copy.addEventListener("click", async () => {
        try { await navigator.clipboard.writeText(info.link); copy.textContent = "Copied"; }
        catch { input.select(); copy.textContent = "Select and copy"; }
    });

    const wa = el("a", { class: "btn", target: "_blank", rel: "noopener", text: "Send on WhatsApp",
        href: `https://wa.me/${whatsappNumber(o.customer_phone)}?text=${encodeURIComponent(text)}` });
    const mail = el("a", { class: "btn", text: "Send by email",
        href: `mailto:${o.customer_email}?subject=${encodeURIComponent("Your website is ready")}&body=${encodeURIComponent(text)}` });

    return el("div", { class: "pay-panel" },
        el("p", { text: "Payment link ready. The customer is charged only when they pay it." }),
        input,
        el("div", { class: "row" }, copy, wa, mail));
}

/* ───────── order drawer ───────── */
function kv(rows) {
    return el("dl", { class: "kv" }, ...rows.filter(Boolean).map(([k, v]) =>
        el("div", {}, el("dt", { text: k }), el("dd", {}, v instanceof Node ? v : document.createTextNode(v)))));
}

async function openOrder(id) {
    const { order: o, payments } = await api("/api/admin/orders/" + id);

    const status = el("select", { id: "statusSelect", "aria-label": "Status" },
        ...Object.entries(STATUS_LABEL).map(([v, l]) => {
            const opt = el("option", { value: v, text: l });
            if (v === o.status) opt.selected = true;
            return opt;
        }));
    const notes = el("textarea", { id: "adminNotes", "aria-label": "Private notes", placeholder: "Private notes, only you can see these" });
    notes.value = o.admin_notes || "";
    const msg = el("p", { class: "msg", role: "status" });

    const flash = (text, bad = false) => { msg.textContent = text; msg.className = "msg" + (bad ? " bad" : ""); };

    const save = el("button", { class: "btn primary", type: "button", text: "Save changes" });
    save.addEventListener("click", async () => {
        try {
            await api("/api/admin/orders/" + id, { method: "PATCH", body: { status: status.value, admin_notes: notes.value } });
            flash("Saved.");
            loadOrders(); loadStats(); loadCustomers();
        } catch (e) { flash(e.message, true); }
    });

    const buttons = [save];
    const panelSlot = el("div", {});

    if (["in_progress", "awaiting_payment", "payment_failed"].includes(o.status)) {
        const finished = el("button", { class: "btn primary", type: "button",
            text: o.status === "in_progress" ? "Website finished: get payment link" : "Show payment link" });
        finished.addEventListener("click", async () => {
            if (o.status === "in_progress" && !confirm("Is the website finished? This makes the payment link live so the customer can pay and monthly billing can start.")) return;
            finished.disabled = true;
            try {
                const info = await api(`/api/admin/orders/${id}/request-payment`, { method: "POST" });
                panelSlot.replaceChildren(paymentPanel(o, info));
                flash("");
                loadOrders(); loadStats();
            } catch (e) { flash(e.message, true); }
            finished.disabled = false;
        });
        buttons.unshift(finished);
    }

    if (["pending", "failed"].includes(o.domain_status) && o.payments_count > 0) {
        const buy = el("button", { class: "btn", type: "button", text: "Buy domain now" });
        buy.addEventListener("click", async () => {
            if (!confirm(`Register ${o.domain} on Hostinger now? This spends money and can't be undone.`)) return;
            buy.disabled = true;
            try {
                await api(`/api/admin/orders/${id}/buy-domain`, { method: "POST" });
                openOrder(id); loadOrders(); loadStats();
            } catch (e) { flash(e.message, true); buy.disabled = false; }
        });
        buttons.push(buy);
    }

    if (o.amount_fix_pending) {
        const fix = el("button", { class: "btn", type: "button", text: "Retry lowering the monthly amount" });
        fix.addEventListener("click", async () => {
            fix.disabled = true;
            try {
                await api(`/api/admin/orders/${id}/fix-amount`, { method: "POST" });
                openOrder(id); loadOrders(); loadStats();
            } catch (e) { flash(e.message, true); fix.disabled = false; }
        });
        buttons.push(fix);
    }
    if (o.status !== "cancelled") {
        const cancel = el("button", { class: "btn danger", type: "button", text: "Cancel subscription" });
        cancel.addEventListener("click", async () => {
            if (!confirm("Stop future monthly charges for this customer?")) return;
            try {
                await api(`/api/admin/orders/${id}/cancel`, { method: "POST" });
                openOrder(id); loadOrders(); loadStats(); loadCustomers();
            } catch (e) { flash(e.message, true); }
        });
        buttons.push(cancel);
    }

    const payRows = payments.length
        ? payments.map(p => [
            date(p.paid_at),
            `${fmt(p.amount)} · ${p.pending ? "Pending" : p.success ? "Paid" : "Failed"}${p.card_last4 ? " · •••• " + p.card_last4 : ""}`
        ])
        : [["—", "No payments yet"]];

    const body = [
        el("p", { class: "sub", text: o.ref }),
        el("h2", { text: o.customer_name }),
        el("p", { class: "sub" }, badge(o.status)),

        el("h3", { text: "Customer" }),
        kv([
            ["Business", o.customer_business],
            ["Email", el("a", { href: "mailto:" + o.customer_email, text: o.customer_email })],
            ["Phone", el("a", { href: "tel:" + o.customer_phone, text: o.customer_phone })]
        ]),

        el("h3", { text: "Subscription" }),
        kv([
            ["Plan", `${o.plan[0].toUpperCase() + o.plan.slice(1)} · ${fmt(o.plan_price)}`],
            o.domain ? ["Domain", o.domain] : null,
            o.domain ? ["Domain status", DOMAIN_LABEL[o.domain_status] || o.domain_status] : null,
            o.domain_error ? ["Domain error", o.domain_error] : null,
            o.domain_year_cost > 0 ? ["Domain cost, 1 year", fmt(o.domain_year_cost)] : null,
            o.domain_fee > 0 ? ["First 2 monthly payments", fmt(o.first_amount)] : null,
            [o.domain_fee > 0 ? "Then every month" : "Charged monthly", fmt(o.monthly_amount)],
            ["Paid so far", `${fmt(o.total_paid)} (${o.payments_count} payment${o.payments_count === 1 ? "" : "s"})`],
            ["Created", date(o.created_at)],
            o.activated_at ? ["Activated", date(o.activated_at)] : null,
            o.cancelled_at ? ["Cancelled", date(o.cancelled_at)] : null,
            o.paymob_subscription_id ? ["Paymob subscription", o.paymob_subscription_id] : null
        ]),

        o.amount_fix_pending ? el("p", { class: "note-box", text: "The domain is paid off, but the monthly amount at Paymob is still the higher one. Retry below, or change it in your Paymob dashboard." }) : null,

        el("h3", { text: "Payments" }),
        kv(payRows),

        o.customer_notes ? el("h3", { text: "Customer's project notes" }) : null,
        o.customer_notes ? el("div", { class: "note-box", text: o.customer_notes }) : null,

        el("h3", { text: "Manage" }),
        status,
        el("div", { class: "spacer" }),
        notes,
        el("div", { class: "row" }, ...buttons),
        panelSlot,
        msg
    ];

    $("drawerBody").replaceChildren(...body.filter(Boolean));
    $("drawer").hidden = false;
    document.querySelector(".drawer .close").focus();
}

const closeDrawer = () => { $("drawer").hidden = true; };
$("closeDrawer").addEventListener("click", closeDrawer);
$("drawer").addEventListener("click", e => { if (e.target === $("drawer")) closeDrawer(); });
document.addEventListener("keydown", e => { if (e.key === "Escape") closeDrawer(); });

/* ───────── start ───────── */
api("/api/admin/me").then(showApp).catch(() => showLogin());
