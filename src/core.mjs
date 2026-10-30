import DEFAULT_CONFIG from "./default-config.mjs";
import TEXT_KEYS from "./texts.mjs";

const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;
const MAX_GAMES = 100, MAX_PACKS = 300, MAX_IMG_BYTES = 600 * 1024;

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...extra },
  });

/* ---------- tiny Web Crypto helpers (work on Vercel, Cloudflare, Node 18+, browsers) ---------- */
const enc = new TextEncoder();
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64url = (str) => { const b = atob(str.replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(b, (c) => c.charCodeAt(0)); };
const hex = (n) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => b.toString(16).padStart(2, "0")).join("");
async function hmac(keyBytes, data) {
  const key = await crypto.subtle.importKey("raw", keyBytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", key, typeof data === "string" ? enc.encode(data) : data);
}
/* constant-time string compare: compare fixed-length digests, so length and content timing don't leak */
async function safeEq(a, b) {
  const k = enc.encode("cmp");
  const x = new Uint8Array(await hmac(k, String(a))), y = new Uint8Array(await hmac(k, String(b)));
  let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

/* ---------- auth: password lives in the ADMIN_PASSWORD environment variable ---------- */
const secret = async (env) => hmac(enc.encode("minnie-store-v1"), env.ADMIN_PASSWORD || "");
async function makeToken(env) {
  const payload = b64url(enc.encode(JSON.stringify({ exp: Date.now() + TOKEN_TTL_MS, n: hex(6) })));
  return payload + "." + b64url(await hmac(await secret(env), payload));
}
async function checkToken(req, env) {
  if (!env.ADMIN_PASSWORD) return false;
  const h = req.headers.get("authorization") || "";
  const t = h.startsWith("Bearer ") ? h.slice(7) : "";
  const [payload, sig] = t.split(".");
  if (!payload || !sig) return false;
  const want = b64url(await hmac(await secret(env), payload));
  if (!(await safeEq(sig, want))) return false;
  try { return JSON.parse(new TextDecoder().decode(unb64url(payload))).exp > Date.now(); } catch { return false; }
}

/* ---------- Supabase (REST, no libraries). Needs env vars SUPABASE_URL and SUPABASE_SERVICE_KEY ---------- */
let ENV = {}; // set once per request in handle()
const SB_URL = () => (ENV.SUPABASE_URL || "").replace(/\/+$/, "");
const SB_KEY = () => ENV.SUPABASE_SERVICE_KEY || "";
const sbConfigured = () => !!(SB_URL() && SB_KEY());
function sbHeaders(extra = {}) {
  const key = SB_KEY();
  const h = { apikey: key, ...extra };
  if (key.startsWith("eyJ")) h.Authorization = "Bearer " + key; // legacy JWT-style keys also go in Authorization
  return h;
}
async function sbGetConfig() {
  const r = await fetch(SB_URL() + "/rest/v1/store_config?id=eq.main&select=data", { headers: sbHeaders() });
  if (!r.ok) throw new Error("Supabase read failed: " + r.status + " " + (await r.text()).slice(0, 200));
  const rows = await r.json();
  return rows[0]?.data || null;
}
async function sbSaveConfig(cfg) {
  const r = await fetch(SB_URL() + "/rest/v1/store_config?on_conflict=id", {
    method: "POST",
    headers: sbHeaders({ "content-type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }),
    body: JSON.stringify({ id: "main", data: cfg, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) throw new Error("Supabase write failed: " + r.status + " " + (await r.text()).slice(0, 200));
}
async function sbPutImage(id, type, buf) {
  const r = await fetch(SB_URL() + "/storage/v1/object/store-images/" + id, {
    method: "POST", headers: sbHeaders({ "content-type": type, "cache-control": "max-age=31536000" }), body: buf,
  });
  if (!r.ok) throw new Error("Supabase upload failed: " + r.status + " " + (await r.text()).slice(0, 200));
}
async function sbGetImage(id) {
  const r = await fetch(SB_URL() + "/storage/v1/object/store-images/" + id, { headers: sbHeaders() });
  if (!r.ok) return null;
  return { data: await r.arrayBuffer(), type: r.headers.get("content-type") || "image/jpeg" };
}

/* ---------- order tracking (table "orders", see supabase-setup.sql) ---------- */
const ORDER_FLOW = ["pending", "verifying", "paid", "delivered"];
async function sbOrderGet(code) {
  const r = await fetch(SB_URL() + "/rest/v1/orders?code=eq." + encodeURIComponent(code) + "&select=*", { headers: sbHeaders() });
  if (!r.ok) throw new Error("orders read failed " + r.status);
  return (await r.json())[0] || null;
}
async function sbOrderInsert(row) {
  const r = await fetch(SB_URL() + "/rest/v1/orders?on_conflict=code", {
    method: "POST", headers: sbHeaders({ "content-type": "application/json", Prefer: "resolution=ignore-duplicates,return=minimal" }), body: JSON.stringify(row) });
  if (!r.ok) throw new Error("orders write failed " + r.status);
}
async function sbOrderPatch(code, patch) {
  const r = await fetch(SB_URL() + "/rest/v1/orders?code=eq." + encodeURIComponent(code), {
    method: "PATCH", headers: sbHeaders({ "content-type": "application/json", Prefer: "return=minimal" }), body: JSON.stringify(patch) });
  if (!r.ok) throw new Error("orders write failed " + r.status);
}
/* move an order to a new status and remember when; never throws (tracking must not break ordering) */
async function setOrderStatus(code, status, base) {
  if (!sbConfigured()) return;
  try {
    let o = await sbOrderGet(code);
    const now = new Date().toISOString();
    if (!o) { if (!base) return; await sbOrderInsert({ code, ...base, status, history: [{ s: status, t: now }], updated_at: now }); return; }
    if (o.status === status) return;
    // customer "I have paid" may only move a pending order forward; owner decisions always apply
    if (status === "verifying" && o.status !== "pending") return;
    if (status === "rejected" && o.status !== "rejected") {   // give the item back to the stock
      try {
        const cfg = await load(); const g = cfg.games.find((x) => x.name === o.game); const p = g && g.packs.find((x) => x.name === o.pack && Number(x.usd) === Number(o.usd));
        if (g && p && typeof g.stock === "number") { g.stock += packUnits(p); await sbSaveConfig(cfg); }
      } catch (e) { /* ignore */ }
    }
    await sbOrderPatch(code, { status, history: [...(o.history || []), { s: status, t: now }], updated_at: now });
  } catch (e) { /* ignore */ }
}
const publicOrder = (o) => ({ code: o.code, game: o.game, pack: o.pack, usd: Number(o.usd), status: o.status, created: o.created_at, updated: o.updated_at, history: o.history || [] });

/* ---------- validation: never trust the client ---------- */
const packUnits = (p) => Math.max(1, Math.round(Number(p.units) || 0) || parseInt(String(p.name || "").replace(/[, ]/g, "").match(/\d+/)?.[0] || "1", 10) || 1);
const str = (v, max) => String(v ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "").trim().slice(0, max);
const num = (v, min, max, dflt) => { const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt; };
const imgUrl = (v) => { const s = str(v, 300); return /^\/(assets|api\/img)\/[\w.\-\/]+$/.test(s) ? s : ""; };
const slug = (v, fallback) => (str(v, 40).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || fallback);

function clean(input) {
  if (!input || typeof input !== "object" || !Array.isArray(input.games)) throw new Error("Bad data");
  if (input.games.length > MAX_GAMES) throw new Error("Too many games");
  const s = input.settings || {};
  const settings = {
    storeName: str(s.storeName, 60) || "Store",
    telegram: str(s.telegram, 40).replace(/^@/, "").replace(/[^\w]/g, ""),
    supportTelegram: str(s.supportTelegram, 40).replace(/^@/, "").replace(/[^\w]/g, ""),
    openHour: Math.round(num(s.openHour, 0, 23, 7)),
    closeHour: Math.round(num(s.closeHour, 1, 24, 23)),
    khrRate: Math.round(num(s.khrRate, 1, 100000, 4100)),
    qrAccountName: str(s.qrAccountName, 60),
    texts: {},
  };
  // One payment link per price (only https links are kept).
  const link = (v) => { const t = str(v, 500); return /^https:\/\/[^\s<>"']+$/i.test(t) ? t : ""; };
  settings.qrCodes = (Array.isArray(s.qrCodes) ? s.qrCodes : []).slice(0, 80).map((q) => {
    const raw = q && q.usd;
    const has = raw !== "" && raw != null && Number.isFinite(Number(raw));
    return { usd: has ? Math.round(num(raw, 0, 100000, 0) * 100) / 100 : "", link: link(q && q.link) };
  }).filter((q) => q.link && q.usd !== "");
  // Editable store wording: keep only known keys; an empty value means "use the built-in text"
  const tin = s.texts && typeof s.texts === "object" ? s.texts : {};
  for (const k of TEXT_KEYS) { const v = str(tin[k], 600); if (v) settings.texts[k] = v; }
  const used = new Set();
  const games = input.games.map((g, i) => {
    let id = slug(g.id || g.name, "game-" + (i + 1));
    while (used.has(id)) id += "-" + (i + 1);
    used.add(id);
    if (!Array.isArray(g.packs) || g.packs.length > MAX_PACKS) throw new Error("Bad packs in " + str(g.name, 40));
    const packs = g.packs.map((p) => {
      const out = { name: str(p.name, 60), usd: Math.round(num(p.usd, 0, 100000, 0) * 100) / 100 };
      const k = Math.round(num(p.khr, 0, 1e9, 0));
      if (k > 0) out.khr = k;
      const un = Math.round(num(p.units, 0, 1e9, 0)); if (un > 0) out.units = un;   // how much of the game's stock one purchase uses (empty = the number in the pack name)
      if (!out.name) throw new Error("A pack in " + str(g.name, 40) + " has no name");
      return out;
    });
    const fields = (Array.isArray(g.fields) ? g.fields : []).slice(0, 6).map((f, j) => ({
      key: slug(f.key || f.label, "f" + (j + 1)).replace(/-/g, "_"),
      label: str(f.label, 60) || "Details",
      ...(f.roblox === true || f.roblox === false ? { roblox: f.roblox } : {}),
    }));
    return {
      id,
      name: str(g.name, 60) || "Untitled",
      tag: str(g.tag, 16),
      sub: str(g.sub, 160),
      note: str(g.note, 240),
      color: /^#[0-9a-fA-F]{6}$/.test(g.color || "") ? g.color : "#c93a76",
      icon: imgUrl(g.icon),
      glyph: str(g.glyph, 4),
      hidden: !!g.hidden,
      soldOut: !!g.soldOut,
      ...(g.stock !== null && g.stock !== undefined && g.stock !== "" ? { stock: Math.round(num(g.stock, 0, 1e9, 0)) } : {}),   // total left; no value = unlimited
      fields,
      packs,
    };
  });
  return { version: 1, updatedAt: new Date().toISOString(), settings, games };
}

async function load() {
  if (!sbConfigured()) return DEFAULT_CONFIG; // storefront still works before Supabase is connected
  return (await sbGetConfig()) || DEFAULT_CONFIG;
}

/* ---------- Telegram notifications (bot token + chat id live in environment variables) ---------- */
const tgReady = () => !!(ENV.TELEGRAM_BOT_TOKEN && ENV.TELEGRAM_CHAT_ID);
async function tgCall(method, payload) {
  if (!tgReady()) return { sent: false, error: "Telegram is not set up on the server (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)." };
  const api = (ENV.TELEGRAM_API || "https://api.telegram.org").replace(/\/+$/, "");
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 6000);
  try {
    const r = await fetch(api + "/bot" + ENV.TELEGRAM_BOT_TOKEN + "/" + method, {
      method: "POST", headers: { "content-type": "application/json" }, signal: ctl.signal, body: JSON.stringify(payload),
    });
    const d = await r.json().catch(() => ({}));
    return d.ok ? { sent: true, result: d.result } : { sent: false, error: "Telegram said: " + str(d.description || ("HTTP " + r.status), 200) };
  } catch (e) { return { sent: false, error: "Could not reach Telegram." }; }
  finally { clearTimeout(t); }
}
const tgSend = (text, markup) => tgCall("sendMessage", { chat_id: ENV.TELEGRAM_CHAT_ID, text: String(text).slice(0, 3500), disable_web_page_preview: true, ...(markup ? { reply_markup: markup } : {}) });
/* ---- one Telegram message per order: it is sent once and then EDITED as the status changes ---- */
async function kvGet(id) {
  if (!sbConfigured()) return null;
  try { const r = await fetch(SB_URL() + "/rest/v1/store_config?id=eq." + encodeURIComponent(id) + "&select=data", { headers: sbHeaders() }); const rows = r.ok ? await r.json() : []; return (rows[0] && rows[0].data) || null; } catch (e) { return null; }
}
async function kvSet(id, data) {
  if (!sbConfigured()) return;
  try { await fetch(SB_URL() + "/rest/v1/store_config?on_conflict=id", { method: "POST", headers: sbHeaders({ "content-type": "application/json", Prefer: "resolution=merge-duplicates,return=minimal" }), body: JSON.stringify({ id, data, updated_at: new Date().toISOString() }) }); } catch (e) { /* ignore */ }
}
function tgRender(status, body, code, by) {
  const tag = by ? "\n" + (status === "paid" ? "Confirmed" : "Marked") + " by " + by.who + " · " + by.when : "";
  const b = (t, d) => ({ text: t, callback_data: d + ":" + code });
  const heads = {
    pending: "⏳ PENDING: waiting for payment",
    verifying: "🟡 TO VERIFY: customer says they paid\nCheck your bank app, then tap a button below.",
    paid: "✅ PAID: COMPLETE" + tag,
    delivered: "📦 DELIVERED" + tag,
    rejected: "❌ NOT RECEIVED" + tag,
  };
  const kb = { pending: [[b("✅ Payment received", "ok"), b("❌ Not received", "no")]], verifying: [[b("✅ Payment received", "ok"), b("❌ Not received", "no")]],
    paid: [[b("📦 Mark as delivered", "dl")]], rejected: [[b("✅ Payment received", "ok")]], delivered: [] };
  return { text: (heads[status] || heads.pending) + "\n\n" + body, markup: { inline_keyboard: kb[status] || [] } };
}
/* opts: body (message text under the status line), by {who,when}, mid (an existing message to edit), onlyIfExists */
async function tgUpsertOrder(code, status, opts = {}) {
  if (!tgReady()) return { sent: false };
  const rec = await kvGet("tg:" + code);
  const body = opts.body || (rec && rec.b);
  if (!body) return { sent: false };
  const { text, markup } = tgRender(status, body, code, opts.by);
  const mid = opts.mid || (rec && rec.m);
  if (mid) {
    const r = await tgCall("editMessageText", { chat_id: ENV.TELEGRAM_CHAT_ID, message_id: mid, text: text.slice(0, 3500), reply_markup: markup, disable_web_page_preview: true });
    if (r.sent || /not modified/i.test(r.error || "")) { if (!rec || rec.b !== body || rec.m !== mid) await kvSet("tg:" + code, { m: mid, b: body }); return { sent: true }; }
  }
  if (opts.onlyIfExists) return { sent: false };
  const r = await tgSend(text, markup);
  const id = r.result && r.result.message_id;
  if (r.sent && id) await kvSet("tg:" + code, { m: id, b: body });
  return { sent: r.sent };
}
/* ---------- ABA PayWay: a fresh KHQR for every order, and automatic "paid" ---------- */
const pwReady = () => !!(ENV.PAYWAY_MERCHANT_ID && ENV.PAYWAY_API_KEY);
const pwBase = () => (ENV.PAYWAY_BASE || "https://checkout.payway.com.kh").replace(/\/+$/, "");
const pwTime = () => new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);   // UTC YYYYMMDDHHmmss
const b64 = (s) => btoa(String.fromCharCode(...enc.encode(s)));
async function pwHash(parts) {
  const key = await crypto.subtle.importKey("raw", enc.encode(ENV.PAYWAY_API_KEY), { name: "HMAC", hash: "SHA-512" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(parts.join("")));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}
async function pwPost(path, body) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 9000);
  try {
    const r = await fetch(pwBase() + "/api/payment-gateway/v1/payments/" + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal });
    return await r.json().catch(() => ({}));
  } catch (e) { return { status: { code: "net", message: "Could not reach ABA PayWay." } }; } finally { clearTimeout(t); }
}
/* ask ABA for a KHQR for this order (amount in USD, exactly the pack price) */
async function pwCreateQr(code, usd, origin) {
  const f = { req_time: pwTime(), merchant_id: ENV.PAYWAY_MERCHANT_ID, tran_id: code, amount: usd, purchase_type: "purchase", payment_option: "abapay_khqr",
    callback_url: b64(origin + "/api/payway-callback"), currency: "USD", lifetime: 30, qr_image_template: "template3_color" };
  f.hash = await pwHash([f.req_time, f.merchant_id, f.tran_id, String(f.amount), "", "", "", "", "", f.purchase_type, f.payment_option, f.callback_url, "", f.currency, "", "", "", String(f.lifetime), f.qr_image_template]);
  const d = await pwPost("generate-qr", f);
  if (d.status && String(d.status.code) === "0" && d.qrImage) return { ok: true, qrImage: d.qrImage, deeplink: d.abapay_deeplink || "", qrString: d.qrString || "" };
  return { ok: false, error: "ABA PayWay said: " + str((d.status && (d.status.message || d.status.code)) || "no answer", 120) };
}
/* ask ABA whether this order was really paid (never trust the browser or the callback alone) */
async function pwIsPaid(code, usd) {
  const time = pwTime();
  const d = await pwPost("check-transaction-2", { req_time: time, merchant_id: ENV.PAYWAY_MERCHANT_ID, tran_id: code, hash: await pwHash([time, ENV.PAYWAY_MERCHANT_ID, code]) });
  const x = d && d.data;
  if (!x || Number(x.payment_status_code) !== 0) return false;
  const paid = Number(x.original_amount ?? x.total_amount ?? x.payment_amount);
  return Number.isFinite(paid) && Math.abs(paid - Number(usd)) < 0.011;
}
/* if ABA says the order is paid, mark it paid and update its Telegram message; returns true when paid */
async function pwSync(code) {
  if (!pwReady() || !sbConfigured()) return false;
  let o = null; try { o = await sbOrderGet(code); } catch (e) { return false; }
  if (!o) return false;
  if (o.status === "paid" || o.status === "delivered") return true;
  if (o.status === "rejected") return false;
  if (!(await pwIsPaid(code, o.usd))) return false;
  await setOrderStatus(code, "paid");
  const when = new Date().toLocaleString("en-GB", { timeZone: "Asia/Phnom_Penh", hour12: false, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
  await tgUpsertOrder(code, "paid", { by: { who: "ABA PayWay (automatic)", when } });
  return true;
}
const tgSecret = async (env) => b64url(await hmac(await secret(env), "tg-webhook")).slice(0, 40);
/* ---------- Roblox username check (public Roblox web APIs; the browser can't call them directly) ---------- */
async function rbxGet(host, path, init) {
  const base = ENV.ROBLOX_API_BASE ? String(ENV.ROBLOX_API_BASE).replace(/\/+$/, "") + "/" + host : "https://" + host;
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 4500);
  try { const r = await fetch(base + path, { ...(init || {}), signal: ctl.signal, headers: { accept: "application/json", ...((init && init.headers) || {}) } }); if (!r.ok) throw new Error("HTTP " + r.status); return await r.json(); }
  finally { clearTimeout(t); }
}
/* returns {found:false} when the name does not exist, a profile when it does; throws when Roblox can't be reached */
async function robloxLookup(name) {
  const u = await rbxGet("users.roblox.com", "/v1/usernames/users", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ usernames: [name], excludeBannedUsers: true }) });
  const me = u && u.data && u.data[0];
  if (!me) return { found: false };
  const id = Number(me.id);
  const cnt = (k) => rbxGet("friends.roblox.com", "/v1/users/" + id + "/" + k + "/count").then((d) => Number(d.count) || 0).catch(() => null);
  const [img, friends, followers, following] = await Promise.all([
    rbxGet("thumbnails.roblox.com", "/v1/users/avatar-headshot?userIds=" + id + "&size=150x150&format=Png&isCircular=false").then((d) => d.data && d.data[0] && d.data[0].imageUrl).catch(() => ""),
    cnt("friends"), cnt("followers"), cnt("followings"),
  ]);
  return { found: true, id, name: str(me.name, 30), displayName: str(me.displayName || me.name, 40), verified: !!me.hasVerifiedBadge,
    avatar: /^https:\/\/[\w.-]+\.rbxcdn\.com\/[\w\-\/.%?=&]+$/.test(img || "") ? img : "", friends, followers, following };
}
const seen = new Map();   // best-effort rate limit + duplicate guard (per server instance)
function throttled(key, limit, ms) {
  const now = Date.now(); const a = (seen.get(key) || []).filter((x) => now - x < ms);
  a.push(now); seen.set(key, a);
  if (seen.size > 5000) for (const [k, v] of seen) if (!v.some((x) => now - x < ms)) seen.delete(k);
  return a.length > limit;
}

/* ---------- router ---------- */
export async function handle(req, env = {}) {
  ENV = env;
  const url = new URL(req.url);
  let path = url.pathname.replace(/\/+$/, "");
  // On Vercel, /api/<x> is rewritten to /api?__p=<x>; rebuild the real path from it when needed.
  if ((path === "/api" || path === "/api/index") && url.searchParams.has("__p")) path = "/api/" + url.searchParams.get("__p");
  const m = req.method;

  try {
    // Public: what the storefront shows (hidden games removed)
    if (path === "/api/products" && m === "GET") {
      const cfg = await load();
      return json({ ...cfg, games: cfg.games.filter((g) => !g.hidden), tracking: sbConfigured(), payway: pwReady() });
    }

    // Safe diagnostics: says only whether settings are present (never their values)
    if (path === "/api/health" && m === "GET") {
      return json({
        ok: true,
        adminPasswordSet: !!env.ADMIN_PASSWORD,
        supabaseUrlSet: !!env.SUPABASE_URL,
        supabaseKeySet: !!env.SUPABASE_SERVICE_KEY,
        telegramBotTokenSet: !!env.TELEGRAM_BOT_TOKEN,
        telegramChatIdSet: !!env.TELEGRAM_CHAT_ID,
        paywayMerchantIdSet: !!env.PAYWAY_MERCHANT_ID,
        paywayApiKeySet: !!env.PAYWAY_API_KEY,
        ordersTableOk: await (async () => { if (!sbConfigured()) return false; try { await sbOrderGet("NS-00000"); return true; } catch (e) { return false; } })(),
        settingNamesSeen: Object.keys(env).filter((k) => /admin|supabase|telegram|payway/i.test(k)).map((k) => JSON.stringify(k)),
      });
    }

    // Public: check that a Roblox username exists and show its profile
    if (path === "/api/roblox" && m === "GET") {
      const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "x";
      if (throttled("rbx:" + ip, 120, 60000)) return json({ error: "Too many requests" }, 429);
      const name = str(url.searchParams.get("u"), 30);
      if (!/^[A-Za-z0-9_]{3,20}$/.test(name)) return json({ error: "notfound" }, 404);
      try {
        const r = await robloxLookup(name);
        return r.found ? json({ ok: true, ...r, found: undefined }) : json({ error: "notfound" }, 404);
      } catch (e) { return json({ error: "unavailable" }, 503); }
    }

    // Public: tell the shop owner (Telegram) about an order. Price and names come from OUR data, not the browser.
    if (path === "/api/order" && m === "POST") {
      const body = await req.json().catch(() => ({}));
      const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "x";
      if (throttled("ip:" + ip, 20, 60000)) return json({ error: "Too many requests" }, 429);
      const event = body.event === "paid" ? "paid" : "new";
      const code = str(body.code, 12);
      if (!/^NS-[A-Z0-9]{5}$/.test(code)) return json({ error: "Bad order code" }, 400);
      if (throttled("ev:" + event + code, 1, 3600000)) return json({ ok: true, sent: false, duplicate: true });
      const cfg = await load();
      const g = cfg.games.find((x) => x.id === str(body.game, 60));
      const p = g && g.packs[Math.floor(Number(body.pack))];
      if (!g || !p) return json({ error: "Unknown item" }, 400);
      if (event === "new" && typeof g.stock === "number" && sbConfigured()) {
        const need = packUnits(p);
        if (g.stock < need) return json({ ok: false, soldOut: true }, 409);
        g.stock -= need;   // reserved for this order (given back if the order is marked "not received")
        try { await sbSaveConfig(cfg); } catch (e) { /* ordering must not break */ }
      }
      const khr = p.khr || Math.round((p.usd * cfg.settings.khrRate) / 100) * 100;
      let rbxLine = "";
      const rn = str(body.rbx, 30);
      if (/^[A-Za-z0-9_]{3,20}$/.test(rn)) {
        try { const r = await robloxLookup(rn); rbxLine = r.found ? "\nRoblox: " + r.displayName + " (@" + r.name + ") · id " + r.id + "\nhttps://www.roblox.com/users/" + r.id + "/profile" : "\nRoblox: @" + rn + " (not found)"; } catch (e) { rbxLine = "\nRoblox: @" + rn + " (could not check)"; }
      }
      const msgBody = "Order: " + code + "\nGame: " + g.name + "\nPack: " + p.name + "\nAccount: " + (str(body.account, 120) || "-") + rbxLine +
        "\nTotal: $" + p.usd.toFixed(2) + " (" + khr.toLocaleString("en-US") + " ៛)";
      await setOrderStatus(code, event === "paid" ? "verifying" : "pending", { game: g.name, pack: p.name, usd: p.usd });
      if (event === "paid" && sbConfigured()) { try { const cur = await sbOrderGet(code); if (cur && (cur.status === "paid" || cur.status === "delivered")) return json({ ok: true, sent: false }); } catch (e) { /* ignore */ } }
      // "new" sends the order's one message; "paid" edits that same message (a new one only if the first is missing)
      const r = await tgUpsertOrder(code, event === "paid" ? "verifying" : "pending", { body: msgBody });
      return json({ ok: true, sent: r.sent });
    }

    // Telegram calls this when someone taps a button on an order message (secret header proves it is Telegram)
    if (path === "/api/telegram" && m === "POST") {
      if (!tgReady() || !env.ADMIN_PASSWORD) return json({ ok: false }, 503);
      if (!(await safeEq(req.headers.get("x-telegram-bot-api-secret-token") || "", await tgSecret(env)))) return json({ ok: false }, 401);
      const up = await req.json().catch(() => ({}));
      const cq = up && up.callback_query, msg = cq && cq.message;
      const mt = /^(ok|no|dl):(NS-[A-Z0-9]{5})$/.exec(String((cq && cq.data) || ""));
      if (cq && msg && mt && String(msg.chat && msg.chat.id) === String(env.TELEGRAM_CHAT_ID)) {
        const who = str([cq.from && cq.from.first_name, cq.from && cq.from.last_name].filter(Boolean).join(" ") || (cq.from && cq.from.username) || "someone", 60);
        const when = new Date().toLocaleString("en-GB", { timeZone: "Asia/Phnom_Penh", hour12: false, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
        const k = mt[1], code = mt[2];
        const status = k === "ok" ? "paid" : k === "dl" ? "delivered" : "rejected";
        await setOrderStatus(code, status);
        const rec = await kvGet("tg:" + code);
        const fallbackBody = String(msg.text || "").split("\n\n").slice(1).join("\n\n");
        await tgUpsertOrder(code, status, { body: (rec && rec.b) || fallbackBody, by: { who, when }, mid: msg.message_id });
        await tgCall("answerCallbackQuery", { callback_query_id: cq.id, text: k === "ok" ? "Marked as paid" : k === "dl" ? "Marked as delivered" : "Marked as not received" });
      } else if (cq && cq.id) { await tgCall("answerCallbackQuery", { callback_query_id: cq.id }); }
      return json({ ok: true });
    }

    // Public: look up one order by its code (only non-private fields are returned)
    if (path === "/api/track" && m === "GET") {
      const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "x";
      if (throttled("track:" + ip, 60, 60000)) return json({ error: "Too many requests" }, 429);
      const code = str(url.searchParams.get("code"), 12).toUpperCase();
      if (!/^NS-[A-Z0-9]{5}$/.test(code) || !sbConfigured()) return json({ error: "Not found" }, 404);
      let o = null; try { o = await sbOrderGet(code); } catch (e) {}
      if (o && pwReady() && (o.status === "pending" || o.status === "verifying") && !throttled("pw:" + code, 1, 5000)) {
        if (await pwSync(code)) { try { o = await sbOrderGet(code); } catch (e) {} }
      }
      return o ? json(publicOrder(o)) : json({ error: "Not found" }, 404);
    }

    // Tracking page: a customer who forgot to press "I have paid" presses it there
    if (path === "/api/order-paid" && m === "POST") {
      const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "x";
      if (throttled("op:" + ip, 20, 60000)) return json({ error: "Too many requests" }, 429);
      const code = str((await req.json().catch(() => ({}))).code, 12).toUpperCase();
      if (!/^NS-[A-Z0-9]{5}$/.test(code) || !sbConfigured()) return json({ error: "Not found" }, 404);
      let o = null; try { o = await sbOrderGet(code); } catch (e) { /* ignore */ }
      if (!o) return json({ error: "Not found" }, 404);
      if (o.status === "pending") {
        await setOrderStatus(code, "verifying");
        const body = "Order: " + code + "\nGame: " + o.game + "\nPack: " + o.pack + "\nTotal: $" + Number(o.usd).toFixed(2);
        await tgUpsertOrder(code, "verifying", { body });   // uses the order's original message when it has one
        o.status = "verifying";
      }
      return json({ ok: true, status: o.status });
    }
    // ABA PayWay: a KHQR with the exact price for one order
    if (path === "/api/pay" && m === "POST") {
      if (!pwReady()) return json({ error: "ABA PayWay is not set up" }, 503);
      const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "x";
      if (throttled("pay:" + ip, 12, 60000)) return json({ error: "Too many requests" }, 429);
      const body = await req.json().catch(() => ({}));
      const code = str(body.code, 12);
      if (!/^NS-[A-Z0-9]{5}$/.test(code)) return json({ error: "Bad order code" }, 400);
      const cfg = await load();
      const g = cfg.games.find((x) => x.id === str(body.game, 60));
      const p = g && g.packs[Math.floor(Number(body.pack))];
      if (!g || !p || !(p.usd >= 0.01)) return json({ error: "Unknown item" }, 400);
      const r = await pwCreateQr(code, p.usd, url.origin);
      return r.ok ? json({ ok: true, qrImage: r.qrImage, deeplink: r.deeplink, usd: p.usd }) : json({ ok: false, error: r.error }, 502);
    }
    // the store asks this every few seconds while the QR is on screen
    if (path === "/api/pay-status" && m === "GET") {
      const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "x";
      if (throttled("pays:" + ip, 60, 60000)) return json({ error: "Too many requests" }, 429);
      const code = str(url.searchParams.get("code"), 12).toUpperCase();
      if (!/^NS-[A-Z0-9]{5}$/.test(code)) return json({ paid: false });
      return json({ paid: await pwSync(code) });
    }
    // ABA calls this when a payment is made; we still ask ABA to confirm before marking anything paid
    if (path === "/api/payway-callback" && m === "POST") {
      const d = await req.json().catch(() => ({}));
      const code = str(d && d.tran_id, 12);
      if (/^NS-[A-Z0-9]{5}$/.test(code)) await pwSync(code);
      return json({ ok: true });
    }

    if (path === "/api/login" && m === "POST") {
      if (!env.ADMIN_PASSWORD) return json({ error: "Admin password is not set on the server." }, 503);
      const body = await req.json().catch(() => ({}));
      if (await safeEq(String(body.password || ""), env.ADMIN_PASSWORD)) return json({ token: await makeToken(env) });
      await new Promise((r) => setTimeout(r, 1200)); // slow down guessing
      return json({ error: "Wrong password" }, 401);
    }

    if (path.startsWith("/api/img/") && m === "GET") {
      const id = path.slice(9);
      if (!/^[\w\-]{6,60}$/.test(id)) return new Response("Not found", { status: 404 });
      if (!sbConfigured()) return new Response("Not found", { status: 404 });
      const img = await sbGetImage(id);
      if (!img) return new Response("Not found", { status: 404 });
      return new Response(img.data, { headers: { "content-type": img.type, "cache-control": "public, max-age=31536000, immutable" } });
    }

    // Everything below needs the admin token
    if (path.startsWith("/api/admin/")) {
      if (!(await checkToken(req, env))) return json({ error: "Please log in again" }, 401);

      if (path === "/api/admin/telegram-test" && m === "POST") {
        const r = await tgSend("✅ Test message from your Minnie Store admin. Order alerts will arrive in this chat.");
        return json(r, r.sent ? 200 : 502);
      }
      if (path === "/api/admin/telegram-webhook" && m === "POST") {
        const host = req.headers.get("x-forwarded-host") || url.host, proto = (req.headers.get("x-forwarded-proto") || url.protocol.replace(":", "")).split(",")[0];
        const r = await tgCall("setWebhook", { url: proto + "://" + host + "/api/telegram", secret_token: await tgSecret(env), allowed_updates: ["callback_query"], drop_pending_updates: true });
        return json(r, r.sent ? 200 : 502);
      }
      if (path === "/api/admin/orders" && m === "GET") {
        if (!sbConfigured()) return json({ orders: [], error: "Supabase is not connected" });
        const r = await fetch(SB_URL() + "/rest/v1/orders?order=created_at.desc&limit=100&select=*", { headers: sbHeaders() });
        if (!r.ok) return json({ orders: [], error: "Orders table not found. Run supabase-setup.sql in Supabase." }, 502);
        return json({ orders: (await r.json()).map(publicOrder) });
      }
      if (path === "/api/admin/orders" && m === "PUT") {
        const b = await req.json().catch(() => ({}));
        const code = str(b.code, 12), st = str(b.status, 12);
        if (!/^NS-[A-Z0-9]{5}$/.test(code) || ![...ORDER_FLOW, "rejected"].includes(st)) return json({ error: "Bad request" }, 400);
        const o = await sbOrderGet(code).catch(() => null);
        if (!o) return json({ error: "Order not found" }, 404);
        await setOrderStatus(code, st);
        await tgUpsertOrder(code, st, { by: { who: "admin page", when: new Date().toLocaleString("en-GB", { timeZone: "Asia/Phnom_Penh", hour12: false, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) }, onlyIfExists: true });
        return json({ ok: true });
      }
      if (path === "/api/admin/products" && m === "GET") return json(await load());

      if (path === "/api/admin/products" && m === "PUT") {
        if (!sbConfigured()) return json({ error: "Supabase is not connected yet (SUPABASE_URL / SUPABASE_SERVICE_KEY missing in Vercel)." }, 503);
        const inc = await req.json();
        // stock is counted down by orders; keep the live number for any pack whose stock the admin did not change
        try {
          const cur = await load();
          for (const g of (inc && inc.games) || []) {
            const cg = cur.games.find((x) => x.id === g.id);
            if (cg && (g.stock ?? null) === (g.stock0 ?? null)) g.stock = cg.stock ?? null;
          }
        } catch (e) { /* ignore */ }
        const next = clean(inc);
        await sbSaveConfig(next);
        return json({ ok: true, updatedAt: next.updatedAt, config: next });
      }

      if (path === "/api/admin/image" && m === "POST") {
        if (!sbConfigured()) return json({ error: "Supabase is not connected yet." }, 503);
        const type = (req.headers.get("content-type") || "").split(";")[0];
        if (!["image/jpeg", "image/png", "image/webp"].includes(type)) return json({ error: "Use a JPG, PNG or WebP image" }, 400);
        const buf = await req.arrayBuffer();
        if (buf.byteLength > MAX_IMG_BYTES) return json({ error: "Image is too big (max 600 KB)" }, 413);
        const id = hex(9);
        await sbPutImage(id, type, buf);
        return json({ url: "/api/img/" + id });
      }
    }

    return json({ error: "Not found" }, 404);
  } catch (e) {
    console.error("api error", path, m, e);
    const msg = e && /^(Bad|Too many|A pack)/.test(e.message) ? e.message : "Server error";
    return json({ error: msg }, msg === "Server error" ? 500 : 400);
  }
}
