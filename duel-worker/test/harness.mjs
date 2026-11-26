// Стенд для тестов дуэли на своём компьютере: настоящий Worker (wrangler dev), поддельная база Firebase,
// раздача файлов сайта и ключи для «токенов Firebase». Ничего не уходит в настоящий Firebase или Cloudflare.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import { readFile, rm, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parsePool } from '../game.js';

export const DIR = path.dirname(fileURLToPath(import.meta.url));
export const WORKER_DIR = path.resolve(DIR, '..');
export const SITE_DIR = path.resolve(DIR, '../..');
export const PROJECT = 'reclama-kgu';

/* ---------- «токены Firebase», подписанные тестовым ключом ---------- */
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const KID = 'test-key-1';
export const JWKS = JSON.stringify({ keys: [{ ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' }] });
const b64u = b => Buffer.from(b).toString('base64url');
export function token(uid, over = {}, key = privateKey) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: 'RS256', kid: KID, typ: 'JWT' }));
  const p = b64u(JSON.stringify({ iss: 'https://securetoken.google.com/' + PROJECT, aud: PROJECT, auth_time: now - 60, user_id: uid, sub: uid, iat: now - 10, exp: now + 3600, ...over }));
  return h + '.' + p + '.' + b64u(sign('sha256', Buffer.from(h + '.' + p), key));
}
export const otherKey = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey;

/* ---------- поддельная база: users/<uid> отдаётся только своему токену, как по правилам ---------- */
export const USERS = {};
export function addUser(uid, name, extra = {}) { USERS[uid] = { name, key: name.toLowerCase().replace(/ё/g, 'е'), login: 'x' + uid, renamed: false, course: 3, fac: 'lech', ...extra }; return uid; }
function rtdb(req, res) {
  const u = new URL(req.url, 'http://x');
  const m = /^\/users\/([^/]+)\.json$/.exec(u.pathname);
  const auth = u.searchParams.get('auth') || '';
  let sub = '';
  try { sub = JSON.parse(Buffer.from(auth.split('.')[1], 'base64url')).sub; } catch (e) { /* bad */ }
  if (!m || decodeURIComponent(m[1]) !== sub) { res.writeHead(401); res.end('{"error":"Permission denied"}'); return; }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(USERS[sub] || null));
}
/* ---------- файлы сайта (index.html, data/…) ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
async function site(req, res) {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const f = path.join(SITE_DIR, p.endsWith('/') ? p + 'index.html' : p);
  if (!f.startsWith(SITE_DIR)) { res.writeHead(403); res.end(); return; }
  try { const b = await readFile(f); res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' }); res.end(b); }
  catch (e) { res.writeHead(404); res.end('not found'); }
}
const listen = (fn, port) => new Promise((ok, bad) => { const s = createServer(fn); s.on('error', bad); s.listen(port, '127.0.0.1', () => ok(s)); });

export async function startStand({ port = 8788, dbPort = 8790, sitePort = 8791, vars = {} } = {}) {
  const db = await listen(rtdb, dbPort);
  const web = await listen(site, sitePort);
  const ORIGIN = 'http://127.0.0.1:' + sitePort;
  const state = path.join(WORKER_DIR, '.test-state');
  await rm(state, { recursive: true, force: true }); await mkdir(state, { recursive: true });
  const all = { TEST_JWKS: JWKS, FIREBASE_DB: 'http://127.0.0.1:' + dbPort, SITE_URL: ORIGIN + '/', ALLOWED_ORIGIN: ORIGIN, ...vars };
  const args = ['wrangler', 'dev', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', state, '--show-interactive-dev-session=false', '--log-level', 'warn'];
  for (const [k, v] of Object.entries(all)) args.push('--var', k + ':' + v);
  const wr = spawn('npx', args, { cwd: WORKER_DIR, env: { ...process.env, WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  wr.stdout.on('data', d => { log += d; });
  wr.stderr.on('data', d => { log += d; if (process.env.DEBUG_WR) process.stderr.write(d); });
  const BASE = 'http://127.0.0.1:' + port;
  for (let i = 0; ; i++) {
    try { const r = await fetch(BASE + '/duel/health'); if (r.ok) break; } catch (e) { /* not yet */ }
    if (i > 240 || wr.exitCode != null) { wr.kill(); db.close(); web.close(); throw new Error('wrangler dev не запустился:\n' + log.slice(-3000)); }
    await new Promise(r => setTimeout(r, 250));
  }
  return {
    BASE, WS: 'ws://127.0.0.1:' + port, ORIGIN, log: () => log,
    async stop() { wr.kill('SIGTERM'); await new Promise(r => { wr.once('exit', r); setTimeout(r, 3000); }); db.close(); web.close(); }
  };
}

/* ---------- правильный ответ на вопрос, который видит игрок (ключ берём из того же файла) ---------- */
const pools = new Map();
export async function keyFor(file) {
  if (!pools.has(file)) pools.set(file, parsePool(JSON.parse(await readFile(path.join(SITE_DIR, 'data', file), 'utf8'))));
  return pools.get(file);
}
export function solve(pool, v) {
  const same = (a, b) => a.length === b.length && [...a].sort().join('\u0001') === [...b].sort().join('\u0001');
  const q = pool.find(p => p.kind === v.kind && p.prompt === v.prompt && (p.context || null) === (v.context || null) && (
    v.kind === 'dropdown' ? same(p.rows.map(r => r.left), v.rows) : v.kind === 'sortable' ? same(p.order, v.items) : same(p.options.map(o => o.text), v.options)));
  if (!q) throw new Error('вопрос не найден в файле: ' + v.prompt);
  if (v.kind === 'single') return { sel: v.options.findIndex(t => q.options.some(o => o.correct && o.text === t)) };
  if (v.kind === 'multiple') {
    // одинаковые тексты вариантов встречаются: берём столько верных, сколько их в файле
    const want = q.options.filter(o => o.correct).map(o => o.text), multi = [];
    v.options.forEach((t, i) => { const k = want.indexOf(t); if (k >= 0) { multi.push(i); want.splice(k, 1); } });
    return { multi };
  }
  if (v.kind === 'dropdown') return { dd: Object.fromEntries(v.rows.map((l, i) => [i, q.rows.find(r => r.left === l).value])) };
  const used = new Set();
  return { order: q.order.map(t => { const i = v.items.findIndex((x, k) => x === t && !used.has(k)); used.add(i); return i; }) };
}
export function wrong(v) {
  if (v.kind === 'single') return { sel: 0 };
  if (v.kind === 'multiple') return { multi: v.options.map((_, i) => i) };
  if (v.kind === 'dropdown') return { dd: {} };
  return { order: v.items.map((_, i) => i) };
}
