const qs = new URLSearchParams(location.search);
const ref = qs.get("ref");
const payToken = qs.get("t");
const icon = document.getElementById("resultIcon");
const title = document.getElementById("resultTitle");
const text = document.getElementById("resultText");
const retry = document.getElementById("retryBtn");

document.getElementById("resultRef").textContent = ref ? `Reference: ${ref}` : "";

const STATES = {
    active: ["✓", "Payment received.", "Your monthly subscription is active. I'll be in touch to start your project."],
    payment_failed: ["!", "The payment didn't go through.", "Your card wasn't charged. Check your card details and try again, or contact me for help."],
    awaiting_payment: ["…", "Confirming your payment…", "We're waiting for confirmation from the bank. This page updates by itself."],
    cancelled: ["–", "This order was cancelled.", "Contact me if you'd like to start again."]
};

function show(status) {
    const [i, t, p] = STATES[status] || STATES.awaiting_payment;
    icon.textContent = i;
    title.textContent = t;
    text.textContent = p;
    retry.hidden = status !== "payment_failed" || !ref || !payToken;
    if (!retry.hidden) retry.href = `pay.html?ref=${encodeURIComponent(ref)}&t=${encodeURIComponent(payToken)}`;
}

async function poll(attempt = 0) {
    if (!ref) { show("awaiting_payment"); title.textContent = "Missing order reference."; text.textContent = "Open this page from the link you were sent after paying."; return; }
    try {
        const res = await fetch(`/api/orders/${encodeURIComponent(ref)}/status`);
        if (!res.ok) throw new Error();
        const { status } = await res.json();
        show(status);
        if (status === "awaiting_payment" && attempt < 20) setTimeout(() => poll(attempt + 1), 3000);
    } catch {
        title.textContent = "We couldn't check the status.";
        text.textContent = "Your order is saved. Contact me with your reference if you need help.";
    }
}

poll();
