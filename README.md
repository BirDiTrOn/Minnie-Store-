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
