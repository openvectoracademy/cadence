// functions/api/[[route]].js
// Cadence — single-user auth + state sync backend
// Cloudflare Pages Functions + D1
// Routes:
//   GET  /api/auth/status   → { needs_setup }
//   POST /api/auth/setup    → { token, username, user_id }
//   POST /api/auth/login    → { token, username, user_id }
//   GET  /api/state         → { state, updated_at }   (JWT)
//   PUT  /api/state         → { ok, updated_at }      (JWT)

export async function onRequest(context) {
  const { request, env } = context;

  const CORS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
  };

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS });
  }

  const json = (data, status = 200) =>
    new Response(JSON.stringify(data), {
      status,
      headers: { 'Content-Type': 'application/json', ...CORS },
    });

  const err = (msg, status = 400) => json({ error: msg }, status);

  try {
    const db = env.DB;
    if (!db) return err('Database binding missing', 500);

    // ── sha256 ────────────────────────────────────────────────
    async function sha256(str) {
      const buf = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(str)
      );
      return [...new Uint8Array(buf)]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    }

    // ── JWT (HS256, hand-rolled) ──────────────────────────────
    const JWT_SECRET = env.JWT_SECRET || 'cadence-dev-secret-change-me';

    function b64urlEncode(input) {
      const arr =
        input instanceof Uint8Array ? input : new Uint8Array(input);
      let bin = '';
      for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
      return btoa(bin)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
    }

    function b64urlDecode(str) {
      str = str.replace(/-/g, '+').replace(/_/g, '/');
      while (str.length % 4) str += '=';
      const bin = atob(str);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      return arr;
    }

    async function hmacKey() {
      return crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(JWT_SECRET),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign', 'verify']
      );
    }

    async function signToken(payload) {
      const header = { alg: 'HS256', typ: 'JWT' };
      const h = b64urlEncode(new TextEncoder().encode(JSON.stringify(header)));
      const p = b64urlEncode(new TextEncoder().encode(JSON.stringify(payload)));
      const data = `${h}.${p}`;
      const key = await hmacKey();
      const sig = await crypto.subtle.sign(
        'HMAC',
        key,
        new TextEncoder().encode(data)
      );
      return `${data}.${b64urlEncode(sig)}`;
    }

    async function verifyToken(token) {
      try {
        const parts = String(token || '').split('.');
        if (parts.length !== 3) return null;
        const [h, p, s] = parts;
        const key = await hmacKey();
        const ok = await crypto.subtle.verify(
          'HMAC',
          key,
          b64urlDecode(s),
          new TextEncoder().encode(`${h}.${p}`)
        );
        if (!ok) return null;
        const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
        if (payload.exp && Date.now() > payload.exp) return null;
        return payload;
      } catch {
        return null;
      }
    }

    async function getUser(request) {
      const auth = request.headers.get('Authorization') || '';
      if (!auth.startsWith('Bearer ')) return null;
      return verifyToken(auth.slice(7));
    }

    // ── ensure tables (idempotent per cold start) ────────────
    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS users (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          username TEXT UNIQUE NOT NULL,
          password_hash TEXT NOT NULL,
          created_at INTEGER NOT NULL
        )`
      )
      .run();

    await db
      .prepare(
        `CREATE TABLE IF NOT EXISTS state (
          user_id INTEGER PRIMARY KEY,
          json_blob TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        )`
      )
      .run();

    // ── route parsing ─────────────────────────────────────────
    const url = new URL(request.url);
    let path = url.pathname.replace(/^\/api/, '');
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    const method = request.method;

    let body = {};
    if (['POST', 'PUT', 'PATCH'].includes(method)) {
      try {
        body = await request.json();
      } catch {
        body = {};
      }
    }

    // ══════════════════════════════════════════════════════════
    // AUTH
    // ══════════════════════════════════════════════════════════

    if (method === 'GET' && path === '/auth/status') {
      const row = await db.prepare('SELECT COUNT(*) AS n FROM users').first();
      return json({ needs_setup: !row || Number(row.n) === 0 });
    }

    if (method === 'POST' && path === '/auth/setup') {
      const row = await db.prepare('SELECT COUNT(*) AS n FROM users').first();
      if (row && Number(row.n) > 0) return err('Account already exists', 403);

      const username = String(body.username || '').trim().toLowerCase();
      const password = String(body.password || '');

      if (!/^[a-z0-9_]{3,32}$/.test(username))
        return err('Username must be 3–32 chars: a–z, 0–9, _');
      if (password.length < 4)
        return err('Password must be at least 4 characters');

      const hash = await sha256(password);
      const now = Date.now();

      const result = await db
        .prepare(
          'INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)'
        )
        .bind(username, hash, now)
        .run();

      const userId = result.meta && result.meta.last_row_id;
      const token = await signToken({
        id: userId,
        username,
        exp: now + 365 * 24 * 60 * 60 * 1000,
      });

      return json({ token, username, user_id: userId });
    }

    if (method === 'POST' && path === '/auth/login') {
      const username = String(body.username || '').trim().toLowerCase();
      const password = String(body.password || '');
      if (!username || !password) return err('Username and password required');

      const user = await db
        .prepare('SELECT * FROM users WHERE username = ?')
        .bind(username)
        .first();

      if (!user) return err('Invalid credentials', 401);

      const hash = await sha256(password);
      if (hash !== user.password_hash) return err('Invalid credentials', 401);

      const token = await signToken({
        id: user.id,
        username: user.username,
        exp: Date.now() + 365 * 24 * 60 * 60 * 1000,
      });

      return json({ token, username: user.username, user_id: user.id });
    }

    // ══════════════════════════════════════════════════════════
    // STATE (JWT required)
    // ══════════════════════════════════════════════════════════

    if (method === 'GET' && path === '/state') {
      const user = await getUser(request);
      if (!user) return err('Unauthorized', 401);

      const row = await db
        .prepare('SELECT json_blob, updated_at FROM state WHERE user_id = ?')
        .bind(user.id)
        .first();

      if (!row) return json({ state: null, updated_at: 0 });
      return json({
        state: JSON.parse(row.json_blob),
        updated_at: row.updated_at,
      });
    }

    if (method === 'PUT' && path === '/state') {
      const user = await getUser(request);
      if (!user) return err('Unauthorized', 401);

      if (!body || typeof body.state !== 'object' || body.state === null)
        return err('Missing state object');

      const now = Date.now();
      const blob = JSON.stringify(body.state);

      await db
        .prepare(
          `INSERT INTO state (user_id, json_blob, updated_at)
           VALUES (?, ?, ?)
           ON CONFLICT(user_id) DO UPDATE SET
             json_blob = excluded.json_blob,
             updated_at = excluded.updated_at`
        )
        .bind(user.id, blob, now)
        .run();

      return json({ ok: true, updated_at: now });
    }

    return err('Not found', 404);
  } catch (e) {
    return json(
      { error: 'Server error: ' + (e && e.message ? e.message : 'unknown') },
      500
    );
  }
}
