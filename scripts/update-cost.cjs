// Обновляет себестоимость в decrypted/wb-data.js из файла продавца.
// Ключ ищется по имени колонки: «Код»/«код поставщика»/«артикул wb» → сопоставляем
// сначала с supplierCode (код 1С), потом с артикулом ВБ. Цена — колонка «себестоимость».
// Числа в файле бывают в «озоновском» формате: запятая = разделитель тысяч, точка = десятичная
// («1,015.09» = 1015.09) — учитываем.
//
// ВАЖНО — история цен. Второй аргумент — дата, С КОТОРОЙ действует новая цена
// (ISO, напр. 2026-07-27). Тогда старая цена не пропадает: у товара появляется
//   costHistory=[{from:null,cost:старая},{from:"2026-07-27",cost:новая}]
// и прибыль каждого дня считается по цене, действовавшей в этот день (см. costAt()
// в index.html) — новая поставка НЕ пересчитывает прошлые недели.
// Без второго аргумента цена просто перезаписывается на всю историю (старое поведение).
//
// Перед запуском: node scripts/decrypt.cjs <код>
// Использование: node scripts/update-cost.cjs <файл.xlsx> [дата-с-которой-действует]
// После: node scripts/encrypt.cjs <код>, затем закоммитить wb-secure.js.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const XLSX = require('./node_modules/xlsx');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'decrypted');
const file = process.argv[2];
const from = process.argv[3] || null;
if (!file) { console.error('usage: node scripts/update-cost.cjs <файл.xlsx> [дата-с (2026-07-27)]'); process.exit(1); }
if (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) { console.error('дата должна быть в формате ГГГГ-ММ-ДД'); process.exit(1); }

const S = v => ('' + (v == null ? '' : v)).replace(/\s+/g, ' ').trim();
// «1,015.09» → 1015.09 · «1015,09» → 1015.09 · «1 015.09» → 1015.09
function num(v) {
  let s = S(v).replace(/[\s ]/g, '');
  if (!s) return null;
  if (s.includes(',') && s.includes('.')) s = s.replace(/,/g, '');        // запятая = тысячи
  else if (s.includes(',')) s = s.replace(',', '.');                       // запятая = десятичная
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

const wb = XLSX.read(fs.readFileSync(file), { type: 'buffer', cellStyles: false, cellFormula: false });
const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' });
const H = (rows[0] || []).map(x => S(x).toLowerCase());
const iKey = H.findIndex(h => /^код$|код поставщика|артикул|^sku$/.test(h));
const iCost = H.findIndex(h => /себестоим|цена|cost/.test(h));
if (iKey < 0 || iCost < 0) { console.error('не нашёл колонки ключа/себестоимости (шапка: ' + H.join(' | ') + ')'); process.exit(1); }
console.log('лист «' + wb.SheetNames[0] + '» · ключ: «' + rows[0][iKey] + '» · цена: «' + rows[0][iCost] + '»');

const ctx = {}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(OUT, 'wb-data.js'), 'utf8') + '\nglobalThis.R = REAL_DATA;', ctx);
const R = ctx.R;
// один код 1С может стоять у НЕСКОЛЬКИХ артикулов ВБ (склейки/варианты) — цену получают все
const bySup = {}, bySku = {};
R.catalog.forEach(c => { bySku['' + c.sku] = [c];
  const s = S(c.supplierCode); if (s) (bySup[s] || (bySup[s] = [])).push(c); });

let filledNew = 0, changed = 0, same = 0, notFound = [], fileRows = 0, badCost = 0;
const changes = [];
for (let i = 1; i < rows.length; i++) {
  const key = S(rows[i][iKey]).replace(/,/g, '');   // «316,807» → «316807»
  if (!key) continue;
  fileRows++;
  const nw = num(rows[i][iCost]);
  if (nw == null || nw <= 0) { badCost++; continue; }
  const targets = bySup[key] || bySku[key];
  if (!targets) { notFound.push(key); continue; }
  for (const c of targets) {
    const old = c.costPrice;
    if (old == null) { filledNew++; c.costPrice = nw; c.costHistory = [{ from: null, cost: nw }]; continue; }
    if (old === nw) { same++; continue; }
    changed++; changes.push({ sku: c.sku, code: key, old, nw, name: (c.name || '').slice(0, 34) });
    if (from) {
      // первая запись истории всегда «с начала времён» со СТАРОЙ ценой — иначе costAt()
      // не найдёт цену для прошлых дат и свалится на текущую (то есть пересчитает прошлое)
      const h = Array.isArray(c.costHistory) && c.costHistory.length ? c.costHistory.slice() : [{ from: null, cost: old }];
      const at = h.findIndex(e => e.from === from);
      if (at >= 0) h[at] = { from, cost: nw }; else h.push({ from, cost: nw });
      h.sort((a, b) => (a.from || '') < (b.from || '') ? -1 : (a.from || '') > (b.from || '') ? 1 : 0);
      c.costHistory = h;
    } else if (Array.isArray(c.costHistory) && c.costHistory.length) {
      c.costHistory = [{ from: null, cost: nw }];   // без даты — переписываем всю историю
    }
    c.costPrice = nw;                                // текущая цена (дозаказ, безубыточность)
  }
}
R.meta.costUpdatedAt = new Date().toISOString().slice(0, 10);
if (from) R.meta.costFrom = from;

console.log('\nстрок в файле: ' + fileRows + ' · без корректной цены: ' + badCost);
console.log('заполнено впервые: ' + filledNew + ' · изменено: ' + changed + ' · без изменений: ' + same
  + ' · ключей не в каталоге: ' + notFound.length);
if (notFound.length) console.log('   не найдены: ' + notFound.slice(0, 20).join(', '));
console.log(from ? ('\nНовая цена действует С ' + from + '; для более ранних дат остаётся прежняя (costHistory).')
                 : '\nЦена перезаписана на ВСЮ историю (дата не задана).');
if (changes.length) {
  const up = changes.filter(c => c.nw > c.old), dn = changes.filter(c => c.nw < c.old);
  const avg = a => a.length ? (a.reduce((s, c) => s + (c.nw - c.old) / c.old, 0) / a.length * 100).toFixed(1) : '0';
  console.log('   подорожало: ' + up.length + ' (в среднем +' + avg(up) + '%) · подешевело: ' + dn.length + ' (в среднем ' + avg(dn) + '%)');
  console.log('\nтоп изменений (было → стало):');
  changes.sort((a, b) => Math.abs(b.nw - b.old) - Math.abs(a.nw - a.old)).slice(0, 15)
    .forEach(c => console.log('   ' + c.sku + ' (1С ' + c.code + ')  ' + c.old + ' → ' + c.nw
      + '  (' + (c.nw - c.old > 0 ? '+' : '') + Math.round(c.nw - c.old) + ')  ' + c.name));
}
const noCost = R.catalog.filter(c => c.costPrice == null);
console.log('\nбез себестоимости в каталоге: ' + noCost.length + ' из ' + R.catalog.length);
const withHist = R.catalog.filter(c => Array.isArray(c.costHistory) && c.costHistory.length > 1);
console.log('товаров с историей цен (2+ периода): ' + withHist.length);

fs.writeFileSync(path.join(OUT, 'wb-data.js'),
  '// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\nconst REAL_DATA = ' + JSON.stringify(R) + ';\n');
console.log('\ndecrypted/wb-data.js обновлён. Далее: node scripts/encrypt.cjs <код>');
