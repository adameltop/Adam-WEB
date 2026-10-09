const WHATSAPP_NUMBER = "201122450119";

// Features are display-only. Prices always come from the server.
const FEATURES = {
    basic: ["Professional website", "Mobile-friendly design", "Essential pages", "Basic maintenance", "Website updates"],
    premium: ["Everything in Basic", "Premium custom design", "More website sections", "Advanced features", "Priority updates", "Ongoing support"],
    custom: ["Fully custom website", "Custom design", "Custom functionality", "Advanced features", "Ongoing maintenance", "Priority support"]
};

const fmt = n => "EGP " + Number(n).toLocaleString("en-US");
const $ = id => document.getElementById(id);

const form = $("checkoutForm");
const planOptions = $("planOptions");
const submitBtn = $("submitBtn");
const banner = $("formBanner");

let config = null;
let currentPlan = new URLSearchParams(location.search).get("plan");

/* ───────── helpers ───────── */
function normalizeDomain(raw) {
    return raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");
}

// Latest domain price check: null, or { domain, status, yearly, part, message }
let domainState = null;
let domainTimer;
let domainSeq = 0;

const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

const domainPart = () => (domainState && domainState.status === "available" ? domainState.part : 0);

function showBanner(message) {
    banner.textContent = message;
    banner.hidden = !message;
}

function setError(id, text) {
    const err = form.querySelector(`.field-error[data-for="${id}"]`);
    const el = $(id);
    if (err) err.textContent = text;
    if (el) {
        el.closest(".field")?.classList.toggle("invalid", Boolean(text));
        el.setAttribute("aria-invalid", text ? "true" : "false");
    }
}

/* ───────── render ───────── */
function renderPlans() {
    planOptions.replaceChildren();
    config.plans.forEach(p => {
        const label = document.createElement("label");
        label.className = "plan-option";

        const input = document.createElement("input");
        input.type = "radio";
        input.name = "plan";
        input.value = p.key;
        input.checked = p.key === currentPlan;

        const dot = document.createElement("span");
        dot.className = "radio-dot";
        dot.setAttribute("aria-hidden", "true");

        const info = document.createElement("span");
        const tag = document.createElement("span");
        tag.className = "plan-option-tag";
        tag.textContent = p.name.toUpperCase();
        const name = document.createElement("span");
        name.className = "plan-option-name";
        name.textContent = p.name;
        info.append(tag, name);

        const price = document.createElement("span");
        price.className = "plan-option-price";
        const small = document.createElement("small");
        small.textContent = "/ month";
        price.append(fmt(p.price) + " ", small);

        label.append(input, dot, info, price);
        planOptions.append(label);
    });
}

function renderSummary() {
    const plan = config.plans.find(p => p.key === currentPlan);
    const domain = normalizeDomain($("domain").value);
    const part = domainPart();
    const parts = config.domainParts || 2;
    const dueNow = plan.price + part;

    $("sumTag").textContent = plan.name.toUpperCase();
    $("sumName").textContent = plan.name;
    $("sumPrice").textContent = fmt(plan.price) + " / month";
    $("sumFeatures").replaceChildren(...(FEATURES[plan.key] || []).map(f => {
        const li = document.createElement("li");
        li.textContent = "✓ " + f;
        return li;
    }));

    $("sumPlanLabel").textContent = plan.name + " plan";
    $("sumSubtotal").textContent = fmt(plan.price);

    $("sumDomainRow").hidden = !part;
    $("sumDomainLabel").textContent = part ? `Domain ${domain}, 1 year (${fmt(domainState.yearly)}) in ${parts} parts` : "Domain";
    $("sumDomainFee").textContent = fmt(part);

    $("sumTotalLabel").textContent = part ? `Each of the first ${parts} months` : "Total every month, once billing starts";
    $("sumTotal").textContent = fmt(dueNow) + " / month";

    $("sumThen").hidden = !part;
    $("sumThen").textContent = part ? `Then ${fmt(plan.price)} / month from month ${parts + 1}.` : "";

    $("sumNote").textContent = part
        ? "Nothing is charged today. Billing starts when your website is ready. The domain is registered after your first payment and can't be refunded."
        : "Nothing is charged today. Billing starts when your website is ready, and you pay on Paymob's secure page.";
}

function setDomainHint(text, tone = "") {
    const hint = $("domainHint");
    hint.textContent = text;
    hint.className = "hint" + (tone ? " " + tone : "");
}

async function checkDomain() {
    const domain = normalizeDomain($("domain").value);
    const seq = ++domainSeq;
    setError("domain", "");

    if (!domain) {
        domainState = null;
        setDomainHint("Domain registration is charged separately.");
        return renderSummary();
    }
    if (!config.domainPricing) {
        domainState = null;
        setDomainHint("Domain registration is charged separately. I'll confirm the price with you.");
        return renderSummary();
    }
    if (!DOMAIN_RE.test(domain)) {
        domainState = null;
        setDomainHint("Enter a domain like yourbusiness.com.");
        return renderSummary();
    }

    domainState = { domain, status: "checking" };
    setDomainHint("Checking availability and price…");
    renderSummary();

    try {
        const res = await fetch("/api/domain/quote", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ domain })
        });
        const data = await res.json().catch(() => ({}));
        if (seq !== domainSeq) return; // a newer check replaced this one

        if (!res.ok) {
            domainState = { domain, status: "error" };
            setDomainHint(data.error || "We couldn't check that domain right now.", "bad");
        } else if (!data.priced) {
            domainState = { domain, status: "unpriced" };
            setDomainHint("Domain registration is charged separately. I'll confirm the price with you.");
        } else if (!data.available) {
            domainState = { domain, status: "taken" };
            setDomainHint(`${domain} isn't available. Try another name or extension.`, "bad");
        } else {
            domainState = { domain, status: "available", yearly: data.yearly, part: data.part };
            setDomainHint(`${domain} is available: ${fmt(data.yearly)} for the first year, split across your first ${data.parts} monthly payments.`, "good");
        }
    } catch {
        if (seq !== domainSeq) return;
        domainState = { domain, status: "error" };
        setDomainHint("We couldn't check that domain right now.", "bad");
    }
    renderSummary();
}

/* ───────── events ───────── */
planOptions.addEventListener("change", e => {
    if (e.target.name === "plan") {
        currentPlan = e.target.value;
        history.replaceState(null, "", "?plan=" + currentPlan);
        renderSummary();
    }
});

$("domain").addEventListener("input", () => {
    clearTimeout(domainTimer);
    domainState = null;
    renderSummary();
    domainTimer = setTimeout(checkDomain, 700);
});
$("domain").addEventListener("blur", () => { clearTimeout(domainTimer); checkDomain(); });

const messages = {
    name: "Enter your full name.",
    phone: "Enter a phone number we can reach you on.",
    email: "Enter a valid email address, like name@example.com.",
    business: "Enter your business name.",
    terms: "Confirm to continue."
};

function validateField(id) {
    const el = $(id);
    let ok;
    if (id === "terms") ok = el.checked;
    else if (id === "phone") ok = el.value.replace(/\D/g, "").length >= 8;
    else if (id === "email") ok = el.value.trim() !== "" && el.checkValidity();
    else ok = el.value.trim().length >= 2;
    setError(id, ok ? "" : messages[id]);
    return ok;
}

const requiredIds = ["name", "phone", "email", "business", "terms"];
requiredIds.forEach(id => {
    const el = $(id);
    el.addEventListener("blur", () => { if (id !== "terms") validateField(id); });
    el.addEventListener("input", () => { if (el.getAttribute("aria-invalid") === "true") validateField(id); });
    el.addEventListener("change", () => { if (id === "terms") validateField(id); });
});

form.addEventListener("submit", async e => {
    e.preventDefault();
    showBanner("");

    const results = requiredIds.map(validateField);
    if (results.includes(false)) {
        document.querySelector('[aria-invalid="true"]')?.focus();
        return;
    }

    if (domainState && domainState.status === "taken") {
        setError("domain", `${domainState.domain} isn't available. Try another name or extension.`);
        $("domain").focus();
        return;
    }
    if (domainState && domainState.status === "checking") {
        showBanner("Still checking your domain. Try again in a moment.");
        return;
    }

    const payload = {
        plan: currentPlan,
        name: $("name").value,
        phone: $("phone").value,
        email: $("email").value,
        business: $("business").value,
        domain: $("domain").value,
        notes: $("notes").value
    };

    submitBtn.disabled = true;
    const label = submitBtn.textContent;
    submitBtn.textContent = "Please wait…";

    try {
        const res = await fetch("/api/orders", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        const data = await res.json().catch(() => ({}));

        if (res.status === 400 && data.errors) {
            Object.entries(data.errors).forEach(([field, msg]) => setError(field, msg));
            document.querySelector('[aria-invalid="true"]')?.focus();
        } else if (!res.ok) {
            showBanner(data.error || "Something went wrong. Please try again.");
        } else {
            showReceived(data.ref, payload);
        }
    } catch {
        showBanner("We couldn't reach the server. Check your connection and try again.");
    }

    submitBtn.disabled = false;
    submitBtn.textContent = label;
});

/* Shown when card payments aren't switched on yet: the order is saved either way. */
function showReceived(ref, p) {
    const plan = config.plans.find(x => x.key === p.plan);
    const domain = normalizeDomain(p.domain);
    const rows = [
        ["Reference", ref],
        ["Plan", `${plan.name} (${fmt(plan.price + domainPart())} / month)`],
        ["Name", p.name.trim()],
        ["Business", p.business.trim()],
        ["Phone", p.phone.trim()],
        ["Email", p.email.trim()],
        domain ? ["Domain", domain] : null
    ].filter(Boolean);

    const dl = $("confirmDetails");
    dl.replaceChildren();
    rows.forEach(([k, v]) => {
        const row = document.createElement("div");
        const dt = document.createElement("dt");
        const dd = document.createElement("dd");
        dt.textContent = k;
        dd.textContent = v;
        row.append(dt, dd);
        dl.append(row);
    });

    $("sendWhatsapp").href = `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent("Hi, I just placed an order. Reference: " + ref)}`;

    document.querySelector(".checkout-layout").hidden = true;
    document.querySelector(".checkout-head").hidden = true;
    $("confirmation").hidden = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
}

/* ───────── start ───────── */
(async function init() {
    try {
        const res = await fetch("/api/config");
        if (!res.ok) throw new Error();
        config = await res.json();
    } catch {
        submitBtn.disabled = true;
        showBanner("Online checkout isn't available right now. Please contact me on WhatsApp and I'll set you up.");
        planOptions.textContent = "";
        return;
    }

    if (!config.plans.some(p => p.key === currentPlan)) currentPlan = "premium";
    renderPlans();
    renderSummary();
})();
