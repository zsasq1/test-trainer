// Дуэли для тренажёра (Cloudflare Worker + Durable Object «Arena»).
//
// Игроков в дуэли — от двоих до восьми. Сервер — судья. Клиент только показывает вопросы и присылает выбор игрока; всё остальное решает здесь:
//   • кто подключился — по токену Firebase (подпись Google + чтение users/<uid> этим же токеном);
//   • какие вопросы достанутся — случайно из файла курса и выбранной категории, у каждого игрока свои;
//   • верен ли ответ — ключ лежит только здесь, игроку уходит вопрос без ключа;
//   • сколько длилась игра — по часам сервера;
//   • кто победил — больше верных, при равенстве — быстрее.
//
// Как подключается сайт:
//   POST /duel/ticket  (Authorization: Bearer <ID-токен Firebase>) → { ticket, me } — пропуск на минуту
//   GET  /duel/ws?ticket=…  — WebSocket; дальше сообщения JSON (см. H ниже)
//   GET  /duel/health  — жив ли сервер
//
// Переменные (wrangler.toml): ALLOWED_ORIGIN, SITE_URL, FIREBASE_DB, FIREBASE_PROJECT.
// Только для тестов: TEST_JWKS — ключи вместо Google и TEST_USERS — игроки вместо Firebase. Действуют на своём компьютере
// (wrangler dev, адрес localhost) или на временной копии сервера, выложенной тестом с STAGING=1 (npm run test:live).
// INVITE_TTL_MS, GRACE_MS, COUNTDOWN_MS, PER_Q_MS, SETUP_MAX_MS, KEEP_MS — сроки покороче.

import { DurableObject } from 'cloudflare:workers';
import { MAX_N, MAX_PLAYERS, CATS, byCat, catCounts, parsePool, deal, view, grade, decide, review, doneOf } from './game.js';

const enc = new TextEncoder();
const JWKS_URL = 'https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com';
const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);
const num = (v, d) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
const config = env => ({
  inviteTtl: num(env.INVITE_TTL_MS, 60000), // приглашение ждёт ответа
  grace: num(env.GRACE_MS, 45000), // сколько ждём игрока, потерявшего связь
  countdown: num(env.COUNTDOWN_MS, 3500), // 3-2-1 перед стартом
  perQ: num(env.PER_Q_MS, 120000), // запас времени на вопрос: дуэль не может длиться вечно
  setupMax: num(env.SETUP_MAX_MS, 10 * 60000), // комната настройки живёт не дольше
  keep: num(env.KEEP_MS, 30 * 60000) // законченная дуэль хранится для реванша и повторного показа
});
const rid = n => [...crypto.getRandomValues(new Uint8Array(n))].map(x => 'abcdefghijklmnopqrstuvwxyz0123456789'[x % 36]).join('');
// имя для поиска: строчные, ё = е, одиночные пробелы (как nameKey в app.html)
const normKey = s => String(s || '').normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase().replace(/ё/g, 'е');
const okRid = r => (typeof r === 'string' && r.length <= 24) || Number.isInteger(r) ? r : undefined;

/* ---------- кто подключился: ID-токен Firebase ---------- */
const b64u = s => { s = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return Uint8Array.from(atob(s), c => c.charCodeAt(0)); };
const jpart = s => JSON.parse(new TextDecoder().decode(b64u(s)));
let KEYS = { at: 0, ttl: 0, src: '', map: new Map() };
async function keys(env, local, force) {
  const src = local && env.TEST_JWKS ? 'test' : 'google'; // тестовые ключи — только на своём компьютере или на временной копии для проверки
  if (!force && KEYS.src === src && Date.now() - KEYS.at < KEYS.ttl) return KEYS.map;
  let jwks, ttl = 3600e3;
  if (src === 'test') jwks = JSON.parse(env.TEST_JWKS);
  else {
    const r = await fetch(JWKS_URL);
    if (!r.ok) throw new Error('JWKS ' + r.status);
    jwks = await r.json();
    const m = /max-age=(\d+)/.exec(r.headers.get('Cache-Control') || '');
    if (m) ttl = Math.min(+m[1] * 1000, 6 * 3600e3);
  }
  const map = new Map();
  for (const k of (jwks && jwks.keys) || []) {
    if (k.kty !== 'RSA' || typeof k.kid !== 'string') continue;
    map.set(k.kid, await crypto.subtle.importKey('jwk', { kty: 'RSA', n: k.n, e: k.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
  }
  KEYS = { at: Date.now(), ttl, src, map };
  return map;
}
// → uid или null. https://firebase.google.com/docs/auth/admin/verify-id-tokens#verify_id_tokens_using_a_third-party_jwt_library
export async function verifyToken(token, env, local) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || token.length > 4096) return null;
  let h, p;
  try { h = jpart(parts[0]); p = jpart(parts[1]); } catch (e) { return null; }
  if (!h || h.alg !== 'RS256' || typeof h.kid !== 'string' || !p || typeof p !== 'object') return null;
  let map = await keys(env, local, false);
  if (!map.has(h.kid)) map = await keys(env, local, true);
  const key = map.get(h.kid);
  if (!key) return null;
  let sig;
  try { sig = b64u(parts[2]); } catch (e) { return null; }
  if (!(await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, enc.encode(parts[0] + '.' + parts[1])))) return null;
  const now = Date.now() / 1000, proj = env.FIREBASE_PROJECT;
  if (!proj || p.aud !== proj || p.iss !== 'https://securetoken.google.com/' + proj) return null;
  if (!(p.exp > now) || !(p.iat <= now + 300) || (p.auth_time != null && !(p.auth_time <= now + 300))) return null;
  if (typeof p.sub !== 'string' || !p.sub || p.sub.length > 128) return null;
  return p.sub;
}
// Имя и факультет — из базы, тем же токеном: правила пускают в users/<uid> только самого владельца.
// Временная копия для проверки (STAGING) берёт тестовых игроков из TEST_USERS и в Firebase не ходит.
async function profile(uid, token, env, test) {
  if (test && env.TEST_USERS) return person(uid, JSON.parse(env.TEST_USERS)[uid] || null);
  const r = await fetch(String(env.FIREBASE_DB).replace(/\/+$/, '') + '/users/' + encodeURIComponent(uid) + '.json?auth=' + encodeURIComponent(token));
  if (r.status === 401 || r.status === 403) return { error: 'DENIED' };
  if (!r.ok) return { error: 'DB' };
  return person(uid, await r.json().catch(() => null));
}
function person(uid, u) {
  if (!u || typeof u.name !== 'string' || !u.name.trim()) return { error: 'NO_NAME' };
  if (u.blocked === true) return { error: 'BLOCKED' };
  return { uid, name: u.name.trim().slice(0, 40), fac: /^(lech|ped|stom)$/.test(u.fac) ? u.fac : 'lech', course: Number.isInteger(u.course) && u.course >= 0 && u.course <= 6 ? u.course : 0 };
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    // тестовые ключи и игроки: на своём компьютере (wrangler dev) или на временной копии сервера с STAGING=1;
    // у настоящего сервера этой переменной нет — там только ключи Google и база Firebase
    const local = !!env.TEST_JWKS && (LOCAL.has(url.hostname) || env.STAGING === '1');
    const allowed = String(env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
    const origin = req.headers.get('Origin') || '';
    const okOrigin = allowed.includes(origin);
    const cors = {
      'Access-Control-Allow-Origin': okOrigin ? origin : allowed[0] || 'null',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin'
    };
    const out = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const arena = () => env.ARENA.get(env.ARENA.idFromName('arena'));

    if (url.pathname === '/duel/health') return out({ ok: true, v: 1 });

    if (url.pathname === '/duel/ticket') {
      if (req.method !== 'POST') return out({ error: 'POST_ONLY' }, 405);
      if (!okOrigin) return out({ error: 'ORIGIN' }, 403);
      const m = /^Bearer\s+(\S+)$/.exec(req.headers.get('Authorization') || '');
      if (!m) return out({ error: 'NO_TOKEN' }, 401);
      let uid;
      try { uid = await verifyToken(m[1], env, local); } catch (e) { return out({ error: 'KEYS' }, 503); }
      if (!uid) return out({ error: 'BAD_TOKEN' }, 401);
      const p = await profile(uid, m[1], env, local).catch(() => ({ error: 'DB' }));
      if (p.error) return out({ error: p.error }, p.error === 'DB' ? 503 : 403);
      return out(await arena().ticket(p));
    }

    if (url.pathname === '/duel/ws') {
      if ((req.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return out({ error: 'UPGRADE' }, 426);
      if (!okOrigin) return new Response('origin', { status: 403 });
      return arena().fetch(req);
    }
    return out({ error: 'NOT_FOUND' }, 404);
  }
};


/* =========================================================
   Арена: справочник игроков, приглашения, дуэли (от двоих до MAX_PLAYERS человек)
   ========================================================= */
class Refuse extends Error { constructor(code, extra) { super(code); this.code = code; this.extra = extra || {}; } }
const no = (code, extra) => { throw new Refuse(code, extra); };
const OPEN = 1;
const MAX_SOCKS = 6; // вкладок у одного человека
// дуэли, сохранённые до игры на нескольких (a и b вместо списка игроков), читаются по-новому
function upgrade(d) {
  if (!Array.isArray(d.ids)) { d.ids = [d.a, d.b].filter(Boolean); d.host = d.a; }
  delete d.a; delete d.b;
  if (!d.cat) d.cat = 'all';
  if (d.want == null) d.want = d.n;
  if (d.rematch && !Array.isArray(d.rematch.yes)) d.rematch = { by: d.rematch.by, at: d.rematch.at, yes: [d.rematch.by], no: [] };
  return d;
}

export class Arena extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.cfg = config(env);
    this.sql = ctx.storage.sql;
    this.tickets = new Map(); // пропуск → { uid, exp }
    this.buckets = new Map(); // uid → { tokens, at } — не больше ~15 сообщений в секунду
    this.inviteLog = new Map(); // uid → [время приглашений] — не больше 20 в минуту
    this.qcache = new Map(); // дуэль → { uid: вопросы с ключами }
    this.pools = new Map(); // файл → { pool, at }
    this.setsCache = null;
    this.invites = new Map();
    this.duels = new Map();
    ctx.blockConcurrencyWhile(async () => this.load());
    // ping от вкладки не будит арену
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"t":"ping"}', '{"t":"pong"}'));
  }

  load() {
    const x = this.sql;
    x.exec('CREATE TABLE IF NOT EXISTS users(uid TEXT PRIMARY KEY, name TEXT NOT NULL, key TEXT NOT NULL, fac TEXT, course INTEGER, seen INTEGER, wins INTEGER NOT NULL DEFAULT 0, losses INTEGER NOT NULL DEFAULT 0, draws INTEGER NOT NULL DEFAULT 0)');
    x.exec('CREATE INDEX IF NOT EXISTS users_key ON users(key)');
    x.exec('CREATE TABLE IF NOT EXISTS invites(id TEXT PRIMARY KEY, data TEXT NOT NULL)');
    x.exec('CREATE TABLE IF NOT EXISTS duels(id TEXT PRIMARY KEY, status TEXT NOT NULL, updated INTEGER NOT NULL, data TEXT NOT NULL)');
    x.exec('CREATE TABLE IF NOT EXISTS duel_qs(duel TEXT NOT NULL, uid TEXT NOT NULL, data TEXT NOT NULL, PRIMARY KEY(duel, uid))');
    for (const r of x.exec('SELECT data FROM invites')) { const v = JSON.parse(r.data); this.invites.set(v.id, v); }
    for (const r of x.exec('SELECT data FROM duels')) { const d = upgrade(JSON.parse(r.data)); this.duels.set(d.id, d); }
  }

  /* ---------- хранение ---------- */
  putInvite(v) { this.invites.set(v.id, v); this.sql.exec('INSERT OR REPLACE INTO invites(id, data) VALUES (?, ?)', v.id, JSON.stringify(v)); }
  delInvite(v) { this.invites.delete(v.id); this.sql.exec('DELETE FROM invites WHERE id = ?', v.id); }
  putDuel(d) {
    d.updated = Date.now();
    this.duels.set(d.id, d);
    this.sql.exec('INSERT OR REPLACE INTO duels(id, status, updated, data) VALUES (?, ?, ?, ?)', d.id, d.status, d.updated, JSON.stringify(d));
  }
  delDuel(d) {
    this.duels.delete(d.id); this.qcache.delete(d.id);
    this.sql.exec('DELETE FROM duels WHERE id = ?', d.id);
    this.sql.exec('DELETE FROM duel_qs WHERE duel = ?', d.id);
  }
  getQs(id, uid) {
    let m = this.qcache.get(id);
    if (!m) { m = {}; this.qcache.set(id, m); }
    if (!m[uid]) { const r = this.sql.exec('SELECT data FROM duel_qs WHERE duel = ? AND uid = ?', id, uid).toArray()[0]; m[uid] = r ? JSON.parse(r.data) : []; }
    return m[uid];
  }

  /* ---------- справочник игроков ---------- */
  async ticket(p) {
    const now = Date.now();
    this.sql.exec(`INSERT INTO users(uid, name, key, fac, course, seen) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(uid) DO UPDATE SET name = excluded.name, key = excluded.key, fac = excluded.fac, course = excluded.course, seen = excluded.seen`,
    p.uid, p.name, normKey(p.name), p.fac, p.course, now);
    for (const [t, v] of this.tickets) if (v.exp < now) this.tickets.delete(t);
    const t = rid(32);
    this.tickets.set(t, { uid: p.uid, exp: now + 60000 });
    return { ticket: t, me: this.card(p.uid), now };
  }
  user(uid) { return this.sql.exec('SELECT * FROM users WHERE uid = ?', uid).toArray()[0] || null; }
  card(uid) {
    const u = this.user(uid);
    return u ? { uid: u.uid, name: u.name, fac: u.fac, course: u.course, wins: u.wins, losses: u.losses, draws: u.draws } : { uid, name: '?', fac: 'lech', course: 0, wins: 0, losses: 0, draws: 0 };
  }

  /* ---------- вкладки ---------- */
  socks(uid) { return this.ctx.getWebSockets(uid).filter(w => w.readyState === OPEN); }
  online(uid) { return this.socks(uid).length > 0; }
  onlineUids() {
    const s = new Set();
    for (const w of this.ctx.getWebSockets()) { if (w.readyState !== OPEN) continue; const a = w.deserializeAttachment(); if (a && a.uid) s.add(a.uid); }
    return s;
  }
  send(ws, m) { try { ws.send(JSON.stringify(m)); } catch (e) { /* closed */ } }
  tell(uid, m) { const s = JSON.stringify(m); for (const w of this.socks(uid)) { try { w.send(s); } catch (e) { /* closed */ } } }
  allow(uid) {
    const now = Date.now(), b = this.buckets.get(uid) || { tokens: 30, at: now };
    b.tokens = Math.min(30, b.tokens + ((now - b.at) / 1000) * 15); b.at = now;
    if (b.tokens < 1) { this.buckets.set(uid, b); return false; }
    b.tokens -= 1; this.buckets.set(uid, b);
    return true;
  }

  async fetch(req) {
    const t = new URL(req.url).searchParams.get('ticket') || '';
    const tk = this.tickets.get(t);
    this.tickets.delete(t);
    if (!tk || tk.exp < Date.now()) return new Response('ticket', { status: 401 });
    const old = this.socks(tk.uid);
    if (old.length >= MAX_SOCKS) { try { old[0].close(4002, 'too many tabs'); } catch (e) { /* closed */ } }
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server, [tk.uid]);
    server.serializeAttachment({ uid: tk.uid, at: Date.now() });
    this.arrived(tk.uid, server);
    await this.plan();
    return new Response(null, { status: 101, webSocket: client });
  }

  // вкладка подключилась: вернулся ли игрок в свою дуэль; всё, что ему нужно знать, — в hello
  arrived(uid, ws) {
    const d = this.activeOf(uid);
    if (d && d.p[uid].away) { d.p[uid].away = null; this.putDuel(d); this.push(d); }
    this.send(ws, this.hello(uid));
  }
  hello(uid, r) {
    const now = Date.now();
    const invIn = [...this.invites.values()].filter(v => v.to === uid && v.exp > now).map(v => this.invView(v));
    const outs = this.outOf(uid).map(v => this.invView(v));
    const d = this.currentOf(uid);
    const m = { t: 'hello', rid: r, now, me: this.card(uid), invIn, invOuts: outs, invOut: outs[outs.length - 1] || null, duel: d ? this.view(d) : null };
    if (d && d.status === 'play') m.qs = this.myQs(d, uid);
    if (d && d.status === 'over') m.review = { id: d.id, items: review(this.getQs(d.id, uid), d.p[uid]) };
    return m;
  }

  async webSocketMessage(ws, raw) {
    const a = ws.deserializeAttachment(), uid = a && a.uid;
    if (!uid) { try { ws.close(4001, 'auth'); } catch (e) { /* closed */ } return; }
    if (typeof raw !== 'string' || raw.length > 8192) return;
    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m || typeof m !== 'object' || typeof m.t !== 'string') return;
    const r = okRid(m.rid);
    if (!this.allow(uid)) { this.send(ws, { t: 'error', rid: r, code: 'RATE' }); return; }
    const h = Object.hasOwn(H, m.t) ? H[m.t] : null;
    if (!h) { this.send(ws, { t: 'error', rid: r, code: 'UNKNOWN' }); return; }
    try {
      const res = await h.call(this, ws, uid, m, r);
      if (res !== false && r !== undefined) this.send(ws, { t: 'ok', rid: r });
    } catch (e) {
      if (e instanceof Refuse) this.send(ws, { t: 'error', rid: r, code: e.code, ...e.extra });
      else { console.error(e && e.stack || e); this.send(ws, { t: 'error', rid: r, code: 'SERVER' }); }
    }
    await this.plan();
  }
  async webSocketClose(ws, code, reason) {
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, String(reason || '').slice(0, 60)); } catch (e) { /* already closed */ }
    this.lost(ws);
    await this.plan();
  }
  async webSocketError(ws) { this.lost(ws); await this.plan(); }
  lost(ws) {
    const a = ws.deserializeAttachment(), uid = a && a.uid;
    if (!uid || this.socks(uid).some(w => w !== ws)) return; // другая вкладка ещё открыта
    const d = this.activeOf(uid);
    if (!d) return;
    const p = d.p[uid];
    if (d.status === 'play' && (p.fin != null || p.left)) return; // уже закончил — ждать нечего
    if (!p.away) { p.away = Date.now(); this.putDuel(d); this.push(d); }
  }

  /* ---------- приглашения ---------- */
  // в какую комнату зовут: комната настройки, где хозяин — пригласивший
  hosting(uid) { const d = this.activeOf(uid); return d && d.status === 'setup' && d.host === uid ? d : null; }
  outOf(uid) { const now = Date.now(); return [...this.invites.values()].filter(v => v.from === uid && v.exp > now); }
  invView(v) { const d = this.hosting(v.from); return { id: v.id, from: this.card(v.from), to: this.card(v.to), exp: v.exp, now: Date.now(), room: d ? d.ids.length : 0 }; }
  tellOut(uid) { const all = this.outOf(uid).map(v => this.invView(v)); this.tell(uid, { t: 'invite-out', inv: all[all.length - 1] || null, all }); }
  dropInvite(v, why) {
    this.delInvite(v);
    const m = { t: 'invite-gone', id: v.id, why };
    this.tell(v.from, m); this.tell(v.to, m);
    const d = this.hosting(v.from);
    if (d) this.push(d); // в комнате видно, кого ещё ждут
  }
  // приглашения этих людей (от них и к ним) больше не в силе
  dropInvitesOf(uids, why) { for (const v of [...this.invites.values()]) if (uids.includes(v.from) || uids.includes(v.to)) this.dropInvite(v, why); }

  /* ---------- дуэли ---------- */
  inDuel(d, uid) { return d.ids.includes(uid); }
  activeOf(uid) { for (const d of this.duels.values()) if ((d.status === 'setup' || d.status === 'play') && this.inDuel(d, uid)) return d; return null; }
  currentOf(uid) {
    const act = this.activeOf(uid);
    if (act) return act;
    let best = null;
    for (const d of this.duels.values()) {
      if (d.status !== 'over' || !this.inDuel(d, uid) || d.closed[uid] || d.next) continue;
      if (!best || d.endAt > best.endAt) best = d;
    }
    return best;
  }
  duel(id, uid) { const d = this.duels.get(String(id || '')); if (!d || !this.inDuel(d, uid)) no('NO_DUEL'); return d; }
  join(d, u, now = Date.now()) {
    if (!d.ids.includes(u)) d.ids.push(u);
    const c = this.card(u);
    d.who[u] = { name: c.name, fac: c.fac, course: c.course };
    d.p[u] = { ans: [], ok: 0, fin: null, stop: null, left: false, dropped: false, away: this.online(u) ? null : now };
  }
  newDuel(host, ids, extra = {}) {
    const now = Date.now();
    const d = { id: rid(16), status: 'setup', host, ids: [], who: {}, p: {}, created: now, file: null, title: '', cat: 'all', counts: null, n: 10, want: 10, max: 0, startAt: null, deadline: null, endAt: null, result: null, rematch: null, rematchNo: null, closed: {}, next: null, why: null, by: null, ...extra };
    for (const u of ids) this.join(d, u, now);
    return d;
  }
  // гость уходит из комнаты (сам или пропал со связи); комната остаётся у хозяина и остальных
  remove(d, u, why) {
    const name = (d.who[u] || {}).name || '?';
    d.ids = d.ids.filter(x => x !== u);
    delete d.p[u]; delete d.who[u];
    this.putDuel(d); this.push(d);
    this.tell(u, { t: 'left', id: d.id, why });
    for (const x of d.ids) this.tell(x, { t: 'gone', id: d.id, uid: u, name, why });
  }
  view(d) {
    const P = uid => {
      const p = d.p[uid], w = d.who[uid];
      return { uid, name: w.name, fac: w.fac, course: w.course, on: this.online(uid), back: p.away ? p.away + this.cfg.grace : null, done: doneOf(p), ok: p.ok, fin: p.fin != null && d.startAt ? p.fin - d.startAt : null, left: p.left };
    };
    const players = {};
    for (const u of d.ids) players[u] = P(u);
    const rm = d.rematch;
    return {
      id: d.id, status: d.status, host: d.host, ids: d.ids.slice(), players,
      // для вкладок прежней версии (дуэль на двоих): a — хозяин, b — второй
      a: d.host, b: d.ids.find(u => u !== d.host) || null,
      pend: d.status === 'setup' ? this.outOf(d.host).map(v => ({ uid: v.to, name: this.card(v.to).name, exp: v.exp })) : [],
      file: d.file, title: d.title, cat: d.cat, counts: d.counts, n: d.n, max: d.max, startAt: d.startAt, deadline: d.deadline, endAt: d.endAt,
      result: d.result, rematch: rm ? rm.by : null, yes: rm ? rm.yes.slice() : [], no: rm ? rm.no.slice() : [], rematchNo: d.rematchNo,
      closed: Object.keys(d.closed), next: d.next, why: d.why, by: d.by, now: Date.now()
    };
  }
  push(d) { const m = { t: 'duel', duel: this.view(d) }; for (const u of d.ids) this.tell(u, m); }
  myQs(d, uid) { const p = d.p[uid]; return { id: d.id, qs: this.getQs(d.id, uid).map(view), ans: Array.from(p.ans, x => (x ? { ok: x.ok, empty: x.empty } : null)) }; }
  // игра кончается, когда все ответили или вышли — или когда в игре остался один (остальные сдались или пропали)
  ended(d) { return d.ids.every(u => d.p[u].fin != null || d.p[u].left) || d.ids.filter(u => !d.p[u].left).length <= 1; }
  cancel(d, why, by) {
    d.status = 'cancelled'; d.why = why; d.by = by || null; d.endAt = Date.now();
    this.putDuel(d); this.push(d);
    this.dropInvitesOf([d.host], 'cancelled'); // кого ещё звали в эту комнату
  }
  // старт: каждому — своя случайная раздача из одного файла и одной категории; 3-2-1 идёт по часам сервера
  launch(d, full) {
    const pool = byCat(full, d.cat);
    const now = Date.now(), n = Math.max(1, Math.min(d.n | 0, pool.length, MAX_N));
    d.n = n; d.max = Math.min(MAX_N, pool.length); d.status = 'play'; d.startAt = now + this.cfg.countdown; d.deadline = d.startAt + n * this.cfg.perQ;
    const m = {};
    for (const u of d.ids) {
      m[u] = deal(pool, n);
      this.sql.exec('INSERT OR REPLACE INTO duel_qs(duel, uid, data) VALUES (?, ?, ?)', d.id, u, JSON.stringify(m[u]));
    }
    this.qcache.set(d.id, m);
    this.putDuel(d);
    this.dropInvitesOf(d.ids, 'started'); // игра началась: ни звать, ни отвечать на приглашения им некогда
    this.push(d);
    for (const u of d.ids) this.tell(u, { t: 'qs', ...this.myQs(d, u) });
  }
  finish(d) {
    if (d.status !== 'play') return;
    const now = Date.now();
    d.status = 'over'; d.endAt = now;
    for (const u of d.ids) { const p = d.p[u]; if (p.fin == null && p.stop == null) p.stop = Math.min(now, d.deadline || now); p.away = null; }
    d.result = decide(d);
    if (d.result.reason !== 'abandoned') {
      // победа — одному; делившие первое место — ничья; остальным — поражение
      for (const u of d.ids) {
        const col = d.result.winner === u ? 'wins' : d.result.winner == null && d.result.top.includes(u) ? 'draws' : 'losses';
        this.sql.exec(`UPDATE users SET ${col} = ${col} + 1 WHERE uid = ?`, u);
      }
    }
    this.putDuel(d); this.push(d);
    for (const u of d.ids) this.tell(u, { t: 'review', id: d.id, items: review(this.getQs(d.id, u), d.p[u]) });
  }
  /* реванш: согласные (не меньше двоих) играют снова — тот же файл, та же категория, столько же вопросов, новые вопросы.
     Начинается сам, когда ответили все, кто ещё может ответить; согласившиеся могут не ждать остальных (force). */
  rematchState(d) {
    const rm = d.rematch;
    const yes = rm.yes.filter(u => !d.closed[u] && !this.activeOf(u));
    const waiting = d.ids.filter(u => !rm.yes.includes(u) && !rm.no.includes(u) && !d.closed[u] && this.online(u) && !this.activeOf(u));
    return { yes, waiting };
  }
  async settleRematch(d, force) {
    const rm = d.rematch;
    if (rm && !d.next && d.status === 'over') {
      const { yes, waiting } = this.rematchState(d);
      if (yes.length >= 2 && (force || !waiting.length)) {
        const pool = await this.pool(d.file);
        if (d.rematch === rm && !d.next && !yes.some(u => this.activeOf(u))) {
          const host = yes.includes(rm.by) ? rm.by : yes[0];
          const nd = this.newDuel(host, [host].concat(d.ids.filter(u => u !== host && yes.includes(u))), { file: d.file, title: d.title, cat: d.cat, counts: d.counts, n: d.n, want: d.want, max: d.max });
          d.next = nd.id; d.rematch = null;
          this.putDuel(d); this.push(d);
          this.launch(nd, pool);
          return;
        }
      } else if (yes.length < 2 && !waiting.length) d.rematch = null; // соглашаться больше некому
    }
    this.putDuel(d); this.push(d);
  }

  /* ---------- файлы курсов (те же, что у сайта) ---------- */
  async setsList() {
    if (this.setsCache && Date.now() - this.setsCache.at < 300000) return this.setsCache.list;
    const r = await fetch(new URL('data/sets.json', this.env.SITE_URL), { cf: { cacheTtl: 60 } });
    if (!r.ok) no('SETS');
    const j = await r.json().catch(() => null);
    const list = (Array.isArray(j) ? j : []).filter(x => x && typeof x.file === 'string' && /\.json$/i.test(x.file) && !x.file.split('/').some(s => !s || s === '.' || s === '..' || s.includes('\\')))
      .map(x => ({ file: x.file, title: typeof x.title === 'string' && x.title ? x.title.slice(0, 120) : x.file.replace(/^.*\//, '').replace(/\.json$/i, '') }));
    this.setsCache = { list, at: Date.now() };
    return list;
  }
  async pool(file) {
    const c = this.pools.get(file);
    if (c && Date.now() - c.at < 600000) return c.pool;
    const r = await fetch(new URL('data/' + file.split('/').map(encodeURIComponent).join('/'), this.env.SITE_URL), { cf: { cacheTtl: 300 } });
    if (!r.ok) no('FILE');
    const pool = parsePool(await r.json().catch(() => null));
    this.pools.set(file, { pool, at: Date.now() });
    if (this.pools.size > 8) this.pools.delete(this.pools.keys().next().value);
    return pool;
  }

  /* ---------- сроки: приглашения, обрыв связи, конец игры, уборка ---------- */
  nextDue() {
    const c = this.cfg;
    let t = Infinity;
    for (const v of this.invites.values()) t = Math.min(t, v.exp);
    for (const d of this.duels.values()) {
      if (d.status === 'setup') {
        t = Math.min(t, d.created + c.setupMax);
        for (const u of d.ids) if (d.p[u].away) t = Math.min(t, d.p[u].away + c.grace);
      } else if (d.status === 'play') {
        t = Math.min(t, d.deadline);
        for (const u of d.ids) { const p = d.p[u]; if (p.away && p.fin == null && !p.left) t = Math.min(t, p.away + c.grace); }
      } else t = Math.min(t, (d.endAt || d.updated) + c.keep);
    }
    return t === Infinity ? null : Math.max(t, Date.now() + 20);
  }
  async plan() {
    const t = this.nextDue();
    if (t == null) return;
    const cur = await this.ctx.storage.getAlarm();
    if (cur == null || cur > t || cur < Date.now() - 1000) await this.ctx.storage.setAlarm(t);
  }
  async alarm() {
    const now = Date.now(), c = this.cfg;
    for (const v of [...this.invites.values()]) if (v.exp <= now) this.dropInvite(v, 'expired');
    for (const d of [...this.duels.values()]) {
      if (d.status === 'setup') {
        const gone = d.ids.filter(u => d.p[u].away && now - d.p[u].away >= c.grace);
        // пропал хозяин — комната закрывается; пропал гость — он больше не в комнате
        if (gone.includes(d.host)) this.cancel(d, 'gone', d.host);
        else if (now - d.created >= c.setupMax) this.cancel(d, 'timeout');
        else for (const u of gone) this.remove(d, u, 'gone');
      } else if (d.status === 'play') {
        let changed = false;
        for (const u of d.ids) {
          const p = d.p[u];
          if (p.away && p.fin == null && !p.left && now - p.away >= c.grace) { p.left = true; p.dropped = true; p.stop = p.away; changed = true; }
        }
        // пропавший надолго выбывает, как сдавшийся; остался один — игра окончена
        if (now >= d.deadline || this.ended(d)) this.finish(d);
        else if (changed) { this.putDuel(d); this.push(d); }
      } else if (now - (d.endAt || d.updated) >= c.keep) this.delDuel(d);
    }
    await this.plan();
  }
}

/* ---------- сообщения от вкладки ---------- */
const H = {
  time(ws, uid, m, r) { this.send(ws, { t: 'time', rid: r, now: Date.now() }); return false; },
  sync(ws, uid, m, r) { this.send(ws, this.hello(uid, r)); return false; },

  // поиск по имени (начало любого слова); пустой запрос — кто сейчас в сети
  search(ws, uid, m, r) {
    const q = normKey(typeof m.q === 'string' ? m.q : '').slice(0, 40);
    const on = this.onlineUids();
    let rows;
    if (!q) rows = [...on].filter(x => x !== uid).slice(0, 60).map(x => this.user(x)).filter(Boolean);
    else {
      const e = q.replace(/[\\%_]/g, ch => '\\' + ch);
      rows = this.sql.exec("SELECT * FROM users WHERE uid != ? AND (key LIKE ? ESCAPE '\\' OR key LIKE ? ESCAPE '\\') ORDER BY seen DESC LIMIT 60", uid, e + '%', '% ' + e + '%').toArray();
    }
    const list = rows.map(u => ({ uid: u.uid, name: u.name, fac: u.fac, course: u.course, wins: u.wins, losses: u.losses, draws: u.draws, seen: u.seen, on: on.has(u.uid), busy: !!this.activeOf(u.uid) }));
    list.sort((x, y) => (y.on - x.on) || x.name.localeCompare(y.name, 'ru'));
    this.send(ws, { t: 'search', rid: r, q: typeof m.q === 'string' ? m.q.slice(0, 40) : '', list: list.slice(0, 30) });
    return false;
  },

  // позвать: из поиска (комнаты ещё нет — она откроется, когда кто-то согласится) или из своей комнаты;
  // можно звать нескольких сразу, всего в дуэли — до MAX_PLAYERS человек
  invite(ws, uid, m) {
    const to = typeof m.to === 'string' ? m.to : '';
    if (!to || to === uid) no('SELF');
    if (!this.user(to)) no('NO_USER');
    if (!this.online(to)) no('OFFLINE');
    const mine = this.activeOf(uid);
    if (mine && mine.status !== 'setup') no('BUSY_ME');
    if (mine && mine.host !== uid) no('NOT_HOST');
    if (mine && mine.ids.includes(to)) no('IN_ROOM');
    if (this.activeOf(to)) no('BUSY');
    const now = Date.now();
    // встречное приглашение, пока своей комнаты нет: человек уже позвал меня — это и есть согласие
    const cross = !mine && [...this.invites.values()].find(v => v.from === to && v.to === uid && v.exp > now);
    if (cross) return H.reply.call(this, ws, uid, { id: cross.id, ok: true });
    if ((mine ? mine.ids.length : 1) + this.outOf(uid).filter(v => v.to !== to).length >= MAX_PLAYERS) no('FULL', { max: MAX_PLAYERS });
    const log = (this.inviteLog.get(uid) || []).filter(x => now - x < 60000);
    if (log.length >= 20) no('RATE'); // хозяин зовёт до семи человек — с запасом на повторы
    log.push(now); this.inviteLog.set(uid, log);
    for (const v of [...this.invites.values()]) if (v.from === uid && v.to === to) this.dropInvite(v, 'replaced');
    const v = { id: rid(12), from: uid, to, at: now, exp: now + this.cfg.inviteTtl };
    this.putInvite(v);
    this.tell(to, { t: 'invite-in', inv: this.invView(v) });
    this.tellOut(uid);
    if (mine) this.push(mine);
  },
  cancel(ws, uid, m) {
    const v = this.invites.get(String(m.id || ''));
    if (v && v.from === uid) this.dropInvite(v, 'cancelled');
  },
  // согласие: в комнату пригласившего (если её ещё нет — открывается на двоих)
  reply(ws, uid, m) {
    const v = this.invites.get(String(m.id || ''));
    if (!v || v.to !== uid || v.exp <= Date.now()) no('GONE');
    if (m.ok !== true) { this.dropInvite(v, 'declined'); return; }
    if (!this.online(v.from)) { this.dropInvite(v, 'offline'); no('OFFLINE'); }
    let d = this.activeOf(v.from);
    if (this.activeOf(uid) || (d && (d.status !== 'setup' || d.host !== v.from))) { this.dropInvite(v, 'busy'); no('BUSY'); }
    if (d && d.ids.length >= MAX_PLAYERS) { this.dropInvite(v, 'full'); no('FULL', { max: MAX_PLAYERS }); }
    this.dropInvite(v, 'accepted');
    if (d) this.join(d, uid);
    else d = this.newDuel(v.from, [v.from, uid]);
    this.putDuel(d);
    // у вошедшего другие приглашения больше не в силе; тех, кого хозяин ещё ждёт, — в силе: они придут в эту же комнату
    this.dropInvitesOf([uid], 'busy');
    for (const x of [...this.invites.values()]) if (x.to === v.from) this.dropInvite(x, 'busy');
    this.push(d);
  },

  // настройки — только у хозяина: файл курса, категория вопросов и их число (1–100, не больше, чем есть)
  async setup(ws, uid, m) {
    const d = this.duel(m.id, uid);
    if (d.status !== 'setup') no('STATE');
    if (d.host !== uid) no('NOT_HOST');
    if (m.cat !== undefined && !CATS.includes(m.cat)) no('BAD_CAT');
    if (m.n !== undefined && (!Number.isInteger(m.n) || m.n < 1 || m.n > MAX_N)) no('BAD_N');
    let file = d.file, title = d.title, counts = d.counts;
    if (typeof m.file === 'string' && m.file !== d.file) {
      const e = (await this.setsList()).find(x => x.file === m.file);
      if (!e) no('NO_FILE');
      const pool = await this.pool(e.file);
      if (!pool.length) no('EMPTY');
      file = e.file; title = e.title; counts = catCounts(pool);
    }
    if (this.duels.get(d.id) !== d || d.status !== 'setup') no('STATE'); // пока качался файл, всё могло измениться
    let cat = m.cat !== undefined ? m.cat : d.cat;
    if (counts && !counts[cat]) { if (m.cat !== undefined) no('EMPTY_CAT'); cat = 'all'; } // в новом файле такой категории нет
    d.file = file; d.title = title; d.counts = counts; d.cat = cat;
    d.max = counts ? Math.min(MAX_N, counts[cat]) : 0;
    if (m.n !== undefined) d.want = m.n;
    // число на ползунке помнится: в категории поменьше оно урезается, в большой — возвращается
    d.n = d.max ? Math.min(d.want, d.max) : d.want;
    this.putDuel(d); this.push(d);
  },
  async start(ws, uid, m) {
    const d = this.duel(m.id, uid);
    if (d.status !== 'setup') no('STATE');
    if (d.host !== uid) no('NOT_HOST');
    if (!d.file) no('NO_FILE');
    if (d.ids.length < 2) no('ALONE');
    const here = () => d.ids.filter(u => u === d.host || (this.online(u) && !d.p[u].away));
    if (here().length < 2) no('PEER_OFFLINE');
    const pool = await this.pool(d.file);
    if (this.duels.get(d.id) !== d || d.status !== 'setup') no('STATE');
    if (!byCat(pool, d.cat).length) no('EMPTY_CAT');
    const now = here();
    if (now.length < 2) no('PEER_OFFLINE');
    // кто сейчас не на связи, в игру не попадает
    for (const u of d.ids.filter(x => !now.includes(x))) this.remove(d, u, 'gone');
    this.launch(d, pool);
  },
  answer(ws, uid, m) {
    const d = this.duel(m.id, uid);
    if (d.status !== 'play') no('STATE');
    const p = d.p[uid];
    if (p.fin != null || p.left) no('DONE');
    const now = Date.now();
    if (now < d.startAt - 250) no('EARLY');
    // вопросы — в любом порядке (пропущенный можно открыть позже), но каждый — один раз
    const q = Number.isInteger(m.i) && m.i >= 0 && m.i < d.n ? this.getQs(d.id, uid)[m.i] : null;
    if (!q) no('ORDER');
    if (p.ans[m.i]) no('ANSWERED');
    const g = grade(q, m.a);
    while (p.ans.length < m.i) p.ans.push(null);
    p.ans[m.i] = { ok: g.ok, empty: g.empty, a: g.a, at: now };
    if (g.ok) p.ok++;
    if (doneOf(p) >= d.n) p.fin = now;
    this.putDuel(d);
    this.tell(uid, { t: 'graded', id: d.id, i: m.i, ok: g.ok, empty: g.empty });
    if (this.ended(d)) this.finish(d); else this.push(d);
  },
  // выход: хозяин из комнаты — дуэль отменяется для всех, гость — просто уходит;
  // в игре — сдался: выбывает, остальные играют дальше (остался один — он и победил)
  leave(ws, uid, m) {
    const d = this.duel(m.id, uid);
    if (d.status === 'setup') { if (d.host === uid) this.cancel(d, 'left', uid); else this.remove(d, uid, 'left'); return; }
    if (d.status !== 'play') no('STATE');
    const p = d.p[uid];
    if (p.left) return;
    if (p.fin != null) no('DONE');
    p.left = true; p.stop = Date.now();
    if (this.ended(d)) this.finish(d); else { this.putDuel(d); this.push(d); }
  },
  // реванш: предложить или согласиться
  async rematch(ws, uid, m) {
    const d = this.duel(m.id, uid);
    if (d.status !== 'over' || d.next) no('STATE');
    const others = d.ids.filter(u => u !== uid && !d.closed[u]);
    if (!others.length) no('PEER_LEFT');
    if (this.activeOf(uid)) no('BUSY');
    const rm = d.rematch;
    if (!rm) {
      const free = others.filter(u => this.online(u));
      if (!free.length) no('PEER_OFFLINE');
      if (free.every(u => this.activeOf(u))) no('BUSY');
      d.rematch = { by: uid, at: Date.now(), yes: [uid], no: [] }; d.rematchNo = null;
    } else if (!rm.yes.includes(uid)) { rm.yes.push(uid); rm.no = rm.no.filter(x => x !== uid); }
    await this.settleRematch(d);
  },
  'rematch-no': async function (ws, uid, m) {
    const d = this.duel(m.id, uid);
    const rm = d.rematch;
    if (d.status !== 'over' || !rm || rm.by === uid) return;
    rm.yes = rm.yes.filter(x => x !== uid);
    if (!rm.no.includes(uid)) rm.no.push(uid);
    d.rematchNo = uid;
    await this.settleRematch(d);
  },
  // согласившиеся начинают, не дожидаясь остальных
  async 'rematch-go'(ws, uid, m) {
    const d = this.duel(m.id, uid);
    if (d.status !== 'over' || !d.rematch || d.next || !d.rematch.yes.includes(uid)) no('STATE');
    if (this.rematchState(d).yes.length < 2) no('ALONE');
    await this.settleRematch(d, true);
  },
  // экран итогов закрыт: в реванше этого человека уже не будет
  async close(ws, uid, m) {
    const d = this.duels.get(String(m.id || ''));
    if (!d || !this.inDuel(d, uid) || (d.status !== 'over' && d.status !== 'cancelled')) return;
    d.closed[uid] = true;
    const rm = d.rematch;
    if (rm) {
      rm.yes = rm.yes.filter(x => x !== uid); rm.no = rm.no.filter(x => x !== uid);
      if (rm.by === uid) rm.by = rm.yes[0] || null;
      if (!rm.by) d.rematch = null;
    }
    await this.settleRematch(d);
  }
};
