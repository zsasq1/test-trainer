#!/bin/bash
# Запускает тренажёр с этого Mac, чтобы открыть его на iPhone по Wi‑Fi.
# iPhone и Mac должны быть в одной сети. Остановить: закройте окно Терминала.
cd "$(dirname "$0")" || exit 1
python3 собрать.py || exit 1
PORT=8765
IP=$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null)
echo
echo "Откройте на iPhone в Safari:  http://${IP:-<IP-адрес Mac>}:$PORT"
echo "На этом Mac:                  http://localhost:$PORT"
echo
python3 -m http.server "$PORT"
