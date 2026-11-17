// ЦЕНЫ В ВЫГРУЗКЕ РЕПРАЙСЕРА (Indypa) ПО ОПТОВОЙ — ЦЕНА-11, 17.11.2026.
//
// От оптовой цены W (файл продавца «Оптовые цены»: колонки «Код», «Оптовая цена»):
//   ВБ   — «Цена до скидки (настр.) (PriceBeforeDiscount)» = 4·W · «Мин. цена, ₽ (MinPrice)» = 1,2·W (скидка 70%)
//          · «Базовая цена (МаксРЦ), ₽ (MaxPrice)» = 1,6·W (скидка 60%);
//   Ozon — ТОЛЬКО «Цена до скидки (настройка), ₽ (MaxMarginAmount)» = 4·W; вилку «Мин. цена» / «Базовая цена» не трогаем.
// Строки без оптовой цены не трогаем (товара нет нигде — проверено 17.11). Флаги («Запретить/Разрешить отправку цен»,
// стратегия, план заказов, себестоимость-заглушка 100) не трогаем — это решения продавца.
//
// Как правится файл: ТОЛЬКО ячейки этих колонок в XML первого листа («Отчет»), остальное — байт в байт (тот же способ,
// что в repricer-plan.cjs). Выгрузка репрайсера — «позиционная» (`<x:row>` без адресов ячеек), поддержан и формат
// с адресами (файл, пересохранённый Excel). После записи — сверка: изменились ровно нужные ячейки, остальные совпадают.
//
//   node scripts/repricer-prices.cjs <оптовые.xlsx> <выгрузка репрайсера.xlsx> [папка_для_результата] [--record --date ГГГГ-ММ-ДД]
// --record: записать «было/стало» по каждому коду в снимок (`meta.priceChanges[дата].wb|oz`) — по нему следит price-watch.cjs.
// Запись — по ИСХОДНОЙ выгрузке (до правки), чтобы «было» было настоящим.
// Пишет <папка>/<ВБ|Ozon>_цены_репрайсер_ДД.ММ.ГГГГ.xlsx (грузить в репрайсер) и …_было_стало_….xlsx (посмотреть).
'use strict';
const fs = require('fs'), path = require('path');
const XLSX = require('./node_modules/xlsx');
const CFB = XLSX.CFB;

const argv = process.argv.slice(2);
const RECORD = argv.includes('--record'); const dIdx = argv.indexOf('--date'); const REC_DATE = dIdx >= 0 ? argv[dIdx + 1] : new Date().toISOString().slice(0, 10);
const [optFile, srcFile, outDirArg] = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--date');
if (!optFile || !srcFile) { console.error('usage: node scripts/repricer-prices.cjs <оптовые.xlsx> <выгрузка репрайсера.xlsx> [папка]'); process.exit(1); }
const outDir = outDirArg || path.dirname(srcFile);
const S = v => (v == null ? '' : ('' + v)).replace(/\s/g, '');

// 1) оптовые
const optRows = XLSX.utils.sheet_to_json(XLSX.readFile(optFile).Sheets[XLSX.readFile(optFile).SheetNames[0]], { header: 1, defval: '' });
const oh = optRows.findIndex(r => r.some(x => /^код$/i.test(('' + x).trim())));
if (oh < 0) throw new Error('в файле оптовых нет колонки «Код»');
const oiCode = optRows[oh].findIndex(x => /^код$/i.test(('' + x).trim())), oiW = optRows[oh].findIndex(x => /оптов/i.test('' + x));
const W = {};
optRows.slice(oh + 1).forEach(r => { const k = S(r[oiCode]); const v = +S(r[oiW]).replace(',', '.'); if (k && v > 0) W[k] = v; });

// 2) выгрузка
const wbk = XLSX.readFile(srcFile);
const sheetName = wbk.SheetNames[0];
const rows = XLSX.utils.sheet_to_json(wbk.Sheets[sheetName], { header: 1, defval: '' });
const H = rows[0].map(x => '' + x);
const col = code => H.findIndex(h => h.includes('(' + code + ')'));
let MP, iKey, targets;
if (col('SupplierArticle') >= 0 && col('PriceBeforeDiscount') >= 0) {
  MP = 'ВБ'; iKey = col('SupplierArticle');
  targets = [['PriceBeforeDiscount', w => 4 * w], ['MinPrice', w => 1.2 * w], ['MaxPrice', w => 1.6 * w]];
} else if (col('OfferId') >= 0 && col('MaxMarginAmount') >= 0) {
  MP = 'Ozon'; iKey = col('OfferId');
  targets = [['MaxMarginAmount', w => 4 * w]];
} else throw new Error('не узнал выгрузку: нет колонок ВБ (SupplierArticle/PriceBeforeDiscount) и Ozon (OfferId/MaxMarginAmount)');
targets = targets.map(([code, f]) => { const i = col(code); if (i < 0) throw new Error('нет колонки (' + code + ')'); return { code, i, f, name: H[i] }; });
// целые рубли: оптовые кратны 10 → 1,2·W и 1,6·W целые; иначе — отказ (продавец: цена должна быть «круглой»)
const round = v => { const r = Math.round(v); if (Math.abs(r - v) > 1e-9) throw new Error('не целая цена ' + v + ' — оптовая не кратна 5?'); return r; };

const changes = [];   // {row (1-based, как в Excel), ci, was, now, key}
let rowsWith = 0, rowsWithout = 0;
rows.slice(1).forEach((r, k) => {
  const key = S(r[iKey]); const w = W[key];
  if (!w) { rowsWithout++; return; }
  rowsWith++;
  targets.forEach(t => { const now = round(t.f(w)); const was = r[t.i];
    if (+was !== now) changes.push({ row: k + 2, ci: t.i, was, now, key, w, col: t.name }); });
});

// 3) правка XML листа
const z = CFB.read(fs.readFileSync(srcFile), { type: 'buffer' });
const ent = CFB.find(z, '/xl/worksheets/sheet1.xml');
let xml = Buffer.from(ent.content).toString('utf8');
const positional = !/<(?:\w+:)?c\s+r="/.test(xml);
const pre = (xml.match(/<(\w+:)?row\b/) || [])[1] || '';
const want = {}; changes.forEach(c => { (want[c.row] || (want[c.row] = {}))[c.ci] = c.now; });
if (positional) {
  const rowRe = new RegExp(`<${pre}row\\b[^>]*>[\\s\\S]*?</${pre}row>`, 'g');
  const cellRe = new RegExp(`<${pre}c\\b[^>]*?(?:/>|>[\\s\\S]*?</${pre}c>)`, 'g');
  const nRows = (xml.match(rowRe) || []).length;
  if (nRows !== rows.length) throw new Error('строк в XML ' + nRows + ', а прочитано ' + rows.length + ' — формат другой, правку не делаю');
  let ri = 0;
  xml = xml.replace(rowRe, row => { ri++; const w = want[ri]; if (!w) return row;
    let ci = -1; const hit = new Set();
    const out = row.replace(cellRe, c => { ci++; if (!(ci in w)) return c; hit.add(ci);
      const st = (c.match(/ s="\d+"/) || [''])[0]; return `<${pre}c t="n"${st}><${pre}v>${w[ci]}</${pre}v></${pre}c>`; });
    Object.keys(w).forEach(c => { if (!hit.has(+c)) throw new Error('в строке ' + ri + ' нет ячейки №' + (+c + 1)); });
    return out; });
} else {
  changes.forEach(c => {
    const ref = XLSX.utils.encode_col(c.ci) + c.row;
    const re = new RegExp(`<${pre}c r="${ref}"([^>]*?)(?:/>|>[\\s\\S]*?</${pre}c>)`);
    const m = xml.match(re); if (!m) throw new Error('нет ячейки ' + ref + ' (пустые ячейки в формате с адресами не дописываю)');
    const st = (m[1].match(/ s="\d+"/) || [''])[0];
    xml = xml.replace(re, `<${pre}c r="${ref}"${st}><${pre}v>${c.now}</${pre}v></${pre}c>`);
  });
}
ent.content = Buffer.from(xml, 'utf8');
const dt = new Date().toISOString().slice(0, 10).split('-').reverse().join('.');
fs.mkdirSync(outDir, { recursive: true });
const outFile = path.join(outDir, `${MP}_цены_репрайсер_${dt}.xlsx`);
fs.writeFileSync(outFile, CFB.write(z, { type: 'buffer', fileType: 'zip', compression: true }));

// 4) сверка: изменились ровно нужные ячейки; остальные листы — байт в байт
const back = XLSX.utils.sheet_to_json(XLSX.readFile(outFile).Sheets[sheetName], { header: 1, defval: '' });
if (back.length !== rows.length) throw new Error('после записи другое число строк');
const chg = new Map(changes.map(c => [c.row + ':' + c.ci, c.now]));
let diffs = 0;
rows.forEach((r, k) => { const b = back[k] || []; const n = Math.max(r.length, b.length);
  for (let i = 0; i < n; i++) { const key = (k + 1) + ':' + i;
    if (chg.has(key)) { if (+b[i] !== chg.get(key)) throw new Error('ячейка ' + XLSX.utils.encode_col(i) + (k + 1) + ' не записалась'); }
    else if (String(r[i] ?? '') !== String(b[i] ?? '')) { diffs++; if (diffs < 5) console.error('лишнее изменение', XLSX.utils.encode_col(i) + (k + 1), r[i], '→', b[i]); } } });
if (diffs) throw new Error('изменились лишние ячейки: ' + diffs);
const z2 = CFB.read(fs.readFileSync(outFile), { type: 'buffer' });
z.FullPaths.forEach((p, i) => { if (z.FileIndex[i].type !== 2 || /sheet1\.xml$/.test(p)) return;
  const e2 = CFB.find(z2, p.replace(/^[^/]*\//, '/')); if (!e2 || Buffer.compare(Buffer.from(z.FileIndex[i].content), Buffer.from(e2.content)) !== 0) throw new Error('изменилась часть ' + p); });

// 5) было → стало: по каждой изменённой строке — все целевые колонки (было/стало), по коду 1С
const rep = [];
const touched = [...new Set(changes.map(c => c.row))];
touched.forEach(rw => { const r = rows[rw - 1]; const key = S(r[iKey]); const w = W[key];
  const o = { 'Код 1С': +key || key, 'Оптовая, ₽': w };
  targets.forEach(t => { const short = t.name.replace(/\s*\([^)]*\)\s*$/, '').trim(); const was = r[t.i];
    o[short + ' — было'] = was === '' ? 'пусто' : Math.round(+was * 100) / 100; o[short + ' — стало'] = round(t.f(w)); });
  rep.push(o); });
rep.sort((a, b) => String(a['Код 1С']).localeCompare(String(b['Код 1С'])));
const repFile = path.join(outDir, `${MP}_цены_было_стало_${dt}.xlsx`);
const wb2 = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb2, XLSX.utils.json_to_sheet(rep), 'было → стало'); XLSX.writeFile(wb2, repFile);

console.log(MP + ': строк ' + (rows.length - 1) + ' · с оптовой ' + rowsWith + ' · без оптовой (не трогал) ' + rowsWithout);
targets.forEach(t => { const cs = changes.filter(c => c.ci === t.i);
  console.log('  ' + XLSX.utils.encode_col(t.i) + ' «' + t.name + '»: изменено ' + cs.length + (cs.length ? ' (вверх ' + cs.filter(c => c.now > +c.was).length + ', вниз ' + cs.filter(c => c.now < +c.was).length + ')' : '')); });
console.log('  сверка: изменились только эти ячейки, остальные листы байт в байт ✓');
console.log('  → ' + outFile + '\n  → ' + repFile);

if (RECORD) {
  const vm = require('vm'); const dataFile = path.join(__dirname, '..', 'decrypted', 'wb-data.js');
  const txt = fs.readFileSync(dataFile, 'utf8'); const ctx = {}; vm.createContext(ctx);
  vm.runInContext(txt + '\nglobalThis.__RD=REAL_DATA;', ctx); const RD = ctx.__RD;
  RD.meta = RD.meta || {}; RD.meta.priceChanges = RD.meta.priceChanges || {};
  const rec = RD.meta.priceChanges[REC_DATE] || (RD.meta.priceChanges[REC_DATE] = { date: REC_DATE, rule: 'ЦЕНА-11', createdAt: new Date().toISOString() });
  const num = v => (v === '' || v == null) ? null : Math.round(+v * 100) / 100;
  const byCode = {};
  rows.slice(1).forEach(r => { const key = S(r[iKey]); const w = W[key]; if (!w) return;
    const o = { W: w, old: {}, new: {} };
    targets.forEach(t => { o.old[t.code] = num(r[t.i]); o.new[t.code] = round(t.f(w)); });
    const extra = MP === 'ВБ' ? { nm: S(r[col('SupSku')]), disabled: num(r[col('Disabled')]), strategy: S(r[col('StrategyId')]), plan: num(r[col('OrdersPlanQty')]) }
      : { sku: S(r[col('CurrentSku')]), min: num(r[col('RecommendedRetailPrice')]), base: num(r[col('MaxPrice')]), reprice: num(r[col('Reprice')]), strategy: S(r[col('StrategyId')]) };
    byCode[key] = Object.assign(o, extra); });
  rec[MP === 'ВБ' ? 'wb' : 'oz'] = { file: path.basename(srcFile), rows: rows.length - 1, byCode };
  const head = txt.slice(0, txt.indexOf('const REAL_DATA'));
  fs.writeFileSync(dataFile, head + 'const REAL_DATA = ' + JSON.stringify(RD) + ';\n');
  console.log('  записано в снимок: meta.priceChanges[' + REC_DATE + '].' + (MP === 'ВБ' ? 'wb' : 'oz') + ' · кодов ' + Object.keys(byCode).length + ' (дальше: encrypt.cjs)');
}
