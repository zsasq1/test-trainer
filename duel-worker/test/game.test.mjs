// Правила дуэли: разбор файла, раздача, проверка ответов, победитель. Запуск: npm run test:unit
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parsePool, deal, view, grade, decide, stats, review, shuffle, randInt, isPerm, MAX_N, MAX_PLAYERS, CATS, catOf, byCat, catCounts } from '../game.js';

const raw = JSON.parse(readFileSync(new URL('../../data/3/topka.json', import.meta.url), 'utf8'));
const pool = parsePool(raw);
// правильный ответ на розданный вопрос — так отвечает «честный отличник» в тестах
export const rightAnswer = q => q.kind === 'single' ? { sel: q.key[0] }
  : q.kind === 'multiple' ? { multi: q.key.slice() }
    : q.kind === 'dropdown' ? { dd: Object.fromEntries(q.key.map((v, i) => [i, v])) }
      : { order: q.key.map(t => q.items.indexOf(t)) };

test('файл курса разбирается: только проверяемые виды, у каждого есть ключ', () => {
  assert.ok(pool.length > 100, 'в «Топке» сотни вопросов: ' + pool.length);
  const kinds = new Set(pool.map(q => q.kind));
  for (const k of ['single', 'multiple', 'dropdown', 'sortable']) assert.ok(kinds.has(k), 'есть ' + k);
  for (const q of pool) {
    assert.ok(q.prompt && !/\[вариант \d+\]$/.test(q.prompt));
    if (q.kind === 'single' || q.kind === 'multiple') assert.ok(q.options.length >= 2 && q.options.some(o => o.correct));
  }
  // вопросы кейса приходят по одному, с текстом задачи
  assert.ok(pool.some(q => q.context), 'вопросы кейсов с текстом задачи');
  assert.deepEqual(parsePool(null), []);
  assert.deepEqual(parsePool([1, 2]), []);
  assert.deepEqual(parsePool({ 'Свободный ответ': { type: 'text_input', answers: ['x'] }, 'Без верного': { type: 'single', all_options: [{ text: 'a' }, { text: 'b' }] } }), []);
});

test('раздача: n разных вопросов, у двух игроков — разные наборы, без ключа в «виде»', () => {
  const a = deal(pool, 30), b = deal(pool, 30);
  assert.equal(a.length, 30);
  // ни один вопрос не достаётся чаще, чем он есть в файле (подпись не зависит от порядка вариантов)
  const sig = q => [q.kind, q.prompt, q.context || ''].concat((q.options || q.rows || q.order || q.items || []).map(x => typeof x === 'string' ? x : x.text || x.left).sort()).join('|');
  const have = new Map();
  for (const q of pool) have.set(sig(q), (have.get(sig(q)) || 0) + 1);
  const got = new Map();
  for (const q of a) got.set(sig(q), (got.get(sig(q)) || 0) + 1);
  for (const [k, n] of got) assert.ok(n <= (have.get(k) || 0), 'вопрос не повторяется: ' + k.slice(0, 60));
  assert.notDeepEqual(a.map(q => q.prompt), b.map(q => q.prompt), 'наборы случайные и свои у каждого');
  for (const q of a) {
    const v = view(q);
    assert.ok(!('key' in v), 'в виде нет ключа');
    assert.equal(JSON.stringify(v).includes('"correct"'), false, 'и нет отметок «correct»');
  }
  assert.equal(deal(pool, 0).length, 0);
  assert.equal(deal(pool, 1e6).length, pool.length, 'больше, чем есть, не раздать');
  assert.ok(MAX_N === 100);
});

test('сортировка никогда не приходит уже по порядку', () => {
  const s = pool.filter(q => q.kind === 'sortable');
  for (let k = 0; k < 200; k++) for (const q of deal(s, s.length)) assert.ok(!q.items.every((t, i) => t === q.key[i]));
});

test('проверка: верный ответ засчитан для каждого вида', () => {
  for (const q of deal(pool, pool.length)) {
    const g = grade(q, rightAnswer(q));
    assert.equal(g.ok, true, q.kind + ': ' + q.prompt);
    assert.equal(g.empty, false);
  }
});

test('проверка: неверные, пустые и поддельные ответы не засчитываются', () => {
  const by = k => deal(pool.filter(q => q.kind === k), 5);
  for (const q of by('single')) {
    const wrong = q.options.findIndex((_, i) => !q.key.includes(i));
    assert.equal(grade(q, { sel: wrong }).ok, false);
    assert.deepEqual(grade(q, {}), { ok: false, empty: true, a: null });
    for (const bad of [{ sel: -1 }, { sel: 99 }, { sel: '0' }, { sel: 0.5 }, { sel: [0] }]) assert.equal(grade(q, bad).ok, false);
    assert.equal(grade(q, null).ok, false); assert.equal(grade(q, 'x').ok, false);
  }
  for (const q of by('multiple')) {
    const all = q.options.map((_, i) => i);
    if (all.length !== q.key.length) assert.equal(grade(q, { multi: all }).ok, false, 'всё подряд — неверно');
    assert.equal(grade(q, { multi: q.key.concat(q.key) }).ok, false, 'повторы — неверно');
    assert.equal(grade(q, { multi: [] }).empty, true);
    assert.equal(grade(q, { multi: [999] }).ok, false);
  }
  for (const q of by('dropdown')) {
    assert.equal(grade(q, { dd: {} }).empty, true);
    assert.equal(grade(q, { dd: { 0: 'не из списка' } }).empty, true, 'ответ не из списка не принимается');
    if (q.choices.length > 1) {
      const wrong = Object.fromEntries(q.key.map((v, i) => [i, q.choices.find(c => c !== v)]));
      assert.equal(grade(q, { dd: wrong }).ok, false);
    }
  }
  for (const q of by('sortable')) {
    assert.equal(grade(q, {}).empty, true, 'не трогал — пропуск');
    assert.equal(grade(q, { order: q.items.map((_, i) => i) }).ok, false, 'как выдали — неверно');
    assert.equal(grade(q, { order: [0, 0, 1] }).ok, false);
  }
});

const P = ans => ({ ans, ok: ans.filter(x => x.ok).length, fin: null, stop: null, left: false, dropped: false });
const T0 = 1_000_000;
function duelOf(aAns, bAns, { aFin, bFin, aLeft, bLeft, bDropped } = {}) {
  const d = { a: 'A', b: 'B', n: 3, startAt: T0, p: { A: P(aAns), B: P(bAns) } };
  if (aFin != null) d.p.A.fin = T0 + aFin;
  if (bFin != null) d.p.B.fin = T0 + bFin;
  if (aLeft) d.p.A.left = true;
  if (bLeft) { d.p.B.left = true; d.p.B.dropped = !!bDropped; d.p.B.stop = T0 + 5000; }
  return d;
}
const r = (...oks) => oks.map(ok => ({ ok, empty: false }));

test('победитель: больше верных; поровну — кто быстрее; совсем поровну — ничья', () => {
  assert.equal(decide(duelOf(r(true, true, false), r(true, false, false), { aFin: 90000, bFin: 30000 })).winner, 'A');
  const t = decide(duelOf(r(true, false, true), r(false, true, true), { aFin: 50000, bFin: 40000 }));
  assert.equal(t.winner, 'B'); assert.equal(t.reason, 'time');
  const dr = decide(duelOf(r(true, false, false), r(false, false, true), { aFin: 40000, bFin: 40000 }));
  assert.equal(dr.winner, null); assert.equal(dr.reason, 'draw');
});

test('сдавшийся и пропавший со связи проигрывают; оба ушли — без победителя', () => {
  const s = decide(duelOf(r(false), r(true, true), { aLeft: true }));
  assert.equal(s.winner, 'B'); assert.equal(s.reason, 'left');
  const g = decide(duelOf(r(true, true, true), r(true), { aFin: 9000, bLeft: true, bDropped: true }));
  assert.equal(g.winner, 'A'); assert.equal(g.reason, 'dropped');
  const both = duelOf(r(), r(), { aLeft: true, bLeft: true });
  assert.equal(decide(both).reason, 'abandoned');
});

test('категории: как в тренажёре — вид вопроса, кейсы отдельно; «все» — весь файл', () => {
  const c = catCounts(pool);
  assert.deepEqual(Object.keys(c), CATS);
  assert.equal(c.all, pool.length);
  assert.equal(c.single + c.multiple + c.dropdown + c.sortable + c.caseStudy, c.all);
  for (const k of CATS.slice(1)) {
    assert.ok(c[k] > 0, 'в «Топке» есть ' + k);
    const part = byCat(pool, k);
    assert.equal(part.length, c[k]);
    assert.ok(part.every(q => catOf(q) === k));
  }
  assert.ok(byCat(pool, 'caseStudy').every(q => q.context), 'кейсы — с текстом задачи');
  assert.ok(byCat(pool, 'single').every(q => q.kind === 'single' && !q.context));
  assert.equal(byCat(pool, 'all'), pool);
  for (const q of deal(byCat(pool, 'sortable'), 50)) assert.equal(q.kind, 'sortable');
  assert.equal(MAX_PLAYERS, 8);
});

function group(spec) {
  // spec: { uid: { ok: число верных из 3, fin: мс, left, dropped } }
  const d = { ids: Object.keys(spec), n: 3, startAt: T0, p: {} };
  for (const [u, x] of Object.entries(spec)) {
    const ans = [0, 1, 2].map(i => ({ ok: i < x.ok, empty: false }));
    d.p[u] = { ans, ok: x.ok, fin: x.fin != null ? T0 + x.fin : null, stop: x.left ? T0 + 1000 : null, left: !!x.left, dropped: !!x.dropped };
  }
  return d;
}
test('несколько игроков: места по верным, затем по времени; поровну — одно место на двоих', () => {
  const r = decide(group({ A: { ok: 2, fin: 30000 }, B: { ok: 3, fin: 90000 }, C: { ok: 2, fin: 20000 }, D: { ok: 0, fin: 5000 } }));
  assert.deepEqual(r.rank, ['B', 'C', 'A', 'D']);
  assert.deepEqual(r.place, { B: 1, C: 2, A: 3, D: 4 });
  assert.equal(r.winner, 'B'); assert.equal(r.reason, 'score');
  const t = decide(group({ A: { ok: 2, fin: 30000 }, B: { ok: 2, fin: 30000 }, C: { ok: 1, fin: 10000 } }));
  assert.equal(t.winner, null); assert.equal(t.reason, 'draw');
  assert.deepEqual(t.top.sort(), ['A', 'B']);
  assert.equal(t.place.A, 1); assert.equal(t.place.B, 1); assert.equal(t.place.C, 3);
  const q = decide(group({ A: { ok: 2, fin: 30000 }, B: { ok: 2, fin: 25000 }, C: { ok: 2, fin: 40000 } }));
  assert.equal(q.winner, 'B'); assert.equal(q.reason, 'time');
});
test('несколько игроков: сдавшиеся ниже оставшихся; остался один — он победил', () => {
  const r = decide(group({ A: { ok: 3, left: true }, B: { ok: 1, fin: 50000 }, C: { ok: 2, fin: 60000 } }));
  assert.deepEqual(r.rank, ['C', 'B', 'A'], 'сдавшийся последний, даже с большим числом верных');
  assert.equal(r.winner, 'C'); assert.equal(r.reason, 'score');
  const l = decide(group({ A: { ok: 0, left: true, dropped: true }, B: { ok: 1, fin: 50000 }, C: { ok: 2, left: true } }));
  assert.equal(l.winner, 'B'); assert.equal(l.reason, 'left');
  const g = decide(group({ A: { ok: 0, left: true, dropped: true }, B: { ok: 1 }, C: { ok: 2, left: true, dropped: true } }));
  assert.equal(g.reason, 'dropped');
  assert.equal(decide(group({ A: { ok: 1, left: true }, B: { ok: 1, left: true }, C: { ok: 0, left: true } })).reason, 'abandoned');
});

test('итоги игрока: верно, неверно, пропущено, не отвечено, точность, время', () => {
  const st = stats({ ans: [{ ok: true }, { ok: false, empty: true }, { ok: true }, { ok: false }], fin: T0 + 61000 }, 5, T0);
  assert.deepEqual(st, { ok: 2, wrong: 2, skipped: 1, unanswered: 1, acc: 50, time: 61000, finished: true, left: false, dropped: false });
  assert.equal(stats({ ans: [], fin: null, stop: null }, 3, T0).acc, 0);
});

test('разбор после игры: вопрос, ответ игрока и ключ', () => {
  const qs = deal(pool, 3);
  const p = { ans: [{ ok: true, empty: false, a: rightAnswer(qs[0]) }, { ok: false, empty: true, a: null }] };
  const rv = review(qs, p);
  assert.equal(rv.length, 3);
  assert.equal(rv[0].ok, true); assert.ok(rv[0].key);
  assert.equal(rv[1].empty, true);
  assert.equal(rv[2].none, true, 'до третьего не дошёл');
});

test('случайность без перекоса', () => {
  const n = 7, cnt = Array(n).fill(0);
  for (let i = 0; i < 70000; i++) cnt[randInt(n)]++;
  for (const c of cnt) assert.ok(Math.abs(c - 10000) < 600, 'равномерно: ' + cnt);
  const a = shuffle([...Array(20).keys()]);
  assert.ok(isPerm(a, 20));
});
