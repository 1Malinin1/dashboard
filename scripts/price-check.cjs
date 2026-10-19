#!/usr/bin/env node
/**
 * price-check.cjs <код 1С | артикул ВБ> [предельная цена]
 *
 * Зачем: на ценах я ошибался трижды подряд (стала цена одной сделки текущей, среднее
 * за окно — текущей, цена продавца — ценой для покупателя). Скрипт печатает ВСЕ цены
 * сразу, каждую со своим смыслом, и сам отмечает, какой верить. Правила ЦЕНА-01…ЦЕНА-05.
 *
 * Печатает:
 *   · предельную по ПОСЛЕДНИМ продажам (её и брать) и подённо последние 10 продаж;
 *   · среднее за 28 дней — отдельно, с пометкой «не брать, если цена менялась»;
 *   · надёжность (меньше 5 заказов за 28 дней → спрашивать у продавца);
 *   · цену ДЛЯ ПОКУПАТЕЛЯ на Озоне (money[2]) и прямо говорит, что для ВБ её в снимке нет;
 *   · соседей по склейке и относительное положение цены на обеих площадках;
 *   · экономику: безубыточный ДРР, потолок, маржу с заказа, два порога CPO.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const FIX = 32.7;              // ДАН-03: фиксированная ставка Озона
const MARGIN_FLOOR = 10;       // пол по марже, п.п.
const FRESH_MIN_ORDERS = 5;    // ЦЕНА-03

const DEC = path.join(__dirname, "..", "decrypted", "wb-data.js");
if (!fs.existsSync(DEC)) {
  console.error("Нет decrypted/wb-data.js — сначала: node scripts/decrypt.cjs <код>");
  process.exit(2);
}
const ctx = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(DEC, "utf8") + "\nglobalThis.__RD=REAL_DATA;", ctx);
const RD = ctx.__RD, O = RD.ozon;
/* ПЛАТА ЗА ЗАКАЗ — ТОЛЬКО ИЗ ОТЧЁТОВ ПРОДАВЦА (РЕК-23, 19.10.2026: «берём плату за заказ только с
   отчётов, которые я сам даю тебе»). Номинальной ставки (ручные 5%/7%) больше нет. Доля = Σ списаний
   отчёта «Оплата за заказ (все товары)» ÷ Σ заказанного ₽ (предельная) за последние 7 дней с отчётом,
   по кабинету (по товару слишком шумно): Ozon списывает не со всех заказов и от цены для покупателя,
   поэтому номинал × заказ завышал бы расход. Отчётов нет — 0, и это печатается. */
const FEE_SHARE = (() => {
  const F = O.meta && O.meta.orderFee; if (!F || !Array.isArray(F.periods) || !F.periods.length) return null;
  const M = (O.orderSeries && O.orderSeries.money) || {};
  const P = F.periods.slice().sort((a, b) => a.from < b.from ? -1 : 1).filter(p => p.from === p.to).slice(-7);
  let fee = 0, ord = 0;
  P.forEach(p => { const o = Object.values(M[p.from] || {}).reduce((a, v) => a + (v[0] || 0), 0); if (o > 0 && p.total > 0) { fee += p.total; ord += o; } });
  return ord > 0 ? { pct: fee / ord * 100, from: P[0].from, to: P[P.length - 1].to } : null;
})();
const BASE_EFF = FEE_SHARE ? FEE_SHARE.pct : 0;

const key = String(process.argv[2] || "").trim();
const priceArg = process.argv[3] ? Number(String(process.argv[3]).replace(/[^\d.]/g, "")) : null;
if (!key) { console.error("Укажи код 1С или артикул ВБ."); process.exit(1); }

// --- найти товар -------------------------------------------------------------
let wbCards = RD.catalog.filter(c => String(c.supplierCode) === key);
if (!wbCards.length) wbCards = RD.catalog.filter(c => String(c.sku) === key);
const sup = wbCards.length ? String(wbCards[0].supplierCode) : key;
const ozCard = O.catalog.find(c => String(c.sku) === sup);
if (!wbCards.length && !ozCard) { console.error("Код " + key + " не найден ни в каталоге ВБ, ни в каталоге Озона."); process.exit(1); }

const rub = n => Math.round(n).toLocaleString("ru-RU") + " ₽";
const pct = n => n.toFixed(2) + "%";

// --- ряды --------------------------------------------------------------------
const OD = O.orderSeries.dates, on = OD.length, OM = O.orderSeries.money || {};
const WD = RD.orderSeries.dates, wn = WD.length, WM = RD.orderSeries.money || {};

function ozDaily(code) {
  const row = O.orderSeries.byArt[code] || [];
  const out = [];
  for (let i = 0; i < on; i++) {
    const q = row[i] || 0; if (!q) continue;
    const m = OM[OD[i]] && OM[OD[i]][code];
    out.push({ date: OD[i], qty: q, price: m ? m[0] / q : null, paid: m && m[2] ? m[2] / q : null });
  }
  return out;
}
function ozWindow(code, days) {
  const row = O.orderSeries.byArt[code] || [];
  let q = 0, r = 0, p = 0;
  for (let i = Math.max(0, on - days); i < on; i++) {
    q += row[i] || 0;
    const m = OM[OD[i]] && OM[OD[i]][code];
    if (m) { r += m[0] || 0; p += m[2] || 0; }
  }
  return { q, r, p };
}
function wbWindow(cards, days) {
  let q = 0, r = 0;
  for (const c of cards) {
    const row = RD.orderSeries.bySku[c.sku] || [];
    for (let i = Math.max(0, wn - days); i < wn; i++) {
      q += row[i] || 0;
      const m = WM[WD[i]] && WM[WD[i]][c.sku];
      if (m) r += m[0] || 0;
    }
  }
  return { q, r };
}

// --- цена: последние подряд идущие продаж по одной цене (ЦЕНА-04) ------------
function currentPrice(code) {
  const d = ozDaily(code).filter(x => x.price != null);
  if (!d.length) return { price: null, from: null, days: 0, sales: 0 };
  const last = d[d.length - 1];
  let i = d.length - 1, sales = 0;
  while (i >= 0 && Math.abs(d[i].price - last.price) / last.price < 0.005) { sales += d[i].qty; i--; }
  return { price: last.price, from: d[i + 1].date, days: d.length - 1 - i, sales, lastDate: last.date };
}

console.log("\n" + "═".repeat(74));
console.log(" ЦЕНЫ · код 1С " + sup + (ozCard ? " · " + (ozCard.name || "") : ""));
console.log("═".repeat(74));
if (wbCards.length) console.log(" карточки ВБ: " + wbCards.map(c => c.sku).join(", ") + " · склейка " + (wbCards[0].adTag || "(нет)"));
if (ozCard) console.log(" SKU Ozon: " + (ozCard.ozonSku || "—") + " · остаток " + (ozCard.ozStock || 0) + " шт");

// ---------------- OZON --------------------------------------------------------
const o28 = ozWindow(sup, 28);
const cp = currentPrice(sup);
console.log("\n── OZON · МОЯ ЦЕНА (предельная, база экономики — ЦЕНА-01) ──");
if (!cp.price) {
  console.log("  продаж на Озоне не было ВООБЩЕ — цены в снимке нет.");
  console.log("  ⚠ ЦЕНА-03: спросить предельную у продавца, иначе считать нечего.");
} else {
  console.log("  по ПОСЛЕДНИМ продажам:  " + rub(cp.price) + "   ← ЭТУ И БРАТЬ (ЦЕНА-04)");
  console.log("    держится с " + cp.from + " (" + cp.days + " продаж(и) подряд, " + cp.sales + " шт), последняя " + cp.lastDate);
  if (o28.q) {
    const avg = o28.r / o28.q;
    const dev = (cp.price / avg - 1) * 100;
    console.log("  среднее за 28 дней:     " + rub(avg) + (Math.abs(dev) > 2
      ? "   ⚠ отличается на " + dev.toFixed(1) + "% — НЕ БРАТЬ (ЦЕНА-04)"
      : "   (совпадает, цена не менялась)"));
  }
  console.log("  заказов за 28 дней: " + o28.q + (o28.q < FRESH_MIN_ORDERS
    ? "  ⚠ МЕНЬШЕ " + FRESH_MIN_ORDERS + " — ЦЕНА-03: цену ИЗ РЯДА НЕ БРАТЬ, спросить у продавца"
    : "  (достаточно, цене из ряда можно верить)"));
}

console.log("\n── OZON · ЦЕНА ДЛЯ ПОКУПАТЕЛЯ (ЦЕНА-02) ──");
if (o28.r && o28.p) {
  console.log("  оплачено покупателем: " + pct(o28.p / o28.r * 100) + " от предельной = " + rub(o28.p / o28.q) + "/шт");
  console.log("  ⚠ в эту колонку НЕ входит оплата баллами Ozon — витринная цена выше. Точную брать со скрина карточки.");
} else {
  console.log("  нет данных «оплачено покупателем» за окно — витринную цену брать со скрина карточки.");
}

// ---------------- WB ----------------------------------------------------------
const w28 = wbWindow(wbCards, 28);
console.log("\n── ВБ · МОЯ ЦЕНА ──");
if (w28.q) {
  console.log("  чек за 28 дней: " + rub(w28.r / w28.q) + " (" + w28.q + " шт) — цена ПРОДАВЦА, до СПП");
} else {
  console.log("  продаж на ВБ за 28 дней нет.");
}
console.log("  ⚠ ЦЕНЫ ВБ ДЛЯ ПОКУПАТЕЛЯ В СНИМКЕ НЕТ ВООБЩЕ.");
console.log("    Значит сравнивать витрины ВБ и Озона без скрина продавца НЕЛЬЗЯ (ЦЕНА-02):");
console.log("    соинвест разный (Озон фикс 24%, ВБ плавающая СПП), разрыв моих цен");
console.log("    не переносится на полку ни по величине, ни ПО ЗНАКУ.");

// ---------------- СКЛЕЙКА -----------------------------------------------------
const tag = wbCards.length ? wbCards[0].adTag : null;
if (tag) {
  const mates = [...new Set(RD.catalog.filter(c => c.adTag === tag).map(c => String(c.supplierCode)))];
  console.log("\n── СКЛЕЙКА " + tag + " · положение цены внутри (ЦЕНА-05) ──");
  const rows = [];
  for (const s of mates) {
    const cards = RD.catalog.filter(c => String(c.supplierCode) === s);
    const oz = (s === sup && priceArg) ? priceArg : currentPrice(s).price;
    const w = wbWindow(cards, 28);
    const oc = O.catalog.find(c => String(c.sku) === s);
    rows.push({
      s, name: (oc ? oc.name : (cards[0] && cards[0].name) || "").slice(0, 28),
      oz, wb: w.q ? w.r / w.q : null,
      ozQ: ozWindow(s, 28).q, wbQ: w.q, ozStock: oc ? oc.ozStock || 0 : null,
    });
  }
  console.log("  код     " + "товар".padEnd(30) + "Озон ₽    зак28   ост    ВБ ₽      зак28");
  for (const r of rows.sort((a, b) => (b.oz || 0) - (a.oz || 0))) {
    console.log("  " + r.s.padEnd(8) + r.name.padEnd(30) +
      (r.oz ? rub(r.oz) : "—").padStart(9) + String(r.ozQ).padStart(7) +
      String(r.ozStock === null ? "—" : r.ozStock).padStart(7) +
      (r.wb ? rub(r.wb) : "—").padStart(11) + String(r.wbQ).padStart(7) +
      (r.s === sup ? "   ← он" : ""));
  }
  const me = rows.find(r => r.s === sup);
  for (const [lbl, f] of [["Озон", r => r.oz], ["ВБ", r => r.wb]]) {
    const others = rows.filter(r => r.s !== sup && f(r));
    if (!me || !f(me) || !others.length) continue;
    const top = Math.max(...others.map(f));
    const d = (f(me) / top - 1) * 100;
    console.log("  " + lbl + ": он " + (d >= 0 ? "+" : "") + d.toFixed(1) + "% к старшему соседу по склейке");
  }
  console.log("  ⚠ резкая разница положения между площадками объясняет, почему на одной");
  console.log("    площадке товар продаётся, а на другой нет (ЦЕНА-05).");
}

// ---------------- ЭКОНОМИКА ---------------------------------------------------
const price = priceArg || cp.price;
const cost = wbCards.length ? wbCards[0].costPrice : null;
const bo = ozBuyout();
console.log("\n── ЭКОНОМИКА ОЗОНА (РЕК-01) ──");
if (!price || !cost) {
  console.log("  не хватает " + (!price ? "цены" : "") + (!price && !cost ? " и " : "") + (!cost ? "себестоимости" : "") + " — считать нельзя.");
  if (!price) console.log("  передай цену вторым аргументом: node scripts/price-check.cjs " + sup + " 7480");
} else {
  const base5 = BASE_EFF / bo;                  // плата за заказ в базе выкупа (доля из отчётов, РЕК-23)
  const share = cost / price * 100;             // доля себестоимости (выкуп сокращается)
  const brk = 100 - FIX - share;
  const ceil = brk - MARGIN_FLOOR;
  const revB = price * bo;
  const marg = revB - revB * FIX / 100 - cost * bo - revB * base5 / 100;
  const cpoFloor = marg - revB * MARGIN_FLOOR / 100;
  console.log("  предельная " + rub(price) + (priceArg ? " (задана аргументом)" : "") + " · себестоимость " + rub(cost) + " = " + pct(share) + " выручки");
  console.log("  % выкупа " + pct(bo * 100) + " · фикс Озона " + pct(FIX) + " · плата за заказ "
    + (FEE_SHARE ? pct(BASE_EFF) + " от заказанного ₽ (списания по отчётам «Оплата за заказ» " + FEE_SHARE.from + "…" + FEE_SHARE.to + ") = " + pct(base5) + " в выкупе"
      : "не учтена — отчётов «Оплата за заказ» нет (РЕК-23: только из отчётов)"));
  console.log("  безубыточный ДРР " + pct(brk) + "  →  ПОТОЛОК (−" + MARGIN_FLOOR + " п.п.) " + pct(Math.max(0, ceil)));
  console.log("  выручка в выкупе " + rub(revB) + " − фикс " + rub(revB * FIX / 100) + " − себест " + rub(cost * bo) + " − плата за заказ " + rub(revB * base5 / 100));
  console.log("  = МАРЖА С ЗАКАЗА " + rub(marg));
  console.log("  CPO безубытка " + rub(marg) + "   ·   CPO при поле маржи " + rub(cpoFloor));
  console.log("  (РЕК-02: между ними — «работает, не наращивать», выключать только выше CPO безубытка)");
  for (const bid of [6, 8, 10, 12]) {
    console.log("    ставка " + bid + " ₽ → нужна конверсия клик→заказ: безубыток " +
      pct(bid / marg * 100) + " · пол маржи " + (cpoFloor > 0 ? pct(bid / cpoFloor * 100) : "—"));
  }
  if (o28.q) {
    const ordDay = o28.q / 28 * price;
    const sp = ceil / 100 * bo * ordDay, b5d = base5 / 100 * bo * ordDay;
    console.log("  заказано " + rub(ordDay) + "/день → всего на рекламу ≤ " + rub(sp) +
      "/день − плата за заказ " + rub(b5d) + " → НА КЛИКИ ≤ " + rub(sp - b5d) + "/день = " + rub((sp - b5d) * 7) + "/нед");
    if ((sp - b5d) * 7 < 2000) console.log("    недельный бюджет кампании ставь 2 000 ₽ (меньше Ozon не даёт), а расход режь дневным лимитом товара ≤ " + rub(Math.max(0, sp - b5d)) + "/день — минимум это потолок, а не пол (РЕК-17)");
    console.log("  «Целевой расход» (в ЗАКАЗАХ, РЕК-06): " + pct(Math.max(0, (ceil - base5) * bo)));
  }
}
console.log("\nправила целиком: node scripts/rules.cjs preflight цены\n");

function ozBuyout() {
  const h = O.meta && O.meta.buyoutWin && O.meta.buyoutWin.history;
  if (!h || !h.length) return 0.799;
  const last = h[h.length - 1];
  if (last.bySku && last.bySku[sup]) return last.bySku[sup];
  return last.all || 0.799;
}
