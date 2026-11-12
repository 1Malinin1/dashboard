#!/bin/sh
# Все три проверки разом: вкладки × площадки без ошибок, прибыль Ozon 01–14.10, правило полных машин.
# Код — только из VERIFY_CODE (в файлы не писать). Сам поднимает и гасит статический сервер.
# Запуск: VERIFY_CODE=… sh scripts/check/run-all.sh   (из корня репозитория)
[ -z "$VERIFY_CODE" ] && { echo "run-all: нет VERIFY_CODE — проверки не запущены"; exit 3; }
PORT=${PORT:-8799}; URL="http://127.0.0.1:$PORT/index.html"; export PORT URL
python3 -m http.server "$PORT" --bind 127.0.0.1 >/dev/null 2>&1 &
SRV=$!; trap 'kill $SRV 2>/dev/null' EXIT; sleep 1
FAIL=0
OUT=$(node scripts/check/tabs-smoke.cjs 2>&1); echo "$OUT" | grep -q "^ERRORS 0" && echo "✓ вкладки: ошибок 0" || { echo "✗ вкладки:"; echo "$OUT" | tail -15; FAIL=1; }
OUT=$(node scripts/check/ozon-profit.cjs 2>&1); echo "$OUT" | grep -q '"profit": 2840276' && echo "✓ прибыль Ozon 01–14.10 = 2 840 276" || { echo "✗ прибыль Ozon 01–14.10 разошлась:"; echo "$OUT" | grep -E '"(ad|profit)"' | head -4; FAIL=1; }
OUT=$(node scripts/check/full-trucks.cjs 2>&1); echo "$OUT" | grep -q "browser≠script: 0" && echo "✓ машины: сайт = скрипт" || { echo "✗ машины:"; echo "$OUT" | tail -8; FAIL=1; }
exit $FAIL
