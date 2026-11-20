// ТОЧЕЧНАЯ ПРАВКА ВЫГРУЗКИ INDEEPA (20.11.2026): поставить значения в названные ячейки «код × колонка», остальное — байт в байт.
// Зачем: продавец заводит новинки руками, а проверка находит 2–3 ошибки (не та стратегия, цены соседнего товара, пустой план) —
// пересобирать весь файл ради них нельзя (перетрёт то, что он менял после выгрузки, и недельный план, ЗАП-25).
//
//   node scripts/indeepa-set.cjs <выгрузка.xlsx> <результат.xlsx> "520308:StrategyId=4782; 520308:MaxMarginAmount=4800; 512174:OrdersPlanQty=8"
// Колонка — код в скобках из шапки Indeepa (StrategyId, OrdersPlanQty, PriceBeforeDiscount, MinPrice, MaxPrice, MaxMarginAmount,
// RecommendedRetailPrice, Reprice, Disabled…). Ключ строки — SupplierArticle (ВБ) или OfferId (Ozon). Код, которого нет, — СТОП.
// После записи — сверка чтением: изменились ровно эти ячейки, остальные листы файла не тронуты.
'use strict';
const fs = require('fs');
const XLSX = require('./node_modules/xlsx');
const CFB = XLSX.CFB;
const [src, out, spec] = process.argv.slice(2);
if (!src || !out || !spec) { console.error('usage: node scripts/indeepa-set.cjs <выгрузка.xlsx> <результат.xlsx> "код:Колонка=значение; …"'); process.exit(1); }
const S = v => (v == null ? '' : '' + v).replace(/\s/g, '');
const wbk = XLSX.readFile(src); const sheet = wbk.SheetNames[0];
const rows = XLSX.utils.sheet_to_json(wbk.Sheets[sheet], { header: 1, defval: '' });
const H = rows[0].map(String); const col = c => H.findIndex(h => h.includes('(' + c + ')'));
const iKey = col('SupplierArticle') >= 0 ? col('SupplierArticle') : col('OfferId');
if (iKey < 0) throw new Error('нет колонки SupplierArticle/OfferId');
const want = {}, list = [];
spec.split(/[;\n]+/).map(s => s.trim()).filter(Boolean).forEach(p => {
  const m = p.match(/^(\d+)\s*:\s*(\w+)\s*=\s*(-?[\d.]+)$/); if (!m) throw new Error('не понял «' + p + '»');
  const ci = col(m[2]); if (ci < 0) throw new Error('нет колонки (' + m[2] + ')');
  const ri = rows.findIndex((r, k) => k > 0 && S(r[iKey]) === m[1]); if (ri < 0) throw new Error('нет строки с кодом ' + m[1]);
  if (rows.filter((r, k) => k > 0 && S(r[iKey]) === m[1]).length > 1) throw new Error('код ' + m[1] + ' встречается больше одного раза');
  (want[ri + 1] || (want[ri + 1] = {}))[ci] = +m[3]; list.push({ row: ri + 1, ci, code: m[1], col: m[2], was: rows[ri][ci], now: +m[3] });
});
const z = CFB.read(fs.readFileSync(src), { type: 'buffer' }); const ent = CFB.find(z, '/xl/worksheets/sheet1.xml');
let xml = Buffer.from(ent.content).toString('utf8');
if (/<(?:\w+:)?c\s+r="/.test(xml)) throw new Error('формат с адресами ячеек — не поддержан, правку не делаю');
const pre = (xml.match(/<(\w+:)?row\b/) || [])[1] || '';
const rowRe = new RegExp(`<${pre}row\\b[^>]*>[\\s\\S]*?</${pre}row>`, 'g'), cellRe = new RegExp(`<${pre}c\\b[^>]*?(?:/>|>[\\s\\S]*?</${pre}c>)`, 'g');
if ((xml.match(rowRe) || []).length !== rows.length) throw new Error('строк в XML не столько, сколько прочитано — правку не делаю');
let ri = 0;
xml = xml.replace(rowRe, row => { ri++; const w = want[ri]; if (!w) return row; let ci = -1; const hit = new Set();
  const o = row.replace(cellRe, c => { ci++; if (!(ci in w)) return c; hit.add(ci); const st = (c.match(/ s="\d+"/) || [''])[0];
    return `<${pre}c t="n"${st}><${pre}v>${w[ci]}</${pre}v></${pre}c>`; });
  Object.keys(w).forEach(c => { if (!hit.has(+c)) throw new Error('в строке ' + ri + ' нет ячейки №' + (+c + 1)); }); return o; });
ent.content = Buffer.from(xml, 'utf8');
fs.writeFileSync(out, CFB.write(z, { type: 'buffer', fileType: 'zip', compression: true }));
// сверка
const back = XLSX.utils.sheet_to_json(XLSX.readFile(out).Sheets[sheet], { header: 1, defval: '' });
const chg = new Map(list.map(c => [c.row + ':' + c.ci, c.now])); let diffs = 0;
rows.forEach((r, k) => { const b = back[k] || []; for (let i = 0; i < Math.max(r.length, b.length); i++) { const key = (k + 1) + ':' + i;
  if (chg.has(key)) { if (+b[i] !== chg.get(key)) throw new Error('ячейка не записалась: строка ' + (k + 1)); }
  else if (String(r[i] ?? '') !== String(b[i] ?? '')) diffs++; } });
if (diffs) throw new Error('изменились лишние ячейки: ' + diffs);
const z2 = CFB.read(fs.readFileSync(out), { type: 'buffer' });
z.FullPaths.forEach((p, i) => { if (z.FileIndex[i].type !== 2 || /sheet1\.xml$/.test(p)) return; const e2 = CFB.find(z2, p.replace(/^[^/]*\//, '/'));
  if (!e2 || Buffer.compare(Buffer.from(z.FileIndex[i].content), Buffer.from(e2.content)) !== 0) throw new Error('изменилась часть ' + p); });
list.forEach(c => console.log('  ' + c.code + ' · ' + c.col + ': ' + (S(c.was) || 'пусто') + ' → ' + c.now));
console.log('сверка: изменились только эти ' + list.length + ' ячеек, остальное байт в байт ✓ → ' + out);
