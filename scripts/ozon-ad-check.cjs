#!/usr/bin/env node
/**
 * ozon-ad-check.cjs — проверка рекламы Ozon «до → после» по снимку, без скринов (02.11.2026).
 *
 *   node scripts/ozon-ad-check.cjs due [дата]        все правки Ozon из ОПЫТ.md, которые пора проверять
 *   node scripts/ozon-ad-check.cjs И-24              одна правка
 *   node scripts/ozon-ad-check.cjs <код 1С> [дней]   подённо по товару (по умолчанию 10 дней)
 *   node scripts/ozon-ad-check.cjs all [дней]        ПОЛНЫЙ ПРОХОД: все товары с рекламой + кандидаты без рекламы (новые приходы)
 *
 * ЗАЧЕМ. Продавец 02.11.2026: «если информацию которую я тебе даю — есть у тебя и она сходится — говори
 * у меня есть… Задача перейти к автоматизации». Подённые выгрузки XWAY Ozon уже несут по каждому товару
 * показы, клики, корзины, ПРИПИСАННЫЕ заказы и расход (ozon-ads-spend.cjs кладёт их в
 * ozon.meta.adSpend.parts[].perf). Значит итог правки по товару считается здесь, а со скрина нужно только
 * то, чего в выгрузке нет: деление по кампаниям («Поиск» / «Поиск и рекомендации»), ставки, стратегии, бюджеты.
 *
 * КАК СУДИМ (СПРАВОЧНИК-ОЗОН, «ЕДИНЫЙ ШАБЛОН», и ПРАВИЛА.md):
 *   · CPO кампании = расход НА КЛИКИ (Клики × CPC, без оплаты за заказ — она уже в доле из отчётов) ÷
 *     приписанные заказы («Заказы, шт»), а не «Общий ДРР» (в нём органика);
 *   · два порога из price-check.cjs --json: CPO при поле маржи и CPO безубытка (между ними — «работает,
 *     не наращивать»);
 *   · конверсия клик→заказ до/после — с z (порог 1,96), разница без z не утверждается;
 *   · меньше 5 приписанных заказов — вывода нет, кроме «убыточно даже в лучшем случае» (верхняя граница
 *     заказов по Пуассону всё равно даёт CPO выше безубытка);
 *   · правка-связка или «НЕ ЧИТАЕТСЯ» (ДАН-10) — итог по товару есть, закономерность не засчитывается;
 *   · остаток — первым: сколько дней проживёт товар на темпе «после».
 * Окно «до» — 3 дня до дня правки (так записана база в журнале), «после» — со дня ПОСЛЕ правки по последний
 * день выгрузки. Выгрузка — по товару целиком, обе кампании вместе.
 */
"use strict";
const fs = require("fs"), path = require("path"), vm = require("vm"), cp = require("child_process");
const DEC = path.join(__dirname, "..", "decrypted", "wb-data.js");
if (!fs.existsSync(DEC)) { console.error("Нет decrypted/wb-data.js — сначала: node scripts/decrypt.cjs <код>"); process.exit(2); }
const ctx = {}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(DEC, "utf8") + "\nglobalThis.__RD=REAL_DATA;", ctx);
const O = ctx.__RD.ozon;
const parts = ((O.meta && O.meta.adSpend && O.meta.adSpend.parts) || []).filter(p => p.perf && p.from === p.to)
  .sort((a, b) => a.from < b.from ? -1 : 1);
if (!parts.length) { console.error("В снимке нет подённых показателей XWAY Ozon (perf). Залей выгрузки: node scripts/ozon-ads-spend.cjs <файл>"); process.exit(1); }
const perfDay = {}; parts.forEach(p => perfDay[p.from] = p.perf);
const LAST = parts[parts.length - 1].from, FIRST = parts[0].from;

const OD = O.orderSeries.dates;
const addDays = (d, n) => { const t = new Date(d + "T00:00:00Z"); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const days = (a, b) => { const r = []; for (let d = a; d <= b; d = addDays(d, 1)) r.push(d); return r; };
const F = n => Math.round(n).toLocaleString("ru-RU");
const P1 = n => (n * 100).toFixed(2).replace(".", ",") + "%";
const catOf = s => (O.catalog || []).find(c => String(c.sku) === String(s)) || {};

const econCache = {};
function econ(sup) {
  if (econCache[sup]) return econCache[sup];
  let e = null;
  try { e = JSON.parse(cp.execFileSync(process.execPath, [path.join(__dirname, "price-check.cjs"), sup, "--json"], { encoding: "utf8" }).trim().split("\n").pop()); } catch (_) {}
  return econCache[sup] = e;
}
function agg(sup, ds) {
  const a = { n: 0, sh: 0, cl: 0, cart: 0, ord: 0, own: 0, clk: 0, spend: 0, q: 0 };
  for (const d of ds) {
    const P = perfDay[d]; if (!P) continue; a.n++;
    const x = P[sup]; if (x) { a.sh += x.sh || 0; a.cl += x.cl || 0; a.cart += x.cart || 0; a.ord += x.ord || 0; a.own += x.own || 0; a.clk += x.clk || 0; }
    const pt = parts.find(p => p.from === d); a.spend += (pt && pt.bySup[sup]) || 0;
    const i = OD.indexOf(d); if (i >= 0) a.q += (O.orderSeries.byArt[sup] || [])[i] || 0;
  }
  return a;
}
function zTwo(x1, n1, x2, n2) {
  if (!n1 || !n2) return null; const p = (x1 + x2) / (n1 + n2); if (p <= 0 || p >= 1) return null;
  return (x2 / n2 - x1 / n1) / Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
}
const poisUp = n => n + 1.96 * Math.sqrt(n + 1) + 2;      // грубая верхняя 95%-граница числа заказов

function verdict(a, e) {
  if (!e || e.missing) return "нет цены или себестоимости — порогов нет (price-check.cjs " + "<код>)";
  if (!a.cl) return a.spend > 0 ? "кликов нет, расход " + F(a.spend) + " ₽ — это оплата за заказ, кампании по кликам не крутились" : "рекламы не было";
  const cpo = a.ord ? a.clk / a.ord : Infinity;
  if (a.ord < 5) {
    const best = a.clk / poisUp(a.ord);
    if (best > e.marg) return "УБЫТОЧНО даже в лучшем случае: " + a.ord + " зак. на " + a.cl + " кл., CPO ≥ " + F(best) + " ₽ при безубытке " + F(e.marg) + " ₽ — резать";
    if (!a.ord && a.cl >= 150) return "СТОП-ПРАВИЛО: " + a.cl + " кликов без заказа";
    return "МАЛО ДАННЫХ: " + a.ord + " зак. (нужно ≥5) — продлить, вывод не делать";
  }
  if (cpo <= e.cpoFloor) return "РАБОТАЕТ С ЗАПАСОМ: CPO " + F(cpo) + " ₽ ≤ пола маржи " + F(e.cpoFloor) + " ₽ — можно наращивать, если хватает остатка";
  if (cpo <= e.marg) return "РАБОТАЕТ, НЕ НАРАЩИВАТЬ: CPO " + F(cpo) + " ₽ между полом " + F(e.cpoFloor) + " и безубытком " + F(e.marg) + " ₽";
  return "ВЫШЕ БЕЗУБЫТКА: CPO " + F(cpo) + " ₽ > " + F(e.marg) + " ₽ — резать ставку/канал";
}
function line(lbl, a) {
  const cpo = a.ord ? F(a.clk / a.ord) + " ₽" : "—";
  return "  " + lbl.padEnd(20) + String(a.n).padStart(2) + " дн · клики/дн " + F(a.cl / (a.n || 1)).padStart(5)
    + " · CPC " + (a.cl ? (a.clk / a.cl).toFixed(1).replace(".", ",") : "—").padStart(5)
    + " · клик→заказ " + (a.cl ? P1(a.ord / a.cl) : "—").padStart(6) + " (" + a.ord + " зак., своих " + a.own + ")"
    + " · CPO " + cpo.padStart(8) + " · на клики/дн " + F(a.clk / (a.n || 1)).padStart(6) + " ₽"
    + " · расход всего/дн " + F(a.spend / (a.n || 1)).padStart(6) + " ₽ · заказы товара/дн " + (a.q / (a.n || 1)).toFixed(1).replace(".", ",");
}
function stockLine(sup, perDay) {
  const c = catOf(sup), st = (c.ozStock || 0) + (c.ozTransit || 0);
  const cover = perDay > 0 ? st / perDay : Infinity;
  return "  остаток Ozon " + F(c.ozStock || 0) + " шт" + (c.ozTransit ? " + " + F(c.ozTransit) + " в пути" : "")
    + (isFinite(cover) ? " → ~" + Math.round(cover) + " дн на темпе «после»" + (cover < 30 ? "  ⚠ меньше 30 дней — не наращивать (ЗАП/РЕК-27)" : "") : "");
}

function checkChange(r) {
  const sup = String(r.code).trim();
  const m = String(r.date).match(/^(\d{2})\.(\d{2})$/);
  const d0 = m ? new Date().getFullYear() + "-" + m[2] + "-" + m[1] : r.date;
  const before = days(addDays(d0, -3), addDays(d0, -1)), after = days(addDays(d0, 1), LAST);
  const A = agg(sup, before), B = agg(sup, after), e = econ(sup);
  console.log("\n[" + r.id + "] Ozon · код " + sup + " · " + (catOf(sup).name || "").slice(0, 50));
  console.log("  правка " + d0 + ": " + r.what);
  if (e && !e.missing) console.log("  пороги CPO: пол маржи " + F(e.cpoFloor) + " ₽ · безубыток " + F(e.marg) + " ₽ (предельная " + F(e.price) + " ₽" + (e.reliable ? "" : ", ⚠ <5 заказов за 28 дн — цену уточнить") + ")");
  console.log(line("до " + before[0].slice(8) + "–" + before[2].slice(8) + "." + before[2].slice(5, 7), A));
  console.log(line("после " + after[0].slice(8) + "." + after[0].slice(5, 7) + "–" + LAST.slice(8) + "." + LAST.slice(5, 7), B));
  const z = zTwo(A.ord, A.cl, B.ord, B.cl);
  if (z != null) console.log("  конверсия клик→заказ: z = " + z.toFixed(2).replace(".", ",") + (Math.abs(z) >= 1.96 ? " — разница НАСТОЯЩАЯ" : " — разница в пределах шума (порог 1,96)"));
  console.log(stockLine(sup, B.q / (B.n || 1)));
  // П-12: приписанные заказы ≠ дополнительные. Заказы товара против фона кабинета Ozon (без самого товара).
  const cab = ds => { let q = 0, n = 0; ds.forEach(d => { const i = OD.indexOf(d); if (i < 0) return; n++;
    Object.entries(O.orderSeries.byArt).forEach(([k, row]) => { if (k !== sup) q += row[i] || 0; }); }); return n ? q / n : 0; };
  const K = cab(before) ? cab(after) / cab(before) : 1;
  if (A.n && B.n) {
    const expD = A.q / A.n * K, actD = B.q / B.n, extra = actD - expD;
    const exp = expD * B.n, varE = A.q * Math.pow(K * B.n / A.n, 2);
    const zq = (B.q - exp) / Math.sqrt(Math.max(1, B.q + varE));
    const dAd = B.clk / B.n - A.clk / A.n;
    console.log("  П-12 заказы товара против фона кабинета (×" + K.toFixed(2).replace(".", ",") + "): ждали " + expD.toFixed(1).replace(".", ",") + "/дн, факт "
      + actD.toFixed(1).replace(".", ",") + "/дн → " + (extra >= 0 ? "+" : "") + extra.toFixed(1).replace(".", ",") + "/дн, z = " + zq.toFixed(2).replace(".", ",")
      + (Math.abs(zq) >= 1.96 ? " (настоящее)" : " (шум)")
      + (extra > 0.3 && dAd > 0 && e && !e.missing ? " · доп. расход на клики " + F(dAd) + " ₽/дн = " + F(dAd / extra) + " ₽ за доп. заказ (безубыток " + F(e.marg) + ")" : ""));
  }
  const cover = (() => { const c = catOf(sup), st = (c.ozStock || 0) + (c.ozTransit || 0), pd = B.q / (B.n || 1); return pd > 0 ? st / pd : Infinity; })();
  let v = verdict(B, e);
  if (cover < 30 && /наращивать, если/.test(v)) v = v.replace(/можно наращивать, если хватает остатка/, "ДЕРЖАТЬ: остатка ~" + Math.round(cover) + " дн, наращивать нельзя");
  console.log("  → " + v);
  if (/СВЯЗКА|НЕ ЧИТАЕТСЯ/i.test(r.what)) console.log("  ⚠ ДАН-10: правка меняла несколько рычагов — итог по товару есть, закономерность не засчитывать");
  if (/П\+Р|Поиск/.test(r.what) && (r.hyp || "").includes("П-01")) console.log("  ⓘ П-01 (канал «Поиск» против «Поиск и рекомендации») по этой выгрузке не делится — нужен экран «Кампании с этим товаром»");
  return { id: r.id, sup, before: A, after: B, e, v };
}

const [, , cmd, arg] = process.argv;
const opyt = require("./opyt.cjs");
const ozonRows = () => opyt.CHG().filter(r => /ozon/i.test(r.mp || "Ozon"));
console.log("Выгрузки XWAY Ozon по товарам в снимке: " + FIRST + " … " + LAST + " (" + parts.length + " дн)");
if (cmd === "due") {
  const lim = arg || new Date().toISOString().slice(0, 10);
  const due = ozonRows().filter(r => opyt.noOut(r) && r.check && r.check !== "—" && opyt.cmp(r.check, lim) <= 0);
  if (!due.length) { console.log("На " + lim + " проверять нечего."); process.exit(0); }
  const res = due.map(checkChange);
  console.log("\n══ СВОДКА (" + res.length + ") ══");
  res.forEach(x => console.log("  " + x.id.padEnd(5) + " " + x.sup + "  " + x.v));
  console.log("\nИсход записать: node scripts/opyt.cjs close <ID> \"<исход>\"");
} else if (cmd === "all") {
  /* ПОЛНЫЙ ПРОХОД (02.11.2026, продавец: «ещё раз проходим все товары… учитывай приходы новых товаров»).
     Последние N дней выгрузки (по умолчанию 6) по КАЖДОМУ товару Ozon: (1) с рекламой — итог и вердикт;
     (2) без рекламы, но с остатком — кандидаты, в первую очередь новые приходы (рост остатка Ozon ≥50 шт за 21 день). */
  const n = +(arg || 6), ds = days(addDays(LAST, -(n - 1)), LAST);
  const SH = O.stockHistory || {}, sd = Object.keys(SH).sort(), sLast = sd[sd.length - 1], sFrom = addDays(sLast, -21);
  const arrived = sup => { let g = 0, gd = ""; for (let i = 1; i < sd.length; i++) { if (sd[i] < sFrom) continue;
    const x = ((SH[sd[i]] || {})[sup] || 0) - ((SH[sd[i - 1]] || {})[sup] || 0); if (x > g) { g = x; gd = sd[i]; } } return { g, gd }; };
  const ozQ28 = sup => { const row = O.orderSeries.byArt[sup] || []; return row.slice(-28).reduce((a, b) => a + (b || 0), 0); };
  const withAd = [], cand = [];
  for (const c of O.catalog) {
    const sup = String(c.sku), a = agg(sup, ds), st = (c.ozStock || 0) + (c.ozTransit || 0);
    if (a.cl > 0 || a.spend > 0) withAd.push({ sup, a, c });
    else if (st >= 50) { const ar = arrived(sup); cand.push({ sup, c, st, ar, q28: ozQ28(sup), qd: a.q / (a.n || 1) }); }
  }
  console.log("\n══ С РЕКЛАМОЙ за " + ds[0] + "…" + LAST + " (" + withAd.length + ") — по товару, обе кампании вместе ══");
  withAd.sort((x, y) => y.a.clk - x.a.clk).forEach(({ sup, a, c }) => {
    const e = econ(sup), pd = a.q / (a.n || 1), cover = pd > 0 ? ((c.ozStock || 0) + (c.ozTransit || 0)) / pd : Infinity;
    let v = verdict(a, e); if (cover < 30 && /наращивать, если/.test(v)) v = v.replace(/можно наращивать, если хватает остатка/, "ДЕРЖАТЬ: остатка ~" + Math.round(cover) + " дн");
    console.log("  " + sup + "  клики " + String(a.cl).padStart(5) + " · зак " + String(a.ord).padStart(3) + " · на клики " + F(a.clk).padStart(7) + " ₽ · остаток " + String(c.ozStock || 0).padStart(5)
      + (isFinite(cover) ? " (~" + Math.round(cover) + " дн)" : "") + "\n      → " + v + "   · " + (c.name || "").slice(0, 40));
  });
  console.log("\n══ БЕЗ РЕКЛАМЫ, остаток ≥50 шт (" + cand.length + ") — сначала новые приходы за 21 день ══");
  cand.sort((x, y) => (y.ar.g >= 50) - (x.ar.g >= 50) || y.st - x.st).forEach(({ sup, c, st, ar, q28, qd }) => {
    const e = econ(sup);
    const cover = qd > 0 ? Math.round(st / qd) + " дн" : "продаж нет";
    console.log("  " + sup + (ar.g >= 50 ? "  ПРИХОД +" + ar.g + " " + ar.gd.slice(5) : "").padEnd(20) + " остаток " + String(st).padStart(5) + " · заказов за 28 дн " + String(q28).padStart(4)
      + " · покрытие " + cover + (e && !e.missing ? " · CPO пол/безуб " + F(e.cpoFloor) + "/" + F(e.marg) + (e.reliable ? "" : " (цена ненадёжна)") : " · цены нет") + "   · " + (c.name || "").slice(0, 40));
  });
} else if (/^И-\d+$/i.test(cmd || "")) {
  const r = ozonRows().find(x => x.id.toUpperCase() === cmd.toUpperCase());
  if (!r) { console.error("нет такой правки Ozon: " + cmd); process.exit(1); }
  checkChange(r);
} else if (cmd && /^\d{5,}$/.test(cmd)) {
  const n = +(arg || 10), ds = days(addDays(LAST, -(n - 1)), LAST), e = econ(cmd);
  console.log("\nOzon · код " + cmd + " · " + (catOf(cmd).name || ""));
  if (e && !e.missing) console.log("пороги CPO: пол маржи " + F(e.cpoFloor) + " ₽ · безубыток " + F(e.marg) + " ₽");
  console.log("дата    показы клики  CPC корзины зак(свои) CPO,₽  на клики,₽ расход всего,₽ заказы товара");
  ds.forEach(d => { const a = agg(cmd, [d]); if (!a.n) { console.log(d.slice(5) + "  нет выгрузки"); return; }
    console.log(d.slice(5) + String(F(a.sh)).padStart(9) + String(a.cl).padStart(6) + (a.cl ? (a.clk / a.cl).toFixed(1) : "—").padStart(6)
      + String(a.cart).padStart(7) + (a.ord + "(" + a.own + ")").padStart(10) + (a.ord ? F(a.clk / a.ord) : "—").padStart(8)
      + F(a.clk).padStart(11) + F(a.spend).padStart(15) + String(a.q).padStart(13)); });
  const T = agg(cmd, ds); console.log(line("итого", T)); console.log(stockLine(cmd, T.q / (T.n || 1))); console.log("  → " + verdict(T, e));
} else {
  console.log(fs.readFileSync(__filename, "utf8").split("*/")[0].replace(/^#!.*\n/, "").replace(/^\/\*+/, "").replace(/^ ?\* ?/gm, "").trim());
}
