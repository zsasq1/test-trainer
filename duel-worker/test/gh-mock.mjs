// A fake GitHub (git data API of zsasq1/test-trainer) for Playwright tests of admin.html — nothing reaches the network.
//
//   import { mockGitHub, serveStatic } from './gh-mock.mjs';
//   const srv = await serveStatic(ROOT, 8831);              // optional: serves the repo folder at http://127.0.0.1:8831/
//   const gh = await mockGitHub(ctx, { root: ROOT });       // ctx = a BrowserContext
//   await ctx.addInitScript(() => localStorage.setItem('TestTrainer.admin', 'fake-token'));
//   … gh.commits → [{ message, files: { 'data/sets.json': '<text>' , 'data/x.json': null (removed) } }]
//   gh.sets()     → the current data/sets.json, parsed;   gh.file(path) → current text of a repo file (or null)
//   gh.failNext(status, { method, path })  → the next matching GitHub call answers with that status
//   gh.requests   → [{ method, path }] every GitHub API call
//
// Repository contents: every file under <root>/data (paths "data/…"), read once when mockGitHub() is called.
// Routing (one ctx.route('**/*')): api.github.com/repos/<repo>/… → this mock; Firebase / googleapis / gstatic →
// `firebaseStatus` (404); the local origins (127.0.0.1, localhost) → continue; anything else → aborted.
// Register your own routes AFTER this one (Playwright tries the newest first) and call route.fallback() to pass on.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';

const gitSha = (kind, buf) => crypto.createHash('sha1').update(kind + ' ' + buf.length + '\0').update(buf).digest('hex');
const fakeSha = s => crypto.createHash('sha1').update(s).digest('hex');

export async function mockGitHub(ctx, {
  root, repo = 'zsasq1/test-trainer', branch = 'main', firebaseStatus = 404,
  allowOrigins = ['http://127.0.0.1', 'http://localhost'], delay = 0, log = false
} = {}) {
  if (!root) throw new Error('mockGitHub: root (the repo folder) is required');
  const blobs = new Map();   // sha → Buffer
  const trees = new Map();   // sha → Map(path → blob sha)
  const commitsBySha = new Map(); // sha → { tree, parents, message }
  const commits = [], requests = [], fails = [];
  const putBlob = buf => { const sha = gitSha('blob', buf); blobs.set(sha, buf); return sha; };
  const putTree = map => { const sha = fakeSha('tree|' + [...map].sort().map(e => e.join(':')).join('|')); trees.set(sha, new Map(map)); return sha; };

  const files = new Map();
  (function walk(dir) {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (fs.statSync(p).isDirectory()) walk(p); else files.set(path.relative(root, p).split(path.sep).join('/'), putBlob(fs.readFileSync(p)));
    }
  })(path.join(root, 'data'));
  let head = fakeSha('commit|initial');
  commitsBySha.set(head, { tree: putTree(files), parents: [], message: 'initial' });

  const curTree = () => trees.get(commitsBySha.get(head).tree);
  const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type, accept, x-github-api-version', 'access-control-allow-methods': 'GET, POST, PATCH, DELETE' };
  const json = (route, status, body) => route.fulfill({ status, contentType: 'application/json; charset=utf-8', headers: CORS, body: JSON.stringify(body) });
  const API = 'https://api.github.com/repos/' + repo;

  async function github(route, req) {
    const url = new URL(req.url()), method = req.method();
    const p = url.pathname.slice(('/repos/' + repo).length);
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: CORS });
    requests.push({ method, path: p + url.search });
    if (log) console.log('[gh]', method, p + url.search);
    const fi = fails.findIndex(f => (!f.method || f.method === method) && (!f.path || (f.path instanceof RegExp ? f.path.test(p) : p.startsWith(f.path))));
    if (fi >= 0) { const f = fails.splice(fi, 1)[0]; return json(route, f.status, { message: 'mock failure ' + f.status }); }
    if (delay) await new Promise(r => setTimeout(r, delay));
    let m;
    const body = () => { try { return JSON.parse(req.postData() || '{}'); } catch (e) { return {}; } };
    if (method === 'GET' && p === '/git/ref/heads/' + branch) return json(route, 200, { ref: 'refs/heads/' + branch, object: { sha: head, type: 'commit' } });
    if (method === 'GET' && (m = p.match(/^\/git\/commits\/([0-9a-f]{40})$/))) {
      const c = commitsBySha.get(m[1]);
      return c ? json(route, 200, { sha: m[1], tree: { sha: c.tree }, parents: c.parents.map(sha => ({ sha })), message: c.message }) : json(route, 404, { message: 'Not Found' });
    }
    if (method === 'GET' && (m = p.match(/^\/git\/trees\/([0-9a-f]{40})$/))) {
      const t = trees.get(m[1]);
      if (!t) return json(route, 404, { message: 'Not Found' });
      return json(route, 200, { sha: m[1], truncated: false, tree: [...t].map(([path, sha]) => ({ path, mode: '100644', type: 'blob', sha, size: blobs.get(sha).length })) });
    }
    if (method === 'GET' && (m = p.match(/^\/git\/blobs\/([0-9a-f]{40})$/))) {
      const b = blobs.get(m[1]);
      return b ? json(route, 200, { sha: m[1], size: b.length, encoding: 'base64', content: b.toString('base64').replace(/(.{60})/g, '$1\n') }) : json(route, 404, { message: 'Not Found' });
    }
    if (method === 'GET' && (m = p.match(/^\/contents\/(.+)$/))) {
      const sha = curTree().get(decodeURIComponent(m[1]));
      return sha ? json(route, 200, { type: 'file', path: m[1], sha, size: blobs.get(sha).length, encoding: 'base64', content: blobs.get(sha).toString('base64') }) : json(route, 404, { message: 'Not Found' });
    }
    if (method === 'POST' && p === '/git/blobs') {
      const b = body();
      return json(route, 201, { sha: putBlob(Buffer.from(b.content || '', b.encoding === 'base64' ? 'base64' : 'utf8')) });
    }
    if (method === 'POST' && p === '/git/trees') {
      const b = body(), base = trees.get(b.base_tree);
      if (!base) return json(route, 422, { message: 'base_tree not found' });
      const t = new Map(base);
      for (const e of b.tree || []) {
        if (e.sha === null) t.delete(e.path);
        else if (typeof e.content === 'string') t.set(e.path, putBlob(Buffer.from(e.content, 'utf8')));
        else if (e.sha && blobs.has(e.sha)) t.set(e.path, e.sha);
        else return json(route, 422, { message: 'bad tree entry ' + e.path });
      }
      return json(route, 201, { sha: putTree(t) });
    }
    if (method === 'POST' && p === '/git/commits') {
      const b = body();
      if (!trees.has(b.tree)) return json(route, 422, { message: 'tree not found' });
      const sha = fakeSha('commit|' + JSON.stringify(b) + '|' + commitsBySha.size);
      commitsBySha.set(sha, { tree: b.tree, parents: b.parents || [], message: b.message });
      return json(route, 201, { sha });
    }
    if (method === 'PATCH' && p === '/git/refs/heads/' + branch) {
      const b = body(), c = commitsBySha.get(b.sha);
      if (!c) return json(route, 422, { message: 'commit not found' });
      if (!b.force && c.parents[0] !== head) return json(route, 422, { message: 'Update is not a fast forward' });
      const before = curTree(), after = trees.get(c.tree), changed = {};
      for (const [fp, sha] of after) if (before.get(fp) !== sha) changed[fp] = blobs.get(sha).toString('utf8');
      for (const fp of before.keys()) if (!after.has(fp)) changed[fp] = null;
      head = b.sha;
      commits.push({ message: c.message, files: changed });
      return json(route, 200, { ref: 'refs/heads/' + branch, object: { sha: head, type: 'commit' } });
    }
    return json(route, 404, { message: 'mock: no handler for ' + method + ' ' + p });
  }

  await ctx.route('**/*', async (route, req) => {
    const u = req.url();
    if (u.startsWith(API + '/')) return github(route, req);
    if (/^https:\/\/api\.github\.com\//.test(u)) return json(route, 404, { message: 'Not Found' });
    if (/firebase|googleapis|gstatic|google\.com|firebaseio/.test(new URL(u).hostname)) return json(route, firebaseStatus, null);
    if (u.startsWith('data:') || u.startsWith('blob:') || allowOrigins.some(o => u.startsWith(o))) return route.continue();
    return route.abort('blockedbyclient');
  });

  return {
    commits, requests,
    get head() { return head; },
    file: fp => { const sha = curTree().get(fp); return sha ? blobs.get(sha).toString('utf8') : null; },
    sets() { const t = this.file('data/sets.json'); return t == null ? null : JSON.parse(t); },
    failNext(status, match = {}) { fails.push({ status, ...match }); },
    // a commit made "elsewhere" (another device): replaces files on the branch, so the next publish must retry
    external(changes, message = 'external') {
      const t = new Map(curTree());
      for (const [fp, text] of Object.entries(changes)) text == null ? t.delete(fp) : t.set(fp, putBlob(Buffer.from(text, 'utf8')));
      const sha = fakeSha('commit|ext|' + commitsBySha.size);
      commitsBySha.set(sha, { tree: putTree(t), parents: [head], message });
      head = sha;
    }
  };
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon' };
// A tiny static server for the repo folder. Resolves { url, close() }.
export function serveStatic(root, port = 8831) {
  const srv = http.createServer((req, res) => {
    let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    if (p.endsWith('/')) p += 'index.html';
    const f = path.join(root, p);
    if (!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': TYPES[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((resolve, reject) => {
    srv.once('error', reject);
    srv.listen(port, '127.0.0.1', () => resolve({ url: 'http://127.0.0.1:' + srv.address().port + '/', close: () => new Promise(r => srv.close(r)) }));
  });
}
