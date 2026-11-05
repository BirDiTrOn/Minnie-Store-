# Minnie Store

Game top-up store, paid with KHQR. Hosted on Vercel, data in Supabase.

- `public/` — the website (`index.html` = store, `admin/` = admin page)
- `api/index.js` + `src/core.mjs` — backend (login, save prices, upload pictures)
- `supabase-setup.sql` — run once in Supabase to create the database table
- `vercel.json` — output folder, caching and privacy headers

Environment variables (set in Vercel, never in this repo):
`ADMIN_PASSWORD`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, and for Telegram order alerts `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`

## ABA PayWay (QR pop-up with automatic "paid")

Add these in Vercel → Settings → Environment Variables, then redeploy:

- `PAYWAY_MERCHANT_ID` – your PayWay Merchant ID
- `PAYWAY_API_KEY` – your PayWay API key
- `PAYWAY_BASE` – optional. Defaults to `https://checkout.payway.com.kh`; use `https://checkout-sandbox.payway.com.kh` while testing.

ABA must allow your store's domain (and the callback `https://<your-domain>/api/payway-callback`). `/api/health` shows `paywayMerchantIdSet` / `paywayApiKeySet`.

## Telegram shop bot

Customers can order inside Telegram.

1. In Telegram open @BotFather, send `/newbot` and make a **second** bot (not the one used for order alerts). Copy its token.
2. In Vercel add the environment variable `SHOP_BOT_TOKEN` with that token, then redeploy.
3. Open `/admin` → Settings → **Turn on the shop bot** (once).
4. Open your new bot in Telegram and send `/start`.

Orders from the bot appear in your admin chat like website orders (with the ✅ / ❌ buttons), and the customer is told in the bot when you confirm or deliver. The payment QR uploaded in admin (or the payment link for that price) is sent to the customer.
