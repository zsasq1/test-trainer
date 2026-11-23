// Вход через Telegram для тренажёра (Cloudflare Worker).
//
// Два способа войти:
//  1. В одно нажатие (основной). Сайт открывает t.me/<бот>?start=<код>, человек жмёт в Telegram «Запустить».
//     Telegram присылает это нажатие сюда (вебхук с секретным заголовком), а сайт тем временем
//     спрашивает /tg/poll, подтверждён ли его код. Коды живут в Durable Object «Codes» не дольше 10 минут
//     и срабатывают один раз.
//  2. По номеру телефона (запасной), через страницу oauth.telegram.org. Telegram подписывает данные
//     ключом бота, и подпись проверяется здесь (POST /).
//
// В обоих случаях Worker отдаёт служебный вход tg-… и пароль для Firebase. Их может вычислить только он:
// они получаются из SECRET и номера пользователя Telegram. Поэтому утечка секретов касается только
// Telegram-аккаунтов сайта, а не админа и не аккаунтов с паролем или Google.
//
// Секреты (Cloudflare → этот Worker → Settings → Variables and Secrets, тип Secret):
//   BOT_TOKEN — токен бота от @BotFather
//   SECRET    — длинная случайная строка (её задают один раз и больше не меняют, иначе старые входы через Telegram перестанут работать)
// Обычная переменная (в wrangler.toml):
//   ALLOWED_ORIGIN — адрес сайта, которому можно обращаться к Worker
// После первой выкладки откройте один раз /tg/setup: Worker сам подключит вебхук бота и описание бота.

import { DurableObject } from 'cloudflare:workers';

const TTL = 10 * 60 * 1000; // a code waits for «Запустить» and then for the site at most this long
const SITE = 'https://zsasq1.github.io/test-trainer/';
const enc = new TextEncoder();
const hex = buf => [...new Uint8Array(buf)].map(x => x.toString(16).padStart(2, '0')).join('');
const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
async function hmac(key, msg) {
  const k = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(msg));
}
function same(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}
// the header Telegram sends with every webhook call: only Telegram (told by /tg/setup) knows it
const hookSecret = async env => hex(await hmac(enc.encode(env.SECRET), 'webhook')).slice(0, 48);
// this person's own sign-in for Firebase
async function creds(env, u) {
  const key = enc.encode(env.SECRET), id = String(u.id);
  return {
    login: 'tg-' + hex(await hmac(key, 'login:' + id)).slice(0, 24),
    pass: b64url(await hmac(key, 'pass:' + id)),
    name: [u.first_name, u.last_name].filter(x => typeof x === 'string' && x).join(' ').slice(0, 80),
    username: typeof u.username === 'string' ? u.username.slice(0, 40) : ''
  };
}

// One-time codes: «this code was confirmed in Telegram by this person».
export class Codes extends DurableObject {
  async confirm(code, user) {
    const s = this.ctx.storage, had = await s.get(code);
    if (had) return had.user.id === user.id ? 'again' : 'used';
    await s.put(code, { user, at: Date.now() });
    if (!(await s.getAlarm())) await s.setAlarm(Date.now() + TTL);
    return 'ok';
  }
  async take(code) {
    const s = this.ctx.storage, v = await s.get(code);
    if (!v || v.taken) return null;
    if (Date.now() - v.at > TTL) { await s.delete(code); return null; }
    await s.put(code, { ...v, taken: true }); // used once; kept a little so a second «Запустить» is told it is done
    return v;
  }
  async alarm() {
    const s = this.ctx.storage, all = await s.list(), old = [];
    for (const [k, v] of all) if (Date.now() - v.at > TTL) old.push(k);
    for (let i = 0; i < old.length; i += 128) await s.delete(old.slice(i, i + 128));
    if (all.size > old.length) await s.setAlarm(Date.now() + TTL);
  }
}
const codes = env => env.CODES.get(env.CODES.idFromName('codes'));

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const allowed = String(env.ALLOWED_ORIGIN || '').split(',').map(s => s.trim()).filter(Boolean);
    const origin = req.headers.get('Origin') || '';
    const cors = {
      'Access-Control-Allow-Origin': allowed.includes(origin) ? origin : (allowed[0] || 'null'),
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin'
    };
    const out = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (!env.BOT_TOKEN || !env.SECRET) return out({ error: 'NOT_CONFIGURED' }, 500);

    // Telegram → «Запустить» was pressed
    if (url.pathname === '/tg/hook') {
      if (req.method !== 'POST' || !same(req.headers.get('X-Telegram-Bot-Api-Secret-Token') || '', await hookSecret(env))) return new Response('forbidden', { status: 403 });
      const upd = await req.json().catch(() => null);
      const msg = upd && upd.message;
      if (!msg || !msg.from || msg.from.is_bot || !msg.chat || msg.chat.type !== 'private') return new Response('ok');
      const m = String(msg.text || '').match(/^\/start(?:@\w+)?\s+([A-Za-z0-9_-]{16,64})\s*$/);
      let text;
      if (m) {
        const u = msg.from;
        const r = await codes(env).confirm(m[1], { id: u.id, first_name: u.first_name || '', last_name: u.last_name || '', username: u.username || '' });
        text = r === 'ok' ? '✅ Вход подтверждён.\nВернитесь в браузер — вы уже на сайте.'
          : r === 'again' ? 'Уже подтверждено — просто вернитесь в браузер.'
          : 'Эта ссылка уже использована. Нажмите на сайте «Продолжить с Telegram» ещё раз.';
      } else {
        text = 'Этот бот подтверждает вход на сайт «Тренажёр тестов»:\n' + SITE + '\n\nНажмите там «Продолжить с Telegram».';
      }
      // the reply goes back in the webhook answer itself
      return new Response(JSON.stringify({ method: 'sendMessage', chat_id: msg.chat.id, text, disable_web_page_preview: true }), { headers: { 'Content-Type': 'application/json' } });
    }

    // the site → has my code been confirmed?
    if (url.pathname === '/tg/poll') {
      if (req.method !== 'POST') return out({ error: 'POST_ONLY' }, 405);
      const b = await req.json().catch(() => null);
      const code = b && typeof b.code === 'string' ? b.code : '';
      if (!/^[A-Za-z0-9_-]{16,64}$/.test(code)) return out({ error: 'BAD_DATA' }, 400);
      const v = await codes(env).take(code);
      return v ? out(await creds(env, v.user)) : out({ wait: true });
    }

    // once after deploying: point the bot at this worker and describe it
    if (url.pathname === '/tg/setup') {
      const api = (method, body) => fetch('https://api.telegram.org/bot' + env.BOT_TOKEN + '/' + method, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(r => r.json()).catch(e => ({ ok: false, description: String(e) }));
      // already connected: change nothing (anyone can open this address)
      const info = await api('getWebhookInfo', {});
      if (info.ok && info.result && info.result.url === url.origin + '/tg/hook') return out({ webhook: true, already: true, pending: info.result.pending_update_count || 0, lastError: info.result.last_error_message || undefined });
      const hook = await api('setWebhook', { url: url.origin + '/tg/hook', secret_token: await hookSecret(env), allowed_updates: ['message'], drop_pending_updates: true });
      const desc = await api('setMyDescription', { description: 'Этот бот подтверждает вход на сайт «Тренажёр тестов». Нажмите «Запустить» — и возвращайтесь в браузер.' });
      const short = await api('setMyShortDescription', { short_description: 'Вход на сайт «Тренажёр тестов»' });
      return out({ webhook: !!hook.ok, description: !!desc.ok, short: !!short.ok, error: hook.ok ? undefined : hook.description });
    }

    // the phone-number way: data signed by Telegram
    if (url.pathname !== '/') return out({ error: 'NOT_FOUND' }, 404);
    if (req.method !== 'POST') return out({ error: 'POST_ONLY' }, 405);
    let d;
    try { d = await req.json(); } catch (e) { return out({ error: 'BAD_JSON' }, 400); }
    if (!d || typeof d !== 'object' || Array.isArray(d) || typeof d.hash !== 'string' || !/^[0-9a-f]{64}$/.test(d.hash)) return out({ error: 'BAD_DATA' }, 400);
    const keys = Object.keys(d).filter(k => k !== 'hash');
    if (keys.length > 20 || keys.some(k => !/^[a-z0-9_]{1,32}$/.test(k) || (typeof d[k] !== 'string' && typeof d[k] !== 'number'))) return out({ error: 'BAD_DATA' }, 400);
    // https://core.telegram.org/widgets/login#checking-authorization
    const check = keys.sort().map(k => k + '=' + d[k]).join('\n');
    const sig = hex(await hmac(await crypto.subtle.digest('SHA-256', enc.encode(env.BOT_TOKEN)), check));
    if (!same(sig, d.hash)) return out({ error: 'BAD_HASH' }, 401);
    const age = Date.now() / 1000 - Number(d.auth_date);
    if (!(age < 3600 && age > -300)) return out({ error: 'EXPIRED' }, 401);
    if (!/^\d{1,20}$/.test(String(d.id))) return out({ error: 'BAD_DATA' }, 400);
    return out(await creds(env, d));
  }
};
