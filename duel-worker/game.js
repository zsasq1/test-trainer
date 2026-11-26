// Правила дуэли без ввода-вывода: разбор файла вопросов, раздача, проверка ответа, итог.
// Используется сервером (worker.js) и тестами (test/game.test.mjs).
//
// Ответы на вопросы знает только сервер: игроку уходит «вид» вопроса без ключа (view),
// ответ игрока проверяет grade(), а победителя называет decide(). Клиент ничего не решает сам.

export const MAX_N = 100;
// Вопросы, которые сервер проверяет однозначно. Свободный текст и кейсы целиком в дуэль не берутся,
// а вопросы кейса приходят по одному — с текстом задачи над вопросом (context).
export const KINDS = ['single', 'multiple', 'dropdown', 'sortable'];

const uniq = arr => [...new Set(arr)];
// «… [вариант 2]» — так конвертер различает одинаковые вопросы; игроку это не показывается
const shownPrompt = k => String(k).replace(/\s*\[вариант \d+\]\s*$/, '').trim();
export const isPerm = (arr, n) => Array.isArray(arr) && arr.length === n && new Set(arr).size === n && arr.every(i => Number.isInteger(i) && i >= 0 && i < n);

// Файл тренажёра ({"Текст вопроса": {"type": "single", "all_options": [...]}}) → вопросы, годные для дуэли.
export function parsePool(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
  const out = [];
  for (const [key, r] of Object.entries(raw)) {
    if (!r || typeof r !== 'object' || Array.isArray(r)) continue;
    const prompt = shownPrompt(key);
    if (!prompt) continue;
    const context = typeof r.main_text === 'string' && r.main_text.trim() ? r.main_text : null;
    const opts = Array.isArray(r.all_options) ? r.all_options.filter(o => o && typeof o === 'object') : [];
    if (r.type === 'single' || r.type === 'multiple') {
      const options = opts.filter(o => typeof o.text === 'string' && o.text !== '').map(o => ({ text: o.text, correct: o.correct === true }));
      // без верного варианта или с одним вариантом вопрос нечестный — пропускаем
      if (options.length < 2 || !options.some(o => o.correct)) continue;
      out.push({ kind: r.type, prompt, context, options });
    } else if (r.type === 'dropdown') {
      const rows = opts.filter(o => typeof o.left === 'string' && o.left && typeof o.correct_value === 'string' && o.correct_value)
        .map(o => ({ left: o.left, value: o.correct_value }));
      if (!rows.length) continue;
      out.push({ kind: 'dropdown', prompt, context, rows, choices: uniq(rows.map(x => x.value)) });
    } else if (r.type === 'sortable') {
      const order = opts.filter(o => Number.isFinite(o.position) && typeof o.text === 'string' && o.text)
        .sort((a, b) => a.position - b.position).map(o => o.text);
      if (order.length < 2 || new Set(order).size < 2) continue;
      out.push({ kind: 'sortable', prompt, context, order });
    }
  }
  return out;
}

/* ---------- случайность: crypto, без перекоса по модулю ---------- */
export const cryptoRnd = () => crypto.getRandomValues(new Uint32Array(1))[0];
export function randInt(n, rnd = cryptoRnd) {
  const lim = Math.floor(0x100000000 / n) * n;
  let x;
  do { x = rnd() >>> 0; } while (x >= lim);
  return x % n;
}
export function shuffle(a, rnd = cryptoRnd) {
  for (let i = a.length - 1; i > 0; i--) { const j = randInt(i + 1, rnd); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// Вопрос, как он достанется игроку: варианты и пункты в своём случайном порядке, ключ — рядом.
function prepare(q, rnd) {
  const base = { kind: q.kind, prompt: q.prompt, context: q.context };
  switch (q.kind) {
    case 'single':
    case 'multiple': {
      const options = shuffle(q.options.slice(), rnd);
      return { ...base, options: options.map(o => o.text), key: options.map((o, i) => (o.correct ? i : -1)).filter(i => i >= 0) };
    }
    case 'dropdown':
      return { ...base, rows: q.rows.map(r => r.left), choices: shuffle(q.choices.slice(), rnd), key: q.rows.map(r => r.value) };
    case 'sortable': {
      // пункты перемешаны и никогда не стоят сразу по порядку
      let items = q.order.slice();
      for (let k = 0; k < 8 && items.every((t, i) => t === q.order[i]); k++) items = shuffle(q.order.slice(), rnd);
      if (items.every((t, i) => t === q.order[i])) items = q.order.slice(1).concat(q.order[0]);
      return { ...base, items, key: q.order.slice() };
    }
  }
  return null;
}

// n разных вопросов одному игроку. У каждого игрока — своя раздача.
export function deal(pool, n, rnd = cryptoRnd) {
  const k = Math.max(0, Math.min(n | 0, pool.length));
  const idx = shuffle(pool.map((_, i) => i), rnd).slice(0, k);
  return idx.map(i => prepare(pool[i], rnd));
}

// Что видит игрок: вопрос без ключа.
export function view(q) {
  const v = { kind: q.kind, prompt: q.prompt, context: q.context };
  if (q.kind === 'single' || q.kind === 'multiple') v.options = q.options;
  else if (q.kind === 'dropdown') { v.rows = q.rows; v.choices = q.choices; }
  else if (q.kind === 'sortable') v.items = q.items;
  return v;
}

// Ответ игрока (что угодно с клиента) → { ok, empty, a }. Всё, что не подходит по форме, — неверно;
// пустой ответ — «вопрос пропущен». a — ответ в чистом виде, для разбора после игры.
export function grade(q, raw) {
  const a = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  switch (q.kind) {
    case 'single': {
      const s = a.sel;
      if (s == null) return { ok: false, empty: true, a: null };
      if (!Number.isInteger(s) || s < 0 || s >= q.options.length) return { ok: false, empty: false, a: null };
      return { ok: q.key.includes(s), empty: false, a: { sel: s } };
    }
    case 'multiple': {
      if (!Array.isArray(a.multi) || !a.multi.length) return { ok: false, empty: true, a: null };
      if (a.multi.length > q.options.length) return { ok: false, empty: false, a: null };
      const sel = [...new Set(a.multi)];
      if (sel.length !== a.multi.length || !sel.every(i => Number.isInteger(i) && i >= 0 && i < q.options.length)) return { ok: false, empty: false, a: null };
      sel.sort((x, y) => x - y);
      return { ok: sel.length === q.key.length && q.key.every(i => sel.includes(i)), empty: false, a: { multi: sel } };
    }
    case 'dropdown': {
      const dd = a.dd && typeof a.dd === 'object' && !Array.isArray(a.dd) ? a.dd : {};
      const vals = q.rows.map((_, i) => (typeof dd[i] === 'string' && q.choices.includes(dd[i]) ? dd[i] : ''));
      if (!vals.some(Boolean)) return { ok: false, empty: true, a: null };
      return { ok: vals.every((v, i) => v === q.key[i]), empty: false, a: { dd: vals } };
    }
    case 'sortable': {
      if (a.order == null) return { ok: false, empty: true, a: null };
      if (!isPerm(a.order, q.items.length)) return { ok: false, empty: false, a: null };
      return { ok: a.order.every((oi, pos) => q.items[oi] === q.key[pos]), empty: false, a: { order: a.order.slice() } };
    }
  }
  return { ok: false, empty: false, a: null };
}

// Итог одного игрока. time — от старта до последнего ответа (или до момента, когда игра для него кончилась).
export function stats(p, n, startAt) {
  const answered = p.ans.length;
  const ok = p.ans.filter(x => x.ok).length;
  const skipped = p.ans.filter(x => x.empty).length;
  const end = p.fin != null ? p.fin : p.stop != null ? p.stop : null;
  return {
    ok,
    wrong: answered - ok, // неверные и пропущенные
    skipped,
    unanswered: n - answered, // не дошёл (сдался, отключился, вышло время)
    acc: answered ? Math.round((ok / answered) * 100) : 0,
    time: end != null && startAt != null ? Math.max(0, end - startAt) : null,
    finished: p.fin != null,
    left: !!p.left,
    dropped: !!p.dropped
  };
}

// Кто победил. Больше верных — победа; поровну — быстрее закончивший; совсем поровну — ничья.
// Сдавшийся или пропавший со связи проигрывает, если второй остался в игре.
export function decide(d) {
  const A = d.p[d.a], B = d.p[d.b];
  const sa = stats(A, d.n, d.startAt), sb = stats(B, d.n, d.startAt);
  const out = (winner, reason) => ({ winner, reason, stats: { [d.a]: sa, [d.b]: sb } });
  if (A.left && B.left) return out(null, 'abandoned');
  if (A.left) return out(d.b, A.dropped ? 'dropped' : 'left');
  if (B.left) return out(d.a, B.dropped ? 'dropped' : 'left');
  if (sa.ok !== sb.ok) return out(sa.ok > sb.ok ? d.a : d.b, 'score');
  if (sa.time != null && sb.time != null && sa.time !== sb.time) return out(sa.time < sb.time ? d.a : d.b, 'time');
  return out(null, 'draw');
}

// Разбор после игры: вопрос, ответ игрока, верный ли он и правильный ответ.
export function review(qs, p) {
  return qs.map((q, i) => {
    const x = p.ans[i];
    return { ...view(q), key: q.key, a: x ? x.a : null, ok: !!(x && x.ok), empty: x ? !!x.empty : true, none: !x };
  });
}
