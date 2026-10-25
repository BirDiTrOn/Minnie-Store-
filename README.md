# Minnie Store

Game top-up store, paid with KHQR. Hosted on Vercel, data in Supabase.

- `public/` — the website (`index.html` = store, `admin/` = admin page)
- `api/index.js` + `src/core.mjs` — backend (login, save prices, upload pictures)
- `supabase-setup.sql` — run once in Supabase to create the database table
- `vercel.json` — output folder, caching and privacy headers

Environment variables (set in Vercel, never in this repo):
`ADMIN_PASSWORD`, `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, and for Telegram order alerts `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`
