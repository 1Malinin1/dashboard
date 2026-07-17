// Разбор отчётов WB (реализация / реклама / себестоимость).
// ВАЖНО: эта логика должна оставаться идентичной воркеру в index.html
// (переменная WORKER_SRC, ветки type==="finance"/"ads"/"cost"). Если формула
// «Итого к оплате» или набор колонок поменяются на сайте — обновите и здесь,
// иначе отпечатки строк (rowHash) не совпадут и дедуп между сайтом и
// офлайн-скриптами перестанет работать.
'use strict';

function num(v) {
  const n = parseFloat(('' + v).replace(/\s/g, '').replace(',', '.'));
  return isNaN(n) ? 0 : n;
}

// Стабильный 64-битный отпечаток строки (два независимых 32-битных хэша).
// Один и тот же физический ряд отчёта даёт одинаковый hash в любом файле/куске.
function rowHash(cells) {
  const s = cells.join('');
  let h1 = 0x811c9dc5, h2 = 0xc2b2ae35;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 16777619);
    h2 = Math.imul(h2 ^ c, 2246822519);
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

function headerRow(XLSX, ws) {
  const ref = ws['!ref'];
  if (!ref) return [];
  const range = XLSX.utils.decode_range(ref), header = [];
  for (let c = range.s.c; c <= range.e.c; c++) {
    const cell = ws[XLSX.utils.encode_cell({ r: range.s.r, c })];
    header.push(cell ? (cell.w !== undefined ? cell.w : cell.v) : '');
  }
  return header;
}

const FIN_COLS = {
  sku: 'Код номенклатуры', name: 'Название', category: 'Предмет',
  docType: 'Тип документа', basis: 'Обоснование для оплаты', saleDate: 'Дата продажи', qty: 'Кол-во',
  retail: 'Цена розничная с учетом согласованной скидки',
  payout: 'К перечислению Продавцу за реализованный Товар',
  logistics: 'Услуги по доставке товара покупателю',
  penalty: 'Общая сумма штрафов', storage: 'Хранение',
  reimb: 'Возмещение издержек по перевозке/по складским операциям с товаром',
  deduction: 'Удержания', priyomka: 'Операции на приемке',
  loyalty: 'Стоимость участия в программе лояльности',
  loyaltyPts: 'Сумма баллов, удержанных по программе лояльности',
};

// Разбор отчёта «О реализации товаров». Берёт ВСЕ типы строк (не только продажи) —
// логистика/хранение/штрафы/возмещение лежат отдельными строками и это расходы.
// Возвращает построчные записи (не агрегированные), ключ id = rowHash.
function parseFinanceSheet(XLSX, wb, catalogSkuSet) {
  if (!wb.SheetNames.length) throw new Error('В файле не нашлось ни одного листа.');
  let ws = null, header = null, sheetInfo = [];
  for (const name of wb.SheetNames) {
    const cand = wb.Sheets[name];
    const h = headerRow(XLSX, cand);
    const ref = cand['!ref'];
    const rc = ref ? XLSX.utils.decode_range(ref).e.r + 1 : 0;
    sheetInfo.push(name + ' (' + rc + ' стр.)');
    if (h.indexOf(FIN_COLS.sku) >= 0 && h.indexOf(FIN_COLS.payout) >= 0) { ws = cand; header = h; break; }
  }
  if (!ws) return null; // не отчёт о реализации — вызывающий код попробует другой парсер
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
  if (rows.length < 2) throw new Error('Лист найден, но в нём нет строк с данными.');
  const colIdx = {}; for (const k in FIN_COLS) colIdx[k] = header.indexOf(FIN_COLS[k]);
  if (colIdx.sku < 0 || colIdx.payout < 0) throw new Error('Не нашёл нужные колонки — это точно отчёт о реализации WB?');
  const val = (r, k) => (colIdx[k] >= 0 ? num(r[colIdx[k]]) : 0);
  const byId = {}; let matched = 0, total = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]; if (!r || !r.length) continue;
    const sku = (r[colIdx.sku] || '').toString().trim(); if (!sku) continue;
    total++;
    if (!catalogSkuSet.has(sku)) continue;
    matched++;
    const date = (r[colIdx.saleDate] || '').toString().trim();
    const h = rowHash(r);
    byId[h] = {
      id: h, date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '', sku,
      name: (r[colIdx.name] || sku).toString(), category: (r[colIdx.category] || '').toString(),
      docType: (r[colIdx.docType] || '').toString().trim(), qty: val(r, 'qty'),
      retail: val(r, 'retail'), payout: val(r, 'payout'),
      logistics: val(r, 'logistics'), penalty: val(r, 'penalty'), storage: val(r, 'storage'),
      reimb: val(r, 'reimb'), deduction: val(r, 'deduction'), priyomka: val(r, 'priyomka'),
      loyalty: val(r, 'loyalty'), loyaltyPts: val(r, 'loyaltyPts'),
    };
  }
  return { records: Object.values(byId), matched, total };
}

// Разбор «История затрат» (WB Продвижение). Кампании «18+», артикул — последние
// цифры в названии. occ-счётчик даёт одинаковым строкам одного файла разные ключи
// (это реальные разные списания), а повторная загрузка того же файла — те же ключи.
function parseAdsSheet(XLSX, wb, catalogSkuSet) {
  let ws = null, header = null;
  for (const name of wb.SheetNames) {
    const cand = wb.Sheets[name]; const h = headerRow(XLSX, cand);
    if (h.indexOf('Кампания') >= 0 && h.indexOf('Сумма') >= 0) { ws = cand; header = h; break; }
  }
  if (!ws) return null;
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
  const ci = { name: header.indexOf('Кампания'), date: header.indexOf('Дата списания'), sum: header.indexOf('Сумма') };
  const byId = {}, occ = {}; let matched = 0, total = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]; if (!r || !r.length) continue;
    const camp = (r[ci.name] || '').toString().trim(); if (!camp) continue;
    total++;
    if (!/^\s*18\+/.test(camp)) continue;
    const m = camp.match(/(\d{5,})\s*$/); if (!m) continue;
    const sku = m[1]; if (!catalogSkuSet.has(sku)) continue;
    matched++;
    const date = (r[ci.date] || '').toString().trim().slice(0, 10);
    const h = rowHash(r);
    const n = (occ[h] = (occ[h] || 0) + 1) - 1;
    const id = n ? h + '#' + n : h;
    byId[id] = { id, date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '', sku, campaign: camp, spend: num(r[ci.sum]) };
  }
  return { records: Object.values(byId), matched, total };
}

// Файл себестоимости: колонки «Артикул»/«себестоимость» (гибкий поиск по regex).
function parseCostSheet(XLSX, wb) {
  let ws = null, header = null;
  for (const name of wb.SheetNames) {
    const cand = wb.Sheets[name]; const h = headerRow(XLSX, cand);
    const hasSku = h.findIndex(x => /артикул/i.test('' + x));
    const hasCost = h.findIndex(x => /себестоим/i.test('' + x));
    if (hasSku >= 0 && hasCost >= 0) { ws = cand; header = h; break; }
  }
  if (!ws) return null;
  let si = header.findIndex(x => /артикул/i.test('' + x) && /wb|вб/i.test('' + x));
  if (si < 0) si = header.findIndex(x => /артикул/i.test('' + x));
  const ci = header.findIndex(x => /себестоим/i.test('' + x));
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
  const costMap = {}; let matched = 0, total = 0;
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i]; if (!r || !r.length) continue;
    const sku = ('' + (r[si] || '')).trim(); if (!/^\d+$/.test(sku)) continue;
    total++;
    const c = num(r[ci]);
    if (c > 0) { costMap[sku] = Math.round(c); matched++; }
  }
  return { costMap, matched, total };
}

// Агрегация построчных финансовых записей в свод по (дата+артикул) — как FINANCE_CACHE
// на сайте. Штуки/выручка только по Продажа(+)/Возврат(−); деньги — сырыми суммами.
function aggregateFinanceRows(raw) {
  const dated = raw.map(r => r.date).filter(Boolean).sort();
  const maxDate = dated.length ? dated[dated.length - 1] : '';
  const byKey = {};
  for (const r of raw) {
    const d = r.date || maxDate, key = d + '_' + r.sku;
    let b = byKey[key];
    if (!b) b = byKey[key] = {
      id: key, date: d, sku: r.sku, name: r.name, category: r.category,
      qty: 0, returnsQty: 0, revenue: 0, payout: 0, logistics: 0, penalty: 0, storage: 0,
      reimb: 0, deduction: 0, priyomka: 0, loyalty: 0, loyaltyPts: 0,
    };
    if (r.docType === 'Продажа') { b.qty += r.qty || 0; b.revenue += (r.retail || 0) * (r.qty || 0); }
    else if (r.docType === 'Возврат') { b.returnsQty += r.qty || 0; b.revenue -= (r.retail || 0) * (r.qty || 0); }
    b.payout += r.payout || 0; b.logistics += r.logistics || 0; b.penalty += r.penalty || 0; b.storage += r.storage || 0;
    b.reimb += r.reimb || 0; b.deduction += r.deduction || 0; b.priyomka += r.priyomka || 0;
    b.loyalty += r.loyalty || 0; b.loyaltyPts += r.loyaltyPts || 0;
    if ((!b.name || b.name === b.sku) && r.name && r.name !== r.sku) b.name = r.name;
    if (!b.category && r.category) b.category = r.category;
  }
  return Object.values(byKey);
}

function aggregateAdRows(raw) {
  const byKey = {};
  for (const r of raw) {
    const d = r.date || '', key = d + '_' + r.sku;
    let b = byKey[key]; if (!b) b = byKey[key] = { id: key, date: d, sku: r.sku, spend: 0 };
    b.spend += r.spend || 0;
  }
  return Object.values(byKey);
}

function holdings(a) {
  return (a.logistics || 0) + (a.penalty || 0) + (a.storage || 0) + (a.reimb || 0)
    + (a.deduction || 0) + (a.priyomka || 0) + (a.loyalty || 0) + (a.loyaltyPts || 0);
}

// Контрольная сводка для сверки с личным кабинетом WB перед заливкой.
function controlTotals(aggregatedFinRows) {
  let revenue = 0, net = 0, qty = 0, returnsQty = 0;
  aggregatedFinRows.forEach(a => { revenue += a.revenue; net += (a.payout - holdings(a)); qty += a.qty; returnsQty += a.returnsQty; });
  return { revenue: Math.round(revenue), net: Math.round(net), soldNet: qty - returnsQty };
}

module.exports = {
  num, rowHash, headerRow, FIN_COLS,
  parseFinanceSheet, parseAdsSheet, parseCostSheet,
  aggregateFinanceRows, aggregateAdRows, holdings, controlTotals,
};
