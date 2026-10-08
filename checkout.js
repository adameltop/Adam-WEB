const WHATSAPP_NUMBER = "201122450119";
const EMAIL = "1234adamhussein@gmail.com";

const PLANS = {
    basic: {
        tag: "BASIC",
        name: "Basic",
        price: 500,
        features: ["Professional website", "Mobile-friendly design", "Essential pages", "Basic maintenance", "Website updates"]
    },
    premium: {
        tag: "PREMIUM",
        name: "Premium",
        price: 750,
        features: ["Everything in Basic", "Premium custom design", "More website sections", "Advanced features", "Priority updates", "Ongoing support"]
    },
    custom: {
        tag: "CUSTOM",
        name: "Custom",
        price: 1250,
        features: ["Fully custom website", "Custom design", "Custom functionality", "Advanced features", "Ongoing maintenance", "Priority support"]
    }
};

const fmt = n => "EGP " + n.toLocaleString("en-US");
const fmtMonthly = n => fmt(n) + " / month";

const params = new URLSearchParams(location.search);
let currentPlan = PLANS[params.get("plan")] ? params.get("plan") : "premium";

const form = document.getElementById("checkoutForm");
const planOptions = document.getElementById("planOptions");
const paymentStep = document.getElementById("paymentStep");
const submitBtn = document.getElementById("submitBtn");

/* ───────── Plan picker ───────── */
planOptions.innerHTML = Object.entries(PLANS).map(([key, p]) => `
    <label class="plan-option">
        <input type="radio" name="plan" value="${key}" ${key === currentPlan ? "checked" : ""}>
        <span class="radio-dot" aria-hidden="true"></span>
        <span>
            <span class="plan-option-tag">${p.tag}</span>
            <span class="plan-option-name">${p.name}</span>
        </span>
        <span class="plan-option-price">${fmt(p.price)} <small>/ month</small></span>
    </label>
`).join("");

planOptions.addEventListener("change", e => {
    if (e.target.name === "plan") {
        currentPlan = e.target.value;
        history.replaceState(null, "", "?plan=" + currentPlan);
        renderSummary();
    }
});

/* ───────── Summary ───────── */
function renderSummary() {
    const p = PLANS[currentPlan];
    const quote = p.price === null;

    document.getElementById("sumTag").textContent = p.tag;
    document.getElementById("sumName").textContent = p.name;
    document.getElementById("sumPrice").textContent = fmt(p.price);
    document.getElementById("sumFeatures").innerHTML = p.features.map(f => `<li>✓ ${f}</li>`).join("");
    document.getElementById("sumSubtotal").textContent = fmtMonthly(p.price);
    document.getElementById("sumTotal").textContent = fmtMonthly(p.price);
    document.getElementById("sumNote").textContent = "Domain registration is charged separately. No payment is taken on this page.";

    paymentStep.hidden = quote;
    submitBtn.textContent = quote ? "Request a quote" : "Place order";
}

renderSummary();

/* ───────── Validation ───────── */
const messages = {
    name: "Enter your full name.",
    phone: "Enter a phone number we can reach you on.",
    email: "Enter a valid email address, like name@example.com.",
    business: "Enter your business name.",
    terms: "Confirm the details to continue."
};

function setError(id, text) {
    const err = form.querySelector(`.field-error[data-for="${id}"]`);
    const field = document.getElementById(id)?.closest(".field");
    if (err) err.textContent = text;
    if (field) field.classList.toggle("invalid", Boolean(text));
    document.getElementById(id)?.setAttribute("aria-invalid", text ? "true" : "false");
}

function validateField(id) {
    const el = document.getElementById(id);
    let ok = true;

    if (id === "terms") ok = el.checked;
    else if (id === "phone") ok = el.value.replace(/\D/g, "").length >= 8;
    else if (id === "email") ok = el.value.trim() !== "" && el.checkValidity();
    else ok = el.value.trim() !== "";

    setError(id, ok ? "" : messages[id]);
    return ok;
}

const requiredIds = ["name", "phone", "email", "business", "terms"];

requiredIds.forEach(id => {
    const el = document.getElementById(id);
    el.addEventListener("blur", () => { if (id !== "terms") validateField(id); });
    el.addEventListener("input", () => { if (el.getAttribute("aria-invalid") === "true") validateField(id); });
    el.addEventListener("change", () => { if (id === "terms") validateField(id); });
});

/* ───────── Order ───────── */
function buildOrder() {
    const p = PLANS[currentPlan];
    const quote = p.price === null;
    const data = Object.fromEntries(new FormData(form).entries());
    const now = new Date();
    const ref = "AW-" +
        String(now.getFullYear()).slice(2) +
        String(now.getMonth() + 1).padStart(2, "0") +
        String(now.getDate()).padStart(2, "0") + "-" +
        Math.random().toString(36).slice(2, 6).toUpperCase();

    return {
        ref,
        plan: p.name,
        total: fmtMonthly(p.price) + " + domain",
        payment: quote ? null : data.payment,
        name: data.name.trim(),
        phone: data.phone.trim(),
        email: data.email.trim(),
        business: data.business.trim(),
        notes: (data.notes || "").trim(),
        quote
    };
}

function orderText(o) {
    return [
        o.quote ? "Quote request — ADAM WEB" : "New order — ADAM WEB",
        `Reference: ${o.ref}`,
        "",
        `Plan: ${o.plan}`,
        `Total: ${o.total}`,
        o.payment ? `Payment method: ${o.payment}` : null,
        "",
        `Name: ${o.name}`,
        `Business: ${o.business}`,
        `Phone: ${o.phone}`,
        `Email: ${o.email}`,
        o.notes ? `\nProject notes:\n${o.notes}` : null
    ].filter(line => line !== null).join("\n");
}

const layout = document.querySelector(".checkout-layout");
const head = document.querySelector(".checkout-head");
const confirmation = document.getElementById("confirmation");

form.addEventListener("submit", e => {
    e.preventDefault();

    const results = requiredIds.map(validateField);
    if (results.includes(false)) {
        document.querySelector('[aria-invalid="true"]')?.focus();
        return;
    }

    const order = buildOrder();
    const text = orderText(order);

    document.getElementById("sendWhatsapp").href =
        `https://wa.me/${WHATSAPP_NUMBER}?text=${encodeURIComponent(text)}`;
    document.getElementById("sendEmail").href =
        `mailto:${EMAIL}?subject=${encodeURIComponent((order.quote ? "Quote request " : "Order ") + order.ref)}&body=${encodeURIComponent(text)}`;

    const rows = [
        ["Reference", order.ref],
        ["Plan", order.plan],
        ["Total", order.total],
        order.payment ? ["Payment method", order.payment] : null,
        ["Name", order.name],
        ["Business", order.business],
        ["Phone", order.phone],
        ["Email", order.email]
    ].filter(Boolean);

    const dl = document.getElementById("confirmDetails");
    dl.innerHTML = "";
    rows.forEach(([k, v]) => {
        const row = document.createElement("div");
        const dt = document.createElement("dt");
        const dd = document.createElement("dd");
        dt.textContent = k;
        dd.textContent = v;
        row.append(dt, dd);
        dl.append(row);
    });

    document.querySelector("#confirmation h2").textContent = order.quote
        ? "Your quote request is ready to send."
        : "Your order is ready to send.";

    layout.hidden = true;
    head.hidden = true;
    confirmation.hidden = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
    confirmation.querySelector("h2").setAttribute("tabindex", "-1");
    confirmation.querySelector("h2").focus({ preventScroll: true });
});

document.getElementById("editOrder").addEventListener("click", () => {
    confirmation.hidden = true;
    layout.hidden = false;
    head.hidden = false;
    window.scrollTo({ top: 0, behavior: "smooth" });
});
