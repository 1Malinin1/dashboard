// Шифрует ../decrypted/wb-data.js + wb-reports.js обратно в ../wb-secure.js
// (единственный файл с данными, который коммитится в репозиторий).
//
// Использование: node scripts/encrypt.cjs <код-доступа>
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'decrypted');
const ITER = 250000;

const pass = process.argv[2];
if (!pass) { console.error('usage: node scripts/encrypt.cjs <код-доступа>'); process.exit(1); }

const ctx = {}; vm.createContext(ctx);
vm.runInContext(
  fs.readFileSync(path.join(OUT, 'wb-data.js'), 'utf8') + '\n'
  + fs.readFileSync(path.join(OUT, 'wb-reports.js'), 'utf8') + '\n'
  + 'globalThis.__OUT = {REAL_DATA, BAKED_AT, BAKED_PERIOD, BAKED_FINANCE_ROWS, BAKED_ADS_ROWS, BAKED_FINANCE, BAKED_ADS};',
  ctx
);
const out = ctx.__OUT;
const payload = Buffer.from(JSON.stringify(out), 'utf8');

const salt = crypto.randomBytes(16);
const iv = crypto.randomBytes(12);
const key = crypto.pbkdf2Sync(Buffer.from(pass, 'utf8'), salt, ITER, 32, 'sha256');
const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
const enc = Buffer.concat([cipher.update(payload), cipher.final()]);
const tag = cipher.getAuthTag();
const ct = Buffer.concat([enc, tag]);

const secure = {
  v: 1, alg: 'AES-GCM', kdf: 'PBKDF2-SHA256', hash: 'SHA-256', iter: ITER,
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
const back = JSON.parse(Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8'));
const ok = back.BAKED_FINANCE.length === out.BAKED_FINANCE.length && back.REAL_DATA.catalog.length === out.REAL_DATA.catalog.length;

console.log('wb-secure.js записан:', (js.length / 1024 | 0), 'KB · каталог', out.REAL_DATA.catalog.length,
  '· фин.агрегатов', out.BAKED_FINANCE.length, '· рекл.агрегатов', out.BAKED_ADS.length,
  '· период', out.BAKED_PERIOD, '· roundtrip', ok ? 'OK' : 'FAILED');
if (!ok) process.exit(1);
