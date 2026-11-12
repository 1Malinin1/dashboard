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
  orderDate: 'Дата заказа покупателем',   // для срока «заказ → продажа» (wb-fin-compare.cjs)
  retail: 'Цена розничная с учетом согласованной скидки',
  payout: 'К перечислению Продавцу за реализованный Товар',
  logistics: 'Услуги по доставке товара покупателю',
  penalty: 'Общая сумма штрафов', storage: 'Хранение',
  // Массив = варианты названия одной и той же колонки: ВБ их переименовывает (отчёты 11.2026:
  // «Возмещение издержек по перемещению и операционной обработке товара», «Услуга по обработке Товара»).
  reimb: ['Возмещение издержек по перевозке/по складским операциям с товаром',
          'Возмещение издержек по перемещению и операционной обработке товара'],
  deduction: 'Удержания', priyomka: ['Операции на приемке', 'Услуга по обработке Товара'],
  loyalty: 'Стоимость участия в программе лояльности',
  loyaltyPts: 'Сумма баллов, удержанных по программе лояльности',
  // СПРАВОЧНО, В ИТОГ НЕ ИДЁТ: «Компенсация скидки по программе лояльности» уже сидит внутри «Продажи» и
  // «К перечислению» (в кабинете: «Продажа …, в том числе компенсация …»). Прибавлять её — двойной счёт.
  loyaltyComp: 'Компенсация скидки по программе лояльности',
  // «Корректировка Вознаграждения Вайлдберриз (ВВ)» — ВЫЧИТАЕТСЯ из «Итого к оплате» (плата за разблокировку ТС и т.п.);
  // отдельного поля не заводим — кладём в deduction.
  vvCorr: 'Корректировка Вознаграждения Вайлдберриз (ВВ)',
};
/* ФОРМУЛА «ИТОГО К ОПЛАТЕ» — СВЕРЕНА С КАБИНЕТОМ ВБ ДО КОПЕЙКИ (12.11.2026, отчёт №896659722, весь кабинет:
   196 920 592,25 ₽; второй отчёт №896659723 «по выкупам»: 6 390 661,36 ₽):
     К перечислению за товар (продажи − ВОЗВРАТЫ)
     − доставка − хранение − обработка товара − прочие удержания − штрафы − корректировка ВВ
     − стоимость участия в программе лояльности − баллы лояльности.
   НЕ ВХОДЯТ: «Возмещение издержек по перемещению…» (в тех же строках «Вознаграждение ВВ» и НДС стоят с минусом
   на ту же сумму — это перекладка внутри комиссии, деньги продавца не меняет; до 12.11.2026 вычиталось зря)
   и «Компенсация скидки по программе лояльности» (уже внутри «К перечислению»). Поэтому reimb в записи = 0,
   исходная сумма лежит справочно в reimbInfo. */
// Колонки, которых в старых отчётах не было вовсе, — об их отсутствии не предупреждаем.
const FIN_OPTIONAL = { loyaltyComp: 1, orderDate: 1, vvCorr: 1 };
// индекс колонки по имени или по любому из вариантов имени
function colOf(header, names) {
  for (const n of [].concat(names)) { const i = header.indexOf(n); if (i >= 0) return i; }
  return -1;
}

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
  const colIdx = {}; for (const k in FIN_COLS) colIdx[k] = colOf(header, FIN_COLS[k]);
  if (colIdx.sku < 0 || colIdx.payout < 0) throw new Error('Не нашёл нужные колонки — это точно отчёт о реализации WB?');
  // ВАЖНО: колонки ищутся по ТОЧНОМУ имени. Если WB переименует «Хранение» или «Удержания»,
  // indexOf вернёт -1, val() молча отдаст 0 — и целая статья расходов исчезнет из «Итого к оплате»
  // без единой ошибки. Поэтому о ненайденных колонках сообщаем вслух.
  const missing = Object.keys(FIN_COLS).filter(k => colIdx[k] < 0 && !FIN_OPTIONAL[k]);
  if (missing.length) console.warn('  ⚠ не нашёл колонки в отчёте (будут считаться нулём): '
    + missing.map(k => '«' + [].concat(FIN_COLS[k]).join('» / «') + '»').join(', '));
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
    const docType = (r[colIdx.docType] || '').toString().trim();
    /* ВОЗВРАТ — СО ЗНАКОМ МИНУС (12.11.2026). В строках «Возврат» ВБ пишет «К перечислению» ПЛЮСОМ,
       а в итоге недели вычитает: к перечислению = продажи − возвраты. До 12.11.2026 сумма шла в
       свод как есть, то есть возврат ПРИБАВЛЯЛ деньги (по неделям 29.06–02.08 «итого к оплате»
       было завышено на 1,45% выручки). Сверено с кабинетом: «К перечислению за товар» = продажи − возвраты. */
    const sign = docType === 'Возврат' ? -1 : 1;
    const comp = val(r, 'loyaltyComp');
    byId[h] = {
      id: h, date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '', sku,
      name: (r[colIdx.name] || sku).toString(), category: (r[colIdx.category] || '').toString(),
      docType, qty: val(r, 'qty'),
      basis: colIdx.basis >= 0 ? (r[colIdx.basis] || '').toString().trim() : '',
      orderDate: colIdx.orderDate >= 0 ? (r[colIdx.orderDate] || '').toString().trim().slice(0, 10) : '',
      retail: val(r, 'retail'), payout: sign * val(r, 'payout'), loyaltyComp: sign * comp,
      logistics: val(r, 'logistics'), penalty: val(r, 'penalty'), storage: val(r, 'storage'),
      reimb: 0, reimbInfo: val(r, 'reimb'), deduction: val(r, 'deduction') + val(r, 'vvCorr'), priyomka: val(r, 'priyomka'),
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
//
// Строки БЕЗ даты. WB не проставляет «Дата продажи» строкам, не привязанным к продаже
// (прежде всего «Возмещение издержек»): в отчёте у них пусты ВСЕ колонки с датами.
// Раньше такие строки целиком падали на последний день периода (`r.date || maxDate`) —
// сумма за период выходила верной, но день-приёмник получал весь расход разом и
// проваливался на графике «Прибыль по дням» (напр. 26.07: 404 487 ₽ вместо ~810 000 ₽).
// Теперь расход РАЗМАЗЫВАЕТСЯ по датам того же артикула пропорционально его выручке
// за день. Итог за период не меняется (это те же деньги), а подённая картина
// перестаёт врать. Если у артикула нет ни одного дня с выручкой — кладём на maxDate.
// reimbInfo и loyaltyComp — справочные (в «Итого к оплате» не входят), но в своде их сохраняем
const MONEY_FIELDS = ['payout', 'logistics', 'penalty', 'storage', 'reimb', 'deduction', 'priyomka', 'loyalty', 'loyaltyPts', 'reimbInfo', 'loyaltyComp'];
/* opt.from / opt.to — границы недели отчёта. В недельном отчёте попадаются строки с датой ИЗ ПРОШЛЫХ
   недель (баллы за отзывы, штрафы, корректировка эквайринга — 02–08.11.2026 таких 64 строки с датами
   05.10–01.11). Оставь им их дату — и день из «оценки» станет «фактом» с парой рублей: сайт берёт факт
   вместо оценки по ДАТЕ, и вся оценка этого дня пропадёт. Поэтому такие строки считаем недатированными:
   деньги остаются в неделе отчёта и размазываются по дням артикула (как «Возмещение издержек»). */
function aggregateFinanceRows(raw, opt) {
  if (opt && (opt.from || opt.to)) raw = raw.map(r =>
    (r.date && ((opt.from && r.date < opt.from) || (opt.to && r.date > opt.to))) ? Object.assign({}, r, { date: '' }) : r);
  const dated = raw.map(r => r.date).filter(Boolean).sort();
  const maxDate = dated.length ? dated[dated.length - 1] : '';
  const byKey = {};
  const mkBucket = (d, r) => ({
    id: d + '_' + r.sku, date: d, sku: r.sku, name: r.name, category: r.category,
    qty: 0, returnsQty: 0, revenue: 0, payout: 0, logistics: 0, penalty: 0, storage: 0,
    reimb: 0, deduction: 0, priyomka: 0, loyalty: 0, loyaltyPts: 0, reimbInfo: 0, loyaltyComp: 0,
  });
  const undated = [];
  for (const r of raw) {
    if (!r.date) { undated.push(r); continue; }          // отложим — разложим ниже
    const key = r.date + '_' + r.sku;
    let b = byKey[key]; if (!b) b = byKey[key] = mkBucket(r.date, r);
    if (r.docType === 'Продажа') { b.qty += r.qty || 0; b.revenue += (r.retail || 0) * (r.qty || 0); }
    else if (r.docType === 'Возврат') { b.returnsQty += r.qty || 0; b.revenue -= (r.retail || 0) * (r.qty || 0); }
    for (const f of MONEY_FIELDS) b[f] += r[f] || 0;
    if ((!b.name || b.name === b.sku) && r.name && r.name !== r.sku) b.name = r.name;
    if (!b.category && r.category) b.category = r.category;
  }
  // суммируем недатированные деньги по артикулу, затем размазываем по дням этого артикула
  const bySku = {};
  for (const r of undated) {
    let s = bySku[r.sku]; if (!s) s = bySku[r.sku] = { sku: r.sku, name: r.name, category: r.category, sums: {} };
    for (const f of MONEY_FIELDS) if (r[f]) s.sums[f] = (s.sums[f] || 0) + r[f];
    if ((!s.name || s.name === s.sku) && r.name && r.name !== r.sku) s.name = r.name;
  }
  const buckets = Object.values(byKey);
  for (const s of Object.values(bySku)) {
    const total = Object.values(s.sums).reduce((a, b) => a + b, 0);
    if (!total) continue;
    const mine = buckets.filter(b => b.sku === s.sku && b.revenue > 0);
    if (!mine.length) {                                   // нет дней с выручкой — кладём на последний день
      const key = maxDate + '_' + s.sku;
      let b = byKey[key]; if (!b) b = byKey[key] = mkBucket(maxDate, s);
      for (const f of MONEY_FIELDS) b[f] += s.sums[f] || 0;
      continue;
    }
    const rev = mine.reduce((a, b) => a + b.revenue, 0);
    for (const f of MONEY_FIELDS) {
      const amount = s.sums[f]; if (!amount) continue;
      let placed = 0;
      mine.forEach((b, i) => {
        // последнему отдаём остаток — чтобы сумма сошлась до копейки без потерь на округлении
        const part = (i === mine.length - 1) ? amount - placed : amount * (b.revenue / rev);
        b[f] += part; placed += part;
      });
    }
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
  num, rowHash, headerRow, FIN_COLS, colOf,
  parseFinanceSheet, parseAdsSheet, parseCostSheet,
  aggregateFinanceRows, aggregateAdRows, holdings, controlTotals,
};
