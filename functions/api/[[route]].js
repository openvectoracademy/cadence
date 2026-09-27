/**
 * Cadence — backend API
 * Cloudflare Pages Functions, single catch-all route.
 *
 * Routes (all under /api):
 *   GET  /api/auth/status   → { exists: boolean }              (public)
 *   POST /api/auth/setup    → { token, username }              (public, only if no account)
 *   POST /api/auth/login    → { token, username }              (public)
 *   GET  /api/auth/me       → { username }                     (auth)
 *   GET  /api/state         → { data, version, updated_at }    (auth)
 *   PUT  /api/state         → { ok, updated_at, version }      (auth)
 *
 * Tables are created lazily on first request via ensureTables().
 * Single-user model: account has exactly one row; app_state has exactly one row.
 *
 * Design principle: the frontend is local-first. This API is only touched on
 * explicit save/restore and on the auto-beacon that fires when the tab closes
 * with unsynced changes. No per-tap writes.
 */

const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 365; // 1 year
const enc = new TextEncoder();

// ── entry ────────────────────────────────────────────────────────────────────
export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/api";
  const method = request.method.toUpperCase();

  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
  };

  if (method === "OPTIONS") {
    return new Response(null, { status: 204, headers: cors });
  }

  try {
    if (!env.DB) return json({ error: "Server misconfigured." }, 500, cors);
    if (!env.JWT_SECRET) return json({ error: "Server misconfigured." }, 500, cors);

    await ensureTables(env.DB);

    // ── public routes ────────────────────────────────────────────────────────
    if (path === "/api/auth/status" && method === "GET") {
      return await authStatus(env, cors);
    }
    if (path === "/api/auth/setup" && method === "POST") {
      return await authSetup(request, env, cors);
    }
    if (path === "/api/auth/login" && method === "POST") {
      return await authLogin(request, env, cors);
    }

    // ── protected routes ─────────────────────────────────────────────────────
    const auth = await requireAuth(request, env);
    if (!auth.ok) return json({ error: "Unauthorized." }, 401, cors);

    if (path === "/api/auth/me" && method === "GET") {
      return json({ username: auth.username }, 200, cors);
    }
    if (path === "/api/state" && method === "GET") {
      return await stateGet(env, cors);
    }
    if (path === "/api/state" && method === "PUT") {
      return await statePut(request, env, cors);
    }

    return json({ error: "Not found." }, 404, cors);
  } catch {
    return json({ error: "Something went wrong." }, 500, cors);
  }
}

// ── schema ───────────────────────────────────────────────────────────────────
async function ensureTables(db) {
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS account (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         username TEXT NOT NULL,
         password_hash TEXT NOT NULL,
         created_at TEXT NOT NULL,
         updated_at TEXT NOT NULL
       )`
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS app_state (
         id INTEGER PRIMARY KEY CHECK (id = 1),
         data TEXT NOT NULL,
         version INTEGER NOT NULL DEFAULT 1,
         updated_at TEXT NOT NULL
       )`
    ),
  ]);
}

// ── handlers: auth ───────────────────────────────────────────────────────────
async function authStatus(env, cors) {
  const row = await env.DB.prepare(
    "SELECT id FROM account WHERE id = 1"
  ).first();
  return json({ exists: !!row }, 200, cors);
}

async function authSetup(request, env, cors) {
  const existing = await env.DB.prepare(
    "SELECT id FROM account WHERE id = 1"
  ).first();
  if (existing) return json({ error: "Account already exists." }, 409, cors);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request." }, 400, cors);
  }

  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (username.length < 3 || username.length > 40) {
    return json({ error: "Username must be 3–40 characters." }, 400, cors);
  }
  if (password.length < 6) {
    return json({ error: "Password must be at least 6 characters." }, 400, cors);
  }

  const now = new Date().toISOString();
  const hash = await sha256Hex(password);

  await env.DB.prepare(
    `INSERT INTO account (id, username, password_hash, created_at, updated_at)
     VALUES (1, ?, ?, ?, ?)`
  )
    .bind(username, hash, now, now)
    .run();

  const token = await signToken({ sub: 1, username }, env.JWT_SECRET);
  return json({ token, username }, 200, cors);
}

async function authLogin(request, env, cors) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request." }, 400, cors);
  }

  const username = typeof body.username === "string" ? body.username.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!username || !password) {
    return json({ error: "Invalid username or password." }, 401, cors);
  }

  const row = await env.DB.prepare(
    "SELECT username, password_hash FROM account WHERE id = 1"
  ).first();

  // Generic failure — never reveal whether the user or the password was wrong.
  if (!row) return json({ error: "Invalid username or password." }, 401, cors);

  const hash = await sha256Hex(password);
  if (row.username !== username || row.password_hash !== hash) {
    return json({ error: "Invalid username or password." }, 401, cors);
  }

  const token = await signToken({ sub: 1, username: row.username }, env.JWT_SECRET);
  return json({ token, username: row.username }, 200, cors);
}

// ── handlers: state ──────────────────────────────────────────────────────────
async function stateGet(env, cors) {
  const row = await env.DB.prepare(
    "SELECT data, version, updated_at FROM app_state WHERE id = 1"
  ).first();

  if (!row) {
    return json({ data: null, version: 0, updated_at: null }, 200, cors);
  }

  let parsed;
  try {
    parsed = JSON.parse(row.data);
  } catch {
    return json({ error: "Stored state is corrupted." }, 500, cors);
  }

  return json(
    { data: parsed, version: row.version, updated_at: row.updated_at },
    200,
    cors
  );
}

async function statePut(request, env, cors) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request." }, 400, cors);
  }

  if (!body || typeof body.data !== "object" || body.data === null) {
    return json({ error: "Invalid state payload." }, 400, cors);
  }

  const now = new Date().toISOString();
  const serialized = JSON.stringify(body.data);

  const existing = await env.DB.prepare(
    "SELECT version FROM app_state WHERE id = 1"
  ).first();
  const nextVersion = (existing?.version || 0) + 1;

  await env.DB.prepare(
    `INSERT INTO app_state (id, data, version, updated_at)
     VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       data = excluded.data,
       version = excluded.version,
       updated_at = excluded.updated_at`
  )
    .bind(serialized, nextVersion, now)
    .run();

  return json({ ok: true, updated_at: now, version: nextVersion }, 200, cors);
}

// ── auth: token verification ─────────────────────────────────────────────────
async function requireAuth(request, env) {
  const header = request.headers.get("Authorization") || "";
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return { ok: false };

  const payload = await verifyToken(m[1], env.JWT_SECRET);
  if (!payload) return { ok: false };

  const row = await env.DB.prepare(
    "SELECT username FROM account WHERE id = 1"
  ).first();
  if (!row || row.username !== payload.username) return { ok: false };

  return { ok: true, username: row.username };
}

// ── JWT (HS256 via crypto.subtle — no libraries) ─────────────────────────────
function b64urlEncode(bytes) {
  let str = "";
  for (let i = 0; i < bytes.length; i++) str += String.fromCharCode(bytes[i]);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecodeToString(input) {
  let s = input.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return atob(s);
}

async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

async function signToken(payload, secret) {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const full = { ...payload, iat: now, exp: now + TOKEN_TTL_SECONDS };

  const h = b64urlEncode(enc.encode(JSON.stringify(header)));
  const p = b64urlEncode(enc.encode(JSON.stringify(full)));
  const data = `${h}.${p}`;

  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return `${data}.${b64urlEncode(new Uint8Array(sig))}`;
}

async function verifyToken(token, secret) {
  if (typeof token !== "string") return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [h, p, s] = parts;
  const data = `${h}.${p}`;

  let sigBytes;
  try {
    const raw = b64urlDecodeToString(s);
    sigBytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) sigBytes[i] = raw.charCodeAt(i);
  } catch {
    return null;
  }

  const key = await hmacKey(secret);
  const ok = await crypto.subtle.verify(
    "HMAC",
    key,
    sigBytes,
    enc.encode(data)
  );
  if (!ok) return null;

  let payload;
  try {
    payload = JSON.parse(b64urlDecodeToString(p));
  } catch {
    return null;
  }

  if (typeof payload.exp !== "number") return null;
  if (payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

// ── password hashing (SHA-256 hex) ───────────────────────────────────────────
async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", enc.encode(text));
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

// ── helpers ──────────────────────────────────────────────────────────────────
function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...cors,
    },
  });
}
