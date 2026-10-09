// ─────────────────────────────────────────────────────────────
// Plan prices. Edit the numbers here. Domain prices come from Hostinger.
// All prices are in EGP, charged EVERY MONTH.
// ─────────────────────────────────────────────────────────────

export const PLANS = {
    basic:   { name: "Basic",   price: 500,  paymobPlanId: process.env.PAYMOB_PLAN_BASIC },
    premium: { name: "Premium", price: 750,  paymobPlanId: process.env.PAYMOB_PLAN_PREMIUM },
    custom:  { name: "Custom",  price: 1250, paymobPlanId: process.env.PAYMOB_PLAN_CUSTOM }
};

export const CURRENCY = "EGP";
