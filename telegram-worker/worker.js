// Вход через Telegram для тренажёра (Cloudflare Worker).
//
// Telegram подписывает данные о человеке ключом бота. Этот ключ секретный и на открытом сайте лежать
// не может, поэтому подпись проверяется здесь. Если она верна, Worker отдаёт служебный вход и пароль
// для Firebase. Вычислить их может только он: они получаются из SECRET и номера пользователя Telegram.
// Поэтому даже утечка этих секретов касается только Telegram-аккаунтов сайта, а не админа и не
// аккаунтов с паролем или Google.
//
// Секреты (Cloudflare → этот Worker → Settings → Variables and Secrets, тип Secret):
//   BOT_TOKEN — токен бота от @BotFather
//   SECRET    — длинная случайная строка (её задают один раз и больше не меняют, иначе старые входы через Telegram перестанут работать)
// Обычная переменная (уже есть в wrangler.toml):
//   ALLOWED_ORIGIN — адрес сайта, которому можно обращаться к Worker

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

export default {
  async fetch(req, env) {
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
    if (req.method !== 'POST') return out({ error: 'POST_ONLY' }, 405);
    if (!env.BOT_TOKEN || !env.SECRET) return out({ error: 'NOT_CONFIGURED' }, 500);

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
    const id = String(d.id);
    if (!/^\d{1,20}$/.test(id)) return out({ error: 'BAD_DATA' }, 400);

    const key = enc.encode(env.SECRET);
    return out({
      login: 'tg-' + hex(await hmac(key, 'login:' + id)).slice(0, 24),
      pass: b64url(await hmac(key, 'pass:' + id)),
      name: [d.first_name, d.last_name].filter(x => typeof x === 'string' && x).join(' ').slice(0, 80),
      username: typeof d.username === 'string' ? d.username.slice(0, 40) : ''
    });
  }
};
