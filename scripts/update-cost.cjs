// Обновляет costPrice в decrypted/wb-data.js из файла себестоимости
// (колонки «Артикул wb» / «себестоимость», см. parseCostSheet). Не трогает
// цены товаров, которых нет в файле. Печатает, что заполнено впервые и что
// изменилось (для отчёта пользователю о новой поставке/пересчёте).
//
// Перед запуском: node scripts/decrypt.cjs <код>
// Использование: node scripts/update-cost.cjs себестоимость.xlsx
// После: node scripts/encrypt.cjs <код>, затем закоммитить wb-secure.js.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const XLSX = require('xlsx');
const { parseCostSheet } = require('./lib/parse-wb.cjs');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'decrypted');
const file = process.argv[2];
if (!file) { console.error('usage: node scripts/update-cost.cjs <файл-себестоимости.xlsx>'); process.exit(1); }

const wb = XLSX.read(fs.readFileSync(file), { type: 'buffer', cellStyles: false, cellFormula: false, bookVBA: false, sheetStubs: false });
const res = parseCostSheet(XLSX, wb);
if (!res) { console.error('Не нашёл колонки «Артикул»/«себестоимость» в файле.'); process.exit(1); }
console.log('в файле валидных цен:', Object.keys(res.costMap).length, 'из', res.total, 'строк');

const dataPath = path.join(OUT, 'wb-data.js');
const ctx = {}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(dataPath, 'utf8') + '\nglobalThis.R = REAL_DATA;', ctx);
const R = ctx.R;
const catBySku = {}; R.catalog.forEach(c => catBySku[c.sku] = c);

let filledNew = 0, changed = 0, same = 0, notInCat = 0;
const changes = [], notFound = [];
for (const sku in res.costMap) {
  const c = catBySku[sku];
  if (!c) { notInCat++; notFound.push(sku); continue; }
  const old = c.costPrice, nw = res.costMap[sku];
  if (old == null) { filledNew++; c.costPrice = nw; }
  else if (old !== nw) { changed++; changes.push({ sku, old, nw, name: (c.name || '').slice(0, 32) }); c.costPrice = nw; }
  else same++;
}
R.meta.costUpdatedAt = new Date().toISOString().slice(0, 10);

console.log('заполнено впервые:', filledNew, '| изменено:', changed, '| без изменений:', same, '| из файла не в каталоге:', notInCat);
const stillMissing = R.catalog.filter(c => c.costPrice == null);
console.log('ещё БЕЗ себестоимости в каталоге:', stillMissing.length);
if (stillMissing.length) console.log('  ', stillMissing.slice(0, 15).map(c => c.sku + ' ' + (c.name || '').slice(0, 24)).join(' | '));
if (changes.length) {
  console.log('\nизменения цены (было → стало), сортировка по размеру изменения:');
  changes.sort((a, b) => Math.abs(b.nw - b.old) - Math.abs(a.nw - a.old)).slice(0, 20)
    .forEach(c => console.log('  ' + c.sku + '  ' + c.old + ' → ' + c.nw + '  (' + (c.nw - c.old > 0 ? '+' : '') + (c.nw - c.old) + ')  ' + c.name));
}
if (notFound.length) console.log('\nартикулы из файла НЕ в каталоге (новые товары? проверьте):', notFound.slice(0, 20).join(', '));

fs.writeFileSync(dataPath, '// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\nconst REAL_DATA = ' + JSON.stringify(R) + ';\n');
console.log('\ndecrypted/wb-data.js обновлён. С себестоимостью:', R.catalog.filter(c => c.costPrice != null).length, 'из', R.catalog.length);
console.log('Далее: node scripts/encrypt.cjs <код>, затем git add wb-secure.js && git commit && git push.');
