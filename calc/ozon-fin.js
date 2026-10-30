/* calc/ozon-fin.js — ОДИН расчёт прибыли Ozon для сайта и скриптов (с 30.10.2026).

   ЗАЧЕМ. До этого правила жили в двух копиях: ozFinRows/ozApplyAdFact и соседи в index.html и calc()
   в scripts/ozon-finance.cjs, с пометками «ДЕРЖИ СИНХРОННО». Пропущенная правка в одной копии не давала
   ни ошибки, ни пустой таблицы — сайт и скрипт молча расходились (замечание продавца 30.10.2026 про
   «тихие ошибки»). Теперь копия одна: сайт подключает этот файл обычным <script>, скрипты — require().
   Здесь только правила расчёта, ДАННЫХ НЕТ — файл публичный, как и index.html.

   Сборки нет: файл пишется так, чтобы работать и в браузере (window.OzFin), и в Node (module.exports).

   ИСПОЛЬЗОВАНИЕ
     const C = OzFin.create(REAL_DATA, {forceAdRate: null});   // forceAdRate — ручная ставка рекламы, %
     C.rows()              → подённые строки прибыли: одна на (дата + код 1С)
     C.aggregate(dates)    → свод за набор дат (ordRub, ordQty, revenue, qty, cogs, mpFee, ad, profit, noCostQty)
     C.adRateFor(d) · C.fixedRate · C.buyoutFor(d) · C.costAt(sup,d) · C.feeOn(d) · C.feeDay(d) · C.parts · C.partIdx(d)
     OzFin.applyRevBase(REAL_DATA)  — один раз после загрузки снимка (идемпотентно)

   ПРАВИЛА (каждое — решение продавца, подробности в ПРАВИЛА.md и справочник/озон-учёт.md):
   · база выручки — «Предельная цена» × % выкупа по дате дня (ЦЕНА-01); соинвест не вычитается;
   · % выкупа — история замеров, каждый действует С ДАТЫ ЗАМЕРА И ВПЕРЁД (ozBuyoutFor);
   · тариф: фиксированная часть = total − ads (Premium 1,4% в ней всегда);
   · реклама до 01.10.2026 — ставка из отчётов «Юнит-экономика» (зрелых, не manual), с 01.10 модельной
     ставки нет (РЕК-23): плата за заказ — только факт отчёта «Оплата за заказ», дня без отчёта — 0;
   · выгрузка XWAY перекрывает ставку ПОТОВАРНО, расход части разносится по дням пропорционально
     выручке; товар с расходом без продаж — строка с нулевой выручкой на последний день части;
   · сверх XWAY: в дни с отчётом — факт списания; без отчёта — модельная ставка, кроме товаров ozzOn;
   · себестоимость — каталог ВБ по коду 1С (история цен по дате), фолбэк meta.costBySup. */
(function (root) {
  'use strict';
  const FEE_REPORT_ONLY_FROM = '2026-10-01';

  /* БАЗА ВЫРУЧКИ С ДАТЫ (revBase) — правило выключено (applied!==true), но механизм оставлен: включается
     одним флагом в снимке. Пересчёт делается ОДИН раз прямо в orderSeries.money (ту же карту читают
     «Динамика» и «Всего»), элемент [2] «оплачено покупателем» не трогаем. */
  function revBase(RD) {
    const B = (RD && RD.ozon && RD.ozon.meta && RD.ozon.meta.revBase) || null;
    return (B && B.applied === true && Array.isArray(B.history) && B.history.length) ? B : null;
  }
  function revK(RD, d) { const B = revBase(RD); if (!B) return 1; let k = 1; B.history.forEach(h => { if (h.from <= d) k = h.k; }); return k; }
  function applyRevBase(RD) {
    const S = RD && RD.ozon && RD.ozon.orderSeries;
    if (!S || !S.money || S.moneyRebased) return;
    S.moneyRebased = true;
    if (!revBase(RD)) return;
    Object.keys(S.money).forEach(d => { const k = revK(RD, d); if (k === 1) return;
      Object.values(S.money[d]).forEach(v => { v[0] = Math.round((v[0] || 0) * k); v[1] = Math.round((v[1] || 0) * k); }); });
  }

  function create(RD, opts) {
    opts = opts || {};
    const O = (RD && RD.ozon) || {}, M = O.meta || {};
    const forced = opts.forceAdRate != null;
    const T = M.terms || null;
    const fixedRate = T ? +((T.total || 0) - (T.ads || 0)).toFixed(4) : 0;

    // реклама до 01.10 — ставка зрелых отчётов «Юнит-экономика»: внутри периода — его, раньше первого — первого,
    // позже последнего — последнего (как у % выкупа)
    const UR = (M.unitReports || []).filter(r => r.mature !== false && r.src !== 'manual').slice().sort((a, b) => a.from < b.from ? -1 : 1);
    function adRateFor(d) {
      if (forced) return opts.forceAdRate;
      if (d >= FEE_REPORT_ONLY_FROM) return 0;
      if (!UR.length) return T ? (T.ads || 0) : 0;
      for (const r of UR) if (r.from <= d && d <= r.to) return r.adsRate;
      if (d < UR[0].from) return UR[0].adsRate;
      let last = UR[0]; for (const r of UR) if (r.to < d) last = r;
      return last.adsRate;
    }
    const parts = (!forced && M.adSpend && Array.isArray(M.adSpend.parts) && M.adSpend.parts.length)
      ? M.adSpend.parts.slice().sort((a, b) => a.from < b.from ? -1 : 1) : [];
    function partIdx(d) { for (let i = 0; i < parts.length; i++) if (parts[i].from <= d && d <= parts[i].to) return i; return -1; }
    const fee = (!forced && M.orderFee && Array.isArray(M.orderFee.periods) && M.orderFee.periods.length) ? M.orderFee : null;
    const feeOn = d => !!(fee && fee.periods.some(p => p.from <= d && d <= p.to));
    const feeDay = d => (fee && fee.byDate && fee.byDate[d]) || {};
    const ozz = (M.ozzOn && M.ozzOn.bySup) || {};

    const BOH = (M.buyoutWin && Array.isArray(M.buyoutWin.history) && M.buyoutWin.history.length)
      ? M.buyoutWin.history.slice().sort((a, b) => (a.builtAt || '') < (b.builtAt || '') ? -1 : 1) : null;
    function buyoutFor(d) {
      if (!BOH) return M.buyoutAll != null ? M.buyoutAll : 1;
      let pick = null; BOH.forEach(h => { if ((h.builtAt || '').slice(0, 10) <= d) pick = h; });
      return (pick || BOH[0]).all;
    }

    const costNow = {}, costHist = {};
    ((RD && RD.catalog) || []).forEach(c => { const s = ('' + (c.supplierCode || '')).trim(); if (!s) return;
      if (c.costPrice != null && costNow[s] == null) costNow[s] = c.costPrice;
      if (c.costHistory && c.costHistory.length && !costHist[s]) costHist[s] = c.costHistory; });
    // фолбэк для товаров без карточки ВБ: каталог ВБ всегда сильнее
    Object.entries((RD && RD.meta && RD.meta.costBySup) || {}).forEach(([s, v]) => { if (!v) return;
      const c = (typeof v === 'object') ? v.cost : v; if (c != null && costNow[s] == null) costNow[s] = c; });
    function costAt(sup, date) {
      const h = costHist[sup];
      if (h) { let v = null; for (const e of h) { if (!e.from || e.from <= date) v = e.cost; } if (v != null) return v; }
      return costNow[sup] != null ? costNow[sup] : null;
    }

    let _rows = null;
    function rows() {
      if (_rows) return _rows;
      if (!T || !O.orderSeries) return (_rows = []);
      const S = O.orderSeries, dates = S.dates || [], byArt = S.byArt || {}, money = S.money || {};
      const meta = {}; (O.catalog || []).forEach(c => meta['' + c.sku] = { name: c.name || '', cat: c.category || '', wbCat: c.wbCategory || '' });
      const out = [];
      const blank = (d, a) => { const e = meta[a] || {};
        return { date: d, sku: a, sup: a, name: e.name || a, category: e.cat || '', wbCategory: e.wbCat || '',
          ordRub: 0, ordQty: 0, revenue: 0, qty: 0, cogs: 0, hasCost: costAt(a, d) != null }; };
      dates.forEach((d, i) => {
        const m = money[d] || {};
        const arts = new Set(Object.keys(m));
        Object.entries(byArt).forEach(([a, s]) => { if (s[i]) arts.add(a); });
        const bo = buyoutFor(d), adRate = adRateFor(d);
        const fo = feeOn(d), fd = fo ? feeDay(d) : null, made = new Set();
        arts.forEach(a => {
          const ordRub = (m[a] && m[a][0]) || 0, ordQty = (byArt[a] && byArt[a][i]) || 0;
          if (!ordRub && !ordQty) return;
          const rev = ordRub * bo, qty = ordQty * bo;
          const cp = costAt(a, d), cogs = cp != null ? qty * cp : 0;
          const ads = fo ? (fd[a] || 0) : rev * adRate / 100, mpFee = rev * fixedRate / 100 + ads;
          const e = meta[a] || {};
          made.add(a);
          out.push({ date: d, sku: a, sup: a, name: e.name || a, category: e.cat || '', wbCategory: e.wbCat || '',
            ordRub, ordQty, revenue: rev, qty, cogs, hasCost: cp != null, mpFee, ad: ads,
            // состав рекламы: adX — XWAY, fee — факт «Оплаты за заказ», adBase — модельная ставка; ad = adX + fee + adBase
            fee: fo ? (fd[a] || 0) : 0, feeFact: fo, adX: 0, adBase: fo ? 0 : ads, profit: rev - mpFee - cogs });
        });
        // списание есть, а строки товара в этот день нет — строка с нулевой выручкой, деньги не теряются
        if (fo) Object.entries(fd).forEach(([a, f]) => { if (made.has(a) || !f) return;
          out.push(Object.assign(blank(d, a), { mpFee: f, ad: f, fee: f, feeFact: true, adX: 0, adBase: 0, profit: -f })); });
      });
      applyAdFact(out, dates, blank);
      return (_rows = out);
    }

    /* XWAY ПЕРЕКРЫВАЕТ СТАВКУ — вторым проходом: доля дня считается от выручки товара за всю часть. Выручки
       в части нет — весь расход на ПОСЛЕДНИЙ день части (строка этого дня или новая строка-остаток). */
    function applyAdFact(out, dates, blank) {
      if (!parts.length) return;
      const idx = new Map();
      out.forEach(r => { const pi = partIdx(r.date); if (pi < 0) return;
        if (((parts[pi].bySup) || {})[r.sku] == null) return;
        const k = pi + '|' + r.sku; let a = idx.get(k); if (!a) idx.set(k, a = []); a.push(r); });
      parts.forEach((p, pi) => {
        const days = dates.filter(d => d >= p.from && d <= p.to);
        const last = days[days.length - 1] || p.to;
        Object.entries(p.bySup || {}).forEach(([sku, spend]) => {
          const arr = idx.get(pi + '|' + sku);
          if (!arr || !arr.length) {
            out.push(Object.assign(blank(last, sku), { mpFee: spend, ad: spend, adFact: true, adX: spend, adBase: 0, fee: 0, feeFact: feeOn(last), profit: -spend }));
            return; }
          const tot = arr.reduce((a, r) => a + r.revenue, 0);
          const addBase = ozz[sku] == null;                 // оплата за заказ выключена → модельная ставка сверху (только без отчёта)
          let host = null;
          if (tot <= 0) { host = arr.find(r => r.date === last) || null;
            if (!host) { host = Object.assign(blank(last, sku), { mpFee: 0, ad: 0, adX: 0, adBase: 0, fee: 0, feeFact: false, profit: 0 });
              out.push(host); arr.push(host); } }
          arr.forEach(r => {
            const share = tot > 0 ? r.revenue / tot : (r === host ? 1 : 0);
            const base = r.feeFact ? (r.fee || 0) : (addBase ? r.revenue * adRateFor(r.date) / 100 : 0);
            const ad = spend * share + base;
            r.ad = ad; r.adFact = true; r.adX = spend * share; r.adBase = r.feeFact ? 0 : base;
            r.mpFee = r.revenue * fixedRate / 100 + ad;
            r.profit = r.revenue - r.mpFee - r.cogs;
          });
        });
      });
    }

    function aggregate(dates) {
      const set = new Set(dates), a = { ordRub: 0, ordQty: 0, revenue: 0, qty: 0, cogs: 0, mpFee: 0, ad: 0, profit: 0, noCostQty: 0 };
      rows().forEach(r => { if (!set.has(r.date)) return;
        a.ordRub += r.ordRub; a.ordQty += r.ordQty; a.revenue += r.revenue; a.qty += r.qty; a.cogs += r.cogs;
        a.mpFee += r.mpFee; a.ad += r.ad; a.profit += r.profit; if (!r.hasCost) a.noCostQty += r.ordQty; });
      a.margin = a.revenue ? a.profit / a.revenue : 0;
      return a;
    }

    return { terms: T, fixedRate, unitReports: UR, adRateFor, parts, partIdx, orderFee: fee, feeOn, feeDay,
      ozzOn: ozz, buyoutHist: BOH, buyoutFor, costMap: { now: costNow, hist: costHist }, costAt, rows, aggregate };
  }

  const api = { FEE_REPORT_ONLY_FROM, create, applyRevBase, revBase, revK };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.OzFin = api;
})(typeof window !== 'undefined' ? window : this);
