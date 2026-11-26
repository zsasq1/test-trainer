// Сервер дуэлей целиком: настоящий Worker в wrangler dev и несколько «игроков» по WebSocket.
// Запуск: npm run test:server   (DEBUG_WR=1 — показать лог wrangler)
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startStand, token, otherKey, addUser, keyFor, solve } from './harness.mjs';

const FILE = '3/topka.json';
const stand = await startStand({ vars: { INVITE_TTL_MS: '2500', GRACE_MS: '1500', COUNTDOWN_MS: '700', PER_Q_MS: '4000', SETUP_MAX_MS: '600000', KEEP_MS: '600000' } });
const { BASE, WS, ORIGIN } = stand;
const pool = await keyFor(FILE);
const sleep = ms => new Promise(r => setTimeout(r, ms));
let pass = 0, fail = 0;
async function step(name, fn) {
  try { await fn(); pass++; console.log('  ✔ ' + name); }
  catch (e) { fail++; console.log('  ✘ ' + name + '\n    ' + (e && e.stack || e).split('\n').slice(0, 6).join('\n    ')); }
}

const ticket = async (uid, tok = token(uid), origin = ORIGIN) => {
  const r = await fetch(BASE + '/duel/ticket', { method: 'POST', headers: { Authorization: 'Bearer ' + tok, Origin: origin } });
  return { status: r.status, body: await r.json() };
};
class Player {
  constructor(uid) { this.uid = uid; this.inbox = []; this.waiters = []; this.n = 0; }
  async connect() {
    const t = await ticket(this.uid);
    assert.equal(t.status, 200, 'пропуск: ' + JSON.stringify(t.body));
    this.ws = new WebSocket(WS + '/duel/ws?ticket=' + t.body.ticket, { origin: ORIGIN });
    this.ws.on('message', d => this.got(JSON.parse(String(d))));
    await new Promise((ok, bad) => { this.ws.once('open', ok); this.ws.once('error', bad); });
    this.hello = await this.next('hello');
    return this;
  }
  got(m) {
    const w = this.waiters.find(x => x.fn(m));
    if (w) { this.waiters.splice(this.waiters.indexOf(w), 1); clearTimeout(w.t); w.ok(m); } else this.inbox.push(m);
  }
  // следующее сообщение такого вида (из уже пришедших или будущих)
  next(t, pred = () => true, ms = 5000) {
    const fn = m => m.t === t && pred(m);
    const i = this.inbox.findIndex(fn);
    if (i >= 0) return Promise.resolve(this.inbox.splice(i, 1)[0]);
    return new Promise((ok, bad) => { const w = { fn, ok, t: setTimeout(() => { this.waiters.splice(this.waiters.indexOf(w), 1); bad(new Error(this.uid + ': не дождался ' + t)); }, ms) }; this.waiters.push(w); });
  }
  // запрос с ответом: ok / error / search / …
  req(m, ms = 6000) {
    const rid = 'r' + (++this.n);
    this.ws.send(JSON.stringify({ ...m, rid }));
    return new Promise((ok, bad) => {
      const fn = x => x.rid === rid;
      const i = this.inbox.findIndex(fn);
      if (i >= 0) return ok(this.inbox.splice(i, 1)[0]);
      const w = { fn, ok, t: setTimeout(() => bad(new Error(this.uid + ': нет ответа на ' + m.t)), ms) };
      this.waiters.push(w);
    });
  }
  // последнее состояние дуэли (пропуская промежуточные)
  async duel(pred, ms = 5000) { return (await this.next('duel', m => pred(m.duel), ms)).duel; }
  drain() { this.inbox = []; }
  close() { try { this.ws.close(); } catch (e) { /* */ } }
}
const err = async (p, code) => { const r = await p; assert.equal(r.t, 'error', 'ждали отказ ' + code + ', а пришло ' + JSON.stringify(r).slice(0, 200)); assert.equal(r.code, code); return r; };
const okr = async p => { const r = await p; assert.equal(r.t, 'ok', JSON.stringify(r).slice(0, 300)); return r; };

const A = addUser('uid-alice', 'Алиса Тестова');
const B = addUser('uid-bob', 'Боб Пробный');
const C = addUser('uid-carol', 'Карина Третья');
const X = addUser('uid-blocked', 'Злоумышленник', { blocked: true });
const PCT = addUser('uid-percent', '100% Процент');
const D = addUser('uid-dave', 'Денис Офлайн');

// приглашение → согласие → комната настроек
async function room(a, b) {
  a.drain(); b.drain();
  const r = await a.req({ t: 'invite', to: b.uid });
  assert.equal(r.t, 'ok', JSON.stringify(r));
  const inv = (await b.next('invite-in')).inv;
  await okr(b.req({ t: 'reply', id: inv.id, ok: true }));
  const d = await a.duel(x => x.status === 'setup');
  await b.duel(x => x.id === d.id);
  return d;
}
async function play(a, b, { n = 4 } = {}) {
  const d = await room(a, b);
  await okr(a.req({ t: 'setup', id: d.id, file: FILE, n }));
  await okr(a.req({ t: 'start', id: d.id }));
  const qa = await a.next('qs'), qb = await b.next('qs');
  const v = await a.duel(x => x.status === 'play');
  await sleep(Math.max(0, v.startAt - v.now) + 30);
  return { id: d.id, qa: qa.qs, qb: qb.qs, startAt: v.startAt };
}
async function answerAll(p, id, qs, how, gap = 0) {
  for (let i = 0; i < qs.length; i++) {
    const g = await p.req({ t: 'answer', id, i, a: how(qs[i], i) });
    assert.equal(g.t, 'ok', JSON.stringify(g));
    if (gap) await sleep(gap);
  }
}
const right = q => solve(pool, q);
const bad = q => {
  if (q.kind === 'single') { const r = solve(pool, q).sel; return { sel: r === 0 ? 1 : 0 }; }
  if (q.kind === 'multiple') return { multi: [] };
  if (q.kind === 'dropdown') return { dd: {} };
  return { order: q.items.map((_, i) => i) };
};

console.log('Сервер дуэлей (' + BASE + ')');
let a, b, c;
try {
  await step('вход: без токена, с чужой подписью, просроченный, не того проекта, заблокированный — отказ', async () => {
    let r = await fetch(BASE + '/duel/ticket', { method: 'POST', headers: { Origin: ORIGIN } });
    assert.equal(r.status, 401);
    assert.equal((await ticket(A, token(A, {}, otherKey))).status, 401);
    assert.equal((await ticket(A, token(A, { exp: Math.floor(Date.now() / 1000) - 5 }))).status, 401);
    assert.equal((await ticket(A, token(A, { aud: 'other-project', iss: 'https://securetoken.google.com/other-project' }))).status, 401);
    assert.equal((await ticket(A, 'abc.def.ghi')).status, 401);
    // токен настоящий, но чужой uid в базе не читается
    assert.equal((await ticket(A, token('uid-nobody'))).status, 403);
    assert.equal((await ticket(X)).status, 403, 'заблокированный не играет');
    assert.equal((await ticket(A, token(A), 'https://evil.example')).status, 403, 'чужой сайт');
  });
  await step('пропуск одноразовый; WebSocket без пропуска и с чужого сайта не открывается', async () => {
    const t = await ticket(A);
    const open = (url, origin) => new Promise(ok => { const w = new WebSocket(url, { origin }); w.on('open', () => { w.close(); ok('open'); }); w.on('error', () => ok('fail')); w.on('unexpected-response', () => ok('fail')); });
    assert.equal(await open(WS + '/duel/ws?ticket=' + t.body.ticket, ORIGIN), 'open');
    assert.equal(await open(WS + '/duel/ws?ticket=' + t.body.ticket, ORIGIN), 'fail', 'второй раз — нельзя');
    assert.equal(await open(WS + '/duel/ws?ticket=nope', ORIGIN), 'fail');
    const t2 = await ticket(A);
    assert.equal(await open(WS + '/duel/ws?ticket=' + t2.body.ticket, 'https://evil.example'), 'fail');
  });
  await step('подключение: hello с именем из базы', async () => {
    a = await new Player(A).connect(); b = await new Player(B).connect();
    // эти двое заходили и ушли: в справочнике есть, в сети нет
    for (const u of [PCT, D]) { const p = await new Player(u).connect(); p.close(); }
    await sleep(300);
    assert.equal(a.hello.me.name, 'Алиса Тестова');
    assert.equal(b.hello.me.name, 'Боб Пробный');
    assert.equal(a.hello.duel, null);
  });
  await step('поиск: по началу любого слова, без учёта регистра и ё; себя не видно; «%» не ломает поиск', async () => {
    let r = await a.req({ t: 'search', q: 'боб' });
    assert.deepEqual(r.list.map(x => x.name), ['Боб Пробный']);
    assert.equal(r.list[0].on, true);
    r = await a.req({ t: 'search', q: 'ПРОБ' });
    assert.deepEqual(r.list.map(x => x.name), ['Боб Пробный']);
    r = await a.req({ t: 'search', q: 'алиса' });
    assert.deepEqual(r.list, [], 'себя не видно');
    r = await a.req({ t: 'search', q: '%' });
    assert.deepEqual(r.list, [], '«%» — это просто символ');
    r = await a.req({ t: 'search', q: '' });
    assert.deepEqual(r.list.map(x => x.uid), [B], 'пустой запрос — кто сейчас в сети');
    c = await new Player(C).connect();
    r = await c.req({ t: 'search', q: 'т' });
    assert.ok(r.list.some(x => x.uid === A), 'Алиса Тестова по слову «Тестова»');
  });
  await step('приглашение: отклонено — оба узнают', async () => {
    a.drain(); b.drain();
    await okr(a.req({ t: 'invite', to: B }));
    const inv = (await b.next('invite-in')).inv;
    assert.equal(inv.from.name, 'Алиса Тестова');
    assert.ok(inv.exp > inv.now);
    await okr(b.req({ t: 'reply', id: inv.id, ok: false }));
    assert.equal((await a.next('invite-gone')).why, 'declined');
  });
  await step('приглашение: отменено пригласившим', async () => {
    await okr(a.req({ t: 'invite', to: B }));
    const inv = (await b.next('invite-in')).inv;
    await okr(a.req({ t: 'cancel', id: inv.id }));
    assert.equal((await b.next('invite-gone', m => m.id === inv.id)).why, 'cancelled');
    await err(b.req({ t: 'reply', id: inv.id, ok: true }), 'GONE');
  });
  await step('приглашение: истекает само', async () => {
    await okr(a.req({ t: 'invite', to: B }));
    const inv = (await b.next('invite-in')).inv;
    assert.equal((await b.next('invite-gone', m => m.id === inv.id, 6000)).why, 'expired');
  });
  await step('приглашение: себе, несуществующему, не в сети — отказ', async () => {
    await err(a.req({ t: 'invite', to: A }), 'SELF');
    await err(a.req({ t: 'invite', to: 'uid-ghost' }), 'NO_USER');
    await err(a.req({ t: 'invite', to: D }), 'OFFLINE');
  });
  await step('встречные приглашения — сразу комната', async () => {
    a.drain(); b.drain();
    await okr(a.req({ t: 'invite', to: B }));
    await b.next('invite-in');
    await okr(b.req({ t: 'invite', to: A }));
    const d = await a.duel(x => x.status === 'setup');
    assert.equal(d.a, A, 'хозяин — кто позвал первым');
    await okr(a.req({ t: 'leave', id: d.id }));
    const c2 = await b.duel(x => x.status === 'cancelled');
    assert.equal(c2.why, 'left'); assert.equal(c2.by, A);
  });

  let g;
  await step('комната: настраивает только хозяин; чужой файл, 0 и 101 вопрос — отказ; соперник видит ползунок сразу', async () => {
    const d = await room(a, b);
    await err(b.req({ t: 'setup', id: d.id, file: FILE, n: 5 }), 'NOT_HOST');
    await err(a.req({ t: 'setup', id: d.id, file: '../../worker.js' }), 'NO_FILE');
    await err(a.req({ t: 'setup', id: d.id, file: 'https://evil.example/x.json' }), 'NO_FILE');
    await err(a.req({ t: 'start', id: d.id }), 'NO_FILE');
    await okr(a.req({ t: 'setup', id: d.id, file: FILE, n: 10 }));
    let v = await b.duel(x => x.file === FILE);
    assert.equal(v.title, 'Топка'); assert.equal(v.max, 100); assert.equal(v.n, 10);
    await err(a.req({ t: 'setup', id: d.id, n: 0 }), 'BAD_N');
    await err(a.req({ t: 'setup', id: d.id, n: 101 }), 'BAD_N');
    await err(a.req({ t: 'setup', id: d.id, n: 2.5 }), 'BAD_N');
    await okr(a.req({ t: 'setup', id: d.id, n: 37 }));
    v = await b.duel(x => x.n === 37);
    assert.equal(v.n, 37, 'ползунок у соперника двигается вживую');
    await err(b.req({ t: 'start', id: d.id }), 'NOT_HOST');
    // третий не может вмешаться
    await err(c.req({ t: 'setup', id: d.id, n: 1 }), 'NO_DUEL');
    await err(c.req({ t: 'invite', to: A }), 'BUSY');
    await okr(a.req({ t: 'setup', id: d.id, n: 4 }));
    await b.duel(x => x.n === 4);
    a.drain(); b.drain();
    await okr(a.req({ t: 'start', id: d.id }));
    const qa = await a.next('qs'), qb = await b.next('qs');
    const pv = await b.duel(x => x.status === 'play');
    assert.equal(qa.qs.length, 4); assert.equal(qb.qs.length, 4);
    assert.ok(!JSON.stringify(qa).includes('"key"') && !JSON.stringify(qa).includes('"correct"'), 'ключей у игрока нет');
    assert.ok(pv.startAt > pv.now, 'обратный отсчёт по часам сервера');
    g = { id: d.id, qa: qa.qs, qb: qb.qs, startAt: pv.startAt, now: pv.now };
  });
  await step('игра: раньше старта не принимается; ответы строго по порядку и по одному разу', async () => {
    await err(a.req({ t: 'answer', id: g.id, i: 0, a: right(g.qa[0]) }), 'EARLY');
    await sleep(Math.max(0, g.startAt - g.now) + 40);
    await err(a.req({ t: 'answer', id: g.id, i: 2, a: right(g.qa[2]) }), 'ORDER');
    await okr(a.req({ t: 'answer', id: g.id, i: 0, a: right(g.qa[0]) }));
    const r = await a.req({ t: 'answer', id: g.id, i: 0, a: right(g.qa[0]) });
    assert.equal(r.code, 'ORDER'); assert.equal(r.at, 1, 'сервер подсказывает, с какого вопроса продолжать');
    await err(c.req({ t: 'answer', id: g.id, i: 0, a: {} }), 'NO_DUEL');
    await okr(a.req({ t: 'answer', id: g.id, i: 1, a: right(g.qa[1]), ok: false, uid: B, time: 1 })); // лишние поля ничего не меняют
  });
  await step('прогресс соперника приходит вживую; кто больше верных — победил; разбор с ключами', async () => {
    const v = await b.duel(x => x.players[A].done >= 1, 3000).catch(() => null);
    assert.ok(v, 'Боб видит, что Алиса ответила');
    // Алиса доотвечает верно (вопрос 1 уже принят выше), Боб — неверно
    const st = await a.req({ t: 'sync' });
    const at = st.qs.ans.length;
    for (let i = at; i < 4; i++) await okr(a.req({ t: 'answer', id: g.id, i, a: right(g.qa[i]) }));
    const mid = await b.duel(x => x.players[A].done === 4 && x.players[A].fin != null);
    assert.equal(mid.status, 'play', 'игра идёт, пока не закончит второй');
    assert.equal(mid.players[A].ok, 4);
    await answerAll(b, g.id, g.qb, bad);
    const over = await a.duel(x => x.status === 'over');
    assert.equal(over.result.winner, A); assert.equal(over.result.reason, 'score');
    assert.equal(over.result.stats[A].ok, 4); assert.equal(over.result.stats[A].acc, 100);
    assert.equal(over.result.stats[B].ok, 0); assert.equal(over.result.stats[B].wrong, 4);
    assert.ok(over.result.stats[A].time > 0);
    const rv = await b.next('review');
    assert.equal(rv.items.length, 4); assert.ok(rv.items.every(x => x.key && !x.ok));
    const s = await c.req({ t: 'search', q: 'алиса' });
    assert.equal(s.list[0].wins, 1);
    const s2 = await c.req({ t: 'search', q: 'боб' });
    assert.equal(s2.list[0].losses, 1);
  });
  await step('реванш: один предлагает, второй соглашается — новая игра с теми же настройками и новыми вопросами', async () => {
    a.drain(); b.drain();
    await okr(b.req({ t: 'rematch', id: g.id }));
    const offer = await a.duel(x => x.rematch === B);
    assert.equal(offer.status, 'over');
    await okr(a.req({ t: 'rematch', id: g.id }));
    const old = await a.duel(x => x.id === g.id && x.next);
    const nv = await a.duel(x => x.id === old.next && x.status === 'play');
    assert.equal(nv.a, B, 'хозяин реванша — кто предложил');
    assert.equal(nv.n, 4); assert.equal(nv.file, FILE);
    const qa = await a.next('qs', m => m.id === nv.id);
    assert.notDeepEqual(qa.qs.map(q => q.prompt), g.qa.map(q => q.prompt), 'вопросы новые');
    g = { id: nv.id, qa: qa.qs, qb: (await b.next('qs', m => m.id === nv.id)).qs, startAt: nv.startAt, now: nv.now };
  });
  await step('ничья по очкам — побеждает тот, кто закончил быстрее', async () => {
    await sleep(Math.max(0, g.startAt - g.now) + 40);
    await answerAll(b, g.id, g.qb, right);
    await answerAll(a, g.id, g.qa, right, 120);
    const over = await a.duel(x => x.id === g.id && x.status === 'over');
    assert.equal(over.result.stats[A].ok, over.result.stats[B].ok);
    assert.equal(over.result.winner, B); assert.equal(over.result.reason, 'time');
    assert.ok(over.result.stats[B].time < over.result.stats[A].time);
  });
  await step('реванш: отказ и закрытый экран итогов', async () => {
    a.drain(); b.drain();
    await okr(a.req({ t: 'rematch', id: g.id }));
    await b.duel(x => x.rematch === A);
    await okr(b.req({ t: 'rematch-no', id: g.id }));
    const v = await a.duel(x => x.rematchNo === B);
    assert.equal(v.rematch, null);
    await okr(b.req({ t: 'close', id: g.id }));
    await a.duel(x => x.closed.includes(B));
    await err(a.req({ t: 'rematch', id: g.id }), 'PEER_LEFT');
  });
  await step('выход из игры — поражение, соперник побеждает сразу', async () => {
    const p = await play(a, b, { n: 3 });
    await okr(a.req({ t: 'answer', id: p.id, i: 0, a: right(p.qa[0]) }));
    await okr(a.req({ t: 'leave', id: p.id }));
    const over = await b.duel(x => x.id === p.id && x.status === 'over');
    assert.equal(over.result.winner, B); assert.equal(over.result.reason, 'left');
    assert.equal(over.players[A].left, true);
    await okr(a.req({ t: 'close', id: p.id })); await okr(b.req({ t: 'close', id: p.id }));
  });
  await step('обрыв связи: соперник видит «нет связи», игрок возвращается и продолжает с того же вопроса', async () => {
    const p = await play(a, b, { n: 3 });
    await okr(b.req({ t: 'answer', id: p.id, i: 0, a: right(p.qb[0]) }));
    a.drain();
    b.close();
    const off = await a.duel(x => x.id === p.id && x.players[B].on === false && x.players[B].back);
    assert.ok(off.players[B].back > off.now, 'сколько ждать — видно');
    b = await new Player(B).connect();
    assert.equal(b.hello.duel.id, p.id); assert.equal(b.hello.duel.status, 'play');
    assert.equal(b.hello.qs.ans.length, 1, 'ответ до обрыва сохранён');
    assert.equal(b.hello.qs.qs.length, 3);
    await a.duel(x => x.id === p.id && x.players[B].on === true && !x.players[B].back);
    for (const i of [1, 2]) await okr(b.req({ t: 'answer', id: p.id, i, a: right(p.qb[i]) }));
    await answerAll(a, p.id, p.qa, bad);
    const over = await b.duel(x => x.id === p.id && x.status === 'over');
    assert.equal(over.result.winner, B);
    await okr(a.req({ t: 'close', id: p.id })); await okr(b.req({ t: 'close', id: p.id }));
  });
  await step('обрыв связи надолго — пропавший проигрывает', async () => {
    const p = await play(a, b, { n: 3 });
    a.drain();
    b.close();
    const over = await a.duel(x => x.id === p.id && x.status === 'over', 6000);
    assert.equal(over.result.winner, A); assert.equal(over.result.reason, 'dropped');
    b = await new Player(B).connect();
    assert.equal(b.hello.duel && b.hello.duel.id, p.id, 'вернувшийся видит итог');
    await okr(a.req({ t: 'close', id: p.id })); await okr(b.req({ t: 'close', id: p.id }));
  });
  await step('обрыв связи в комнате настроек — дуэль отменяется', async () => {
    const d = await room(a, b);
    a.drain();
    b.close();
    const v = await a.duel(x => x.id === d.id && x.status === 'cancelled', 6000);
    assert.equal(v.why, 'gone'); assert.equal(v.by, B);
    b = await new Player(B).connect();
    assert.equal(b.hello.duel, null);
  });
  await step('время вышло — неотвеченные не засчитываются, игра заканчивается сама', async () => {
    const p = await play(a, b, { n: 1 });
    await okr(a.req({ t: 'answer', id: p.id, i: 0, a: right(p.qa[0]) }));
    const over = await b.duel(x => x.id === p.id && x.status === 'over', 8000);
    assert.equal(over.result.winner, A);
    assert.equal(over.result.stats[B].unanswered, 1);
    await okr(a.req({ t: 'close', id: p.id })); await okr(b.req({ t: 'close', id: p.id }));
  });
  await step('поток сообщений ограничен', async () => {
    let rate = 0;
    const rs = [];
    for (let i = 0; i < 80; i++) rs.push(c.req({ t: 'time' }).then(r => { if (r.code === 'RATE') rate++; }));
    await Promise.all(rs);
    assert.ok(rate > 0, 'часть отклонена: ' + rate);
    await sleep(1200);
  });
} finally {
  for (const p of [a, b, c]) if (p) p.close();
  await stand.stop();
}
console.log(`\n${pass} прошло, ${fail} не прошло`);
if (fail) { if (process.env.DEBUG_WR) console.log(stand.log().slice(-4000)); process.exit(1); }
