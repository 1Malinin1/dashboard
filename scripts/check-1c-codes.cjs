// СВЕРКА КОДОВ 1С С КАБИНЕТАМИ (17.11.2026) — несостыковки отдаём продавцу, он правит в 1С.
//
// ЗАЧЕМ. 17.11.2026 в ведомости 1С у 519398 и 519406 стоял ОДИН «Код Wildberries» 2144987049, хотя у 519398 на ВБ —
// 2144885006. Такая ошибка в 1С не ломает загрузку остатков (они идут по коду 1С), но ломает всё, что связывает код
// с карточкой: заведение новинок (new-codes check перезаписал верный артикул неверным), подсорт, рекламу.
// Продавец (17.11): «если видишь какие-то несостыковки — скидывай мне их, будем исправлять».
//
// ИСТИНА — сами кабинеты: каталог ВБ снимка (supplierCode → артикул ВБ), каталог Ozon снимка (код → SKU Ozon) и, если
// переданы, сырые отчёты площадок: отчёт остатков ВБ / воронка ВБ («Артикул продавца» + «Артикул WB»), остатки и
// заказы Ozon («Артикул» + «SKU»). 1С сверяется с ними, а не наоборот.
//
//   node scripts/check-1c-codes.cjs <ведомость 1С.xlsx> [отчёты ВБ/Ozon …]
// Вызывается сам в конце update-warehouse.cjs stock (только по снимку). Ничего не меняет.
'use strict';
const fs = require('fs'), vm = require('vm'), path = require('path');
const XLSX = require('./node_modules/xlsx');
const S = v => (v == null ? '' : ('' + v)).replace(/\s/g, '');

function readRows(f) {
  if (f.toLowerCase().endsWith('.csv')) {
    const t = fs.readFileSync(f, 'utf8'); const sep = t.split(/\r?\n/)[0].split(';').length > 2 ? ';' : ',';
    return [{ name: path.basename(f), rows: XLSX.utils.sheet_to_json(XLSX.read(t, { type: 'string', FS: sep, raw: true }).Sheets.Sheet1, { header: 1, defval: '' }) }];
  }
  const wb = XLSX.read(fs.readFileSync(f), { type: 'buffer', cellStyles: false, cellFormula: false, sheetRows: 60000 });
  return wb.SheetNames.map(n => ({ name: n, rows: XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1, defval: '' }) }));
}

// истина из сырых отчётов площадок: код → Set(артикул ВБ), код → Set(SKU Ozon)
function truthFromFiles(files) {
  const wb = {}, oz = {};
  const add = (m, k, v) => { if (!k || !v || !/^\d{5,}$/.test(v)) return; (m[k] || (m[k] = new Set())).add(v); };
  files.forEach(f => { let sheets; try { sheets = readRows(f); } catch (e) { console.log('  ' + path.basename(f) + ' — не прочитан: ' + e.message); return; }
    sheets.forEach(sh => {
      const hi = sh.rows.slice(0, 15).findIndex(r => r.some(x => /артикул/i.test('' + x))); if (hi < 0) return;
      const H = sh.rows[hi].map(x => ('' + x).trim());
      const iSup = H.findIndex(x => /^артикул\s*продавца$/i.test(x)), iWb = H.findIndex(x => /^артикул\s*wb$/i.test(x));
      const iArt = H.findIndex(x => /^артикул$/i.test(x)), iSku = H.findIndex(x => /^sku$/i.test(x));
      sh.rows.slice(hi + 1).forEach(r => {
        if (iSup >= 0 && iWb >= 0) add(wb, S(r[iSup]), S(r[iWb]));
        if (iArt >= 0 && iSku >= 0) add(oz, S(r[iArt]), S(r[iSku]));
      });
    }); });
  return { wb, oz };
}

function check(RD, file1c, truthFiles) {
  const out = [];
  // 1С: код · Код Ozon · Код Wildberries
  const rows = XLSX.utils.sheet_to_json(XLSX.read(fs.readFileSync(file1c), { type: 'buffer' }).Sheets[XLSX.read(fs.readFileSync(file1c), { type: 'buffer', bookSheets: true }).SheetNames[0]], { header: 1, defval: '' });
  const hi = rows.slice(0, 10).findIndex(r => r.some(x => /^код$/i.test(('' + x).trim()))); if (hi < 0) return ['не нашёл шапку с колонкой «Код» в ' + path.basename(file1c)];
  const H = rows[hi].map(x => ('' + x).trim());
  const iCode = H.findIndex(x => /^код$/i.test(x)), iOz = H.findIndex(x => /^код\s*ozon/i.test(x)), iWb = H.findIndex(x => /^код\s*wildberries/i.test(x)), iName = H.findIndex(x => /номенклатура/i.test(x));
  const c1 = {};
  rows.slice(hi + 1).forEach(r => { const k = S(r[iCode]); if (!/^\d{5,7}$/.test(k)) return;
    c1[k] = { wb: iWb >= 0 ? S(r[iWb]) : '', oz: iOz >= 0 ? S(r[iOz]) : '', name: iName >= 0 ? ('' + r[iName]).trim() : '' }; });

  // истина: снимок + сырые отчёты
  const tWb = {}, tOz = {}, wbOwner = {}, ozOwner = {};
  const addT = (m, own, k, v) => { if (!k || !v) return; (m[k] || (m[k] = new Set())).add(v); (own[v] || (own[v] = new Set())).add(k); };
  (RD.catalog || []).forEach(c => addT(tWb, wbOwner, S(c.supplierCode), S(c.sku)));
  ((RD.ozon && RD.ozon.catalog) || []).forEach(c => { if (c.ozonSku) addT(tOz, ozOwner, S(c.sku), S(c.ozonSku)); });
  if (truthFiles && truthFiles.length) { const t = truthFromFiles(truthFiles);
    Object.entries(t.wb).forEach(([k, s]) => s.forEach(v => addT(tWb, wbOwner, k, v)));
    Object.entries(t.oz).forEach(([k, s]) => s.forEach(v => addT(tOz, ozOwner, k, v))); }

  const nm = k => (c1[k] && c1[k].name ? ' — ' + c1[k].name.slice(0, 45) : '');
  const dupWb = {}, dupOz = {};
  Object.entries(c1).forEach(([k, v]) => { if (v.wb) (dupWb[v.wb] || (dupWb[v.wb] = [])).push(k); if (v.oz) (dupOz[v.oz] || (dupOz[v.oz] = [])).push(k); });
  const L = [];
  Object.entries(dupWb).filter(([, ks]) => ks.length > 1).forEach(([v, ks]) => {
    const real = [...(wbOwner[v] || [])].filter(x => /^\d{5,7}$/.test(x)); L.push('ВБ: один «Код Wildberries» ' + v + ' у кодов 1С ' + ks.join(' и ') + (real.length ? ' — на ВБ он у ' + real.join(', ') : '')
      + ks.filter(k => !real.includes(k)).map(k => (tWb[k] ? '; у ' + k + ' на ВБ ' + [...tWb[k]].join('/') : '')).join('')); });
  Object.entries(dupOz).filter(([, ks]) => ks.length > 1).forEach(([v, ks]) => {
    const real = [...(ozOwner[v] || [])].filter(x => /^\d{5,7}$/.test(x)); L.push('Ozon: один «Код Ozon» ' + v + ' у кодов 1С ' + ks.join(' и ') + (real.length ? ' — на Ozon он у ' + real.join(', ') : '')); });
  Object.entries(c1).forEach(([k, v]) => {
    if (v.wb && !(dupWb[v.wb].length > 1)) {
      // владелец — только код вида 1С (5–7 цифр): у части карточек ВБ «артикул продавца» заводской («661-014WBкрасный»), это не ошибка 1С
      const own = [...(wbOwner[v.wb] || [])].filter(x => x !== k && /^\d{5,7}$/.test(x) && !(tWb[k] && tWb[k].has(v.wb)));
      if (own.length) L.push('ВБ: у ' + k + ' в 1С «Код Wildberries» ' + v.wb + ', но на ВБ это карточка кода ' + own.join(', ') + (tWb[k] ? '; у ' + k + ' на ВБ ' + [...tWb[k]].join('/') : '') + nm(k));
      else if (tWb[k] && !tWb[k].has(v.wb)) L.push('ВБ: у ' + k + ' в 1С «Код Wildberries» ' + v.wb + ', а на ВБ у него ' + [...tWb[k]].join('/') + nm(k));
    }
    if (v.oz && !(dupOz[v.oz].length > 1)) {
      const own = [...(ozOwner[v.oz] || [])].filter(x => x !== k && /^\d{5,7}$/.test(x) && !(tOz[k] && tOz[k].has(v.oz)));
      if (own.length) L.push('Ozon: у ' + k + ' в 1С «Код Ozon» ' + v.oz + ', но на Ozon это SKU кода ' + own.join(', ') + (tOz[k] ? '; у ' + k + ' на Ozon ' + [...tOz[k]].join('/') : '') + nm(k));
      else if (tOz[k] && !tOz[k].has(v.oz)) L.push('Ozon: у ' + k + ' в 1С «Код Ozon» ' + v.oz + ', а на Ozon у него SKU ' + [...tOz[k]].join('/') + nm(k));
    }
  });
  const empty = Object.entries(c1).filter(([k, v]) => (!v.wb && tWb[k]) || (!v.oz && tOz[k])).map(([k, v]) =>
    k + ': не заполнено ' + [(!v.wb && tWb[k]) ? '«Код Wildberries» (на ВБ ' + [...tWb[k]].join('/') + ')' : '', (!v.oz && tOz[k]) ? '«Код Ozon» (на Ozon ' + [...tOz[k]].join('/') + ')' : ''].filter(Boolean).join(', ') + nm(k));
  return { wrong: L, empty, codes: Object.keys(c1).length };
}

module.exports = check;

if (require.main === module) {
  const files = process.argv.slice(2); if (!files.length) { console.error('usage: node scripts/check-1c-codes.cjs <ведомость 1С.xlsx> [отчёты ВБ/Ozon …]'); process.exit(1); }
  const ctx = {}; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'decrypted', 'wb-data.js'), 'utf8') + '\nglobalThis.__RD=REAL_DATA;', ctx);
  const r = check(ctx.__RD, files[0], files.slice(1));
  if (Array.isArray(r)) { console.log(r.join('\n')); process.exit(1); }
  console.log('СВЕРКА КОДОВ 1С С КАБИНЕТАМИ: кодов в ведомости ' + r.codes);
  console.log(r.wrong.length ? '\n⚠ НЕСТЫКОВКИ (' + r.wrong.length + ') — отдать продавцу, правит в 1С:\n   ' + r.wrong.join('\n   ') : '\nнестыковок артикулов не найдено');
  if (r.empty.length) console.log('\nНЕ ЗАПОЛНЕНО в 1С, хотя карточка на площадке есть (' + r.empty.length + '):\n   ' + r.empty.join('\n   '));
}
