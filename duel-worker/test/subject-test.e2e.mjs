// Готовый тест по предмету — от админки до студента, в настоящем WebKit, без сети:
// админка задаёт тест (GitHub подменён: test/gh-mock.mjs) → сохранённый data/sets.json отдаётся тренажёру →
// «Сделать тест» → выбор: большая зелёная «Пройти тест» / маленькая серая «Сделать самому».
// Запуск (сначала python3 собрать.py): NODE_PATH=<playwright-core> npm run test:subject
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mockGitHub, serveStatic } from './gh-mock.mjs';
const require = createRequire(import.meta.url);
const pw = require('playwright-core');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const WEBKIT = process.env.PW_WEBKIT || path.join(process.env.HOME, 'Library/Caches/ms-playwright/webkit-2391/pw_run.sh');
const SHOTS = process.env.SHOTS || '';
const FILE = '3/topka.json';
let passed = 0, failed = 0;
const ok = (c, m) => { if (c) { passed++; console.log('  ✓ ' + m); } else { failed++; console.log('  ✗ ' + m); } return c; };
const shot = async (p, n) => { if (SHOTS) { await p.waitForTimeout(500); await p.screenshot({ path: path.join(SHOTS, n + '.png') }); } };
const errors = [];
const watch = (p, who) => {
  p.on('pageerror', e => errors.push(who + ': ' + e.message));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(who + ' console: ' + m.text()); });
};

const srv = await serveStatic(ROOT, 8851);
const browser = await pw.webkit.launch(fs.existsSync(WEBKIT) ? { executablePath: WEBKIT } : {});
const original = fs.readFileSync(path.join(ROOT, 'data/sets.json'), 'utf8');
try {
  console.log('1. Админка: тест для «Топки»');
  const actx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const gh = await mockGitHub(actx, { root: ROOT });
  await actx.addInitScript(() => localStorage.setItem('TestTrainer.admin', 'fake-token'));
  const ad = await actx.newPage(); watch(ad, 'админка');
  await ad.goto(srv.url + 'admin.html');
  await ad.click('#courses [data-c="3"]');
  const chip = `[data-test="${FILE}"]`;
  await ad.waitForSelector(chip);
  ok(!(await ad.$eval(chip, b => b.classList.contains('on'))), 'у «Топки» кнопка «Тест» — теста ещё нет');
  await ad.click(chip);
  await ad.waitForSelector('#testEd [data-tcat="single"] input[data-tcount]');
  const avail = await ad.$$eval('#testEd [data-tcat]', rs => Object.fromEntries(rs.map(r => [r.dataset.tcat, r.textContent.match(/в файле (\d+)/)[1]])));
  console.log('    ', JSON.stringify(avail));
  ok(avail.single === '290' && avail.caseStudy === '16', 'в редакторе видно, сколько вопросов каждого типа в файле');
  await ad.fill('#tTitle', 'Итоговый тест');
  for (const c of Object.keys(avail)) if (c !== 'single' && c !== 'caseStudy') { const b = `#testEd [data-tcat="${c}"] input[data-tpick]`; if (await ad.isChecked(b)) await ad.click(b); }
  const set = async (sel, v) => { await ad.fill(sel, String(v)); await ad.dispatchEvent(sel, 'change'); };
  await set('#testEd [data-tcat="single"] input[data-tcount]', 4);
  await set('#testEd [data-tcat="caseStudy"] input[data-tcount]', 2);
  await set('#testEd [data-tcat="caseStudy"] input[data-tpts]', 5);
  if (!(await ad.isChecked('#tSame'))) await ad.click('#tSame');
  await ad.waitForFunction(() => /6 вопросов · 14 баллов/.test(document.getElementById('tSum').textContent), null, { timeout: 3000 });
  ok(true, 'итог считается на ходу: «6 вопросов · 14 баллов»');
  await shot(ad, 'subject-admin');
  await ad.click('#tSave');
  for (let i = 0; i < 100 && !gh.commits.length; i++) await ad.waitForTimeout(100);
  const committed = gh.commits[0] && gh.commits[0].files['data/sets.json'];
  const entry = committed && JSON.parse(committed).find(x => x.file === FILE);
  console.log('    ', gh.commits[0] && gh.commits[0].message, JSON.stringify(entry && entry.test));
  const t = entry && entry.test;
  ok(t && t.title === 'Итоговый тест' && t.same === true && Number.isInteger(t.seed) && t.seed > 0
    && JSON.stringify(t.parts) === JSON.stringify([{ cat: 'single', count: 4, points: 1 }, { cat: 'caseStudy', count: 2, points: 5 }]), 'в data/sets.json у «Топки» записан тест в нужном виде');
  ok(JSON.stringify(JSON.parse(committed).map(x => { const { test, ...rest } = x; return rest; })) === JSON.stringify(JSON.parse(original)), 'остальное в списке файлов не тронуто');
  await ad.waitForFunction(s => document.querySelector(s).classList.contains('on'), chip, { timeout: 4000 });
  ok(true, 'кнопка у «Топки» стала «Тест ✓»');

  console.log('\n2. Тренажёр: «Сделать тест» → «Пройти тест»');
  const student = async () => {
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
    await ctx.route(u => !u.href.startsWith(srv.url), r => r.fulfill({ status: 404, body: '' }));
    await ctx.route('**/data/sets.json*', r => r.fulfill({ status: 200, contentType: 'application/json', body: committed }));
    await ctx.addInitScript(() => {
      window.__trMiss = new Set();
      localStorage.setItem('TestTrainer.web.v1', JSON.stringify({ lang: 'ru', fac: 'lech', setId: 'bundle.3/topka', course: 3, tour: { intro: 1, main: 1, menu: 1, test: 1 }, checks: 0, starred: {} }));
    });
    const p = await ctx.newPage(); watch(p, 'студент');
    await p.goto(srv.url + 'index.html');
    await p.waitForSelector('#content .q');
    p.ctx = ctx;
    return p;
  };
  const makeTest = async p => {
    if (await p.isVisible('#menuBtn')) { await p.click('#menuBtn'); await p.waitForTimeout(450); }
    await p.click('[data-act="m-maketest"]');
  };
  // the page writes its state a moment later
  const testIds = async p => { await p.waitForFunction(() => !!(JSON.parse(localStorage.getItem('TestTrainer.web.v1')) || {}).test, null, { timeout: 4000 }); return p.evaluate(() => JSON.parse(localStorage.getItem('TestTrainer.web.v1')).test); };
  const s1 = await student();
  if (await s1.isVisible('#menuBtn')) { await s1.click('#menuBtn'); await s1.waitForTimeout(450); }
  ok((await s1.textContent('[data-act="m-maketest"] small')) === 'Готовый тест или свой', 'в меню: «Сделать тест — Готовый тест или свой»');
  await s1.click('[data-act="m-maketest"]');
  await s1.waitForSelector('.sheet.tc-sheet .tc-go');
  ok((await s1.textContent('.tc-name b')) === 'Итоговый тест' && /6 вопросов · 14 баллов/.test(await s1.textContent('.tc-name small')), 'выбор: «Итоговый тест», 6 вопросов · 14 баллов');
  const look = await s1.evaluate(() => {
    const m = el => { const r = el.getBoundingClientRect(), c = getComputedStyle(el).backgroundColor.match(/\d+/g).map(Number); return { h: r.height, w: r.width, c, fs: parseFloat(getComputedStyle(el).fontSize) }; };
    return { go: m(document.querySelector('.tc-go')), own: m(document.querySelector('.tc-own')) };
  });
  console.log('    ', JSON.stringify(look));
  const [gr, gg, gb] = look.go.c, [or, og, ob] = look.own.c;
  ok(look.go.h > look.own.h + 8 && look.go.w > look.own.w && look.go.fs > look.own.fs, '«Пройти тест» больше «Сделать самому»: выше, шире, крупнее шрифт');
  ok(gg > gr + 40 && gg > gb + 40, '«Пройти тест» зелёная');
  ok(Math.max(or, og, ob) - Math.min(or, og, ob) < 16, '«Сделать самому» серая');
  await shot(s1, 'subject-choice');
  await s1.click('.tc-go');
  await s1.waitForSelector('[data-act="finish"]', { timeout: 5000 });
  const t1 = await testIds(s1);
  const kinds = t1.ids.reduce((a, id) => { const k = id.split('-')[0]; a[k] = (a[k] || 0) + 1; return a; }, {});
  console.log('    ', JSON.stringify(kinds), JSON.stringify(t1.points));
  ok(kinds.single === 4 && kinds.case === 2 && t1.ids.length === 6, 'тест начался: 4 «Один ответ» и 2 кейса, как задано в админке');
  ok(t1.points.single === 1 && t1.points.caseStudy === 5, 'баллы — как в админке');
  ok(!(await s1.evaluate(() => JSON.parse(localStorage.getItem('TestTrainer.web.v1')).savedTests || []).then(x => x.length)), 'готовый тест не попал в «свои» тесты студента');
  await shot(s1, 'subject-started');

  const s2 = await student();
  await makeTest(s2);
  await s2.waitForSelector('.tc-go');
  await s2.click('.tc-go');
  await s2.waitForSelector('[data-act="finish"]', { timeout: 5000 });
  const t2 = await testIds(s2);
  ok(JSON.stringify(t2.ids) === JSON.stringify(t1.ids), '«Одинаковые вопросы у всех»: у второго студента те же вопросы в том же порядке');

  console.log('\n3. «Сделать самому» — свой тест, как раньше');
  await makeTest(s2);
  await s2.waitForSelector('.tc-sheet .tc-own');
  ok(/Сейчас идёт тест/.test(await s2.textContent('.tc-sheet')), 'пока идёт тест — предупреждение, что новый его заменит');
  await s2.click('.tc-own');
  await s2.waitForSelector('.sheet .mt-sec', { timeout: 4000 });
  ok(await s2.waitForSelector('.tc-sheet', { state: 'detached', timeout: 3000 }).then(() => true, () => false), '«Сделать самому» открывает обычный конструктор теста, выбор закрывается');
  for (const p of [s1, s2]) { const m = await p.evaluate(() => [...window.__trMiss]); ok(!m.length, 'все строки переведены' + (m.length ? ': ' + JSON.stringify(m) : '')); }
  await s1.ctx.close(); await s2.ctx.close();

  console.log('\n4. Админка: «Убрать тест»');
  await ad.click(chip);
  await ad.waitForSelector('#tDel');
  await ad.click('#tDel');
  await ad.waitForSelector('[data-r="1"]');
  await ad.click('[data-r="1"]');
  for (let i = 0; i < 100 && gh.commits.length < 2; i++) await ad.waitForTimeout(100);
  ok(gh.commits[1] && gh.commits[1].files['data/sets.json'] === original, 'тест убран — data/sets.json снова как был');
  await ad.waitForFunction(s => !document.querySelector(s).classList.contains('on'), chip, { timeout: 4000 });
  ok(true, 'кнопка у «Топки» снова просто «Тест»');
  // the mock answers api.github.com/repos/zsasq1/test-trainer and aborts every other outside address
  ok(gh.requests.filter(r => r.method === 'PATCH' && r.path.startsWith('/git/refs/heads/main')).length === 2, 'обе записи (тест и его удаление) ушли в подменённый GitHub, не в настоящий');
  await actx.close();
  ok(!errors.length, 'ошибок JavaScript нет' + (errors.length ? ': ' + JSON.stringify(errors) : ''));
} catch (e) {
  failed++; console.log('  ✗ ' + (e && e.stack || e));
} finally {
  await browser.close();
  await srv.close();
}
console.log(`\n${passed} прошло, ${failed} не прошло`);
process.exit(failed ? 1 : 0);
