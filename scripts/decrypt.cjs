// Расшифровывает ../wb-secure.js кодом доступа → ../decrypted/wb-data.js + wb-reports.js
// (плейнтекст, .gitignore'd — никогда не коммитить). Формат шифра — AES-256-GCM,
// ключ = PBKDF2-SHA256(код, salt, iter); должен совпадать с wbDecrypt() в index.html.
//
// Использование: node scripts/decrypt.cjs <код-доступа>
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'decrypted');

const pass = process.argv[2];
if (!pass) { console.error('usage: node scripts/decrypt.cjs <код-доступа>'); process.exit(1); }

const ctx = {}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(ROOT, 'wb-secure.js'), 'utf8') + '\nglobalThis.__S = WB_SECURE;', ctx);
const S = ctx.__S;

const key = crypto.pbkdf2Sync(Buffer.from(pass, 'utf8'), Buffer.from(S.salt, 'base64'), S.iter, 32, 'sha256');
const ctBuf = Buffer.from(S.ct, 'base64');
const tag = ctBuf.subarray(ctBuf.length - 16);
const body = ctBuf.subarray(0, ctBuf.length - 16);
const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(S.iv, 'base64'));
decipher.setAuthTag(tag);
let payload;
try {
  // Снимок сжат gzip до шифрования (флаг `zip`) — так файл на сайте весит ~1,2 МБ вместо 12,7.
  // Старые снимки без флага лежат обычным текстом, читаем их по-прежнему.
  let buf = Buffer.concat([decipher.update(body), decipher.final()]);
  if (S.zip === 'gzip') buf = zlib.gunzipSync(buf);
  payload = JSON.parse(buf.toString('utf8'));
} catch (e) {
  console.error('Не удалось расшифровать — неверный код доступа?'); process.exit(1);
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'wb-data.js'),
  '// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\n'
  + 'const REAL_DATA = ' + JSON.stringify(payload.REAL_DATA) + ';\n');
const bakedFunnel = payload.BAKED_FUNNEL || [];              // может отсутствовать в старом снимке
const bakedFunnelRows = payload.BAKED_FUNNEL_ROWS || 0;
fs.writeFileSync(path.join(OUT, 'wb-reports.js'),
  '// Зашитый снимок отчётов (финансы + реклама + воронка) по нашим артикулам.\n'
  + 'const BAKED_AT="' + payload.BAKED_AT + '", BAKED_PERIOD="' + payload.BAKED_PERIOD + '";\n'
  + 'const BAKED_FINANCE_ROWS=' + payload.BAKED_FINANCE_ROWS + ', BAKED_ADS_ROWS=' + payload.BAKED_ADS_ROWS + ', BAKED_FUNNEL_ROWS=' + bakedFunnelRows + ';\n'
  + 'const BAKED_FINANCE=' + JSON.stringify(payload.BAKED_FINANCE) + ';\n'
  + 'const BAKED_ADS=' + JSON.stringify(payload.BAKED_ADS) + ';\n'
  + 'const BAKED_FUNNEL=' + JSON.stringify(bakedFunnel) + ';\n');

console.log('OK: decrypted/wb-data.js (' + payload.REAL_DATA.catalog.length + ' товаров) + wb-reports.js '
  + '(' + payload.BAKED_FINANCE.length + ' фин.агрегатов, ' + payload.BAKED_ADS.length + ' рекл.агрегатов, ' + bakedFunnel.length + ' строк воронки)'
  + ' · период снимка: ' + payload.BAKED_PERIOD);
