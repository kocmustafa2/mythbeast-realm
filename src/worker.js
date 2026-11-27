// Mythbeast Realm — sunucu: hesaplar, bulut kaydı ve oyun ekonomisi (hile koruması).
import '../rules.js';
const MR = globalThis.MR;
// /api/* istekleri buraya gelir, diğer her şey statik oyun dosyalarıdır (ASSETS).
// Veritabanı: Cloudflare D1 (binding: DB). Tablolar ilk istekte kendiliğinden kurulur.

const EZ_IDS = new Set(['83', '84', '85']);           // sadece oyunun sahibine açık kartlar
const PBKDF2_ITER = 20000;                            // ücretsiz planın işlemci sınırına uygun
const SESSION_DAYS = 180;
const MAX_SAVE = 512 * 1024;                          // bir kaydın en büyük boyutu (bayt)
const ONLINE_MS = 150000;   // son 2,5 dakikada sinyal veren çevrimiçi sayılır
const seenAt = (db, uid) => db.prepare('INSERT INTO presence (user_id, t) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET t = excluded.t').bind(uid, Date.now()).run();
// ---------- SOHBET YARDIMCILARI ----------
const CHAT_MAX = 200;
const uerr = (msg, status) => Object.assign(new Error(msg), { user: true, status });
// basit küfür filtresi: kelimenin içinde geçen kaba ifadeler yıldızlanır (harf benzerleri ve tekrarlar dahil)
// kısa kaba kelimeler sadece tam (ya da yaygın ekleriyle), uzunlar kelimenin içinde geçince yakalanır
const BAD_SHORT = ['amk','aq','amq','oç','oc','piç','pic','göt','got','sik','sg','mk'];
const BAD_SUFX = ['','e','i','ı','u','ü','im','in','ım','ın','ini','ine','ler','lar','ler'];
const BAD_LONG = ['orospu','yarrak','yarağ','yarak','ibne','kahpe','pezevenk','gavat','şerefsiz','serefsiz','gerizekal','siktir','sikerim','sikeyim','sikik','sikiş','sikis','amına','amina','amcık','amcik','salak','fuck','shit','bitch','motherf'];
const norm = t => t.toLocaleLowerCase('tr').replace(/[0@]/g, 'o').replace(/1/g, 'i').replace(/3/g, 'e').replace(/\$/g, 's').replace(/(.)\1+/g, '$1');
function cleanTxt(txt) {
  return txt.split(/(\s+)/).map(w => { const n = norm(w).replace(/[^a-zçğıöşü]/g, '');
    const r = w.toLocaleLowerCase('tr').replace(/[0@]/g, 'o').replace(/[^a-zçğıöşü]/g, '');   // kısa kelimelerde harf tekrarı birleştirilmez (sikke ≠ sik)
    const bad = n && (BAD_LONG.some(b => n.includes(norm(b))) || BAD_SHORT.some(b => BAD_SUFX.some(x => r === b + x || n === b)));
    return bad ? '*'.repeat(Math.min(w.length, 6)) : w; }).join('');
}
const dmRoom = (x, y) => 'd:' + Math.min(x, y) + ':' + Math.max(x, y);
const isBlocked = async (db, by, who) => !!(await db.prepare('SELECT 1 FROM blocks WHERE user_id = ? AND blocked = ?').bind(by, who).first());
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
    // çevrimiçi durumu: oyun açıkken dakikada bir güncellenir
    // sohbet: oda 'c:<klan>' ya da 'd:<küçük id>:<büyük id>' (özel)
    db.prepare(`CREATE TABLE IF NOT EXISTS chat (id INTEGER PRIMARY KEY AUTOINCREMENT, room TEXT NOT NULL, user_id INTEGER NOT NULL, txt TEXT NOT NULL, t INTEGER NOT NULL, del INTEGER NOT NULL DEFAULT 0)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS chat_room ON chat (room, id)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS chat_read (user_id INTEGER NOT NULL, room TEXT NOT NULL, last INTEGER NOT NULL, PRIMARY KEY (user_id, room))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS blocks (user_id INTEGER NOT NULL, blocked INTEGER NOT NULL, PRIMARY KEY (user_id, blocked))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS presence (user_id INTEGER PRIMARY KEY, t INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS pub (user_id INTEGER PRIMARY KEY, stats TEXT NOT NULL, deck TEXT NOT NULL, updated INTEGER NOT NULL)`),
    // arkadaş destesine karşı yapılan savaşlar
    db.prepare(`CREATE TABLE IF NOT EXISTS duels (id INTEGER PRIMARY KEY AUTOINCREMENT, from_id INTEGER NOT NULL, to_id INTEGER NOT NULL, win INTEGER NOT NULL, t INTEGER NOT NULL)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS duels_to ON duels (to_id, t)`),
    // klanlar: role 'leader' | 'co' | 'member'
    db.prepare(`CREATE TABLE IF NOT EXISTS clans (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, nkey TEXT UNIQUE NOT NULL, descr TEXT NOT NULL DEFAULT '', created INTEGER NOT NULL)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS clan_members (user_id INTEGER PRIMARY KEY, clan_id INTEGER NOT NULL, role TEXT NOT NULL, joined INTEGER NOT NULL)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS clan_members_c ON clan_members (clan_id)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS clan_joins (user_id INTEGER NOT NULL, clan_id INTEGER NOT NULL, t INTEGER NOT NULL, PRIMARY KEY (user_id, clan_id))`),
    db.prepare(`CREATE INDEX IF NOT EXISTS clan_joins_c ON clan_joins (clan_id)`),
    // klan davetleri: lider/yardımcı bir oyuncuyu davet eder, oyuncu kabul edince doğrudan katılır
    // haftalık sezon: arena puanı (net kupa) ve G/M; season_claims önceki sezon ödülünün bir kez verilmesini sağlar
    // maç geçmişi: oyuncu başına son 50 maç (profilde görünür)
    db.prepare(`CREATE TABLE IF NOT EXISTS match_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, t INTEGER NOT NULL, mode TEXT NOT NULL, opp TEXT, win INTEGER NOT NULL, dt INTEGER NOT NULL DEFAULT 0)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS match_log_u ON match_log (user_id, t)`),
    db.prepare(`CREATE TABLE IF NOT EXISTS season_stats (user_id INTEGER NOT NULL, season INTEGER NOT NULL, pts INTEGER NOT NULL DEFAULT 0, wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, season))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS season_claims (user_id INTEGER NOT NULL, season INTEGER NOT NULL, t INTEGER NOT NULL, PRIMARY KEY (user_id, season))`),
    db.prepare(`CREATE TABLE IF NOT EXISTS clan_invites (user_id INTEGER NOT NULL, clan_id INTEGER NOT NULL, by_id INTEGER NOT NULL, t INTEGER NOT NULL, PRIMARY KEY (user_id, clan_id))`),
    db.prepare(`CREATE INDEX IF NOT EXISTS clan_invites_c ON clan_invites (clan_id)`),
    // kart istekleri
    db.prepare(`CREATE TABLE IF NOT EXISTS card_reqs (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, card INTEGER NOT NULL, need INTEGER NOT NULL, got INTEGER NOT NULL DEFAULT 0, created INTEGER NOT NULL, expires INTEGER NOT NULL, closed INTEGER NOT NULL DEFAULT 0)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS card_reqs_u ON card_reqs (user_id, closed)`),
    // akış: kind = duel | donate | request | join | leave | clan_create | kick
    db.prepare(`CREATE TABLE IF NOT EXISTS feed (id INTEGER PRIMARY KEY AUTOINCREMENT, clan_id INTEGER, kind TEXT NOT NULL, a INTEGER NOT NULL, b INTEGER, card INTEGER, win INTEGER, t INTEGER NOT NULL)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS feed_c ON feed (clan_id, t)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS feed_a ON feed (a, t)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS feed_b ON feed (b, t)`),
    // ekonomi günlüğü: her /api/act ve yönetici işleminde altın, macera ilerlemesi ve ücretsiz paket önce/sonra (oyuncu başına son 500 satır)
    db.prepare(`CREATE TABLE IF NOT EXISTS econ_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, t INTEGER NOT NULL, a TEXT NOT NULL, gold_before INTEGER, gold_after INTEGER, advC_before INTEGER, advC_after INTEGER, free_before INTEGER, free_after INTEGER, note TEXT)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS econ_log_u ON econ_log (user_id, id)`),
    // yönetici hediyeleri: zil kutusunda 'Yönetici hediyesi' olarak görünür, oyuncu 'Al' deyince kaydına işlenir
    db.prepare(`CREATE TABLE IF NOT EXISTS admin_gifts (id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, msg TEXT NOT NULL, payload TEXT NOT NULL, t INTEGER NOT NULL, claimed INTEGER NOT NULL DEFAULT 0)`),
    db.prepare(`CREATE INDEX IF NOT EXISTS admin_gifts_u ON admin_gifts (user_id, claimed)`),
  ]).then(async () => {
    // kayıt sürümü: iki cihaz aynı anda oynarsa eski sürüm yenisinin üstüne yazamaz
    const addCol = async sql => { try { await db.prepare(sql).run(); } catch (e) { if (!/duplicate column/i.test(String(e && e.message))) throw e; } };
    await addCol('ALTER TABLE saves ADD COLUMN rev INTEGER NOT NULL DEFAULT 0');
    await addCol('ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0');   // engellenen oyuncu giriş yapamaz
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
  // Oyunun sahibi: bütün kartlardan (normal, EX, Parlak) en az 1 tane. Yeni kart eklendikçe eksikler bir kez tamamlanır.
  if (owner) {
    const all = [...MR.CARDS, ...MR.EXC, ...MR.PRL];
    if ((data.ownAll || 0) < all.length) { for (const c of all) if (!(data.owned[c.id] > 0)) data.owned[c.id] = 1; data.ownAll = all.length; }
  }
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
  const row = await db.prepare('SELECT u.id, u.name, u.banned, s.expires FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ?')
    .bind(m[1]).first();
  if (!row || row.expires < Date.now() || row.banned) return null;
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
const myClan = (db, uid) => db.prepare('SELECT m.clan_id, m.role, c.name FROM clan_members m JOIN clans c ON c.id = m.clan_id WHERE m.user_id = ?').bind(uid).first();
async function sameClan(db, x, y) {
  const r = await db.prepare('SELECT a.clan_id FROM clan_members a JOIN clan_members b ON a.clan_id = b.clan_id WHERE a.user_id = ? AND b.user_id = ?').bind(x, y).first();
  return r ? r.clan_id : null;
}
// arkadaşlar ya da aynı klandakiler birbirinin destesiyle savaşabilir, birbirine kart bağışlayabilir
async function canDuel(db, x, y) { return (await areFriends(db, x, y)) || !!(await sameClan(db, x, y)); }
const feedAdd = (db, clan, kind, a, b = null, card = null, win = null) =>
  db.prepare('INSERT INTO feed (clan_id, kind, a, b, card, win, t) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(clan, kind, a, b, card, win, Date.now()).run();

// kriptografik rastgele sayı (0-1): paketleri ve sandıkları sunucu açar
function cryptoRng() { const a = new Uint32Array(2); crypto.getRandomValues(a); return (a[0] * 2 ** 21 + (a[1] >>> 11)) / 2 ** 53; }
async function loadState(db, uid) {
  const row = await db.prepare('SELECT data, rev FROM saves WHERE user_id = ?').bind(uid).first();
  if (row) return { st: JSON.parse(row.data), rev: row.rev, exists: true };
  // Kayıt satırı yok: kayıt olurken her zaman yazılır, bu yüzden bu bir anormallik. Günlüğe yaz;
  // storeState yeni satırı ON CONFLICT DO NOTHING ile ekler, var olan bir kaydın üstüne asla yazmaz.
  console.warn('loadState: kayıt satırı yok', uid);
  try { await econLog(db, uid, 'fresh', null, null, 'kayıt satırı bulunamadı, boş kayıt kullanıldı'); } catch (e) {}
  return { st: MR.fresh(), rev: 0, exists: false };
}
// ekonomi günlüğü (önce/sonra); oyuncu başına son 500 satır tutulur
const ECON_KEEP = 500;
async function econLog(db, uid, a, b, c, note) {
  const g = (s, k) => (s && Number.isFinite(+s[k]) ? Math.floor(+s[k]) : null);
  await db.batch([
    db.prepare('INSERT INTO econ_log (user_id, t, a, gold_before, gold_after, advC_before, advC_after, free_before, free_after, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(uid, Date.now(), String(a).slice(0, 24), g(b, 'gold'), g(c, 'gold'), g(b, 'advC'), g(c, 'advC'), g(b, 'free'), g(c, 'free'), note == null ? null : String(note).slice(0, 300)),
    db.prepare('DELETE FROM econ_log WHERE user_id = ?1 AND id <= (SELECT id FROM econ_log WHERE user_id = ?1 ORDER BY id DESC LIMIT 1 OFFSET ' + ECON_KEEP + ')').bind(uid)]);
}
const econSnap = st => ({ gold: st.gold, advC: st.advC, free: st.free });
// Kaydı yazar; başka bir istek araya girdiyse false döner (çağıran yeniden dener).
async function storeState(db, uid, st, rev, exists) {
  const txt = JSON.stringify(st), now = Date.now();
  if (txt.length > MAX_SAVE) throw new Error('too_big');
  if (!exists) {
    const r = await db.prepare('INSERT INTO saves (user_id, data, t, updated, rev) VALUES (?, ?, ?, ?, 1) ON CONFLICT(user_id) DO NOTHING RETURNING rev')
      .bind(uid, txt, Number(st.t) || now, now).first();
    return r ? r.rev : false;
  }
  const r = await db.prepare('UPDATE saves SET data = ?, t = ?, updated = ?, rev = rev + 1 WHERE user_id = ? AND rev = ? RETURNING rev')
    .bind(txt, Number(st.t) || now, now, uid, rev).first();
  return r ? r.rev : false;
}
async function storePub(db, uid, st, deck, owner) {
  const own = k => typeof k !== 'number' || (st.owned && st.owned[k] > 0);
  await db.prepare('INSERT INTO pub (user_id, stats, deck, updated) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET stats = excluded.stats, deck = excluded.deck, updated = excluded.updated')
    .bind(uid, JSON.stringify(MR.pubStats(st)), JSON.stringify(cleanDeck(deck, owner).filter(own)), Date.now()).run();
}
// Test saati: sadece env.TEST_TIME === '1' iken (yerel test sunucusu) x-test-now başlığıyla zaman ileri alınabilir. Canlıda bu değişken yok.
let NOW_OFF = 0;
const ctxOf = (uid, extra) => ({ rng: cryptoRng, now: Date.now() + NOW_OFF, uid, ...extra });
// Bir oyuncunun kaydını sunucuda değiştirir (çakışmada yeniden dener). fn hata fırlatırsa kayıt değişmez.
async function mutateState(db, env, uid, fn) {
  const u = await db.prepare('SELECT name FROM users WHERE id = ?').bind(uid).first();
  const owner = !!u && isOwner(env, { name: u.name });
  for (let tries = 0; tries < 6; tries++) {
    const cur = await loadState(db, uid), st = cur.st, ctx = ctxOf(uid, {});
    MR.normalize(st, ctx); fixEz(st, owner);
    const before = econSnap(st);
    const r = fn(st, ctx.now);
    fixEz(st, owner); MR.achSync(st, null);
    const rev = await storeState(db, uid, st, cur.rev, cur.exists);
    if (rev !== false) return { r, st, rev, before };
  }
  throw new Error('busy');
}
const feedRows = async (db, sql, ...args) => ((await db.prepare(sql).bind(...args).all()).results || []).map(f => ({
  kind: f.kind, a: f.an, b: f.bn, card: f.card, win: f.win == null ? null : !!f.win, t: f.t }));
const FEED_SEL = `SELECT f.kind, f.card, f.win, f.t, ua.name AS an, ub.name AS bn FROM feed f JOIN users ua ON ua.id = f.a AND ua.banned = 0 LEFT JOIN users ub ON ub.id = f.b`;

async function handleApi(req, env, path) {
  const db = env.DB;
  if (!db) return err('Sunucu veritabanı ayarlı değil.', 500);
  await ensureSchema(db);
  const method = req.method;
  NOW_OFF = env.TEST_TIME === '1' ? (Math.floor(Number(req.headers.get('x-test-now')) || 0)) : 0;

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
    const user = { id, name: u }, owner = isOwner(env, user);
    const st = fixEz(MR.normalize(MR.fresh(), ctxOf(id)), owner);   // yeni hesap sunucuda sıfırdan başlar
    await storeState(db, id, st, 0, false);
    return json({ token: await newSession(db, id), user: u, owner, save: { data: st, t: st.t || 0, rev: 1 } });
  }

  if (path === '/api/login' && method === 'POST') {
    const { u, p } = await readBody(req);
    if (typeof u !== 'string' || typeof p !== 'string') return err('Kullanıcı adı ve şifre gerekli.');
    const ukey = ukeyOf(u), now = Date.now();
    const f = await db.prepare('SELECT n, until FROM fails WHERE ukey = ?').bind(ukey).first();
    if (f && f.until > now) return err('Çok fazla yanlış deneme. Birkaç dakika sonra tekrar dene.', 429);
    const row = await db.prepare('SELECT id, name, salt, hash, banned FROM users WHERE ukey = ?').bind(ukey).first();
    const ok = row && sameStr(await hashPw(p, row.salt), row.hash);
    if (ok && row.banned) return err('Bu hesap yönetici tarafından engellendi.', 403);
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
      save: sv ? { data: fixEz(MR.normalize(JSON.parse(sv.data), ctxOf(row.id)), owner), t: sv.t, rev: sv.rev } : null });
  }

  const user = await authUser(req, db);
  if (!user) return err('Oturum geçersiz. Tekrar giriş yap.', 401);
  const owner = isOwner(env, user);
  const logMatch = async (uid, mode, opp, win, dt) => {
    await db.batch([db.prepare('INSERT INTO match_log (user_id, t, mode, opp, win, dt) VALUES (?, ?, ?, ?, ?, ?)').bind(uid, Date.now(), mode, String(opp || '').slice(0, 40), win ? 1 : 0, Math.round(dt) || 0),
      db.prepare('DELETE FROM match_log WHERE user_id = ?1 AND id NOT IN (SELECT id FROM match_log WHERE user_id = ?1 ORDER BY t DESC, id DESC LIMIT 50)').bind(uid)]);
  };
  if (path === '/api/logout' && method === 'POST') {
    await db.prepare('DELETE FROM sessions WHERE token = ?').bind(user.token).run();
    return json({ ok: true });
  }
  if (path === '/api/me' && method === 'GET') {
    await seenAt(db, user.id);
    const sv = await db.prepare('SELECT data, t, rev FROM saves WHERE user_id = ?').bind(user.id).first();
    return json({ user: user.name, owner, save: sv ? { data: fixEz(MR.normalize(JSON.parse(sv.data), ctxOf(user.id)), owner), t: sv.t, rev: sv.rev } : null });
  }
  if (path === '/api/save' && method === 'PUT') {
    // Oyun sadece ayarları, deste seçimini ve öğreticinin ilk adımlarını değiştirebilir; ekonomi alanları yok sayılır.
    const body = await readBody(req);
    const data = body && body.data;
    if (!data || typeof data !== 'object') return err('Kayıt geçersiz.');
    for (let tries = 0; tries < 4; tries++) {
      const cur = await loadState(db, user.id);
      const st = fixEz(MR.normalize(MR.mergeClient(cur.st, data), ctxOf(user.id)), owner);
      const rev = await storeState(db, user.id, st, cur.rev, cur.exists);
      if (rev === false) continue;
      await storePub(db, user.id, st, body.deck, owner);
      return json({ ok: true, t: st.t || 0, rev });
    }
    return err('Kayıt şu an yazılamadı, tekrar dene.', 503);
  }
  if (path === '/api/act' && method === 'POST') {
    const body = await readBody(req);
    const a = String(body.a || '');
    let friendOk = false;
    const inClan = !!(await myClan(db, user.id));
    if (a === 'battle_start' && body.mode === 'friend') {
      const o = await userByName(db, body.fr);
      friendOk = !!o && await canDuel(db, user.id, o.id);
    }
    // İstek kimliği (rid): bağlantı kopup istemci aynı isteği yeniden gönderirse işlem ikinci kez uygulanmaz,
    // ilk sonucun aynısı döner (Safari'de yanıtı kaybolan POST'lar için).
    const rid = typeof body.rid === 'string' && /^[A-Za-z0-9_-]{8,40}$/.test(body.rid) ? body.rid : null;
    for (let tries = 0; tries < 4; tries++) {
      const cur = await loadState(db, user.id);
      const st = cur.st;
      const ctx = ctxOf(user.id, { friendOk });
      const seen = rid && Array.isArray(st.rq) ? st.rq.find(x => x && x.id === rid) : null;
      if (seen) {
        MR.normalize(st, ctx); fixEz(st, owner);
        await econLog(db, user.id, a, econSnap(st), econSnap(st), 'tekrar (rid) — yeniden uygulanmadı');
        return json({ r: seen.r, save: st, rev: cur.rev, ach: [], replay: true });
      }
      if (Number.isInteger(body.tut)) MR.mergeClient(st, { tut: body.tut });
      MR.normalize(st, ctx); fixEz(st, owner);
      const before = econSnap(st);
      let r;
      try { r = MR.act(st, a, body, ctx); }
      catch (e) { if (e && e.user) return err(e.message, 400); throw e; }
      fixEz(st, owner);
      const ach = MR.achSync(st, { inClan });   // yeni tamamlanan başarımlar
      if (rid) st.rq = [...(Array.isArray(st.rq) ? st.rq : []).filter(x => x && x.id !== rid), { id: rid, a, r: r === undefined ? null : r, t: ctx.now }].slice(-8);
      const rev = await storeState(db, user.id, st, cur.rev, cur.exists);
      if (rev === false) continue;          // aynı anda başka bir işlem yazdı: baştan dene
      try { await econLog(db, user.id, a, before, econSnap(st), rid ? null : 'rid yok'); } catch (e) { console.warn('econ_log', e && e.message); }
      // sezon puanı: sadece arena (bitirilen ya da terk edilip yenilgi sayılan savaşlar)
      const sAdd = (pts, w, l) => db.prepare('INSERT INTO season_stats (user_id, season, pts, wins, losses) VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, season) DO UPDATE SET pts = pts + excluded.pts, wins = wins + excluded.wins, losses = losses + excluded.losses')
        .bind(user.id, MR.seasonOf(Date.now()), pts, w, l).run();
      if (a === 'battle_end' && r && r.mode === 'arena') await sAdd(r.dt || 0, r.win ? 1 : 0, r.win ? 0 : 1);
      if (a === 'battle_start' && r && r.forfeit) await sAdd(r.forfeit.dt || 0, 0, 1);
      // maç geçmişi
      if (a === 'battle_end' && r) await logMatch(user.id, r.mode, r.mode === 'arena' ? 'Bot · ' + MR.LEAGUES[r.lg0 || 0].n : r.mode === 'adv' ? MR.advStage(r.adv).name : r.mode === 'tower' ? MR.towerStage(r.el, r.f).name : (r.opp || '?'), r.win, r.dt || 0);
      if (a === 'battle_start' && r && r.forfeit) await logMatch(user.id, 'arena', 'Terk edilen savaş', false, r.forfeit.dt || 0);
      if (a === 'battle_end' || a === 'pack' || a === 'evo' || a === 'awaken' || a === 'craft' || a === 'chest' || a === 'avatar' || a === 'lvup')
        await db.prepare("INSERT INTO pub (user_id, stats, deck, updated) VALUES (?, ?, '[]', ?) ON CONFLICT(user_id) DO UPDATE SET stats = excluded.stats, updated = excluded.updated")
          .bind(user.id, JSON.stringify(MR.pubStats(st)), Date.now()).run();   // deste seçimine dokunmadan tabloyu güncelle
      return json({ r, save: st, rev, ach });
    }
    return err('İşlem şu an yapılamadı, tekrar dene.', 503);
  }

  // ---------- ARKADAŞLAR ----------
  if (path === '/api/friends' && method === 'GET') {
    const rows = (await db.prepare(`SELECT f.a, f.b, f.status, u.id AS oid, u.name, p.stats, p.updated, pr.t AS last
      FROM friends f JOIN users u ON u.id = CASE WHEN f.a = ?1 THEN f.b ELSE f.a END
      LEFT JOIN pub p ON p.user_id = u.id LEFT JOIN presence pr ON pr.user_id = u.id WHERE f.a = ?1 OR f.b = ?1`).bind(user.id).all()).results || [];
    const unr = {};   // arkadaş başına okunmamış özel mesaj
    for (const r of ((await db.prepare(`SELECT c.user_id AS uid, COUNT(*) AS n FROM chat c LEFT JOIN chat_read rd ON rd.user_id = ?1 AND rd.room = c.room
      WHERE (c.room LIKE ?2 OR c.room LIKE ?3) AND c.user_id != ?1 AND c.del = 0 AND c.id > IFNULL(rd.last, 0) GROUP BY c.user_id`).bind(user.id, 'd:' + user.id + ':%', 'd:%:' + user.id).all()).results || [])) unr[r.uid] = r.n;
    const friends = [], incoming = [], outgoing = [];
    for (const r of rows) {
      if (r.status === 'ok') friends.push({ name: r.name, stats: r.stats ? JSON.parse(r.stats) : null, seen: r.updated || 0, last: r.last || 0, on: !!r.last && Date.now() - r.last < ONLINE_MS, unread: unr[r.oid] || 0 });
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
    if (!o || !(await canDuel(db, user.id, o.id))) return err('Sadece arkadaşlarının ya da klan üyelerinin destesiyle savaşabilirsin.', 403);
    const p = await db.prepare('SELECT stats, deck FROM pub WHERE user_id = ?').bind(o.id).first();
    const deck = p ? JSON.parse(p.deck) : [];
    if (deck.filter(k => typeof k === 'number').length < 3) return err(`${o.name} henüz arena destesi kaydetmemiş.`, 404);
    return json({ name: o.name, deck, stats: JSON.parse(p.stats) });
  }
  if (path === '/api/duel' && method === 'POST') {
    const { u, win } = await readBody(req);
    const o = await userByName(db, u);
    if (!o || !(await canDuel(db, user.id, o.id))) return err('Arkadaş ya da klan üyesi değilsiniz.', 403);
    const last = await db.prepare('SELECT t FROM duels WHERE from_id = ? ORDER BY t DESC LIMIT 1').bind(user.id).first();
    if (last && Date.now() - last.t < 20000) return json({ ok: true, skipped: true });   // aşırı hızlı kayıtları yok say
    await db.prepare('INSERT INTO duels (from_id, to_id, win, t) VALUES (?, ?, ?, ?)').bind(user.id, o.id, win ? 1 : 0, Date.now()).run();
    await feedAdd(db, await sameClan(db, user.id, o.id), 'duel', user.id, o.id, null, win ? 1 : 0);
    return json({ ok: true });
  }

  // ---------- KLAN ----------
  const CL = MR.CLAN;

  const memberCount = async cid => (await db.prepare('SELECT COUNT(*) AS n FROM clan_members WHERE clan_id = ?').bind(cid).first()).n;
  const clanByName = async n => typeof n === 'string' ? db.prepare('SELECT id, name FROM clans WHERE nkey = ?').bind(ukeyOf(n.trim())).first() : null;
  const officer = async () => { const m = await myClan(db, user.id); if (!m) throw Object.assign(new Error('Bir klanda değilsin.'), { user: true });
    if (m.role !== 'leader' && m.role !== 'co') throw Object.assign(new Error('Bunun için lider ya da yardımcı olmalısın.'), { user: true, status: 403 }); return m; };
  const ue = e => e && e.user ? err(e.message, e.status || 400) : null;

  if (path === '/api/clan' && method === 'GET') {
    const m = await myClan(db, user.id);
    if (!m) {
      const pend = ((await db.prepare('SELECT c.name FROM clan_joins j JOIN clans c ON c.id = j.clan_id WHERE j.user_id = ?').bind(user.id).all()).results || []).map(r => r.name);
      const invites = ((await db.prepare(`SELECT c.name, u.name AS by FROM clan_invites i JOIN clans c ON c.id = i.clan_id JOIN users u ON u.id = i.by_id
        WHERE i.user_id = ? ORDER BY i.t DESC`).bind(user.id).all()).results || []).map(r => ({ name: r.name, by: r.by }));
      return json({ clan: null, pending: pend, invites, cost: CL.cost });
    }
    const c = await db.prepare('SELECT id, name, descr, created FROM clans WHERE id = ?').bind(m.clan_id).first();
    const members = ((await db.prepare(`SELECT u.name, m.role, m.joined, p.stats, pr.t AS last FROM clan_members m JOIN users u ON u.id = m.user_id
      LEFT JOIN pub p ON p.user_id = m.user_id LEFT JOIN presence pr ON pr.user_id = m.user_id WHERE m.clan_id = ?`).bind(c.id).all()).results || [])
      .map(r => ({ name: r.name, role: r.role, joined: r.joined, stats: r.stats ? JSON.parse(r.stats) : null, last: r.last || 0, on: !!r.last && Date.now() - r.last < ONLINE_MS }))
      .sort((x, y) => ((y.stats || {}).tr || 0) - ((x.stats || {}).tr || 0));
    const joins = (m.role === 'leader' || m.role === 'co') ? ((await db.prepare(`SELECT u.name, p.stats FROM clan_joins j JOIN users u ON u.id = j.user_id
      LEFT JOIN pub p ON p.user_id = j.user_id WHERE j.clan_id = ? ORDER BY j.t`).bind(c.id).all()).results || []).map(r => ({ name: r.name, stats: r.stats ? JSON.parse(r.stats) : null })) : [];
    const feed = await feedRows(db, FEED_SEL + ' WHERE f.clan_id = ? ORDER BY f.t DESC LIMIT 50', c.id);
    // davet edilebilecek arkadaşlar: hiçbir klanda olmayanlar
    const invitable = (m.role === 'leader' || m.role === 'co') ? ((await db.prepare(`SELECT u.name, (SELECT 1 FROM clan_invites i WHERE i.user_id = u.id AND i.clan_id = ?2) AS inv
      FROM friends f JOIN users u ON u.id = CASE WHEN f.a = ?1 THEN f.b ELSE f.a END
      WHERE f.status = 'ok' AND (f.a = ?1 OR f.b = ?1) AND u.id NOT IN (SELECT user_id FROM clan_members)`).bind(user.id, c.id).all()).results || [])
      .map(r => ({ name: r.name, invited: !!r.inv })) : [];
    return json({ invitable, clan: { name: c.name, descr: c.descr, created: c.created, max: CL.max, total: members.reduce((t, x) => t + ((x.stats || {}).tr || 0), 0) },
      role: m.role, members, joins, feed });
  }
  if (path === '/api/clan/search' && method === 'GET') {
    const q = (new URL(req.url).searchParams.get('q') || '').trim().toLocaleLowerCase('tr').slice(0, 20).replace(/[%_]/g, '');
    const rows = ((await db.prepare(`SELECT c.name, c.descr, COUNT(m.user_id) AS n, COALESCE(SUM(json_extract(p.stats, '$.tr')), 0) AS tr
      FROM clans c LEFT JOIN clan_members m ON m.clan_id = c.id LEFT JOIN pub p ON p.user_id = m.user_id
      WHERE c.nkey LIKE ? GROUP BY c.id ORDER BY tr DESC, n DESC LIMIT 20`).bind('%' + q + '%').all()).results || []);
    return json({ clans: rows.map(r => ({ name: r.name, descr: r.descr, n: r.n, tr: r.tr, full: r.n >= CL.max })) });
  }
  if (path === '/api/clan/create' && method === 'POST') {
    const { name, descr } = await readBody(req);
    const nm = typeof name === 'string' ? name.trim().replace(/\s+/g, ' ') : '';
    if (nm.length < CL.nameMin || nm.length > CL.nameMax || !/^[A-Za-z0-9 _çğıöşüÇĞİÖŞÜ-]+$/.test(nm)) return err(`Klan adı ${CL.nameMin}-${CL.nameMax} karakter olmalı: harf, rakam, boşluk, - ya da _`);
    const ds = typeof descr === 'string' ? descr.trim().slice(0, CL.descMax) : '';
    if (await myClan(db, user.id)) return err('Zaten bir klandasın. Önce ayrılmalısın.');
    if (await clanByName(nm)) return err('Bu klan adı alınmış.', 409);
    let res;
    try { res = await mutateState(db, env, user.id, st => MR.clanPay(st)); } catch (e) { return ue(e) || (() => { throw e; })(); }
    let cid;
    try { cid = (await db.prepare('INSERT INTO clans (name, nkey, descr, created) VALUES (?, ?, ?, ?) RETURNING id').bind(nm, ukeyOf(nm), ds, Date.now()).first()).id; }
    catch { await mutateState(db, env, user.id, st => { st.gold += CL.cost; }); return err('Bu klan adı alınmış.', 409); }
    await db.batch([db.prepare('INSERT INTO clan_members (user_id, clan_id, role, joined) VALUES (?, ?, ?, ?)').bind(user.id, cid, 'leader', Date.now()),
      db.prepare('DELETE FROM clan_joins WHERE user_id = ?').bind(user.id)]);
    await feedAdd(db, cid, 'clan_create', user.id);
    const st = (await loadState(db, user.id));
    return json({ ok: true, name: nm, save: st.st, rev: st.rev });
  }
  if (path === '/api/clan/join' && method === 'POST') {
    const { name } = await readBody(req);
    if (await myClan(db, user.id)) return err('Zaten bir klandasın.');
    const c = await clanByName(name);
    if (!c) return err('Klan bulunamadı.', 404);
    if (await memberCount(c.id) >= CL.max) return err(`Klan dolu (${CL.max} üye).`);
    const pend = await db.prepare('SELECT COUNT(*) AS n FROM clan_joins WHERE user_id = ?').bind(user.id).first();
    if (pend.n >= 5) return err('En fazla 5 klana aynı anda istek gönderebilirsin.');
    await db.prepare('INSERT INTO clan_joins (user_id, clan_id, t) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').bind(user.id, c.id, Date.now()).run();
    return json({ ok: true, name: c.name });
  }
  if (path === '/api/clan/cancel' && method === 'POST') {
    const { name } = await readBody(req); const c = await clanByName(name);
    if (c) await db.prepare('DELETE FROM clan_joins WHERE user_id = ? AND clan_id = ?').bind(user.id, c.id).run();
    return json({ ok: true });
  }
  if ((path === '/api/clan/accept' || path === '/api/clan/decline') && method === 'POST') {
    let m; try { m = await officer(); } catch (e) { return ue(e); }
    const { u } = await readBody(req); const o = await userByName(db, u);
    if (!o) return err('Oyuncu bulunamadı.', 404);
    const j = await db.prepare('SELECT 1 FROM clan_joins WHERE user_id = ? AND clan_id = ?').bind(o.id, m.clan_id).first();
    if (!j) return err('Bu oyuncunun bekleyen isteği yok.', 404);
    if (path === '/api/clan/decline') { await db.prepare('DELETE FROM clan_joins WHERE user_id = ? AND clan_id = ?').bind(o.id, m.clan_id).run(); return json({ ok: true }); }
    if (await myClan(db, o.id)) { await db.prepare('DELETE FROM clan_joins WHERE user_id = ?').bind(o.id).run(); return err(`${o.name} başka bir klana katılmış.`); }
    if (await memberCount(m.clan_id) >= CL.max) return err(`Klan dolu (${CL.max} üye).`);
    try { await db.prepare('INSERT INTO clan_members (user_id, clan_id, role, joined) VALUES (?, ?, ?, ?)').bind(o.id, m.clan_id, 'member', Date.now()).run(); }
    catch { return err(`${o.name} başka bir klana katılmış.`); }
    await db.batch([db.prepare('DELETE FROM clan_joins WHERE user_id = ?').bind(o.id), db.prepare('DELETE FROM clan_invites WHERE user_id = ?').bind(o.id)]);
    if (await memberCount(m.clan_id) > CL.max) {   // aynı anda iki onay: fazlayı geri al
      await db.prepare('DELETE FROM clan_members WHERE user_id = ?').bind(o.id).run(); return err(`Klan dolu (${CL.max} üye).`);
    }
    await feedAdd(db, m.clan_id, 'join', o.id, user.id);
    return json({ ok: true, name: o.name });
  }
  if (path === '/api/clan/invite' && method === 'POST') {
    let m; try { m = await officer(); } catch (e) { return ue(e); }
    const { u } = await readBody(req); const o = await userByName(db, u);
    if (!o) return err('Bu kullanıcı adıyla oyuncu bulunamadı.', 404);
    if (o.id === user.id) return err('Kendini davet edemezsin.');
    if (await myClan(db, o.id)) return err(`${o.name} zaten bir klanda.`);
    const n = await db.prepare('SELECT COUNT(*) AS n FROM clan_invites WHERE clan_id = ?').bind(m.clan_id).first();
    if (n.n >= 50) return err('Çok fazla bekleyen davet var.');
    await db.prepare('INSERT INTO clan_invites (user_id, clan_id, by_id, t) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING').bind(o.id, m.clan_id, user.id, Date.now()).run();
    return json({ ok: true, name: o.name });
  }
  if ((path === '/api/clan/invite_accept' || path === '/api/clan/invite_decline') && method === 'POST') {
    const { name } = await readBody(req);
    const c = await clanByName(name);
    const inv = c && await db.prepare('SELECT by_id FROM clan_invites WHERE user_id = ? AND clan_id = ?').bind(user.id, c.id).first();
    if (!inv) return err('Bu klandan bekleyen davetin yok.', 404);
    if (path === '/api/clan/invite_decline') { await db.prepare('DELETE FROM clan_invites WHERE user_id = ? AND clan_id = ?').bind(user.id, c.id).run(); return json({ ok: true }); }
    if (await myClan(db, user.id)) return err('Zaten bir klandasın.');
    if (await memberCount(c.id) >= CL.max) return err(`Klan dolu (${CL.max} üye).`);
    try { await db.prepare('INSERT INTO clan_members (user_id, clan_id, role, joined) VALUES (?, ?, ?, ?)').bind(user.id, c.id, 'member', Date.now()).run(); }
    catch { return err('Zaten bir klandasın.'); }
    await db.batch([db.prepare('DELETE FROM clan_joins WHERE user_id = ?').bind(user.id), db.prepare('DELETE FROM clan_invites WHERE user_id = ?').bind(user.id)]);
    if (await memberCount(c.id) > CL.max) { await db.prepare('DELETE FROM clan_members WHERE user_id = ?').bind(user.id).run(); return err(`Klan dolu (${CL.max} üye).`); }
    await feedAdd(db, c.id, 'join', user.id, inv.by_id);
    return json({ ok: true, name: c.name });
  }
  if (path === '/api/clan/leave' && method === 'POST') {
    const m = await myClan(db, user.id); if (!m) return err('Bir klanda değilsin.');
    await db.prepare('DELETE FROM clan_members WHERE user_id = ?').bind(user.id).run();
    const left = await memberCount(m.clan_id);
    if (!left) {      // son üye: klan silinir
      await db.batch([db.prepare('DELETE FROM clans WHERE id = ?').bind(m.clan_id), db.prepare('DELETE FROM clan_joins WHERE clan_id = ?').bind(m.clan_id), db.prepare('DELETE FROM clan_invites WHERE clan_id = ?').bind(m.clan_id),
        db.prepare('DELETE FROM feed WHERE clan_id = ?').bind(m.clan_id)]);
      return json({ ok: true, deleted: true });
    }
    if (m.role === 'leader') {   // liderlik en eski yardımcıya, yoksa en eski üyeye geçer
      const nx = await db.prepare(`SELECT user_id FROM clan_members WHERE clan_id = ? ORDER BY CASE role WHEN 'co' THEN 0 ELSE 1 END, joined LIMIT 1`).bind(m.clan_id).first();
      await db.prepare(`UPDATE clan_members SET role = 'leader' WHERE user_id = ?`).bind(nx.user_id).run();
    }
    await feedAdd(db, m.clan_id, 'leave', user.id);
    return json({ ok: true });
  }
  if (path === '/api/clan/kick' && method === 'POST') {
    let m; try { m = await officer(); } catch (e) { return ue(e); }
    const { u } = await readBody(req); const o = await userByName(db, u);
    if (!o || o.id === user.id) return err('Bu oyuncuyu atamazsın.');
    const t = await db.prepare('SELECT role FROM clan_members WHERE user_id = ? AND clan_id = ?').bind(o.id, m.clan_id).first();
    if (!t) return err('Bu oyuncu klanında değil.', 404);
    if (t.role === 'leader' || (m.role === 'co' && t.role === 'co')) return err('Bu oyuncuyu atma yetkin yok.', 403);
    await db.prepare('DELETE FROM clan_members WHERE user_id = ?').bind(o.id).run();
    await feedAdd(db, m.clan_id, 'kick', o.id, user.id);
    return json({ ok: true });
  }
  if (path === '/api/clan/role' && method === 'POST') {
    const m = await myClan(db, user.id);
    if (!m || m.role !== 'leader') return err('Sadece lider rol değiştirebilir.', 403);
    const { u, role } = await readBody(req); const o = await userByName(db, u);
    if (!o || o.id === user.id || (role !== 'co' && role !== 'member')) return err('Geçersiz istek.');
    const r = await db.prepare('UPDATE clan_members SET role = ? WHERE user_id = ? AND clan_id = ? AND role != ?').bind(role, o.id, m.clan_id, 'leader').run();
    if (!r.meta.changes) return err('Bu oyuncu klanında değil.', 404);
    return json({ ok: true });
  }
  if (path === '/api/clan/edit' && method === 'POST') {
    const m = await myClan(db, user.id);
    if (!m || m.role !== 'leader') return err('Sadece lider açıklamayı değiştirebilir.', 403);
    const { descr } = await readBody(req);
    await db.prepare('UPDATE clans SET descr = ? WHERE id = ?').bind(typeof descr === 'string' ? descr.trim().slice(0, CL.descMax) : '', m.clan_id).run();
    return json({ ok: true });
  }

  // ---------- KART İSTEKLERİ VE BAĞIŞ ----------
  const RQ = MR.REQ;
  if (path === '/api/reqs' && method === 'GET') {
    const now = Date.now(), m = await myClan(db, user.id);
    const rows = ((await db.prepare(`SELECT r.id, r.card, r.need, r.got, r.expires, r.user_id, u.name FROM card_reqs r JOIN users u ON u.id = r.user_id
      WHERE r.closed = 0 AND r.expires > ?1 AND (r.user_id = ?2
        OR r.user_id IN (SELECT CASE WHEN a = ?2 THEN b ELSE a END FROM friends WHERE status = 'ok' AND (a = ?2 OR b = ?2))
        OR r.user_id IN (SELECT user_id FROM clan_members WHERE clan_id = ?3))
      ORDER BY r.created DESC LIMIT 60`).bind(now, user.id, m ? m.clan_id : -1).all()).results || []);
    const cur = await loadState(db, user.id), st = cur.st;
    return json({ reqs: rows.map(r => ({ id: r.id, card: r.card, need: r.need, got: r.got, expires: r.expires, name: r.name, mine: r.user_id === user.id,
      have: (st.owned || {})[r.card] || 0 })), next: Math.max(0, (st.rqT || 0) + RQ.every - now), left: MR.dnLeft(st, now), daily: RQ.daily });
  }
  if (path === '/api/reqs/open' && method === 'POST') {
    const { card } = await readBody(req), id = Math.floor(Number(card)), now = Date.now();
    let res;
    try { res = await mutateState(db, env, user.id, (st, t) => MR.reqOpen(st, id, t)); } catch (e) { return ue(e) || (() => { throw e; })(); }
    await db.prepare('UPDATE card_reqs SET closed = 1 WHERE user_id = ? AND closed = 0').bind(user.id).run();
    await db.prepare('INSERT INTO card_reqs (user_id, card, need, created, expires) VALUES (?, ?, ?, ?, ?)').bind(user.id, id, res.r.need, now, now + RQ.dur).run();
    const m = await myClan(db, user.id);
    await feedAdd(db, m ? m.clan_id : null, 'request', user.id, null, id);
    return json({ ok: true, save: res.st, rev: res.rev });
  }
  if (path === '/api/reqs/donate' && method === 'POST') {
    const { id } = await readBody(req), now = Date.now();
    const rq = await db.prepare('SELECT id, user_id, card, need, got, expires, closed FROM card_reqs WHERE id = ?').bind(Math.floor(Number(id))).first();
    if (!rq || rq.closed || rq.expires <= now || rq.got >= rq.need) return err('Bu istek kapanmış.', 404);
    if (rq.user_id === user.id) return err('Kendi isteğine bağış yapamazsın.');
    if (!(await canDuel(db, user.id, rq.user_id))) return err('Sadece arkadaşlarına ve klan üyelerine bağış yapabilirsin.', 403);
    { const cur = await loadState(db, user.id); try { MR.normalize(cur.st, ctxOf(user.id, {})); MR.donateCheck(cur.st, rq.card, now); } catch (e) { return ue(e) || (() => { throw e; })(); } }
    // yer ayır: aynı anda gelen bağışlar hedefi aşamaz
    const slot = await db.prepare('UPDATE card_reqs SET got = got + 1, closed = CASE WHEN got + 1 >= need THEN 1 ELSE 0 END WHERE id = ? AND closed = 0 AND got < need AND expires > ? RETURNING got, need')
      .bind(rq.id, now).first();
    if (!slot) return err('Bu istek doldu.', 409);
    let give;
    try { give = await mutateState(db, env, user.id, (st, t) => MR.donateGive(st, rq.card, t)); }
    catch (e) {   // bağışçı tarafı olmadı: ayrılan yeri geri ver
      await db.prepare('UPDATE card_reqs SET got = got - 1, closed = 0 WHERE id = ?').bind(rq.id).run();
      return ue(e) || (() => { throw e; })();
    }
    try { await mutateState(db, env, rq.user_id, st => MR.donateGet(st, rq.card)); }
    catch (e) {   // alıcıya yazılamadı: bağışçının kartını iade et, ayrılan yeri geri ver
      await db.prepare('UPDATE card_reqs SET got = got - 1, closed = 0 WHERE id = ?').bind(rq.id).run();
      try { await mutateState(db, env, user.id, st => { st.owned[rq.card] = (st.owned[rq.card] || 0) + 1; }); } catch (e2) {}
      return err('Bağış şu an tamamlanamadı, kartın iade edildi. Tekrar dene.', 503);
    }
    await feedAdd(db, await sameClan(db, user.id, rq.user_id), 'donate', user.id, rq.user_id, rq.card);
    return json({ ok: true, r: give.r, got: slot.got, need: slot.need, save: give.st, rev: give.rev });
  }

  // ---------- HAFTALIK SEZON ----------
  // ---------- PROFİL (herkese açık özet) ----------
  if (path === '/api/profile' && method === 'GET') {
    const q = new URL(req.url).searchParams.get('u');
    const o = q ? await userByName(db, q) : { id: user.id, name: user.name };
    if (!o) return err('Oyuncu bulunamadı.', 404);
    const cur = await loadState(db, o.id), st = cur.st;
    MR.normalize(st, ctxOf(o.id, {}));
    const mc = await myClan(db, o.id), x = { inClan: !!mc };
    const N = MR.CARDS.filter(c => (st.owned[c.id] || 0) > 0).length;
    const matches = ((await db.prepare('SELECT t, mode, opp, win, dt FROM match_log WHERE user_id = ? ORDER BY t DESC, id DESC LIMIT 20').bind(o.id).all()).results || [])
      .map(m => ({ t: m.t, mode: m.mode, opp: m.opp, win: !!m.win, dt: m.dt }));
    let rel = { self: o.id === user.id, friend: false, pending: false, clanmate: false };
    if (!rel.self) {
      const fr = await friendRow(db, user.id, o.id);
      rel.friend = !!fr && fr.status === 'ok'; rel.pending = !!fr && fr.status === 'pending';
      const mine = await myClan(db, user.id); rel.clanmate = !!mine && !!mc && mine.clan_id === mc.clan_id;
    }
    return json({ name: o.name, av: MR.avatarOf(st), clan: mc ? mc.name : null, rel,
      stats: { tr: st.trophy || 0, lg: MR.lgOf(st.trophy || 0), bestLg: st.bestLg || 0, lvl: st.lvl || 1, w: st.wins || 0, l: st.losses || 0,
        bestStk: st.bestStk || 0, opened: st.opened || 0, col: N, tot: MR.N, advC: Math.min(MR.ADV_N, st.advC || 0), advN: MR.ADV_N, dnTot: st.dnTot || 0, ssBest: st.ssBest || 0 },
      ach: MR.achList(st, x), matches });
  }
  if (path === '/api/season' && method === 'GET') {
    const now = Date.now(), cur = MR.seasonOf(now), prev = cur - 1;
    // grup: ben + arkadaşlarım + klan üyelerim (tekrarsız)
    const ids = new Set([user.id]);
    for (const r of ((await db.prepare(`SELECT CASE WHEN a = ?1 THEN b ELSE a END AS id FROM friends WHERE status = 'ok' AND (a = ?1 OR b = ?1)`).bind(user.id).all()).results || [])) ids.add(r.id);
    const mc = await myClan(db, user.id);
    if (mc) for (const r of ((await db.prepare('SELECT user_id AS id FROM clan_members WHERE clan_id = ?').bind(mc.clan_id).all()).results || [])) ids.add(r.id);
    const idl = [...ids], ph = idl.map(() => '?').join(',');
    const rowsOf = async sid => ((await db.prepare(`SELECT u.id, u.name, p.stats, s.pts, s.wins, s.losses FROM users u LEFT JOIN pub p ON p.user_id = u.id
      LEFT JOIN season_stats s ON s.user_id = u.id AND s.season = ? WHERE u.id IN (${ph})`).bind(sid, ...idl).all()).results || [])
      .map(r => ({ id: r.id, name: r.name, me: r.id === user.id, lg: r.stats ? (JSON.parse(r.stats).lg || 0) : 0, av: r.stats ? (JSON.parse(r.stats).av || 0) : 0, pts: r.pts || 0, wins: r.wins || 0, losses: r.losses || 0 }));
    // önceki sezonun ödülü: bir kez (season_claims satırı kilit görevi görür)
    let reward = null, save = null, rev = null;
    const lock = await db.prepare('INSERT INTO season_claims (user_id, season, t) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').bind(user.id, prev, now).run();
    if (lock.meta.changes) {
      const rw = MR.seasonRewardFor(await rowsOf(prev));
      if (rw && (rw.pk || rw.g)) {
        try { const m = await mutateState(db, env, user.id, st => MR.seasonGive(st, rw)); save = m.st; rev = m.rev; reward = { ...rw, season: prev }; }
        catch (e) { await db.prepare('DELETE FROM season_claims WHERE user_id = ? AND season = ?').bind(user.id, prev).run(); }
      }
    }
    const rows = (await rowsOf(cur)).sort((a, b) => (b.pts - a.pts) || (b.wins - a.wins) || a.name.localeCompare(b.name, 'tr'))
      .map(({ id, ...r }) => r);
    // GENEL SIRALAMA: o sezon arenada oynayan bütün oyuncular (ilk 50 + benim sıram)
    const GSEL = `SELECT u.id, u.name, p.stats, s.pts, s.wins, s.losses FROM season_stats s JOIN users u ON u.id = s.user_id LEFT JOIN pub p ON p.user_id = u.id
      WHERE s.season = ? AND (s.wins + s.losses) > 0 AND u.banned = 0 ORDER BY s.pts DESC, s.wins DESC, u.name`;
    const gmap = r => ({ name: r.name, me: r.id === user.id, lg: r.stats ? (JSON.parse(r.stats).lg || 0) : 0, av: r.stats ? (JSON.parse(r.stats).av || 0) : 0, pts: r.pts || 0, wins: r.wins || 0, losses: r.losses || 0 });
    const gAll = (await db.prepare(GSEL).bind(cur).all()).results || [];
    const gi = gAll.findIndex(r => r.id === user.id);
    const global = { rows: gAll.slice(0, 50).map(gmap), total: gAll.length, meRank: gi >= 0 ? gi + 1 : 0, me: gi >= 50 ? gmap(gAll[gi]) : null };
    // genel sıralamanın küçük ödülü (önceki sezon, en az 5 oyuncu varsa ilk 3): ayrı kilit
    let greward = null;
    const glock = await db.prepare('INSERT INTO season_claims (user_id, season, t) VALUES (?, ?, ?) ON CONFLICT DO NOTHING').bind(user.id, prev + 1000000, now).run();
    if (glock.meta.changes) {
      const gp = (await db.prepare(GSEL).bind(prev).all()).results || [], rk = gp.findIndex(r => r.id === user.id);
      const rw = gp.length >= MR.SEASON.gMin && rk >= 0 && rk < 3 ? MR.SEASON.gRewards[rk] : null;
      if (rw) {
        try { const m = await mutateState(db, env, user.id, st => MR.seasonGive(st, rw)); save = m.st; rev = m.rev; greward = { ...rw, rank: rk + 1, season: prev }; }
        catch (e) { await db.prepare('DELETE FROM season_claims WHERE user_id = ? AND season = ?').bind(user.id, prev + 1000000).run(); }
      }
    }
    return json({ season: cur, ends: MR.seasonEnd(cur), rows, global, rewards: MR.SEASON.rewards, part: MR.SEASON.part, minPlayers: MR.SEASON.minPlayers,
      gRewards: MR.SEASON.gRewards, gMin: MR.SEASON.gMin, reward, greward, save, rev });
  }

  // ---------- AKIŞ VE BİLDİRİM ----------
  if (path === '/api/feed' && method === 'GET') {   // arkadaş akışı: sen ve arkadaşların arasındaki maçlar ve bağışlar
    const feed = await feedRows(db, FEED_SEL + ` WHERE f.kind IN ('duel','donate') AND (f.a IN (SELECT ?1 UNION SELECT CASE WHEN a = ?1 THEN b ELSE a END FROM friends WHERE status = 'ok' AND (a = ?1 OR b = ?1))
      OR f.b IN (SELECT ?1 UNION SELECT CASE WHEN a = ?1 THEN b ELSE a END FROM friends WHERE status = 'ok' AND (a = ?1 OR b = ?1))) ORDER BY f.t DESC LIMIT 50`, user.id);
    return json({ feed });
  }
  // ---------- SOHBET ----------
  // oda çözümü: klan sohbeti için üye olmak, özel sohbet için arkadaş olmak gerekir
  const chatRoom = async (kind, u) => {
    if (kind === 'clan') { const m = await myClan(db, user.id); if (!m) throw uerr('Bir klanda değilsin.'); return { room: 'c:' + m.clan_id, m }; }
    const o = await userByName(db, u); if (!o) throw uerr('Oyuncu bulunamadı.');
    if (!(await areFriends(db, user.id, o.id))) throw uerr('Sadece arkadaşlarınla özel sohbet edebilirsin.');
    return { room: dmRoom(user.id, o.id), o };
  };
  if (path === '/api/chat' && method === 'GET') {
    const q = new URL(req.url).searchParams; let r;
    try { r = await chatRoom(q.get('room'), q.get('u')); } catch (e) { return ue(e); }
    const after = Math.floor(Number(q.get('after')) || 0);
    const rows = ((await db.prepare(`SELECT c.id, c.user_id, u.name, c.txt, c.t, c.del, p.stats FROM chat c JOIN users u ON u.id = c.user_id LEFT JOIN pub p ON p.user_id = c.user_id
      WHERE c.room = ? AND c.id > ? AND u.banned = 0 AND c.user_id NOT IN (SELECT blocked FROM blocks WHERE user_id = ?) ORDER BY c.id DESC LIMIT 60`).bind(r.room, after, user.id).all()).results || []).reverse();
    const msgs = rows.map(x => ({ id: x.id, name: x.name, me: x.user_id === user.id, txt: x.del ? '' : x.txt, del: !!x.del, t: x.t, av: x.stats ? JSON.parse(x.stats).av || 0 : 0 }));
    const top = rows.length ? rows[rows.length - 1].id : 0;
    if (top) await db.prepare('INSERT INTO chat_read (user_id, room, last) VALUES (?, ?, ?) ON CONFLICT(user_id, room) DO UPDATE SET last = MAX(last, excluded.last)').bind(user.id, r.room, top).run();
    const canMod = r.m ? (r.m.role === 'leader' || r.m.role === 'co') : false;
    const blocked = r.o ? await isBlocked(db, user.id, r.o.id) : false;
    return json({ msgs, canMod, blocked });
  }
  if (path === '/api/chat/send' && method === 'POST') {
    const b = await readBody(req); let r;
    try { r = await chatRoom(b.room, b.u); } catch (e) { return ue(e); }
    let txt = typeof b.txt === 'string' ? b.txt.replace(/[\u0000-\u001f\u007f]/g, ' ').trim() : '';
    if (!txt) return err('Boş mesaj gönderilemez.');
    if (txt.length > CHAT_MAX) return err(`Mesaj en fazla ${CHAT_MAX} karakter olabilir.`);
    if (r.o && await isBlocked(db, r.o.id, user.id)) return err('Bu oyuncu sana mesaj almıyor.', 403);
    const now = Date.now();
    const rec = await db.prepare('SELECT COUNT(*) AS n, MAX(t) AS last FROM chat WHERE user_id = ? AND t > ?').bind(user.id, now - 60000).first();
    if (rec.last && now - rec.last < 1500) return err('Biraz yavaş: mesajlar arasında 1-2 saniye bekle.', 429);
    if (rec.n >= 20) return err('Bir dakikada çok fazla mesaj gönderdin, biraz bekle.', 429);
    txt = cleanTxt(txt);
    const ins = await db.prepare('INSERT INTO chat (room, user_id, txt, t) VALUES (?, ?, ?, ?) RETURNING id').bind(r.room, user.id, txt, now).first();
    // oda başına son 500 mesaj tutulur
    if (ins.id % 25 === 0) await db.prepare('DELETE FROM chat WHERE room = ? AND id <= ?').bind(r.room, ins.id - 500).run();
    await db.prepare('INSERT INTO chat_read (user_id, room, last) VALUES (?, ?, ?) ON CONFLICT(user_id, room) DO UPDATE SET last = MAX(last, excluded.last)').bind(user.id, r.room, ins.id).run();
    return json({ ok: true, id: ins.id, txt });
  }
  if (path === '/api/chat/delete' && method === 'POST') {
    const { id } = await readBody(req);
    const msg = await db.prepare('SELECT id, room, user_id FROM chat WHERE id = ?').bind(Math.floor(Number(id))).first();
    if (!msg) return err('Mesaj bulunamadı.', 404);
    let ok = msg.user_id === user.id;
    if (!ok && msg.room.startsWith('c:')) { const m = await myClan(db, user.id); ok = !!m && 'c:' + m.clan_id === msg.room && (m.role === 'leader' || m.role === 'co'); }
    if (!ok) return err('Bu mesajı silemezsin.', 403);
    await db.prepare('UPDATE chat SET del = 1 WHERE id = ?').bind(msg.id).run();
    return json({ ok: true });
  }
  if ((path === '/api/block' || path === '/api/unblock') && method === 'POST') {
    const { u } = await readBody(req); const o = await userByName(db, u);
    if (!o || o.id === user.id) return err('Oyuncu bulunamadı.', 404);
    if (path === '/api/block') await db.prepare('INSERT INTO blocks (user_id, blocked) VALUES (?, ?) ON CONFLICT DO NOTHING').bind(user.id, o.id).run();
    else await db.prepare('DELETE FROM blocks WHERE user_id = ? AND blocked = ?').bind(user.id, o.id).run();
    return json({ ok: true });
  }
  // bildirim merkezi: okunmamış mesajlar, istekler, davetler ve bağışlar tek listede
  if (path === '/api/inbox' && method === 'GET') {
    const since = Math.floor(Number(new URL(req.url).searchParams.get('since')) || 0), m = await myClan(db, user.id);
    const all = async (sql, ...a) => (await db.prepare(sql).bind(...a).all()).results || [];
    const dms = await all(`SELECT x.name, x.n, x.t, (SELECT txt FROM chat WHERE id = x.mid) AS txt FROM (
      SELECT u.name, COUNT(*) AS n, MAX(c.id) AS mid, MAX(c.t) AS t
      FROM chat c JOIN users u ON u.id = c.user_id LEFT JOIN chat_read rd ON rd.user_id = ?1 AND rd.room = c.room
      WHERE (c.room LIKE ?2 OR c.room LIKE ?3) AND c.user_id != ?1 AND c.del = 0 AND c.id > IFNULL(rd.last, 0) AND u.banned = 0
        AND c.user_id NOT IN (SELECT blocked FROM blocks WHERE user_id = ?1) GROUP BY c.user_id) x ORDER BY x.t DESC`, user.id, 'd:' + user.id + ':%', 'd:%:' + user.id);
    let clanChat = null;
    if (m) { const r = await db.prepare(`SELECT COUNT(*) AS n, MAX(c.t) AS t FROM chat c LEFT JOIN chat_read rd ON rd.user_id = ?1 AND rd.room = c.room
      WHERE c.room = ?2 AND c.user_id != ?1 AND c.del = 0 AND c.id > IFNULL(rd.last, 0)`).bind(user.id, 'c:' + m.clan_id).first();
      if (r.n) clanChat = { name: m.name, n: r.n, t: r.t }; }
    const fr = await all(`SELECT u.name, f.t FROM friends f JOIN users u ON u.id = f.a WHERE f.b = ? AND f.status = 'pending' ORDER BY f.t DESC`, user.id);
    const cj = m && (m.role === 'leader' || m.role === 'co') ? await all(`SELECT u.name, j.t FROM clan_joins j JOIN users u ON u.id = j.user_id WHERE j.clan_id = ? ORDER BY j.t DESC`, m.clan_id) : [];
    const ci = m ? [] : await all(`SELECT c.name AS clan, u.name AS by, i.t FROM clan_invites i JOIN clans c ON c.id = i.clan_id JOIN users u ON u.id = i.by_id WHERE i.user_id = ? ORDER BY i.t DESC`, user.id);
    const dn = await all(`SELECT u.name, f.card, f.t FROM feed f JOIN users u ON u.id = f.a WHERE f.kind = 'donate' AND f.b = ? AND f.t > ? ORDER BY f.t DESC LIMIT 20`, user.id, since);
    const ag = (await all('SELECT id, msg, payload, t FROM admin_gifts WHERE user_id = ? AND claimed = 0 ORDER BY t DESC LIMIT 20', user.id))
      .map(g => ({ id: g.id, msg: g.msg, p: JSON.parse(g.payload), t: g.t }));
    return json({ dms: dms.map(d => ({ name: d.name, n: d.n, txt: d.txt, t: d.t })), clanChat, fr, cj, ci, dn, ag });
  }
  if (path === '/api/notify' && method === 'GET') {
    await seenAt(db, user.id);
    const since = Math.floor(Number(new URL(req.url).searchParams.get('since')) || 0), m = await myClan(db, user.id);
    const fr = (await db.prepare(`SELECT COUNT(*) AS n FROM friends WHERE b = ? AND status = 'pending'`).bind(user.id).first()).n;
    const cj = m && (m.role === 'leader' || m.role === 'co') ? (await db.prepare('SELECT COUNT(*) AS n FROM clan_joins WHERE clan_id = ?').bind(m.clan_id).first()).n : 0;
    const dn = (await db.prepare(`SELECT COUNT(*) AS n FROM feed WHERE kind = 'donate' AND b = ? AND t > ?`).bind(user.id, since).first()).n;
    const ci = m ? 0 : (await db.prepare('SELECT COUNT(*) AS n FROM clan_invites WHERE user_id = ?').bind(user.id).first()).n;
    const unread = async room => (await db.prepare(`SELECT COUNT(*) AS n FROM chat c LEFT JOIN chat_read rd ON rd.user_id = ?1 AND rd.room = c.room
      WHERE c.room = ?2 AND c.user_id != ?1 AND c.del = 0 AND c.id > IFNULL(rd.last, 0)`).bind(user.id, room).first()).n;
    const cm = m ? await unread('c:' + m.clan_id) : 0;
    const dm = (await db.prepare(`SELECT COUNT(*) AS n FROM chat c LEFT JOIN chat_read rd ON rd.user_id = ?1 AND rd.room = c.room
      WHERE (c.room LIKE ?2 OR c.room LIKE ?3) AND c.user_id != ?1 AND c.del = 0 AND c.id > IFNULL(rd.last, 0)`).bind(user.id, 'd:' + user.id + ':%', 'd:%:' + user.id).first()).n;
    const ag = (await db.prepare('SELECT COUNT(*) AS n FROM admin_gifts WHERE user_id = ? AND claimed = 0').bind(user.id).first()).n;
    return json({ fr, cj, dn, ci, cm, dm, ag, clan: m ? m.name : null });
  }
  // yönetici hediyesini al: önce satır kilitlenir (claimed=1), kayda işlenemezse kilit geri açılır
  if (path === '/api/gift/claim' && method === 'POST') {
    const { id } = await readBody(req);
    const g = await db.prepare('UPDATE admin_gifts SET claimed = 1 WHERE id = ? AND user_id = ? AND claimed = 0 RETURNING payload').bind(Math.floor(Number(id)) || 0, user.id).first();
    if (!g) return err('Bu hediye zaten alınmış ya da bulunamadı.', 404);
    const P = JSON.parse(g.payload);
    try {
      const m = await mutateState(db, env, user.id, st => applyGift(st, P));
      await econLog(db, user.id, 'admin_gift', m.before, econSnap(m.st), 'admin hediyesi alındı #' + id);
      return json({ ok: true, p: P, save: m.st, rev: m.rev });
    } catch (e) { await db.prepare('UPDATE admin_gifts SET claimed = 0 WHERE id = ?').bind(Math.floor(Number(id))).run(); throw e; }
  }

  // ---------- YÖNETİCİ PANELİ (sadece env.OWNER) ----------
  if (path.startsWith('/api/admin/')) {
    if (!owner) return err('Bu işlem için yetkin yok.', 403);
    return adminApi(req, env, db, path, method, user);
  }

  return err('Bulunamadı.', 404);
}

// ---------- YÖNETİCİ ----------
const nInt = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.trunc(Number(v) || 0)));
// hediye/yönetici yükü: altın, toz, ücretsiz paket, kupa, kartlar {id:n}, destek kartları {tür:n}
function cleanPayload(p) {
  p = p && typeof p === 'object' ? p : {};
  const o = { gold: nInt(p.gold, -1e7, 1e7), dust: nInt(p.dust, -1e7, 1e7), free: nInt(p.free, -1000, 1000), trophy: nInt(p.trophy, -1e5, 1e5), cards: {}, sup: {} };
  for (const [k, v] of Object.entries(p.cards || {})) if (MR.BY[k] && !EZ_IDS.has(String(k))) { const n = nInt(v, -99, 99); if (n) o.cards[k] = n; }
  for (const [k, v] of Object.entries(p.sup || {})) if (MR.SUPK.includes(k)) { const n = nInt(v, -99, 99); if (n) o.sup[k] = n; }
  return o;
}
function applyGift(st, P) {
  st.gold = Math.max(0, (st.gold || 0) + P.gold); st.dust = Math.max(0, (st.dust || 0) + P.dust);
  st.free = Math.max(0, (st.free || 0) + P.free); st.trophy = Math.max(0, (st.trophy || 0) + P.trophy);
  st.owned = st.owned || {};
  for (const [k, n] of Object.entries(P.cards)) { const v = Math.max(0, (st.owned[k] || 0) + n); if (v) st.owned[k] = v; else delete st.owned[k]; }
  st.sup = st.sup || {};
  for (const [k, n] of Object.entries(P.sup)) st.sup[k] = Math.max(0, (st.sup[k] || 0) + n);
  return P;
}
const payloadTxt = P => [P.gold && `${P.gold} altın`, P.dust && `${P.dust} toz`, P.free && `${P.free} paket`, P.trophy && `${P.trophy} kupa`,
  ...Object.entries(P.cards).map(([k, n]) => `${n}× ${MR.BY[k].name || k}`), ...Object.entries(P.sup).map(([k, n]) => `${n}× destek:${k}`)].filter(Boolean).join(', ');
async function adminApi(req, env, db, path, method, me) {
  const target = async u => { const o = await db.prepare('SELECT id, name, banned, created FROM users WHERE ukey = ?').bind(ukeyOf(String(u || ''))).first(); if (!o) throw uerr('Oyuncu bulunamadı.', 404); return o; };
  try {
    if (path === '/api/admin/find' && method === 'GET') {
      const q = ukeyOf(String(new URL(req.url).searchParams.get('q') || '')).replace(/[%_]/g, '').slice(0, 16);
      const rows = (await db.prepare('SELECT name, banned FROM users WHERE ukey LIKE ? ORDER BY ukey LIMIT 20').bind(q + '%').all()).results || [];
      return json({ users: rows.map(r => ({ name: r.name, banned: !!r.banned })) });
    }
    if (path === '/api/admin/user' && method === 'GET') {
      const o = await target(new URL(req.url).searchParams.get('u'));
      const cur = await db.prepare('SELECT data FROM saves WHERE user_id = ?').bind(o.id).first();
      const st = cur ? MR.normalize(JSON.parse(cur.data), ctxOf(o.id)) : null;
      const matches = (await db.prepare('SELECT t, mode, opp, win, dt FROM match_log WHERE user_id = ? ORDER BY t DESC LIMIT 15').bind(o.id).all()).results || [];
      const econ = (await db.prepare('SELECT t, a, gold_before, gold_after, advC_before, advC_after, free_before, free_after, note FROM econ_log WHERE user_id = ? ORDER BY id DESC LIMIT 40').bind(o.id).all()).results || [];
      const gifts = (await db.prepare('SELECT id, msg, payload, t, claimed FROM admin_gifts WHERE user_id = ? ORDER BY t DESC LIMIT 10').bind(o.id).all()).results || [];
      return json({ name: o.name, banned: !!o.banned, created: o.created, sum: st && { gold: st.gold, dust: st.dust, free: st.free, trophy: st.trophy, lvl: st.lvl, xp: st.xp,
        advC: st.advC, advN: MR.ADV_N, col: Object.keys(st.owned || {}).filter(k => st.owned[k] > 0).length, cards: st.owned, sup: st.sup, wins: st.wins, losses: st.losses },
        matches, econ, gifts: gifts.map(g => ({ ...g, payload: JSON.parse(g.payload) })) });
    }
    if (path === '/api/admin/edit' && method === 'POST') {
      const b = await readBody(req), o = await target(b.u);
      let note;
      const m = await mutateState(db, env, o.id, st => {
        if (b.op === 'adv') { const v = nInt(b.advC, 0, MR.ADV_N); note = `macera ${st.advC} → ${v}`; st.advC = v; return v; }
        const P = cleanPayload(b.p); note = payloadTxt(P) || 'değişiklik yok'; return applyGift(st, P);
      });
      await econLog(db, o.id, 'admin', m.before, econSnap(m.st), `admin (${me.name}): ${note}`);
      return json({ ok: true, note });
    }
    if (path === '/api/admin/ban' && method === 'POST') {
      const b = await readBody(req), o = await target(b.u), ban = !!b.ban;
      if (isOwner(env, o)) throw uerr('Sahip hesap engellenemez.');
      await db.prepare('UPDATE users SET banned = ? WHERE id = ?').bind(ban ? 1 : 0, o.id).run();
      if (ban) await db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(o.id).run();   // açık oturumlar hemen düşer
      await econLog(db, o.id, 'admin', null, null, `admin (${me.name}): ${ban ? 'engellendi' : 'engel kaldırıldı'}`);
      return json({ ok: true, banned: ban });
    }
    if (path === '/api/admin/gift' && method === 'POST') {
      const b = await readBody(req), o = await target(b.u), P = cleanPayload(b.p);
      for (const k of ['gold', 'dust', 'free', 'trophy']) P[k] = Math.max(0, P[k]);
      for (const k of Object.keys(P.cards)) if (P.cards[k] < 0) delete P.cards[k];
      for (const k of Object.keys(P.sup)) if (P.sup[k] < 0) delete P.sup[k];
      const msg = String(b.msg || '').trim().slice(0, 200) || 'Yönetici hediyesi';
      if (!payloadTxt(P)) throw uerr('Hediye boş.');
      const r = await db.prepare('INSERT INTO admin_gifts (user_id, msg, payload, t) VALUES (?, ?, ?, ?) RETURNING id').bind(o.id, msg, JSON.stringify(P), Date.now()).first();
      await econLog(db, o.id, 'admin', null, null, `admin (${me.name}): hediye gönderildi #${r.id}: ${payloadTxt(P)}`);
      return json({ ok: true, id: r.id });
    }
  } catch (e) { if (e && e.user) return err(e.message, e.status || 400); throw e; }
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
        if (e && e.message === 'busy') return err('İşlem şu an yapılamadı, tekrar dene.', 503);
        return err('Sunucu hatası.', 500);
      }
    }
    return env.ASSETS.fetch(req);
  },
};
