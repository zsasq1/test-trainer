// Дуэли для тренажёра (Cloudflare Worker + Durable Object «Arena»).
//
// Сервер — судья. Клиент только показывает вопросы и присылает выбор игрока; всё остальное решает здесь:
//   • кто подключился — по токену Firebase (подпись Google + чтение users/<uid> этим же токеном);
//   • какие вопросы достанутся — случайно из файла курса, у каждого игрока свои;
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
import { MAX_N, parsePool, deal, view, grade, decide, review } from './game.js';

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
   Арена: справочник игроков, приглашения, дуэли
   ========================================================= */
class Refuse extends Error { constructor(code, extra) { super(code); this.code = code; this.extra = extra || {}; } }
const no = (code, extra) => { throw new Refuse(code, extra); };
const OPEN = 1;
const MAX_SOCKS = 6; // вкладок у одного человека

export class Arena extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.cfg = config(env);
    this.sql = ctx.storage.sql;
    this.tickets = new Map(); // пропуск → { uid, exp }
    this.buckets = new Map(); // uid → { tokens, at } — не больше ~15 сообщений в секунду
    this.inviteLog = new Map(); // uid → [время приглашений] — не больше 10 в минуту
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
    for (const r of x.exec('SELECT data FROM duels')) { const d = JSON.parse(r.data); this.duels.set(d.id, d); }
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
    const out = [...this.invites.values()].find(v => v.from === uid && v.exp > now);
    const d = this.currentOf(uid);
    const m = { t: 'hello', rid: r, now, me: this.card(uid), invIn, invOut: out ? this.invView(out) : null, duel: d ? this.view(d) : null };
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
    const h = H[m.t];
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
  invView(v) { return { id: v.id, from: this.card(v.from), to: this.card(v.to), exp: v.exp, now: Date.now() }; }
  dropInvite(v, why) {
    this.delInvite(v);
    const m = { t: 'invite-gone', id: v.id, why };
    this.tell(v.from, m); this.tell(v.to, m);
  }
  dropInvitesOf(uids, why) { for (const v of [...this.invites.values()]) if (uids.includes(v.from) || uids.includes(v.to)) this.dropInvite(v, why); }

  /* ---------- дуэли ---------- */
  inDuel(d, uid) { return d.a === uid || d.b === uid; }
  other(d, uid) { return d.a === uid ? d.b : d.a; }
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
  newDuel(a, b, extra = {}) {
    const now = Date.now(), who = {};
    for (const u of [a, b]) { const c = this.card(u); who[u] = { name: c.name, fac: c.fac, course: c.course }; }
    const pl = u => ({ ans: [], ok: 0, fin: null, stop: null, left: false, dropped: false, away: this.online(u) ? null : now });
    return { id: rid(16), status: 'setup', a, b, who, created: now, file: null, title: '', n: 10, max: 0, startAt: null, deadline: null, endAt: null, p: { [a]: pl(a), [b]: pl(b) }, result: null, rematch: null, rematchNo: null, closed: {}, next: null, why: null, by: null, ...extra };
  }
  view(d) {
    const P = uid => {
      const p = d.p[uid], w = d.who[uid];
      return { uid, name: w.name, fac: w.fac, course: w.course, on: this.online(uid), back: p.away ? p.away + this.cfg.grace : null, done: p.ans.length, ok: p.ok, fin: p.fin != null && d.startAt ? p.fin - d.startAt : null, left: p.left };
    };
    return {
      id: d.id, status: d.status, a: d.a, b: d.b, players: { [d.a]: P(d.a), [d.b]: P(d.b) },
      file: d.file, title: d.title, n: d.n, max: d.max, startAt: d.startAt, deadline: d.deadline, endAt: d.endAt,
      result: d.result, rematch: d.rematch ? d.rematch.by : null, rematchNo: d.rematchNo, closed: Object.keys(d.closed),
      next: d.next, why: d.why, by: d.by, now: Date.now()
    };
  }
  push(d) { const m = { t: 'duel', duel: this.view(d) }; this.tell(d.a, m); this.tell(d.b, m); }
  myQs(d, uid) { const p = d.p[uid]; return { id: d.id, qs: this.getQs(d.id, uid).map(view), ans: p.ans.map(x => ({ ok: x.ok, empty: x.empty })) }; }
  allDone(d) { return [d.a, d.b].every(u => d.p[u].fin != null || d.p[u].left); }
  cancel(d, why, by) {
    d.status = 'cancelled'; d.why = why; d.by = by || null; d.endAt = Date.now();
    this.putDuel(d); this.push(d);
  }
  // старт: каждому — своя случайная раздача из одного файла; 3-2-1 идёт по часам сервера
  launch(d, pool) {
    const now = Date.now(), n = Math.max(1, Math.min(d.n | 0, pool.length, MAX_N));
    d.n = n; d.max = Math.min(MAX_N, pool.length); d.status = 'play'; d.startAt = now + this.cfg.countdown; d.deadline = d.startAt + n * this.cfg.perQ;
    const m = {};
    for (const u of [d.a, d.b]) {
      m[u] = deal(pool, n);
      this.sql.exec('INSERT OR REPLACE INTO duel_qs(duel, uid, data) VALUES (?, ?, ?)', d.id, u, JSON.stringify(m[u]));
    }
    this.qcache.set(d.id, m);
    this.putDuel(d); this.push(d);
    for (const u of [d.a, d.b]) this.tell(u, { t: 'qs', ...this.myQs(d, u) });
  }
  finish(d) {
    if (d.status !== 'play') return;
    const now = Date.now();
    d.status = 'over'; d.endAt = now;
    for (const u of [d.a, d.b]) { const p = d.p[u]; if (p.fin == null && p.stop == null) p.stop = Math.min(now, d.deadline || now); p.away = null; }
    d.result = decide(d);
    if (d.result.reason !== 'abandoned') {
      for (const u of [d.a, d.b]) {
        const col = d.result.winner == null ? 'draws' : d.result.winner === u ? 'wins' : 'losses';
        this.sql.exec(`UPDATE users SET ${col} = ${col} + 1 WHERE uid = ?`, u);
      }
    }
    this.putDuel(d); this.push(d);
    for (const u of [d.a, d.b]) this.tell(u, { t: 'review', id: d.id, items: review(this.getQs(d.id, u), d.p[u]) });
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
        for (const u of [d.a, d.b]) if (d.p[u].away) t = Math.min(t, d.p[u].away + c.grace);
      } else if (d.status === 'play') {
        t = Math.min(t, d.deadline);
        for (const u of [d.a, d.b]) { const p = d.p[u]; if (p.away && p.fin == null && !p.left) t = Math.min(t, p.away + c.grace); }
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
        const gone = [d.a, d.b].find(u => d.p[u].away && now - d.p[u].away >= c.grace);
        if (gone) this.cancel(d, 'gone', gone);
        else if (now - d.created >= c.setupMax) this.cancel(d, 'timeout');
      } else if (d.status === 'play') {
        let changed = false;
        for (const u of [d.a, d.b]) {
          const p = d.p[u];
          if (p.away && p.fin == null && !p.left && now - p.away >= c.grace) { p.left = true; p.dropped = true; p.stop = p.away; changed = true; }
        }
        // пропавший надолго проигрывает сразу, как и сдавшийся: второму незачем доигрывать
        if (changed || now >= d.deadline || this.allDone(d)) this.finish(d);
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

  invite(ws, uid, m) {
    const to = typeof m.to === 'string' ? m.to : '';
    if (!to || to === uid) no('SELF');
    if (!this.user(to)) no('NO_USER');
    if (!this.online(to)) no('OFFLINE');
    if (this.activeOf(uid)) no('BUSY_ME');
    if (this.activeOf(to)) no('BUSY');
    // встречное приглашение: человек уже позвал меня — это и есть согласие
    const cross = [...this.invites.values()].find(v => v.from === to && v.to === uid && v.exp > Date.now());
    if (cross) return H.reply.call(this, ws, uid, { id: cross.id, ok: true });
    const now = Date.now(), log = (this.inviteLog.get(uid) || []).filter(x => now - x < 60000);
    if (log.length >= 10) no('RATE');
    log.push(now); this.inviteLog.set(uid, log);
    for (const v of [...this.invites.values()]) if (v.from === uid) this.dropInvite(v, 'replaced'); // одно приглашение за раз
    const v = { id: rid(12), from: uid, to, at: now, exp: now + this.cfg.inviteTtl };
    this.putInvite(v);
    const iv = this.invView(v);
    this.tell(to, { t: 'invite-in', inv: iv });
    this.tell(uid, { t: 'invite-out', inv: iv });
  },
  cancel(ws, uid, m) {
    const v = this.invites.get(String(m.id || ''));
    if (v && v.from === uid) this.dropInvite(v, 'cancelled');
  },
  reply(ws, uid, m) {
    const v = this.invites.get(String(m.id || ''));
    if (!v || v.to !== uid || v.exp <= Date.now()) no('GONE');
    if (m.ok !== true) { this.dropInvite(v, 'declined'); return; }
    if (!this.online(v.from)) { this.dropInvite(v, 'offline'); no('OFFLINE'); }
    if (this.activeOf(uid) || this.activeOf(v.from)) { this.dropInvite(v, 'busy'); no('BUSY'); }
    this.dropInvite(v, 'accepted');
    this.dropInvitesOf([v.from, uid], 'busy'); // остальные приглашения этих двоих больше не в силе
    const d = this.newDuel(v.from, uid);
    this.putDuel(d); this.push(d);
  },

  // настройки — только у того, кто позвал: файл курса и число вопросов (1–100, не больше, чем есть в файле)
  async setup(ws, uid, m) {
    const d = this.duel(m.id, uid);
    if (d.status !== 'setup') no('STATE');
    if (d.a !== uid) no('NOT_HOST');
    let file = d.file, title = d.title, max = d.max;
    if (typeof m.file === 'string' && m.file !== d.file) {
      const e = (await this.setsList()).find(x => x.file === m.file);
      if (!e) no('NO_FILE');
      const pool = await this.pool(e.file);
      if (!pool.length) no('EMPTY');
      file = e.file; title = e.title; max = Math.min(MAX_N, pool.length);
    }
    if (this.duels.get(d.id) !== d || d.status !== 'setup') no('STATE'); // пока качался файл, всё могло измениться
    d.file = file; d.title = title; d.max = max;
    if (m.n !== undefined) { const n = Number(m.n); if (!Number.isInteger(n) || n < 1 || n > MAX_N) no('BAD_N'); d.n = n; }
    if (d.max) d.n = Math.min(d.n, d.max);
    this.putDuel(d); this.push(d);
  },
  async start(ws, uid, m) {
    const d = this.duel(m.id, uid);
    if (d.status !== 'setup') no('STATE');
    if (d.a !== uid) no('NOT_HOST');
    if (!d.file) no('NO_FILE');
    if (!this.online(d.b) || d.p[d.b].away) no('PEER_OFFLINE');
    const pool = await this.pool(d.file);
    if (this.duels.get(d.id) !== d || d.status !== 'setup') no('STATE');
    if (!pool.length) no('EMPTY');
    this.launch(d, pool);
  },
  answer(ws, uid, m) {
    const d = this.duel(m.id, uid);
    if (d.status !== 'play') no('STATE');
    const p = d.p[uid];
    if (p.fin != null || p.left) no('DONE');
    const now = Date.now();
    if (now < d.startAt - 250) no('EARLY');
    if (m.i !== p.ans.length) no('ORDER', { at: p.ans.length });
    const q = this.getQs(d.id, uid)[m.i];
    if (!q) no('ORDER', { at: p.ans.length });
    const g = grade(q, m.a);
    p.ans.push({ ok: g.ok, empty: g.empty, a: g.a, at: now });
    if (g.ok) p.ok++;
    if (p.ans.length >= d.n) p.fin = now;
    this.putDuel(d);
    this.tell(uid, { t: 'graded', id: d.id, i: m.i, ok: g.ok, empty: g.empty });
    if (this.allDone(d)) this.finish(d); else this.push(d);
  },
  // выход: в комнате — дуэль отменяется; в игре — поражение (второй побеждает)
  leave(ws, uid, m) {
    const d = this.duel(m.id, uid);
    if (d.status === 'setup') { this.cancel(d, 'left', uid); return; }
    if (d.status !== 'play') no('STATE');
    const p = d.p[uid];
    if (p.left) return;
    if (p.fin != null) no('DONE');
    p.left = true; p.stop = Date.now();
    this.finish(d);
  },
  // реванш: тот же файл и столько же вопросов, новые случайные вопросы; начинается сразу, когда согласны оба
  async rematch(ws, uid, m) {
    const d = this.duel(m.id, uid);
    if (d.status !== 'over' || d.next) no('STATE');
    const o = this.other(d, uid);
    if (d.closed[o]) no('PEER_LEFT');
    if (this.activeOf(uid) || this.activeOf(o)) no('BUSY');
    if (!this.online(o)) no('PEER_OFFLINE');
    if (d.rematch && d.rematch.by === o) {
      const pool = await this.pool(d.file);
      if (d.status !== 'over' || d.next || !d.rematch || this.activeOf(uid) || this.activeOf(o)) no('STATE');
      const nd = this.newDuel(o, uid, { file: d.file, title: d.title, n: d.n });
      d.next = nd.id; d.rematch = null;
      this.putDuel(d); this.push(d);
      this.dropInvitesOf([uid, o], 'busy');
      this.launch(nd, pool);
      return;
    }
    d.rematch = { by: uid, at: Date.now() }; d.rematchNo = null;
    this.putDuel(d); this.push(d);
  },
  'rematch-no'(ws, uid, m) {
    const d = this.duel(m.id, uid);
    if (d.status === 'over' && d.rematch && d.rematch.by !== uid) { d.rematch = null; d.rematchNo = uid; this.putDuel(d); this.push(d); }
  },
  // экран итогов закрыт: реванша с этим человеком уже не будет
  close(ws, uid, m) {
    const d = this.duels.get(String(m.id || ''));
    if (!d || !this.inDuel(d, uid) || (d.status !== 'over' && d.status !== 'cancelled')) return;
    d.closed[uid] = true;
    if (d.rematch) d.rematch = null;
    this.putDuel(d); this.push(d);
  }
};
