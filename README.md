# ADAM WEB: site, monthly card billing and private admin

What this gives you:

- **Your website** (`public/`): homepage and checkout.
- **Monthly card payments** through Paymob. The customer enters their card **once**, on Paymob's secure page. Paymob then charges the plan price (plus the domain fee, if you set one) every month.
- **A private database** of customers, orders and payments (`data/adamweb.db`).
- **A private dashboard** at `/admin/` (password only you know) to see who is paying, who failed, revenue, notes, search and CSV export.

Card numbers are never typed into your site and never stored. The database only keeps the card brand and last 4 digits that Paymob reports.

> This needs a host that runs Node.js (a VPS, Render, Railway, Fly.io...). It will not work on GitHub Pages or other static-only hosting.

## How an order works

1. **Customer picks a plan** on the homepage and presses the button. This opens the checkout page.
2. **They fill in** their name, phone, email, business name and (optionally) the domain they want. The site checks the domain with Hostinger as they type and shows if it's free and what it costs.
3. **They press "Place order".** Nothing is charged. The order is saved in your dashboard as **In progress**.
4. **You build the website.**
5. **When it's finished,** open the order in `/admin/` and press **"Website finished: get payment link"**. The server re-checks the domain price one more time, then gives you a private payment link. Send it with the **WhatsApp** or **email** button (they open with the message already written).
6. **The customer opens the link,** sees their price, and pays by card on Paymob's secure page. This is when monthly billing starts.
7. **After their first payment** the domain is bought on your Hostinger account. After the second payment the monthly amount drops to the plain plan price.

Order statuses: **In progress** (not charged yet) → **Waiting for payment** (link sent) → **Active** (paying monthly). **Payment failed** and **Cancelled** are shown too.

## 1. Run it on your computer

```bash
npm install
cp .env.example .env      # then open .env and set ADMIN_PASSWORD and SESSION_SECRET
npm start
```

Open http://localhost:3000 for the site and http://localhost:3000/admin/ for the dashboard.

Checkout works even before Paymob is configured: orders are saved and appear in `/admin/`. You can only send payment links once Paymob is set up.

## 2. Prices and domains

**Plans** are in `lib/config.js` (500 / 750 / 1,250 EGP per month). If you change one, also change the text in `public/index.html`.

**Domains are priced automatically from Hostinger.** When a customer types a domain at checkout:

1. The server asks Hostinger if it's free and what one year costs.
2. The one-year price (converted to EGP) is **split into 2 halves**, and one half is added to each of the customer's **first 2 monthly payments**.
3. Example: Basic (500) + a domain costing 1,000 EGP per year means **1,000 in month 1, 1,000 in month 2, then 500 every month from month 3**. The domain is paid off and your plan price is your profit.
4. After the customer's **first successful payment**, the server buys the domain for 1 year on your Hostinger account.
5. After the **second** payment, the server lowers the recurring amount at Paymob to the plain plan price.

Safeguards: the price is always worked out on the server (the browser can't change it), the purchase can only happen once per order, and domains over `MAX_DOMAIN_USD` (default 50 USD) are not bought automatically. If the Hostinger purchase fails, or the amount at Paymob can't be lowered, the dashboard shows a warning with a retry button.

The domain is registered **under your Hostinger account** and your default WHOIS contact. A registered domain can't be refunded, so if a customer cancels after the first payment you've paid the full year and recovered only half.

If Hostinger isn't set up, the domain field is still saved on the order and shown in the dashboard, but nothing is charged for it.

## 3. Turn on card payments (Paymob)

1. Create a Paymob account and finish merchant approval.
2. In the Paymob dashboard, get your **Secret key** and **Public key**, your **API key**, and your **HMAC secret**.
3. You need two integrations: an **Online 3DS** integration (its id goes in `PAYMOB_INTEGRATION_ID`) and a **MOTO** integration (used when the subscription plans are created).
4. Create **three subscription plans billed monthly** (Basic, Premium, Custom). Paymob creates these through their API or their support team. Put each plan id in `PAYMOB_PLAN_BASIC`, `PAYMOB_PLAN_PREMIUM`, `PAYMOB_PLAN_CUSTOM`.
5. Set your **transaction callback / webhook URL** in Paymob to:
   `https://yourdomain.com/api/paymob/webhook?secret=YOUR_PAYMOB_WEBHOOK_SECRET`
6. Fill in `.env`, restart, and test with Paymob's **test keys and test cards first**. Do a full test: checkout, pay, confirm the order turns Active in `/admin/`.

Paymob's subscription docs: https://developers.paymob.com (Subscriptions section).

### Hostinger (domain prices and automatic purchase)

1. In Hostinger hPanel, create an **API token** (Account → API). Put it in `HOSTINGER_API_TOKEN`.
2. Make sure your Hostinger account has a **default payment method** (or set `HOSTINGER_PAYMENT_METHOD_ID`) and a **default WHOIS profile** for the extensions you sell. Purchases fail without them.
3. Hostinger lists prices in USD. Set `USD_EGP_RATE` to the exchange rate you want to use. It's **not updated automatically**, so check it now and then. `DOMAIN_MARKUP_PERCENT` adds a safety margin on top (default 0).
4. Optional: `AUTO_BUY_DOMAINS=false` stops automatic purchases, so you buy each domain yourself with the "Buy domain now" button.

Hostinger limits availability checks to about 10 per minute, so checks are cached and each visitor is rate limited.

### Please verify before going live

I couldn't test against a real Paymob account, so check these with a test payment or with Paymob support:

- The subscription request in `lib/paymob.js` (`createSubscriptionCheckout`). In particular `subscription_plan_id` and `use_transaction_amount` (used so the recurring amount can include a domain fee).
- Which callback fields Paymob sends for **recurring** charges. Anything that can't be matched to an order is saved in the `events` table and counted in the dashboard warning, so no payment is lost.
- Hostinger: that the price list entry used for one-year prices (`lib/domains.js`, `yearPrice`) matches your account's catalog, and that the first-year price is what you're actually charged.
- Lowering the amount after payment 2 (`updateSubscriptionAmount` in `lib/paymob.js`). Ask Paymob support to confirm the subscription "update amount" call for your account.
- Cancelling: the "Cancel subscription" button calls Paymob's cancel endpoint. If it fails, the dashboard tells you to cancel in the Paymob dashboard and then set the status to Cancelled.

## 4. Put it online

- Upload this whole folder to your Node host, run `npm install` and `npm start`.
- Set the `.env` values as environment variables on the host.
- Use HTTPS (hosts like Render and Railway provide it).
- Put `data/` on a **persistent disk**, otherwise orders are lost when the host restarts.
- **Back up `data/adamweb.db`** regularly, and use "Export CSV" in the dashboard as a second copy.
- Put your demo websites in the `demos/` folder (for example `demos/luna-bistro/index.html`). They are served at `/demos/luna-bistro/`, so your homepage links keep working. You can delete the old `index.html`, `style.css` and `script.js` from the root of your old repository, since the new site lives in `public/`.

## Folder map

```
demos/               your demo websites
server.js            web server, orders API, Paymob webhook, admin API
lib/config.js        plans and domain prices
lib/db.js            database tables
lib/paymob.js        Paymob calls and signature check
public/              the website (index, checkout, pay, payment-result)
public/admin/        the private dashboard
data/                the database (created automatically)
```

## Security notes

- The admin password is checked on the server; the login is rate limited and the session cookie is HttpOnly and SameSite=Strict.
- Paymob notifications are accepted only with your secret in the URL **and** a valid signature (or a direct check with Paymob).
- Customer text is always shown as plain text in the dashboard.
- Spreadsheet exports neutralise cells that start with `=`, `+`, `-` or `@`.
