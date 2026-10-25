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

/* ---------- validation: never trust the client ---------- */
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
      if (!out.name) throw new Error("A pack in " + str(g.name, 40) + " has no name");
      return out;
    });
    const fields = (Array.isArray(g.fields) ? g.fields : []).slice(0, 6).map((f, j) => ({
      key: slug(f.key || f.label, "f" + (j + 1)).replace(/-/g, "_"),
      label: str(f.label, 60) || "Details",
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
    return d.ok ? { sent: true } : { sent: false, error: "Telegram said: " + str(d.description || ("HTTP " + r.status), 200) };
  } catch (e) { return { sent: false, error: "Could not reach Telegram." }; }
  finally { clearTimeout(t); }
}
const tgSend = (text, markup) => tgCall("sendMessage", { chat_id: ENV.TELEGRAM_CHAT_ID, text: String(text).slice(0, 3500), disable_web_page_preview: true, ...(markup ? { reply_markup: markup } : {}) });
const tgSecret = async (env) => b64url(await hmac(await secret(env), "tg-webhook")).slice(0, 40);
/* ---- customer login with Telegram (Login Widget): signed proof from Telegram -> our own 30-day customer token ---- */
let botNameCache = "";
async function botUsername() {
  if (ENV.TELEGRAM_BOT_USERNAME) return String(ENV.TELEGRAM_BOT_USERNAME).replace(/^@/, "");
  if (botNameCache || !ENV.TELEGRAM_BOT_TOKEN) return botNameCache;
  try {
    const api = (ENV.TELEGRAM_API || "https://api.telegram.org").replace(/\/+$/, "");
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 3000);
    const d = await fetch(api + "/bot" + ENV.TELEGRAM_BOT_TOKEN + "/getMe", { signal: ctl.signal }).then((r) => r.json()); clearTimeout(t);
    if (d && d.ok && d.result && d.result.username) botNameCache = d.result.username;
  } catch (e) {}
  return botNameCache;
}
const custKey = async (env) => new Uint8Array(await hmac(await secret(env), "customer-v1"));
async function makeCustToken(env, u) {
  const payload = b64url(enc.encode(JSON.stringify({ exp: Date.now() + 30 * 86400000, id: u.id, name: u.name, un: u.un })));
  return payload + "." + b64url(await hmac(await custKey(env), payload));
}
async function readCustToken(env, t) {
  const [payload, sig] = String(t || "").split(".");
  if (!payload || !sig || !env.ADMIN_PASSWORD) return null;
  if (!(await safeEq(b64url(await hmac(await custKey(env), payload)), sig))) return null;
  try { const o = JSON.parse(new TextDecoder().decode(unb64url(payload))); return o.exp > Date.now() ? o : null; } catch (e) { return null; }
}
async function verifyTelegramLogin(env, d) {
  if (!d || typeof d !== "object" || !env.TELEGRAM_BOT_TOKEN || !d.hash || !d.id) return false;
  const check = Object.keys(d).filter((k) => k !== "hash").sort().map((k) => k + "=" + d[k]).join("\n");
  const key = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(env.TELEGRAM_BOT_TOKEN)));
  const mac = Array.from(new Uint8Array(await hmac(key, check)), (b) => b.toString(16).padStart(2, "0")).join("");
  if (!(await safeEq(mac, String(d.hash).toLowerCase()))) return false;
  return Date.now() / 1000 - Number(d.auth_date) < 86400;
}
const custLine = (c) => c ? "Telegram: " + (c.un ? "@" + c.un : c.name) + (c.un ? " (" + c.name + ")" : "") + " · id " + c.id : "Telegram: not logged in";
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
      return json({ ...cfg, games: cfg.games.filter((g) => !g.hidden), loginBot: await botUsername() });
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
        telegramLoginBot: await botUsername(),
        settingNamesSeen: Object.keys(env).filter((k) => /admin|supabase|telegram/i.test(k)).map((k) => JSON.stringify(k)),
      });
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
      const khr = p.khr || Math.round((p.usd * cfg.settings.khrRate) / 100) * 100;
      const cust = await readCustToken(env, body.cust);
      const text = (event === "paid" ? "🟡 TO VERIFY: customer says they paid\nCheck your bank app, then tap a button below.\n\n" : "⏳ PENDING: customer opened the payment page\n\n") +
        "Order: " + code + "\nGame: " + g.name + "\nPack: " + p.name + "\nAccount: " + (str(body.account, 120) || "-") + "\n" + custLine(cust) +
        "\nTotal: $" + p.usd.toFixed(2) + " (" + khr.toLocaleString("en-US") + " ៛)";
      const r = await tgSend(text, event === "paid" ? { inline_keyboard: [[{ text: "✅ Payment received", callback_data: "ok:" + code }, { text: "❌ Not received", callback_data: "no:" + code }]] } : null);
      return json({ ok: true, sent: r.sent });
    }

    // Telegram calls this when someone taps a button on an order message (secret header proves it is Telegram)
    if (path === "/api/telegram" && m === "POST") {
      if (!tgReady() || !env.ADMIN_PASSWORD) return json({ ok: false }, 503);
      if (!(await safeEq(req.headers.get("x-telegram-bot-api-secret-token") || "", await tgSecret(env)))) return json({ ok: false }, 401);
      const up = await req.json().catch(() => ({}));
      const cq = up && up.callback_query, msg = cq && cq.message;
      const mt = /^(ok|no):(NS-[A-Z0-9]{5})$/.exec(String((cq && cq.data) || ""));
      if (cq && msg && mt && String(msg.chat && msg.chat.id) === String(env.TELEGRAM_CHAT_ID)) {
        const who = str([cq.from && cq.from.first_name, cq.from && cq.from.last_name].filter(Boolean).join(" ") || (cq.from && cq.from.username) || "someone", 60);
        const when = new Date().toLocaleString("en-GB", { timeZone: "Asia/Phnom_Penh", hour12: false, day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
        const body = String(msg.text || "").split("\n\n").slice(1).join("\n\n");
        const head = mt[1] === "ok" ? "✅ PAID: COMPLETE\nConfirmed by " + who + " · " + when : "❌ NOT RECEIVED\nMarked by " + who + " · " + when;
        await tgCall("editMessageText", { chat_id: msg.chat.id, message_id: msg.message_id, text: head + "\n\n" + body, reply_markup: { inline_keyboard: [] } });
        await tgCall("answerCallbackQuery", { callback_query_id: cq.id, text: mt[1] === "ok" ? "Marked as paid" : "Marked as not received" });
      } else if (cq && cq.id) { await tgCall("answerCallbackQuery", { callback_query_id: cq.id }); }
      return json({ ok: true });
    }

    // Customer login: the browser sends what the Telegram Login Widget gave it; we check Telegram's signature
    if (path === "/api/tglogin" && m === "POST") {
      const ip = (req.headers.get("x-forwarded-for") || "").split(",")[0].trim() || "x";
      if (throttled("login:" + ip, 15, 60000)) return json({ error: "Too many requests" }, 429);
      const d = await req.json().catch(() => ({}));
      if (!(await verifyTelegramLogin(env, d))) return json({ error: "Telegram login failed" }, 401);
      const name = str([d.first_name, d.last_name].filter(Boolean).join(" "), 60) || "Customer";
      const un = str(d.username, 40).replace(/[^\w]/g, "");
      return json({ token: await makeCustToken(env, { id: String(d.id).replace(/\D/g, "").slice(0, 20), name, un }), name, username: un });
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
      if (path === "/api/admin/products" && m === "GET") return json(await load());

      if (path === "/api/admin/products" && m === "PUT") {
        if (!sbConfigured()) return json({ error: "Supabase is not connected yet (SUPABASE_URL / SUPABASE_SERVICE_KEY missing in Vercel)." }, 503);
        const next = clean(await req.json());
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
