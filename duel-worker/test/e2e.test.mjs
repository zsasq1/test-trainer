// Дуэль в браузере от начала до конца: два человека в двух окнах WebKit (телефон и компьютер),
// настоящий сервер дуэлей (wrangler dev), сайт с этого компьютера, Firebase подменён.
// Поиск → приглашение → согласие → файл и ползунок → 3-2-1 → ответы → итоги → реванш →
// перезагрузка посреди игры → сдача → «Готово». Ничего не уходит в настоящий Firebase или Cloudflare.
//
// Запуск: npm run test:e2e   (нужен playwright-core и WebKit для него; путь к браузеру — PW_WEBKIT)
// Сначала соберите сайт: python3 собрать.py (тест открывает index.html).
//
// npm run test:live — тот же сценарий на настоящей инфраструктуре: сайт — опубликованный на GitHub Pages,
// сервер — временная копия worker.js на Cloudflare (trainer-duel-e2e, удаляется после прогона).
// Вход Google/Firebase подменён тестовыми ключами (настоящих аккаунтов у теста нет): в Firebase ничего не уходит,
// любые запросы мимо сайта и сервера дуэлей браузер не делает (перехватываются).
import { createRequire } from 'node:module';
import WebSocket from 'ws';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { startStand, deployStaging, addUser, token, keyFor, solve, USERS, DIR } from './harness.mjs';

const require = createRequire(import.meta.url);
let pw;
try { pw = require('playwright-core'); }
catch (e) {
  for (const p of (process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean)) { try { pw = require(path.join(p, 'playwright-core')); break; } catch (er) { /* next */ } }
}
if (!pw) { console.error('Нужен playwright-core: npm i -D playwright-core (или NODE_PATH к нему)'); process.exit(1); }
const WEBKIT = process.env.PW_WEBKIT || [path.join(os.homedir(), 'Library/Caches/ms-playwright/webkit-2391/pw_run.sh')].find(existsSync);
const SHOTS = process.env.SHOTS || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });

const FILE = '3/topka.json';
// the second person's language and theme (en by default: the checks read English text; ar/dark — for a look at RTL)
const BL = process.env.B_LANG || 'en', BS = process.env.B_SCHEME || 'light';
const en = c => BL !== 'en' || c;
let passed = 0, failed = 0;
const errors = [];
function ok(cond, msg) { if (cond) { passed++; console.log('  ✓ ' + msg); } else { failed++; console.log('  ✗ ' + msg); } return cond; }
const sleep = ms => new Promise(r => setTimeout(r, ms));

const LIVE = process.env.E2E_TARGET === 'live';
// на живом сервере у каждого прогона свои игроки (статистика побед начинается с нуля)
const RUN = LIVE ? '-' + Date.now().toString(36) : '-uid';
const A = addUser('alice' + RUN, 'Алиса Смирнова');
const B = addUser('boris' + RUN, 'Борис Иванов');

// адрес сервера дуэлей, зашитый в сайт: на живом прогоне браузер стучится туда, а тест передаёт это временной копии
const PROD = 'https://trainer-duel.zsasqzsasq.workers.dev';
const stand = LIVE ? await deployStaging()
  : await startStand({ port: 8796, dbPort: 8797, sitePort: 8798, vars: { INVITE_TTL_MS: '30000', COUNTDOWN_MS: '2000', GRACE_MS: '20000', PER_Q_MS: '60000' } });
const SITE = LIVE ? 'https://zsasq1.github.io/test-trainer/' : stand.ORIGIN + '/index.html';
const SITE_ORIGIN = new URL(SITE).origin;
console.log(LIVE ? `Живой прогон: сайт ${SITE}, сервер ${stand.BASE} (копия ${PROD.replace('https://', '')})` : `Локальный прогон: сайт ${SITE}, сервер ${stand.BASE}`);
const pool = await keyFor(FILE);
const browser = await pw.webkit.launch(WEBKIT ? { executablePath: WEBKIT } : {});

// one person: their own browser profile, signed in, the duel server pointed at the local one
async function person(uid, { lang, phone, scheme = 'light' }) {
  const u = USERS[uid] || { name: 'Гость без аккаунта', login: '', key: '' };
  const ctx = await browser.newContext({ ...(phone
    ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, colorScheme: scheme }
    : { viewport: { width: 1280, height: 820 }, colorScheme: scheme }), ...(LIVE ? { serviceWorkers: 'block' } : {}) });
  // всё, что не сайт и не сервер дуэлей, — мимо (Google, Firebase, шрифты): правила ниже отвечают за нужное
  const mine = [SITE_ORIGIN + '/', ...(LIVE ? [] : [stand.BASE + '/'])];
  const outside = [];
  await ctx.route(url => !mine.some(m => url.href.startsWith(m)), r => { outside.push(r.request().url()); return r.fulfill({ status: 404, body: '{}' }); });
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS' };
  // Firebase: the token is signed by the test key the local server trusts; the base answers from USERS
  await ctx.route(/securetoken\.googleapis\.com/, r => r.request().method() === 'OPTIONS' ? r.fulfill({ status: 204, headers: cors })
    : r.fulfill({ status: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ id_token: token(uid), expires_in: '3600', refresh_token: 'rt-' + uid }) }));
  await ctx.route(/firebasedatabase\.app|firebaseio\.com/, r => {
    const q = r.request();
    if (q.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    const own = new URL(q.url()).pathname === '/users/' + uid + '.json';
    return r.fulfill({ status: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: q.method() === 'GET' && own ? JSON.stringify(u) : 'null' });
  });
  const frames = [];
  if (LIVE) await viaStaging(ctx, frames);

  const ls = {
    'TestTrainer.lang': lang,
    ...(LIVE ? {} : { 'TestTrainer.duelDev': stand.BASE }),
    'TestTrainer.user': uid ? JSON.stringify({ uid, rt: 'rt-' + uid, login: u.login, name: u.name, key: u.key, course: 3, fac: 'lech', renamed: false, blocked: false }) : 'null',
    'TestTrainer.web.v1': JSON.stringify({ lang, fac: 'lech', setId: 'bundle.3/topka', course: 3, tour: { intro: 1, main: 1, menu: 1, test: 1 }, checks: 0, starred: {}, autoAdvance: false })
  };
  await ctx.addInitScript(ls => {
    window.__trMiss = new Set();
    for (const k in ls) localStorage.setItem(k, ls[k]);
    // when each duel screen appeared (to see that both phones start together)
    window.__ph = [];
    const note = () => { const d = document.getElementById('duel'), ph = d ? d.dataset.ph || '' : ''; const l = window.__ph[window.__ph.length - 1]; if (!l || l.ph !== ph) window.__ph.push({ ph, at: Date.now() }); };
    new MutationObserver(note).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['data-ph'] });
  }, ls);
  const page = await ctx.newPage();
  const who = u.name.split(' ')[0];
  page.on('pageerror', e => errors.push(who + ': ' + e.message));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource|WebSocket connection/.test(m.text())) errors.push(who + ' console: ' + m.text()); });
  // everything the server sends this person: to check that no key ever reaches the browser
  if (process.env.DEBUG_NET) page.on('response', r => { if (/duel|securetoken/.test(r.url())) r.text().then(x => console.log('    [net]', who, r.status(), r.url().slice(0, 80), x.slice(0, 120))).catch(() => {}); });
  if (LIVE) page.on('request', r => { if (r.isNavigationRequest() && r.frame() === page.mainFrame()) for (const s of ctx.__up || []) s.terminate(); });
  else page.on('websocket', ws => ws.on('framereceived', f => { try { frames.push(JSON.parse(f.payload)); } catch (e) { /* ping */ } }));
  // ждём сам документ, а не все картинки и шрифты: сеть до GitHub Pages иногда подолгу держит мелкие файлы
  await page.goto(SITE, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('#content .q', { timeout: 30000 });
  return { ctx, page, frames, uid, name: u.name, phone, outside };
}

// Живой прогон: сайт обращается к боевому адресу сервера дуэлей; тест передаёт запросы временной копии
// тем же путём, как их отправил бы браузер (заголовок Origin сайта, токен, тело), и возвращает ответы как есть.
async function viaStaging(ctx, frames) {
  const host = new URL(PROD).host;
  ctx.__up = new Set();
  await ctx.route(url => url.host === host && url.pathname === '/duel/ticket', async r => {
    const q = r.request(), h = q.headers();
    const fwd = { Origin: SITE_ORIGIN };
    for (const k of ['authorization', 'content-type', 'access-control-request-method', 'access-control-request-headers']) if (h[k]) fwd[k] = h[k];
    try {
      const res = await fetch(stand.BASE + '/duel/ticket', { method: q.method(), headers: fwd, body: q.method() === 'POST' ? q.postData() || '' : undefined });
      const headers = {};
      res.headers.forEach((v, k) => { if (/^(access-control-|content-type$|cache-control$|vary$)/.test(k)) headers[k] = v; });
      return r.fulfill({ status: res.status, headers, body: res.status === 204 ? '' : await res.text() });
    } catch (e) { return r.abort('connectionfailed'); }
  });
  const code = c => (c === 1000 || (c >= 3000 && c <= 4999) ? c : 1000);
  await ctx.routeWebSocket(url => url.host === host && url.pathname === '/duel/ws', ws => {
    const up = new WebSocket(stand.WS + '/duel/ws' + new URL(ws.url()).search, { origin: SITE_ORIGIN });
    ctx.__up.add(up);
    const queue = [];
    up.on('open', () => { for (const m of queue.splice(0)) up.send(m); });
    up.on('message', (data, bin) => {
      const s = bin ? data : data.toString();
      if (!bin) try { frames.push(JSON.parse(s)); } catch (e) { /* — */ }
      try { ws.send(s); } catch (e) { /* page gone */ }
    });
    up.on('unexpected-response', (req, res) => { ctx.__up.delete(up); try { ws.close({ code: 1000, reason: 'http ' + res.statusCode }); } catch (e) { /* — */ } });
    up.on('close', (c, why) => { ctx.__up.delete(up); try { ws.close({ code: code(c), reason: String(why || '') }); } catch (e) { /* — */ } });
    up.on('error', () => { /* close follows */ });
    ws.onMessage(m => (up.readyState === WebSocket.OPEN ? up.send(m) : up.readyState === WebSocket.CONNECTING && queue.push(m)));
    ws.onClose((c, why) => { ctx.__up.delete(up); if (up.readyState === WebSocket.OPEN) up.close(code(c), why); else up.terminate(); });
  });
}
const ph = (p, want, ms = 10000) => p.page.waitForFunction(w => { const d = document.getElementById('duel'); return !!d && d.dataset.ph === w; }, want, { timeout: ms });
const text = (p, sel) => p.page.$eval(sel, el => el.textContent.trim()).catch(() => '');
// a picture once the motion has settled
const shot = async (p, name) => { if (!SHOTS) return; await sleep(700); await p.page.screenshot({ path: path.join(SHOTS, name + '.png') }); };
const lastQs = p => [...p.frames].reverse().find(m => m.t === 'qs');

// answer the question on screen the way the UI is used: taps, the list picker, dragging
async function answerRight(p, v) {
  const a = solve(pool, v), pg = p.page;
  if (v.kind === 'single') await pg.click(`#dBody .choice[data-i="${a.sel}"]`);
  else if (v.kind === 'multiple') { for (const i of a.multi) await pg.click(`#dBody .choice[data-i="${i}"]`); }
  else if (v.kind === 'dropdown') {
    for (const [row, val] of Object.entries(a.dd)) {
      await pg.click(`#dBody .dd-btn[data-row="${row}"]`);
      await pg.waitForSelector('.sheet .pick[data-ci]');
      const ci = v.choices.indexOf(val);
      await pg.click(`.sheet .pick[data-ci="${ci}"]`);
      await pg.waitForSelector('.sheet-wrap', { state: 'detached' });
    }
  } else if (v.kind === 'sortable') {
    // move rows one by one until the list reads as the key
    for (let pos = 0; pos < a.order.length; pos++) {
      const cur = await pg.$$eval('#dBody .sort-row', rs => rs.map(r => +r.dataset.oi));
      const from = cur.indexOf(a.order[pos]);
      if (from === pos) continue;
      const rows = await pg.$$('#dBody .sort-row');
      const h = await rows[from].$('[data-handle]');
      const hb = await h.boundingBox(), rf = await rows[from].boundingBox(), rt = await rows[pos].boundingBox();
      const x = hb.x + hb.width / 2, y = hb.y + hb.height / 2, dy = rt.y - rf.y - 2;
      await pg.mouse.move(x, y); await pg.mouse.down();
      for (let k = 1; k <= 8; k++) { await pg.mouse.move(x, y + (dy * k) / 8); await sleep(16); }
      await pg.mouse.up();
      await sleep(120);
    }
    const now = await pg.$$eval('#dBody .sort-row', rs => rs.map(r => +r.dataset.oi));
    if (JSON.stringify(now) !== JSON.stringify(a.order)) console.log('    (порядок не сложился перетаскиванием:', now, a.order, ')');
  }
}
async function press(p) {
  await p.page.waitForFunction(() => { const b = document.getElementById('dGo'); return b && !b.disabled; }, null, { timeout: 5000 });
  await p.page.click('#dGo');
}
// wait until the verdict shows for question i and the next one (or the end) comes
async function graded(p, i) {
  await p.page.waitForFunction(() => !!document.querySelector('#dBody .verdict') || document.getElementById('duel').dataset.ph !== 'play', null, { timeout: 5000 });
  const v = await text(p, '#dBody .verdict');
  await p.page.waitForFunction(i => { const d = document.getElementById('duel'); return d.dataset.ph !== 'play' || !(document.getElementById('dSub').textContent || '').includes(' ' + (i + 1) + ' '); }, i, { timeout: 5000 }).catch(() => {});
  return v;
}

let A1, B1;
try {
  A1 = await person(A, { lang: 'ru', phone: false });
  B1 = await person(B, { lang: BL, phone: true, scheme: BS });

  if (LIVE) {
    const html = await (await fetch(SITE, { cache: 'no-store' })).text();
    ok(html.includes(PROD) && html.includes('Дуэль с другом'), 'опубликованный сайт — с дуэлями и с адресом боевого сервера');
  }
  await B1.page.waitForFunction(() => document.getElementById('menuBtn') != null);
  for (let i = 0; i < 100 && !B1.frames.some(m => m.t === 'hello'); i++) await sleep(100);
  ok(B1.frames.some(m => m.t === 'hello'), 'Борис при запуске сайта подключился к серверу дуэлей (он в сети)');

  console.log('\n1. Меню → Дуэль → поиск соперника по имени');
  ok(await A1.page.$('[data-act="m-duel"]') != null, 'в меню (боковой панели) есть «Дуэль»');
  await A1.page.click('[data-act="m-duel"]');
  await ph(A1, 'lobby');
  await A1.page.waitForSelector('#dNet.on', { timeout: 10000 });
  ok(true, 'экран дуэли открыт, связь с сервером есть');
  await A1.page.fill('#dQ', 'бор');
  await A1.page.waitForFunction(() => [...document.querySelectorAll('#dBody .d-pl')].some(r => r.textContent.includes('Борис Иванов')), null, { timeout: 8000 });
  const row = await A1.page.$('#dBody .d-pl:has-text("Борис Иванов")');
  ok(!!row && !(await (await row.$('[data-d="invite"]')).isDisabled()), 'Борис найден по началу фамилии, в сети, его можно позвать');
  await shot(A1, '01-lobby-A');

  console.log('\n2. Приглашение → уведомление у соперника → согласие');
  await (await row.$('[data-d="invite"]')).click();
  await A1.page.waitForSelector('#dBody .d-card.out', { timeout: 5000 });
  ok((await text(A1, '#dBody .d-card.out')).includes('Ждём ответа'), 'у Алисы: «Ждём ответа» с отсчётом и «Отменить»');
  await B1.page.waitForSelector('#duelBan.on', { timeout: 5000 });
  ok(en((await text(B1, '#duelBan')).includes('Алиса Смирнова invites you to a duel')), 'у Бориса сверху уведомление (по-английски): «Алиса Смирнова invites you to a duel»');
  await shot(B1, '02-banner-B');
  await B1.page.click('#duelBan [data-b="yes"]');
  await Promise.all([ph(A1, 'room'), ph(B1, 'room')]);
  ok(true, 'у обоих открылась комната дуэли');

  console.log('\n3. Комната: файл и ползунок у пригласившего, второй видит всё сразу');
  await A1.page.waitForFunction(() => { const r = document.getElementById('dN'); return r && !r.disabled; }, null, { timeout: 8000 });
  ok((await text(A1, '#dBody .pick.on')).includes('Топка'), 'файл, открытый в тренажёре («Топка»), выбран сам');
  ok(await B1.page.$eval('#dN', r => r.disabled), 'у Бориса ползунок только для просмотра');
  await A1.page.$eval('#dN', r => { r.value = '7'; r.dispatchEvent(new Event('input', { bubbles: true })); });
  await B1.page.waitForFunction(() => document.getElementById('dNv').textContent === '7', null, { timeout: 4000 });
  ok(true, 'Алиса двигает ползунок — у Бориса число меняется на ходу (7)');
  await A1.page.$eval('#dN', r => { r.value = '3'; r.dispatchEvent(new Event('input', { bubbles: true })); r.dispatchEvent(new Event('change', { bubbles: true })); });
  await B1.page.waitForFunction(() => document.getElementById('dNv').textContent === '3', null, { timeout: 4000 });
  ok((await text(B1, '#dBody .d-kv b')).includes('Топка'), 'Борис видит файл и 3 вопроса');
  ok(await B1.page.$eval('#dStart', b => b.hidden), 'кнопки «Начать» у Бориса нет');
  await shot(A1, '03-room-A'); await shot(B1, '03-room-B');
  if (process.env.DEBUG_BOX) console.log('    boxes', await A1.page.evaluate(() => ['#dScroller', '#dFoot', '.d-col', '.d-n', '#dN', '#dStrip', '.d-top'].map(s => { const r = document.querySelector(s).getBoundingClientRect(); return s + ' ' + Math.round(r.top) + '-' + Math.round(r.bottom); }).join(' | ')));

  console.log('\n4. Старт: 3-2-1 у обоих одновременно, у каждого свои вопросы');
  await A1.page.click('#dStart');
  await Promise.all([ph(A1, 'count'), ph(B1, 'count')]);
  ok(true, 'обратный отсчёт у обоих');
  await shot(B1, '04-count-B');
  await Promise.all([ph(A1, 'play', 8000), ph(B1, 'play', 8000)]);
  const tA = (await A1.page.evaluate(() => window.__ph)).find(x => x.ph === 'play').at;
  const tB = (await B1.page.evaluate(() => window.__ph)).find(x => x.ph === 'play').at;
  ok(Math.abs(tA - tB) < 300, `вопросы появились одновременно (разница ${Math.abs(tA - tB)} мс)`);
  const qa = lastQs(A1), qb = lastQs(B1);
  ok(qa && qb && qa.id === qb.id && qa.qs.length === 3 && qb.qs.length === 3, 'каждому пришло по 3 вопроса одной дуэли');
  const all = JSON.stringify(A1.frames) + JSON.stringify(B1.frames);
  ok(!/"key"|"correct"/.test(all), 'ни в одном сообщении до итогов нет ключей и пометок «верно»');

  console.log('\n5. Игра: ответы, прогресс обоих в реальном времени');
  await shot(A1, '05-play-A'); await shot(B1, '05-play-B');
  await answerRight(A1, qa.qs[0]);
  await press(A1);
  ok(/Верный ответ/.test(await graded(A1, 0)), 'Алиса ответила верно — «Верный ответ», затем следующий вопрос');
  await B1.page.waitForFunction(() => /✓ 1 · 1\/3/.test(document.querySelector('.d-race .d-lane:not(.me) .d-sc').textContent), null, { timeout: 4000 });
  ok(true, 'у Бориса полоска Алисы сдвинулась: ✓ 1 · 1/3');
  // Борис: первый — пропускает, второй — наугад
  ok(en((await text(B1, '#dGo')).includes('Skip')), 'у Бориса без выбора кнопка — «Skip»');
  await press(B1);
  ok(en(/Question skipped/.test(await graded(B1, 0))), 'пропуск засчитан как «Question skipped»');
  const v1 = qb.qs[1];
  if (v1.kind === 'single' || v1.kind === 'multiple') {
    const right = solve(pool, v1), pickI = v1.kind === 'single' ? (right.sel === 0 ? 1 : 0) : null;
    if (pickI != null) await B1.page.click(`#dBody .choice[data-i="${pickI}"]`);
    else {
      // заведомо неверно: верный набор с одним переключённым вариантом (бывают вопросы, где верны все варианты)
      const want = new Set(right.multi), flip = want.size === 1 && want.has(0) ? 1 : 0;
      for (let i = 0; i < v1.options.length; i++) if (want.has(i) !== (i === flip)) await B1.page.click(`#dBody .choice[data-i="${i}"]`);
    }
    ok(en((await text(B1, '#dGo')).includes('Answer')), 'после выбора кнопка — «Answer»');
  }
  await press(B1);
  await graded(B1, 1);
  await answerRight(A1, qa.qs[1]); await press(A1); await graded(A1, 1);

  console.log('\n6. Перезагрузка посреди игры: связь пропала и вернулась — игра продолжается');
  await B1.page.route(/\/duel\/ticket/, r => r.fulfill({ status: 503, body: '{"error":"DB"}' }));
  await B1.page.reload();
  await A1.page.waitForFunction(() => /нет связи/.test(document.querySelector('.d-race').textContent), null, { timeout: 6000 });
  ok(true, 'у Алисы видно: «нет связи — ждём ещё …» с отсчётом');
  await shot(A1, '06-peer-away-A');
  await B1.page.unroute(/\/duel\/ticket/);
  await ph(B1, 'play', 15000);
  ok(en((await text(B1, '#dSub')).includes('Question 3 of 3')), 'Борис вернулся на свой третий вопрос (Question 3 of 3)');
  await A1.page.waitForFunction(() => !/нет связи/.test(document.querySelector('.d-race').textContent), null, { timeout: 6000 });
  ok(true, 'у Алисы отметка «нет связи» пропала');
  await press(B1);
  await ph(B1, 'wait', 5000);
  ok(en((await text(B1, '#dBody')).includes('You answered every question')), 'Борис закончил первым и ждёт');
  await shot(B1, '06-wait-B');
  await answerRight(A1, qa.qs[2]); await press(A1);

  console.log('\n7. Итоги: победитель, точность, время, верные и неверные');
  await Promise.all([ph(A1, 'over', 6000), ph(B1, 'over', 6000)]);
  ok((await text(A1, '.d-hero h2')) === 'Победа!', 'у Алисы «Победа!»');
  ok(en((await text(B1, '.d-hero h2')) === 'Defeat'), 'у Бориса «Defeat»');
  ok((await text(A1, '.d-hero p')).includes('больше верных'), 'причина: больше верных ответов');
  const tab = await A1.page.$$eval('.d-tab tbody tr', rs => rs.map(r => [...r.children].map(c => c.textContent.trim())));
  console.log('    ', JSON.stringify(tab));
  ok(tab[0][0] === 'Верно' && tab[0][1] === '3', 'Верно: у Алисы 3');
  ok(tab.some(r => r[0] === 'Точность' && r[1] === '100%'), 'точность Алисы 100%');
  ok(tab.some(r => r[0] === 'Время' && /^\d+:\d\d$/.test(r[1]) && /^\d+:\d\d$/.test(r[2])), 'время обоих');
  // Борис: первый и третий пропущены, второй — неверный (если это выбор варианта) или тоже пропущен
  const choice1 = qb.qs[1].kind === 'single' || qb.qs[1].kind === 'multiple';
  ok(tab.some(r => r[0] === 'Пропущено' && r[2] === String(choice1 ? 2 : 3)) && tab.some(r => r[0] === 'Неверно' && r[2] === String(choice1 ? 1 : 0)), `у Бориса пропущено ${choice1 ? 2 : 3}, неверно ${choice1 ? 1 : 0} — как он отвечал`);
  await A1.page.waitForSelector('.d-rv', { timeout: 5000 });
  ok((await A1.page.$$('.d-rv.ok')).length === 3, 'разбор: три вопроса, все верные');
  await B1.page.waitForSelector('.d-rv', { timeout: 5000 });
  await B1.page.click('.d-rv summary');
  ok(await B1.page.$('.d-rv[open] .b') != null, 'Борис раскрыл разбор: свой ответ и правильный');
  ok(/"t":"review"/.test(JSON.stringify(A1.frames)) && !A1.frames.some(m => m.t === 'review' && m.items.some(x => x.kind && x.key == null)), 'ключи приходят только в разборе после игры');
  await shot(A1, '07-over-A'); await shot(B1, '07-over-B');

  console.log('\n8. Реванш: предложил один, принял другой — новая дуэль сразу');
  await B1.page.click('#dFoot [data-d="rematch"]');
  await A1.page.waitForFunction(() => /предлагает реванш/.test(document.getElementById('dBody').textContent), null, { timeout: 4000 });
  ok(true, 'у Алисы: «Борис Иванов предлагает реванш»');
  ok(en(await B1.page.waitForFunction(() => /Waiting/.test(document.querySelector('#dFoot [data-d="rematch"]').textContent), null, { timeout: 4000 }).then(() => true, () => false)), 'у Бориса: «Waiting…»');
  await A1.page.click('#dFoot [data-d="rematch"]');
  await Promise.all([ph(A1, 'count'), ph(B1, 'count')]);
  await Promise.all([ph(A1, 'play', 8000), ph(B1, 'play', 8000)]);
  const qa2 = lastQs(A1);
  ok(qa2.id !== qa.id && qa2.qs.length === 3, 'реванш: новая дуэль, снова 3 вопроса, новые случайные');

  console.log('\n9. Сдача: соперник побеждает сразу');
  await answerRight(A1, qa2.qs[0]); await press(A1); await graded(A1, 0);
  await B1.page.click('#dFoot [data-d="surrender"]');
  await B1.page.waitForSelector('.sheet .dlg-btn.danger');
  await B1.page.click('.sheet .dlg-btn.danger');
  await Promise.all([ph(A1, 'over', 6000), ph(B1, 'over', 6000)]);
  ok((await text(A1, '.d-hero h2')) === 'Победа!' && (await text(A1, '.d-hero p')).includes('сдался'), 'у Алисы победа: «Борис Иванов сдался(лась)»');
  ok(en((await text(B1, '.d-hero p')) === 'You gave up'), 'у Бориса: «You gave up»');

  console.log('\n10. «Готово» закрывает дуэль; статистика побед');
  await A1.page.click('#dFoot [data-d="done"]');
  await A1.page.waitForSelector('#duel', { state: 'detached', timeout: 3000 });
  ok(true, 'у Алисы экран дуэли закрылся, тренажёр на месте');
  ok(await A1.page.$('#content .q') != null, 'вопрос тренажёра виден как прежде');
  ok(await B1.page.$eval('#dFoot [data-d="rematch"]', b => b.disabled), 'у Бориса «Rematch» больше недоступен (Алиса закрыла итоги)');
  await B1.page.click('#dFoot [data-d="done"]');
  await B1.page.waitForSelector('#duel', { state: 'detached', timeout: 3000 });
  await A1.page.click('[data-act="m-duel"]');
  await ph(A1, 'lobby');
  await A1.page.waitForFunction(() => /побед 2, поражений 0/.test(document.getElementById('dBody').textContent), null, { timeout: 5000 });
  ok(true, 'у Алисы в лобби: побед 2, поражений 0');

  console.log('\n11. Отмена приглашения и отказ');
  await A1.page.fill('#dQ', 'Иван');
  await A1.page.waitForSelector('#dBody .d-pl [data-d="invite"]:not([disabled])', { timeout: 6000 });
  await A1.page.click('#dBody .d-pl [data-d="invite"]');
  await B1.page.waitForSelector('#duelBan.on', { timeout: 5000 });
  await A1.page.click('#dBody [data-d="cancel"]');
  await B1.page.waitForSelector('#duelBan:not(.on)', { timeout: 5000 });
  ok(true, 'Алиса отменила — уведомление у Бориса исчезло');
  await A1.page.click('#dBody .d-pl [data-d="invite"]');
  await B1.page.waitForSelector('#duelBan.on', { timeout: 5000 });
  await B1.page.click('#duelBan [data-b="no"]');
  await A1.page.waitForSelector('#dBody .d-card.out', { state: 'detached', timeout: 5000 });
  ok(true, 'Борис отклонил — у Алисы ожидание пропало');

  console.log('\n12. Гость без аккаунта: дуэль просит войти');
  const G = await person('', { lang: 'ru', phone: true });
  await G.page.click('#menuBtn');
  await G.page.waitForSelector('[data-act="m-duel"]');
  ok((await text(G, '[data-act="m-duel"]')).includes('Войдите, чтобы играть с друзьями'), 'в меню у гостя: «Войдите, чтобы играть с друзьями»');
  await G.page.click('[data-act="m-duel"]');
  await G.page.waitForSelector('.sheet', { timeout: 4000 });
  ok(await G.page.$('#duel') == null, 'вместо дуэли — окно входа; без аккаунта к серверу дуэлей не подключаемся');
  ok(!G.frames.length, 'гость не открывал соединение с сервером дуэлей');
  await G.ctx.close();

  console.log('\n13. Без ошибок и без непереведённых строк');
  const miss = await B1.page.evaluate(() => [...window.__trMiss]);
  ok(miss.length === 0, (BL === 'en' ? 'английский' : BL) + ': все строки переведены' + (miss.length ? ': ' + JSON.stringify(miss) : ''));
  ok(errors.length === 0, 'ошибок JavaScript нет' + (errors.length ? ': ' + JSON.stringify(errors) : ''));
  const outHosts = [...new Set([A1, B1].flatMap(p => p.outside).map(u => new URL(u).host))];
  console.log('    перехвачено и не отправлено:', outHosts.join(', ') || '—');

  if (LIVE) {
    console.log('\n14. Боевой сервер тестовым ключам не верит');
    const r = await fetch(PROD + '/duel/ticket', { method: 'POST', headers: { Authorization: 'Bearer ' + token(A), Origin: SITE_ORIGIN } });
    const body = await r.json().catch(() => ({}));
    ok(r.status === 401 && body.error === 'BAD_TOKEN', `${PROD.replace('https://', '')}: тот же «токен» — ${r.status} ${body.error}`);
  }
} catch (e) {
  failed++;
  console.log('  ✗ ' + (e && e.stack || e));
  for (const p of [A1, B1]) if (p) { await shot(p, 'fail-' + p.uid); console.log('   ', p.name, await p.page.evaluate(() => { const d = document.getElementById('duel'); return d ? d.dataset.ph + ' | ' + d.innerText.slice(0, 400).replace(/\s+/g, ' ') : 'no duel'; }).catch(() => '?')); }
  if (errors.length) console.log('    ошибки:', errors);
} finally {
  await browser.close().catch(() => {});
  await stand.stop();
}
console.log(`\n${passed} прошло, ${failed} не прошло`);
process.exit(failed ? 1 : 0);
