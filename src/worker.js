// Mythbeast Realm — sunucu: hesaplar ve bulut kaydı.
// /api/* istekleri buraya gelir, diğer her şey statik oyun dosyalarıdır (ASSETS).
// Veritabanı: Cloudflare D1 (binding: DB). Tablolar ilk istekte kendiliğinden kurulur.

const EZ_IDS = new Set(['83', '84', '85']);           // sadece oyunun sahibine açık kartlar
const PBKDF2_ITER = 20000;                            // ücretsiz planın işlemci sınırına uygun
const SESSION_DAYS = 180;
const MAX_SAVE = 512 * 1024;                          // bir kaydın en büyük boyutu (bayt)
const MAX_FRIENDS = 50, MAX_PENDING = 30;
const USER_RE = /^[A-Za-z0-9_çğıöşüÇĞİÖŞÜ]{3,16}$/;

let schemaReady = null;
function ensureSchema(db) {
  if (!schemaReady) schemaReady = db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY AUTOINCREMENT, ukey TEXT UNIQUE NOT NULL, name TEXT NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL, created INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL, expires INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS saves (user_id INTEGER PRIMARY KEY, data TEXT NOT NULL, t INTEGER NOT NULL, updated INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS fails (ukey TEXT PRIMARY KEY, n INTEGER NOT NULL, until INTEGER NOT NULL)`),
    // arkadaşlar: a = isteği gönderen, b = alan; status 'pending' ya da 'ok'
    db.prepare(`CREATE TABLE IF NOT EXISTS friends (a INTEGER NOT NULL, b INTEGER NOT NULL, status TEXT NOT NULL, t INTEGER NOT NULL, PRIMARY KEY (a, b))`),
    db.prepare(`CREATE INDEX IF NOT EXISTS friends_b ON friends (b)`),
    // arkadaşların görebildiği özet: istatistikler ve arena destesi
    db.prepare(`CREATE TABLE IF NOT EXISTS pub (user_id INTEGER PRIMARY KEY, stats TEXT NOT NULL, deck TEXT NOT NULL, updated INTEGER NOT NULL)`),
    // arkadaş destesine karşı yapılan savaşlar
    db.prepare(`CREATE TABLE IF NOT EXISTS duels (id INTEGER PRIMARY KEY AUTOINCREMENT, from_id INTEGER NOT NULL, to_id INTEGER NOT NULL, win INTEGER NOT NULL, t INTEGER NOT NULL)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS duels_to ON duels (to_id, t)`),
  ]).then(async () => {
    // kayıt sürümü: iki cihaz aynı anda oynarsa eski sürüm yenisinin üstüne yazamaz
    try { await db.prepare('ALTER TABLE saves ADD COLUMN rev INTEGER NOT NULL DEFAULT 0').run(); }
    catch (e) { if (!/duplicate column/i.test(String(e && e.message))) throw e; }
  }).catch(e => { schemaReady = null; throw e; });
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

// Arkadaşın görebileceği istatistikler: sadece beklenen alanlar, sınırlı değerler.
function cleanStats(st) {
  const n = (v, max) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));
  st = st && typeof st === 'object' ? st : {};
  return { tr: n(st.tr, 1e6), lg: n(st.lg, 50), lvl: n(st.lvl, 1000), col: n(st.col, 5000), tot: n(st.tot, 5000), w: n(st.w, 1e7), l: n(st.l, 1e7) };
}
function cleanDeck(deck, owner) {
  if (!Array.isArray(deck)) return [];
  return deck.slice(0, 30).filter(k => (typeof k === 'number' && Number.isInteger(k) && k > 0 && k < 100000 && (owner || !EZ_IDS.has(String(k))))
    || (typeof k === 'string' && /^s:[a-z]{2,12}$/.test(k)));
}
async function userByName(db, u) {
  if (typeof u !== 'string' || !USER_RE.test(u)) return null;
  return db.prepare('SELECT id, name FROM users WHERE ukey = ?').bind(ukeyOf(u)).first();
}
async function friendRow(db, x, y) {   // iki kişi arasındaki ilişki (yön fark etmez)
  return db.prepare('SELECT a, b, status FROM friends WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)').bind(x, y, y, x).first();
}
async function areFriends(db, x, y) { const r = await friendRow(db, x, y); return !!r && r.status === 'ok'; }

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
    const sv = await db.prepare('SELECT data, t, rev FROM saves WHERE user_id = ?').bind(row.id).first();
    return json({ token: await newSession(db, row.id), user: row.name, owner,
      save: sv ? { data: fixEz(JSON.parse(sv.data), owner), t: sv.t, rev: sv.rev } : null });
  }

  const user = await authUser(req, db);
  if (!user) return err('Oturum geçersiz. Tekrar giriş yap.', 401);
  const owner = isOwner(env, user);

  if (path === '/api/logout' && method === 'POST') {
    await db.prepare('DELETE FROM sessions WHERE token = ?').bind(user.token).run();
    return json({ ok: true });
  }
  if (path === '/api/me' && method === 'GET') {
    const sv = await db.prepare('SELECT data, t, rev FROM saves WHERE user_id = ?').bind(user.id).first();
    return json({ user: user.name, owner, save: sv ? { data: fixEz(JSON.parse(sv.data), owner), t: sv.t, rev: sv.rev } : null });
  }
  if (path === '/api/save' && method === 'PUT') {
    const body = await readBody(req);
    const data = body && body.data;
    if (!data || typeof data !== 'object' || typeof data.owned !== 'object') return err('Kayıt geçersiz.');
    const txt = JSON.stringify(fixEz(data, owner));
    if (txt.length > MAX_SAVE) return err('Kayıt çok büyük.', 413);
    const t = Number(data.t) || Date.now(), now = Date.now();
    let rev;
    if (Number.isInteger(body.rev)) {
      // sadece cihazın bildiği sürüm hâlâ en güncelse yazılır
      const up = await db.prepare('UPDATE saves SET data = ?, t = ?, updated = ?, rev = rev + 1 WHERE user_id = ? AND rev = ? RETURNING rev')
        .bind(txt, t, now, user.id, body.rev).first();
      if (up) rev = up.rev;
      else {
        const cur = await db.prepare('SELECT data, t, rev FROM saves WHERE user_id = ?').bind(user.id).first();
        if (cur) return json({ error: 'Bu hesap başka bir cihazda oynandı.', conflict: true,
          save: { data: fixEz(JSON.parse(cur.data), owner), t: cur.t, rev: cur.rev } }, 409);
        await db.prepare('INSERT INTO saves (user_id, data, t, updated, rev) VALUES (?, ?, ?, ?, 1)').bind(user.id, txt, t, now).run();
        rev = 1;
      }
    } else {   // eski sürüm oyun sayfaları için (sürüm bilmeden yazar)
      const r = await db.prepare('INSERT INTO saves (user_id, data, t, updated, rev) VALUES (?, ?, ?, ?, 1) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, t = excluded.t, updated = excluded.updated, rev = saves.rev + 1 RETURNING rev')
        .bind(user.id, txt, t, now).first();
      rev = r.rev;
    }
    const ops = [];
    if (body.pub) ops.push(db.prepare('INSERT INTO pub (user_id, stats, deck, updated) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET stats = excluded.stats, deck = excluded.deck, updated = excluded.updated')
      .bind(user.id, JSON.stringify(cleanStats(body.pub)), JSON.stringify(cleanDeck(body.deck, owner)), Date.now()));
    if (ops.length) await db.batch(ops);
    return json({ ok: true, t, rev });
  }

  // ---------- ARKADAŞLAR ----------
  if (path === '/api/friends' && method === 'GET') {
    const rows = (await db.prepare(`SELECT f.a, f.b, f.status, u.id AS oid, u.name, p.stats, p.updated
      FROM friends f JOIN users u ON u.id = CASE WHEN f.a = ?1 THEN f.b ELSE f.a END
      LEFT JOIN pub p ON p.user_id = u.id WHERE f.a = ?1 OR f.b = ?1`).bind(user.id).all()).results || [];
    const friends = [], incoming = [], outgoing = [];
    for (const r of rows) {
      if (r.status === 'ok') friends.push({ name: r.name, stats: r.stats ? JSON.parse(r.stats) : null, seen: r.updated || 0 });
      else if (r.b === user.id) incoming.push(r.name); else outgoing.push(r.name);
    }
    const duels = ((await db.prepare(`SELECT u.name, d.win, d.t FROM duels d JOIN users u ON u.id = d.from_id
      WHERE d.to_id = ? ORDER BY d.t DESC LIMIT 15`).bind(user.id).all()).results || []).map(d => ({ name: d.name, win: !!d.win, t: d.t }));
    return json({ friends, incoming, outgoing, duels });
  }
  if (path === '/api/friends/request' && method === 'POST') {
    const { u } = await readBody(req);
    const o = await userByName(db, u);
    if (!o) return err('Bu kullanıcı adıyla oyuncu bulunamadı.', 404);
    if (o.id === user.id) return err('Kendini arkadaş olarak ekleyemezsin.');
    const r = await friendRow(db, user.id, o.id);
    if (r && r.status === 'ok') return err(`${o.name} zaten arkadaşın.`);
    if (r && r.a === user.id) return err(`${o.name} kişisine zaten istek gönderdin.`);
    const cnt = n => db.prepare(`SELECT COUNT(*) AS n FROM friends WHERE status = 'ok' AND (a = ? OR b = ?)`).bind(n, n).first();
    if ((await cnt(user.id)).n >= MAX_FRIENDS) return err(`En fazla ${MAX_FRIENDS} arkadaşın olabilir.`);
    if (r && r.b === user.id) {           // o da sana istek göndermişse direkt arkadaş olursunuz
      await db.prepare(`UPDATE friends SET status = 'ok', t = ? WHERE a = ? AND b = ?`).bind(Date.now(), o.id, user.id).run();
      return json({ ok: true, accepted: true, name: o.name });
    }
    const pend = await db.prepare(`SELECT COUNT(*) AS n FROM friends WHERE status = 'pending' AND a = ?`).bind(user.id).first();
    if (pend.n >= MAX_PENDING) return err('Çok fazla bekleyen isteğin var.');
    await db.prepare(`INSERT INTO friends (a, b, status, t) VALUES (?, ?, 'pending', ?)`).bind(user.id, o.id, Date.now()).run();
    return json({ ok: true, accepted: false, name: o.name });
  }
  if (path === '/api/friends/accept' && method === 'POST') {
    const { u } = await readBody(req);
    const o = await userByName(db, u);
    if (!o) return err('Oyuncu bulunamadı.', 404);
    const r = await db.prepare(`UPDATE friends SET status = 'ok', t = ? WHERE a = ? AND b = ? AND status = 'pending'`).bind(Date.now(), o.id, user.id).run();
    if (!r.meta.changes) return err('Bu kişiden bekleyen istek yok.', 404);
    return json({ ok: true, name: o.name });
  }
  if ((path === '/api/friends/decline' || path === '/api/friends/remove') && method === 'POST') {
    const { u } = await readBody(req);
    const o = await userByName(db, u);
    if (!o) return err('Oyuncu bulunamadı.', 404);
    await db.prepare('DELETE FROM friends WHERE (a = ? AND b = ?) OR (a = ? AND b = ?)').bind(user.id, o.id, o.id, user.id).run();
    return json({ ok: true });
  }
  if (path === '/api/friends/deck' && method === 'GET') {
    const o = await userByName(db, new URL(req.url).searchParams.get('u'));
    if (!o || !(await areFriends(db, user.id, o.id))) return err('Sadece arkadaşlarının destesiyle savaşabilirsin.', 403);
    const p = await db.prepare('SELECT stats, deck FROM pub WHERE user_id = ?').bind(o.id).first();
    const deck = p ? JSON.parse(p.deck) : [];
    if (deck.filter(k => typeof k === 'number').length < 3) return err(`${o.name} henüz arena destesi kaydetmemiş.`, 404);
    return json({ name: o.name, deck, stats: JSON.parse(p.stats) });
  }
  if (path === '/api/duel' && method === 'POST') {
    const { u, win } = await readBody(req);
    const o = await userByName(db, u);
    if (!o || !(await areFriends(db, user.id, o.id))) return err('Arkadaş değilsiniz.', 403);
    const last = await db.prepare('SELECT t FROM duels WHERE from_id = ? ORDER BY t DESC LIMIT 1').bind(user.id).first();
    if (last && Date.now() - last.t < 20000) return json({ ok: true, skipped: true });   // aşırı hızlı kayıtları yok say
    await db.prepare('INSERT INTO duels (from_id, to_id, win, t) VALUES (?, ?, ?, ?)').bind(user.id, o.id, win ? 1 : 0, Date.now()).run();
    return json({ ok: true });
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
