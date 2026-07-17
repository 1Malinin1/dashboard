// Генерирует decrypted/себестоимость-заполнить.xlsx — список товаров без
// costPrice, отсортированный по продажам за снимок (BAKED_FINANCE) убыванием,
// чтобы пользователь заполнял сначала важное. Колонки готовы для обратной
// загрузки через scripts/update-cost.cjs.
//
// Перед запуском: node scripts/decrypt.cjs <код>
// Использование: node scripts/missing-cost-report.cjs
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const XLSX = require('xlsx');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'decrypted');
const ctx = {}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(OUT, 'wb-data.js'), 'utf8') + '\nglobalThis.__C = REAL_DATA.catalog;', ctx);
vm.runInContext(fs.readFileSync(path.join(OUT, 'wb-reports.js'), 'utf8') + '\nglobalThis.__F = BAKED_FINANCE;', ctx);
const catalog = ctx.__C, fin = ctx.__F;

const soldBySku = {};
fin.forEach(r => { const n = (r.qty || 0) - (r.returnsQty || 0); if (n) soldBySku[r.sku] = (soldBySku[r.sku] || 0) + n; });

const missing = catalog.filter(c => c.costPrice == null)
  .map(c => ({ sku: c.sku, name: c.name, category: c.category, sold: soldBySku[c.sku] || 0 }))
  .sort((a, b) => b.sold - a.sold);

console.log('без себестоимости:', missing.length, 'из', catalog.length, '| с продажами по снимку:', missing.filter(m => m.sold > 0).length);

const header = ['Артикул WB', 'Название', 'Категория', 'Продано (нетто) по снимку', 'Себестоимость за шт'];
const rows = [header, ...missing.map(m => [m.sku, m.name, m.category, m.sold, ''])];
const ws = XLSX.utils.aoa_to_sheet(rows);
ws['!cols'] = [{ wch: 14 }, { wch: 46 }, { wch: 20 }, { wch: 22 }, { wch: 18 }];
const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, 'Себестоимость');
const outFile = path.join(OUT, 'себестоимость-заполнить.xlsx');
XLSX.writeFile(wb, outFile);
console.log('файл записан:', outFile);
