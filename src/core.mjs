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
async function tgSend(text) {
  if (!tgReady()) return { sent: false, error: "Telegram is not set up on the server (TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID)." };
  const api = (ENV.TELEGRAM_API || "https://api.telegram.org").replace(/\/+$/, "");
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 6000);
  try {
    const r = await fetch(api + "/bot" + ENV.TELEGRAM_BOT_TOKEN + "/sendMessage", {
      method: "POST", headers: { "content-type": "application/json" }, signal: ctl.signal,
      body: JSON.stringify({ chat_id: ENV.TELEGRAM_CHAT_ID, text: String(text).slice(0, 3500), disable_web_page_preview: true }),
    });
    const d = await r.json().catch(() => ({}));
    return d.ok ? { sent: true } : { sent: false, error: "Telegram said: " + str(d.description || ("HTTP " + r.status), 200) };
  } catch (e) { return { sent: false, error: "Could not reach Telegram." }; }
  finally { clearTimeout(t); }
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
      return json({ ...cfg, games: cfg.games.filter((g) => !g.hidden) });
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
      const text = (event === "paid" ? "✅ CUSTOMER SAYS THEY PAID\nPlease check your bank app before delivering.\n\n" : "🛒 New order (customer opened the payment pop-up)\n\n") +
        "Order: " + code + "\nGame: " + g.name + "\nPack: " + p.name + "\nAccount: " + (str(body.account, 120) || "-") +
        "\nTotal: $" + p.usd.toFixed(2) + " (" + khr.toLocaleString("en-US") + " ៛)";
      const r = await tgSend(text);
      return json({ ok: true, sent: r.sent });
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
