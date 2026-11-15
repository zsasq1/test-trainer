#!/usr/bin/env python3
"""Собирает веб-версию тренажёра для iPhone.

Что делает:
  1. Смотрит все *.json в папке data/ и пишет список data/sets.json
     (так приложение узнаёт, какие файлы встроены).
  2. Делает index.html из app.html — с иконкой и манифестом для экрана «Домой».
  3. Обновляет sw.js — офлайн-кэш, чтобы на iPhone работало без интернета.

Добавить свой JSON во встроенные: положите файл в data/ и запустите
    python3 собрать.py
Название в меню берётся из имени файла; его можно поправить в data/sets.json.
"""
import json
import pathlib
import time
import urllib.parse

ROOT = pathlib.Path(__file__).resolve().parent
DATA = ROOT / "data"
KNOWN_TITLES = {"bot_dlya_tela": "бот для тела"}

HEAD = """<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#F5F4ED" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#262624" media="(prefers-color-scheme: dark)">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="Тренажёр">
<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="icons/icon-180.png">
<link rel="icon" href="icons/icon-192.png">
<style>:root{padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px)}[hidden]{display:none!important}img{max-width:100%}</style>
</head>
<body>
"""
TAIL = "\n</body>\n</html>\n"

SW = """// Офлайн-кэш тренажёра. Файл создаётся скриптом собрать.py — не правьте вручную.
const CACHE = 'trainer-__VERSION__';
const FONTS = 'trainer-fonts-v1'; // шрифты Google: один раз скачать — дальше работают без сети
const ASSETS = __ASSETS__;

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE && k !== FONTS).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// Сначала сеть (чтобы обновления приходили сразу), без сети — из кэша.
self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const origin = new URL(req.url).origin;
  if (origin === 'https://fonts.googleapis.com' || origin === 'https://fonts.gstatic.com') {
    e.respondWith(caches.open(FONTS).then(async cache => {
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res && (res.ok || res.type === 'opaque')) cache.put(req, res.clone());
      return res;
    }));
    return;
  }
  if (origin !== location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const res = await Promise.race([
        fetch(req),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 4000))
      ]);
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(req, { ignoreSearch: true });
      if (hit) return hit;
      if (req.mode === 'navigate') {
        const page = await cache.match('index.html');
        if (page) return page;
      }
      throw err;
    }
  })());
});
"""


def build_sets():
    sets_path = DATA / "sets.json"
    old = []
    if sets_path.exists():
        try:
            old = json.loads(sets_path.read_text("utf-8"))
        except Exception:
            old = []
    titles = {x.get("file"): x.get("title") for x in old if isinstance(x, dict)}
    order = [x.get("file") for x in old if isinstance(x, dict)]

    found = []
    for p in sorted(DATA.glob("*.json")):
        if p.name == "sets.json":
            continue
        try:
            obj = json.loads(p.read_text("utf-8-sig"))
        except Exception as e:
            print(f"  ! {p.name}: это не JSON ({e}) — пропускаю")
            continue
        if not isinstance(obj, dict) or not obj:
            print(f"  ! {p.name}: нет вопросов (ожидается объект «вопрос → ответы») — пропускаю")
            continue
        found.append(p.name)
        print(f"  ✓ {p.name}: {len(obj)} записей")

    found.sort(key=lambda n: (order.index(n) if n in order else len(order), n))
    sets = [{"file": n, "title": titles.get(n) or KNOWN_TITLES.get(pathlib.Path(n).stem) or pathlib.Path(n).stem} for n in found]
    sets_path.write_text(json.dumps(sets, ensure_ascii=False, indent=2) + "\n", "utf-8")
    return sets


def main():
    print("Файлы с вопросами в data/:")
    sets = build_sets()

    app = (ROOT / "app.html").read_text("utf-8")
    (ROOT / "index.html").write_text(HEAD + app + TAIL, "utf-8")
    print("  ✓ index.html")

    assets = ["./", "index.html", "manifest.webmanifest", "icons/icon-180.png", "icons/icon-192.png",
              "icons/icon-512.png", "data/sets.json"]
    assets += ["data/" + urllib.parse.quote(s["file"]) for s in sets]
    sw = SW.replace("__VERSION__", time.strftime("%Y%m%d-%H%M%S")).replace("__ASSETS__", json.dumps(assets, ensure_ascii=False))
    (ROOT / "sw.js").write_text(sw, "utf-8")
    print("  ✓ sw.js (офлайн-кэш)")
    print("Готово.")


if __name__ == "__main__":
    main()
