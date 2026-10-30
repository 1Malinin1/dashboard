// Шифрует ../decrypted/wb-data.js + wb-reports.js обратно в ../wb-secure.js
// (единственный файл с данными, который коммитится в репозиторий).
//
// Использование: node scripts/encrypt.cjs <код-доступа> [--allow-drop]
// Перед записью сверяет новый снимок с текущим wb-secure.js: пропавшее поле или уменьшившийся счётчик — остановка.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'decrypted');
const ITER = 250000;

const pass = process.argv[2];
if (!pass) { console.error('usage: node scripts/encrypt.cjs <код-доступа>'); process.exit(1); }

const ctx = {}; vm.createContext(ctx);
vm.runInContext(
  fs.readFileSync(path.join(OUT, 'wb-data.js'), 'utf8') + '\n'
  + fs.readFileSync(path.join(OUT, 'wb-reports.js'), 'utf8') + '\n'
  + 'globalThis.__OUT = {REAL_DATA, BAKED_AT, BAKED_PERIOD, BAKED_FINANCE_ROWS, BAKED_ADS_ROWS, BAKED_FINANCE, BAKED_ADS,'
  + ' BAKED_FUNNEL: (typeof BAKED_FUNNEL!=="undefined"? BAKED_FUNNEL : []),'
  + ' BAKED_FUNNEL_ROWS: (typeof BAKED_FUNNEL_ROWS!=="undefined"? BAKED_FUNNEL_ROWS : 0),'
  + ' MODELED_FINANCE: (typeof MODELED_FINANCE!=="undefined"? MODELED_FINANCE : [])};',
  ctx
);
const out = ctx.__OUT;

/* ЗАЩИТА ОТ ТИХОЙ ПРОПАЖИ (30.10.2026). Скрипты переписывают снимок целиком, и забытое поле пропадает без ошибки
   и без пустой таблицы — так однажды вышло 7,3 млн «прибыли из воздуха». Перед записью сравниваем новый снимок
   с ТЕКУЩИМ wb-secure.js (тем же кодом): ключ, который был, а теперь пропал, или счётчик, который уменьшился, —
   ОСТАНОВКА. Сознательное удаление (например, model-finance --clear) — флаг --allow-drop. */
function snapshotStats(o){
  const R=o.REAL_DATA||{}, Z=R.ozon||{}, M=Z.meta||{}, len=v=>Array.isArray(v)? v.length : (v&&typeof v==='object'? Object.keys(v).length : 0);
  return {
    keysRD: Object.keys(R), keysOzon: Object.keys(Z), keysOzonMeta: Object.keys(M), keysMeta: Object.keys(R.meta||{}),
    n: { 'каталог ВБ':len(R.catalog), 'дни заказов ВБ':len(R.orderSeries&&R.orderSeries.dates), 'дни заказов Ozon':len(Z.orderSeries&&Z.orderSeries.dates),
      'каталог Ozon':len(Z.catalog), 'фин. отчёты ВБ (строк)':len(o.BAKED_FINANCE), 'оценка финансов ВБ (строк)':len(o.MODELED_FINANCE),
      'воронка ВБ (строк)':len(o.BAKED_FUNNEL), 'выгрузки рекламы ВБ':len(R.adPerf&&R.adPerf.parts), 'выгрузки XWAY Ozon':len(M.adSpend&&M.adSpend.parts),
      'дни «Оплаты за заказ»':len(M.orderFee&&M.orderFee.periods), 'история остатков Ozon':len(Z.stockHistory), 'история остатков ВБ':len(R.wbStockHistory),
      'история своего склада':len(R.whHistory), 'журнал отгрузок ВБ':len(R.shipments), 'партии производства':len(R.prodOrders&&R.prodOrders.rows) } };
}
if (!process.argv.includes('--allow-drop') && fs.existsSync(path.join(ROOT, 'wb-secure.js'))) {
  let prev = null;
  try {
    const src = fs.readFileSync(path.join(ROOT, 'wb-secure.js'), 'utf8'); const S = JSON.parse(src.slice(src.indexOf('{'), src.lastIndexOf('}') + 1));
    const k = crypto.pbkdf2Sync(Buffer.from(pass, 'utf8'), Buffer.from(S.salt, 'base64'), S.iter, 32, 'sha256');
    const ct = Buffer.from(S.ct, 'base64'), d = crypto.createDecipheriv('aes-256-gcm', k, Buffer.from(S.iv, 'base64'));
    d.setAuthTag(ct.subarray(ct.length - 16)); let b = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
    if (S.zip === 'gzip') b = zlib.gunzipSync(b); prev = JSON.parse(b.toString('utf8'));
  } catch (e) { console.warn('⚠ прошлый снимок не прочитан этим кодом — сверку пропускаю (' + e.message + ')'); }
  if (prev) {
    const A = snapshotStats(prev), B = snapshotStats(out), bad = [];
    [['keysRD','REAL_DATA'],['keysOzon','REAL_DATA.ozon'],['keysOzonMeta','ozon.meta'],['keysMeta','REAL_DATA.meta']].forEach(([f,nm]) => {
      A[f].filter(x => !B[f].includes(x)).forEach(x => bad.push('пропало поле ' + nm + '.' + x)); });
    Object.keys(A.n).forEach(x => { if (B.n[x] < A.n[x]) bad.push(x + ': было ' + A.n[x] + ' → стало ' + B.n[x]); });
    if (bad.length) {
      console.error('СТОП: новый снимок потерял данные против текущего wb-secure.js:\n  · ' + bad.join('\n  · ')
        + '\nЕсли это сознательно (например, model-finance --clear) — повторите с --allow-drop. wb-secure.js НЕ перезаписан.');
      process.exit(2);
    }
    console.log('сверка с прошлым снимком: ничего не пропало (' + Object.entries(B.n).filter(([x,v]) => v !== A.n[x]).map(([x,v]) => x + ' ' + A.n[x] + '→' + v).join(', ') + ')');
  }
}
// СЖИМАЕМ до шифрования. JSON снимка — около 9,5 МБ, а base64 в файле раздувал его до
// 12,7 МБ: на слабой связи браузер просто не догружал wb-secure.js и дашборд открывался
// пустым. gzip даёт ~1,2 МБ (данные очень однотипные). Флаг `zip` читает страница;
// старые снимки без него по-прежнему читаются как обычный текст.
const rawJson = Buffer.from(JSON.stringify(out), 'utf8');
const payload = zlib.gzipSync(rawJson, { level: 9 });

const salt = crypto.randomBytes(16);
const iv = crypto.randomBytes(12);
const key = crypto.pbkdf2Sync(Buffer.from(pass, 'utf8'), salt, ITER, 32, 'sha256');
const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
const enc = Buffer.concat([cipher.update(payload), cipher.final()]);
const tag = cipher.getAuthTag();
const ct = Buffer.concat([enc, tag]);

const secure = {
  v: 1, alg: 'AES-GCM', kdf: 'PBKDF2-SHA256', hash: 'SHA-256', iter: ITER, zip: 'gzip',
  salt: salt.toString('base64'), iv: iv.toString('base64'), ct: ct.toString('base64'),
  period: out.BAKED_PERIOD,
};
const js = '// Зашифрованный снимок данных (финансы, реклама, каталог). Без кода доступа не читается.\n'
  + '// Ключ выводится из кода через PBKDF2-SHA256; шифр AES-256-GCM. Расшифровка — только в браузере.\n'
  + 'const WB_SECURE = ' + JSON.stringify(secure) + ';\n';
fs.writeFileSync(path.join(ROOT, 'wb-secure.js'), js);

// самопроверка: расшифруем тем же кодом и сверим размеры
const key2 = crypto.pbkdf2Sync(Buffer.from(pass, 'utf8'), salt, ITER, 32, 'sha256');
const decipher = crypto.createDecipheriv('aes-256-gcm', key2, iv);
decipher.setAuthTag(tag);
const backBuf = Buffer.concat([decipher.update(enc), decipher.final()]);
const back = JSON.parse(zlib.gunzipSync(backBuf).toString('utf8'));
const ok = back.BAKED_FINANCE.length === out.BAKED_FINANCE.length
  && back.BAKED_ADS.length === out.BAKED_ADS.length
  && back.BAKED_FUNNEL.length === out.BAKED_FUNNEL.length
  && back.REAL_DATA.catalog.length === out.REAL_DATA.catalog.length;

// Версия снимка для кеш-бастинга. Лежит отдельным крошечным файлом: index.html грузит его
// БЕЗ кеша и уже по нему запрашивает wb-secure.js. Так обновление данных доезжает до браузера
// даже с закешированной разметкой (раньше версия жила в index.html и залипала вместе с ним).
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 12);
// ВАЖНО: дописываем в существующий файл, а не перезаписываем его целиком. Рядом с версией
// данных там живёт `build` — отпечаток index.html, по которому страница понимает, что вышла
// новая разметка. Полная перезапись сносила его, и самообновление молча выключалось:
// заливка данных (index.html при этом не менялся) не поднимала git-хук, и `build` не возвращался.
const vfile = path.join(ROOT, 'data-version.json');
let vj = {}; try { vj = JSON.parse(fs.readFileSync(vfile, 'utf8')); } catch (e) {}
vj.v = stamp; vj.period = out.BAKED_PERIOD; vj.builtAt = new Date().toISOString();
fs.writeFileSync(vfile, JSON.stringify(vj) + '\n');
console.log('data-version.json:', stamp, vj.build ? '· build ' + vj.build + ' сохранён' : '· ⚠ build отсутствует — запустите scripts/stamp-build.cjs');

console.log('сжатие: JSON', (rawJson.length / 1048576).toFixed(2), 'МБ → gzip',
  (payload.length / 1048576).toFixed(2), 'МБ ·', (payload.length / rawJson.length * 100).toFixed(1) + '% от исходного');
console.log('wb-secure.js записан:', (js.length / 1024 | 0), 'KB · каталог', out.REAL_DATA.catalog.length,
  '· фин.агрегатов', out.BAKED_FINANCE.length, '· рекл.агрегатов', out.BAKED_ADS.length,
  '· строк воронки', out.BAKED_FUNNEL.length,
  '· период', out.BAKED_PERIOD, '· roundtrip', ok ? 'OK' : 'FAILED');
if (!ok) process.exit(1);
