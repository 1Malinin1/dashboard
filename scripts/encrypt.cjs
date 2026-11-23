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
const allowDrop = process.argv.slice(3).includes('--allow-drop');
if (!pass) { console.error('usage: node scripts/encrypt.cjs <код-доступа> [--allow-drop]'); process.exit(1); }

function readCandidate() {
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
  return ctx.__OUT;
}

/* ЗАЩИТА ОТ ТИХОЙ ПРОПАЖИ (30.10.2026). Скрипты переписывают снимок целиком, и забытое поле пропадает без ошибки
   и без пустой таблицы — так однажды вышло 7,3 млн «прибыли из воздуха». Перед записью сравниваем новый снимок
   с ТЕКУЩИМ wb-secure.js (тем же кодом): ключ, который был, а теперь пропал, или счётчик, который уменьшился, —
   ОСТАНОВКА. Сознательное удаление (например, model-finance --clear) — флаг --allow-drop. */
function snapshotStats(o){
  const R=o.REAL_DATA||{}, Z=R.ozon||{}, M=Z.meta||{}, len=v=>Array.isArray(v)? v.length : (v&&typeof v==='object'? Object.keys(v).length : 0);
  return {
    keysPayload: Object.keys(o), keysRD: Object.keys(R), keysOzon: Object.keys(Z), keysOzonMeta: Object.keys(M), keysMeta: Object.keys(R.meta||{}),
    n: { 'каталог ВБ':len(R.catalog), 'дни заказов ВБ':len(R.orderSeries&&R.orderSeries.dates), 'дни заказов Ozon':len(Z.orderSeries&&Z.orderSeries.dates),
      'каталог Ozon':len(Z.catalog), 'фин. отчёты ВБ (строк)':len(o.BAKED_FINANCE), 'оценка финансов ВБ (строк)':len(o.MODELED_FINANCE),
      'отчёты рекламы ВБ (строк)':len(o.BAKED_ADS), 'воронка ВБ (строк)':len(o.BAKED_FUNNEL), 'выгрузки рекламы ВБ':len(R.adPerf&&R.adPerf.parts), 'выгрузки XWAY Ozon':len(M.adSpend&&M.adSpend.parts),
      'дни «Оплаты за заказ»':len(M.orderFee&&M.orderFee.periods), 'история остатков Ozon':len(Z.stockHistory), 'история остатков ВБ':len(R.wbStockHistory),
      'история своего склада':len(R.whHistory), 'журнал отгрузок ВБ':len(R.shipments), 'партии производства':len(R.prodOrders&&R.prodOrders.rows) } };
}

function decodeBase64(value) {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) throw new Error('Некорректный base64 в снимке.');
  return bytes;
}

// Читаем тот же JS-контейнер, что получает браузер. Старый формат без gzip по-прежнему поддерживается.
function decryptSnapshot(file) {
  const src = fs.readFileSync(file, 'utf8');
  const match = /^(?:\s*\/\/[^\n]*\n)*\s*const\s+WB_SECURE\s*=\s*(\{[\s\S]*\})\s*;\s*$/.exec(src);
  if (!match) throw new Error('Некорректный файл снимка.');
  const s = JSON.parse(match[1]);
  if (s.v !== 1 || s.alg !== 'AES-GCM' || s.kdf !== 'PBKDF2-SHA256' || s.hash !== 'SHA-256'
      || (s.zip !== undefined && s.zip !== 'gzip')) throw new Error('Неизвестный формат снимка.');
  const salt = decodeBase64(s.salt), iv = decodeBase64(s.iv), ct = decodeBase64(s.ct);
  if (salt.length !== 16 || iv.length !== 12 || ct.length <= 16) throw new Error('Повреждён контейнер.');
  const key = crypto.pbkdf2Sync(pass, salt, s.iter, 32, 'sha256');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(ct.subarray(-16));
  const payload = Buffer.concat([decipher.update(ct.subarray(0, -16)), decipher.final()]);
  const json = s.zip === 'gzip' ? zlib.gunzipSync(payload) : payload;
  return { json, period: s.period };
}

function validateData(data) {
  if (!Array.isArray(data?.REAL_DATA?.catalog) || !Array.isArray(data.BAKED_FINANCE)
      || !Array.isArray(data.BAKED_ADS) || typeof data.BAKED_PERIOD !== 'string') {
    throw new Error('Отсутствуют обязательные данные снимка.');
  }
  for (const field of ['BAKED_FUNNEL', 'MODELED_FINANCE']) {
    if (field in data && !Array.isArray(data[field])) throw new Error('Повреждено поле ' + field);
  }
}

function checkLosses(previous, candidate, allowDrop) {
  const a = snapshotStats(previous), b = snapshotStats(candidate), losses = [];
  for (const [field, name] of [['keysPayload','снимок'], ['keysRD','REAL_DATA'], ['keysOzon','REAL_DATA.ozon'],
    ['keysOzonMeta','ozon.meta'], ['keysMeta','REAL_DATA.meta']]) {
    for (const key of a[field]) {
      if (!b[field].includes(key)) losses.push('пропало поле ' + name + '.' + key);
    }
  }
  for (const [name, count] of Object.entries(a.n)) {
    if (b.n[name] < count) losses.push(name + ': было ' + count + ' → стало ' + b.n[name]);
  }
  if (losses.length) {
    const details = losses.join('\n  · ');
    if (!allowDrop) {
      const error = new Error('Новый снимок потерял данные:\n  · ' + details
        + '\nДля подтверждённого сокращения предусмотрен --allow-drop.');
      error.exitCode = 2;
      throw error;
    }
    console.warn('Подтверждено сокращение (--allow-drop):\n  · ' + details);
  } else {
    const changes = Object.keys(b.n).filter(k => a.n[k] !== b.n[k]);
    console.log('Сверка с прошлым снимком: ничего не пропало (' +
      changes.map(k => k + ' ' + a.n[k] + '→' + b.n[k]).join(', ') + ')');
  }
}

function encryptSnapshot(rawJson, period) {
  const payload = zlib.gzipSync(rawJson, { level: 9 });
  console.log('сжатие: JSON', (rawJson.length / 1048576).toFixed(2), 'МБ → gzip',
    (payload.length / 1048576).toFixed(2), 'МБ ·', (payload.length / rawJson.length * 100).toFixed(1) + '% от исходного');
  const salt = crypto.randomBytes(16), iv = crypto.randomBytes(12);
  const key = crypto.pbkdf2Sync(pass, salt, ITER, 32, 'sha256');
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(payload), cipher.final(), cipher.getAuthTag()]);
  const secure = {
    v: 1, alg: 'AES-GCM', kdf: 'PBKDF2-SHA256', hash: 'SHA-256', iter: ITER, zip: 'gzip',
    salt: salt.toString('base64'), iv: iv.toString('base64'), ct: ct.toString('base64'), period,
  };
  return '// Зашифрованный снимок данных (финансы, реклама, каталог). Без кода доступа не читается.\n'
    + '// Ключ выводится из кода через PBKDF2-SHA256; шифр AES-256-GCM. Расшифровка — только в браузере.\n'
    + 'const WB_SECURE = ' + JSON.stringify(secure) + ';\n';
}

function updateSnapshot() {
  const snapshot = path.join(ROOT, 'wb-secure.js'), manifest = path.join(ROOT, 'data-version.json');
  // Один писатель. После прерывания каталог и резервные файлы остаются для ручной сверки.
  const pending = path.join(ROOT, '.encrypt-pending');
  try {
    fs.mkdirSync(pending, { mode: 0o700 });
  } catch (e) {
    if (e.code === 'EEXIST') throw new Error('Есть незавершённая запись .encrypt-pending. Проверьте её перед повтором.');
    throw e;
  }
  let keepBackups = false;
  try {
    let previous;
    try {
      const old = decryptSnapshot(snapshot);
      previous = JSON.parse(old.json);
      validateData(previous);
      if (old.period !== previous.BAKED_PERIOD) throw new Error('Период снимка расходится.');
    } catch {
      throw new Error('Не удалось прочитать и проверить прежний wb-secure.js. Проверьте файл и код доступа.');
    }
    const candidate = readCandidate();
    validateData(candidate);
    checkLosses(previous, candidate, allowDrop);

    let version;
    try {
      version = JSON.parse(fs.readFileSync(manifest, 'utf8'));
      if (!version || typeof version !== 'object' || Array.isArray(version)) throw new Error();
    } catch {
      throw new Error('Не удалось прочитать прежний data-version.json.');
    }
    const now = new Date().toISOString();
    version.v = now.replace(/[-:T]/g, '').slice(0, 12);
    version.period = candidate.BAKED_PERIOD;
    version.builtAt = now;
    const manifestText = JSON.stringify(version) + '\n';
    const rawJson = Buffer.from(JSON.stringify(candidate));
    const nextSnapshot = path.join(pending, 'next.js'), nextManifest = path.join(pending, 'next.json');
    fs.writeFileSync(nextSnapshot, encryptSnapshot(rawJson, candidate.BAKED_PERIOD),
      { flag: 'wx', mode: fs.statSync(snapshot).mode & 0o777, flush: true });
    fs.writeFileSync(nextManifest, manifestText, { flag: 'wx', mode: fs.statSync(manifest).mode & 0o777, flush: true });

    const checked = decryptSnapshot(nextSnapshot);
    if (!checked.json.equals(rawJson) || checked.period !== candidate.BAKED_PERIOD) {
      throw new Error('Самопроверка нового снимка не прошла.');
    }
    if (fs.readFileSync(nextManifest, 'utf8') !== manifestText) throw new Error('Самопроверка манифеста не прошла.');

    // Обе ссылки остаются привязаны к исходным байтам после rename. Всё на одной файловой системе.
    const oldSnapshot = path.join(pending, 'previous.js');
    fs.linkSync(snapshot, oldSnapshot);
    fs.linkSync(manifest, path.join(pending, 'previous.json'));
    fs.renameSync(nextSnapshot, snapshot);
    try {
      fs.renameSync(nextManifest, manifest);
    } catch (manifestError) {
      try {
        fs.renameSync(oldSnapshot, snapshot);
      } catch {
        keepBackups = true;
        throw new Error('Откат не удался. Оба исходных файла сохранены в .encrypt-pending/previous.{js,json}.');
      }
      throw manifestError;
    }
    return { candidate, version };
  } finally {
    if (!keepBackups) {
      try { fs.rmSync(pending, { recursive: true }); }
      catch { console.warn('Не удалось очистить .encrypt-pending. Перед повтором проверьте состояние файлов.'); }
    }
  }
}

try {
  const { candidate, version } = updateSnapshot();
  console.log('wb-secure.js записан · каталог', candidate.REAL_DATA.catalog.length,
    '· фин.агрегатов', candidate.BAKED_FINANCE.length, '· рекл.агрегатов', candidate.BAKED_ADS.length,
    '· строк воронки', candidate.BAKED_FUNNEL.length, '· период', version.period, '· roundtrip OK');
  console.log('data-version.json:', version.v, '· build', version.build || 'отсутствует');
  // После успешной записи печатаем прежний аудит полноты.
  try {
    const res = require('./data-audit.cjs')({ __RD: candidate.REAL_DATA, BAKED_FUNNEL: candidate.BAKED_FUNNEL }, { days: 14 });
    console.log(res.length ? '\nАУДИТ ПОЛНОТЫ ДАННЫХ:\n' + res.join('\n') : '\nАУДИТ ПОЛНОТЫ ДАННЫХ: пропаж не найдено.');
  } catch (e) { console.log('\n(аудит полноты не выполнился: ' + e.message + ')'); }
} catch (e) {
  console.error('СТОП:', e.message);
  process.exitCode = e.exitCode || 1;
}
