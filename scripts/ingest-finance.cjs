// Разбирает .xlsx отчёты WB (реализация и/или реклама) и накапливает построчные
// записи в decrypted/acc-finance.json / acc-ads.json с дедупом по отпечатку строки.
// Автоопределяет тип файла (сначала пробует как «реализацию», потом как «рекламу»).
// Требует decrypted/wb-data.js (запустите scripts/decrypt.cjs) — оттуда берётся
// список артикулов продавца, чтобы отбирать только свои строки из общих выгрузок.
//
// Использование: node scripts/ingest-finance.cjs файл1.xlsx файл2.xlsx ...
// Можно вызывать много раз по мере поступления файлов — накопитель не обнуляется.
// Когда все файлы недели собраны — прогнать scripts/bake-snapshot.cjs.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const XLSX = require('xlsx');
const { parseFinanceSheet, parseAdsSheet } = require('./lib/parse-wb.cjs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'decrypted');
const files = process.argv.slice(2);
if (!files.length) { console.error('usage: node scripts/ingest-finance.cjs <файл1.xlsx> [файл2.xlsx ...]'); process.exit(1); }

const ctx = {}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(OUT, 'wb-data.js'), 'utf8') + '\nglobalThis.__C = REAL_DATA.catalog.map(c=>c.sku);', ctx);
const catalogSkuSet = new Set(ctx.__C);

function load(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return {}; } }
const finFile = path.join(OUT, 'acc-finance.json'), adsFile = path.join(OUT, 'acc-ads.json');
const accFin = load(finFile), accAds = load(adsFile);

for (const f of files) {
  const buf = fs.readFileSync(f);
  const wb = XLSX.read(buf, { type: 'buffer', cellStyles: false, cellHTML: false, cellFormula: false, sheetStubs: false, bookVBA: false });
  const base = path.basename(f).slice(0, 50);

  let res = parseFinanceSheet(XLSX, wb, catalogSkuSet), kind = 'finance';
  if (!res) { res = parseAdsSheet(XLSX, wb, catalogSkuSet); kind = 'ads'; }
  if (!res) { console.log(`ПРОПУСК ${base}: не похож ни на отчёт о реализации, ни на «Историю затрат» (листы: ${wb.SheetNames.join(', ')})`); continue; }

  const acc = kind === 'finance' ? accFin : accAds;
  let nw = 0, dup = 0; const dates = new Set();
  for (const rec of res.records) {
    if (acc[rec.id] !== undefined) dup++; else nw++;
    acc[rec.id] = rec;
    if (rec.date) dates.add(rec.date);
  }
  const ds = [...dates].sort();
  let extra = '';
  if (kind === 'ads') {
    const spend = res.records.reduce((a, r) => a + r.spend, 0);
    extra = ` · расход ${Math.round(spend).toLocaleString('ru-RU')} ₽, ${new Set(res.records.map(r => r.sku)).size} арт.`;
  }
  console.log(`[${kind}] ${base} · период ${ds[0] || '?'}–${ds[ds.length - 1] || '?'} · наши ${res.matched}/${res.total} строк${extra} · новых ${nw}, уже было ${dup}`);
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(finFile, JSON.stringify(accFin));
fs.writeFileSync(adsFile, JSON.stringify(accAds));
const finDates = [...new Set(Object.values(accFin).filter(r => r.date).map(r => r.date))].sort();
const adsDates = [...new Set(Object.values(accAds).filter(r => r.date).map(r => r.date))].sort();
console.log(`\nИТОГО в накопителе: финансы ${Object.keys(accFin).length} строк (${finDates[0] || '?'}–${finDates[finDates.length - 1] || '?'})`
  + ` · реклама ${Object.keys(accAds).length} строк (${adsDates[0] || '?'}–${adsDates[adsDates.length - 1] || '?'})`);
