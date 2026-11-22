// Mythbeast Realm — sunucu: hesaplar ve bulut kaydı.
// /api/* istekleri buraya gelir, diğer her şey statik oyun dosyalarıdır (ASSETS).
// Veritabanı: Cloudflare D1 (binding: DB). Tablolar ilk istekte kendiliğinden kurulur.

const EZ_IDS = new Set(['83', '84', '85']);           // sadece oyunun sahibine açık kartlar
const PBKDF2_ITER = 20000;                            // ücretsiz planın işlemci sınırına uygun
const SESSION_DAYS = 180;
const MAX_SAVE = 512 * 1024;                          // bir kaydın en büyük boyutu (bayt)
const USER_RE = /^[A-Za-z0-9_çğıöşüÇĞİÖŞÜ]{3,16}$/;

let schemaReady = null;
function ensureSchema(db) {
  if (!schemaReady) schemaReady = db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, ukey TEXT UNIQUE NOT NULL, name TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL, created INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS saves (user_id INTEGER PRIMARY KEY, data TEXT NOT NULL, t INTEGER NOT NULL, updated INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS fails (ukey TEXT PRIMARY KEY, n INTEGER NOT NULL, until INTEGER NOT NULL)`),
  ]).catch(e => { schemaReady = null; throw e; });
  return schemaReady;
}

const json = (obj, status = 200) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
const err = (msg, status = 400) => json({ error: msg }, status);

const hex = buf => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
const randHex = n => hex(crypto.getRandomValues(new Uint8Array(n)));
const ukeyOf = u => u.toLocaleLowerCase('tr');

async function hashPw(pw, saltHex) {
  const salt = new Uint8Array(saltHex.match(/../g).map(h => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
  return hex(await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: PBKDF2_ITER }, key, 256));
}
function sameStr(a, b) {                                // sabit süreli karşılaştırma
  if (a.length !== b.length) return false;
  let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

const isOwner = (env, user) => !!env.OWNER && ukeyOf(user.name) === ukeyOf(env.OWNER);

// Sahibi olmayan hesapların kaydından özel kartları çıkarır, sahibine ekler.
function fixEz(data, owner) {
  if (!data || typeof data.owned !== 'object' || !data.owned) return data;
  for (const k of Object.keys(data.owned)) {
    const base = String(k).match(/^\d+/);
    if (base && EZ_IDS.has(base[0]) && !owner) delete data.owned[k];
  }
  if (owner) for (const id of EZ_IDS) if (!data.owned[id]) data.owned[id] = 1;
  return data;
}

async function newSession(db, userId) {
  const token = randHex(32);
  await db.prepare('INSERT INTO sessions (token, user_id, expires) VALUES (?, ?, ?)')
    .bind(token, userId, Date.now() + SESSION_DAYS * 864e5).run();
  return token;
}

async function authUser(req, db) {
  const m = (req.headers.get('authorization') || '').match(/^Bearer ([0-9a-f]{64})$/);
  if (!m) return null;
  const row = await db.prepare('SELECT u.id, u.name, s.expires FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?')
    .bind(m[1]).first();
  if (!row || row.expires < Date.now()) return null;
  return { id: row.id, name: row.name, token: m[1] };
}

async function readBody(req) {
  const txt = await req.text();
  if (txt.length > MAX_SAVE + 1024) throw new Error('too_big');
  try { return JSON.parse(txt || '{}'); } catch { throw new Error('bad_json'); }
}

async function handleApi(req, env, path) {
  const db = env.DB;
  if (!db) return err('Sunucu veritabanı ayarlı değil.', 500);
  await ensureSchema(db);
  const method = req.method;

  if (path === '/api/register' && method === 'POST') {
    const { u, p } = await readBody(req);
    if (typeof u !== 'string' || !USER_RE.test(u)) return err('Kullanıcı adı 3-16 karakter olmalı: harf, rakam ya da _');
    if (typeof p !== 'string' || p.length < 6 || p.length > 64) return err('Şifre en az 6 karakter olmalı.');
    const ukey = ukeyOf(u);
    if (await db.prepare('SELECT 1 FROM users WHERE ukey = ?').bind(ukey).first()) return err('Bu kullanıcı adı alınmış.', 409);
    const salt = randHex(16), hash = await hashPw(p, salt);
    let id;
    try {
      const r = await db.prepare('INSERT INTO users (ukey, name, salt, hash, created) VALUES (?, ?, ?, ?, ?)')
        .bind(ukey, u, salt, hash, Date.now()).run();
      id = r.meta.last_row_id;
    } catch { return err('Bu kullanıcı adı alınmış.', 409); }
    const user = { id, name: u };
    return json({ token: await newSession(db, id), user: u, owner: isOwner(env, user), save: null });
  }

  if (path === '/api/login' && method === 'POST') {
    const { u, p } = await readBody(req);
    if (typeof u !== 'string' || typeof p !== 'string') return err('Kullanıcı adı ve şifre gerekli.');
    const ukey = ukeyOf(u), now = Date.now();
    const f = await db.prepare('SELECT n, until FROM fails WHERE ukey = ?').bind(ukey).first();
    if (f && f.until > now) return err('Çok fazla yanlış deneme. Birkaç dakika sonra tekrar dene.', 429);
    const row = await db.prepare('SELECT id, name, salt, hash FROM users WHERE ukey = ?').bind(ukey).first();
    const ok = row && sameStr(await hashPw(p, row.salt), row.hash);
    if (!ok) {
      const n = (f && f.until > now - 15 * 6e4 ? f.n : 0) + 1;
      await db.prepare('INSERT INTO fails (ukey, n, until) VALUES (?, ?, ?) ON CONFLICT(ukey) DO UPDATE SET n = excluded.n, until = excluded.until')
        .bind(ukey, n, n >= 5 ? now + 5 * 6e4 : now).run();
      return err('Kullanıcı adı ya da şifre yanlış.', 401);
    }
    if (f) await db.prepare('DELETE FROM fails WHERE ukey = ?').bind(ukey).run();
    const user = { id: row.id, name: row.name }, owner = isOwner(env, user);
    const sv = await db.prepare('SELECT data, t FROM saves WHERE user_id = ?').bind(row.id).first();
    return json({ token: await newSession(db, row.id), user: row.name, owner,
      save: sv ? { data: fixEz(JSON.parse(sv.data), owner), t: sv.t } : null });
  }

  const user = await authUser(req, db);
  if (!user) return err('Oturum geçersiz. Tekrar giriş yap.', 401);
  const owner = isOwner(env, user);

  if (path === '/api/logout' && method === 'POST') {
    await db.prepare('DELETE FROM sessions WHERE token = ?').bind(user.token).run();
    return json({ ok: true });
  }
  if (path === '/api/me' && method === 'GET') {
    const sv = await db.prepare('SELECT data, t FROM saves WHERE user_id = ?').bind(user.id).first();
    return json({ user: user.name, owner, save: sv ? { data: fixEz(JSON.parse(sv.data), owner), t: sv.t } : null });
  }
  if (path === '/api/save' && method === 'PUT') {
    const body = await readBody(req);
    const data = body && body.data;
    if (!data || typeof data !== 'object' || typeof data.owned !== 'object') return err('Kayıt geçersiz.');
    const txt = JSON.stringify(fixEz(data, owner));
    if (txt.length > MAX_SAVE) return err('Kayıt çok büyük.', 413);
    const t = Number(data.t) || Date.now();
    await db.prepare('INSERT INTO saves (user_id, data, t, updated) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, t = excluded.t, updated = excluded.updated')
      .bind(user.id, txt, t, Date.now()).run();
    return json({ ok: true, t });
  }
  return err('Bulunamadı.', 404);
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname.startsWith('/api/')) {
      try { return await handleApi(req, env, url.pathname); }
      catch (e) {
        if (e && e.message === 'too_big') return err('Kayıt çok büyük.', 413);
        if (e && e.message === 'bad_json') return err('İstek bozuk.');
        return err('Sunucu hatası.', 500);
      }
    }
    return env.ASSETS.fetch(req);
  },
};
