const qs = new URLSearchParams(location.search);
const ref = qs.get("ref");
const token = qs.get("t");

const $ = id => document.getElementById(id);
const fmt = n => "EGP " + Number(n).toLocaleString("en-US");

function setState(icon, title, text) {
    $("payIcon").textContent = icon;
    $("payTitle").textContent = title;
    $("payText").textContent = text;
}

function row(k, v) {
    const div = document.createElement("div");
    const dt = document.createElement("dt");
    const dd = document.createElement("dd");
    dt.textContent = k;
    dd.textContent = v;
    div.append(dt, dd);
    return div;
}

async function load() {
    if (!ref || !token) return setState("!", "This payment link isn't valid.", "Please use the link I sent you, or contact me.");

    let data;
    try {
        const res = await fetch(`/api/pay/${encodeURIComponent(ref)}?t=${encodeURIComponent(token)}`);
        data = await res.json();
        if (!res.ok) throw new Error(data.error);
    } catch {
        return setState("!", "This payment link isn't valid.", "Please use the link I sent you, or contact me.");
    }

    if (data.status === "active") return setState("✓", "Already paid.", "Your monthly plan is active. Thank you!");
    if (data.status === "cancelled") return setState("–", "This order was cancelled.", "Contact me if you'd like to start again.");
    if (!["awaiting_payment", "payment_failed"].includes(data.status)) {
        return setState("…", "Your website isn't ready yet.", "I'll send you the payment link as soon as it is.");
    }

    setState("✓", "Your website is ready.", `Hi ${data.name}, review your plan and pay to start your monthly billing.`);

    const rows = [["Plan", data.plan]];
    if (data.domain) rows.push(["Domain", data.domain]);
    if (data.domainFee > 0) {
        rows.push(["Domain, 1 year", `${fmt(data.domainYearCost)}, split across your first ${data.parts} payments`]);
        rows.push([`First ${data.parts} months`, `${fmt(data.firstAmount)} / month`]);
        rows.push([`From month ${data.parts + 1}`, `${fmt(data.monthlyAmount)} / month`]);
    } else {
        rows.push(["Every month", `${fmt(data.monthlyAmount)} / month`]);
    }
    rows.push(["Charged today", fmt(data.firstAmount)]);

    $("payDetails").replaceChildren(...rows.map(([k, v]) => row(k, v)));
    $("payDetails").hidden = false;
    $("payBtn").hidden = false;
    $("payHint").hidden = false;
}

$("payBtn").addEventListener("click", async () => {
    const btn = $("payBtn");
    $("payError").hidden = true;
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = "Please wait…";

    try {
        const res = await fetch(`/api/pay/${encodeURIComponent(ref)}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ t: token })
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok || !data.checkoutUrl) throw new Error(data.error || "Something went wrong. Please try again.");
        location.href = data.checkoutUrl;
        return;
    } catch (e) {
        $("payError").textContent = e.message;
        $("payError").hidden = false;
    }

    btn.disabled = false;
    btn.textContent = label;
});

load();
