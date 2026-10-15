#!/usr/bin/env node
/**
 * ozon-ozz-detect.cjs <выгрузка XWAY Ozon.xlsx> [--apply]
 *
 * Находит, с каких товаров списывается ОПЛАТА ЗА ЗАКАЗ, прямо из выгрузки — не спрашивая
 * продавца про тумблеры. Правило РЕК-15.
 *
 * ЗАЧЕМ. Тумблер продавца не говорит, за что реально снимают деньги: после выключения оплаты
 * за заказ Ozon ещё до 30 дней списывает «хвост» по прежней ставке за заказы, приписанные к ней
 * раньше (продавец, 15.10.2026; правило РЕК-20 вместо РЕК-15/РЕК-19). Пока хвост идёт, ставка
 * 10/23% стоит в выгрузке вместо базовых 5%, и добавлять 5% поверх нельзя; хвост исчез — код
 * из ozzOn убираем. Версия 14.10 про «чужое продвижение в общем кабинете» не подтвердилась:
 * кампания 5357348 товаров продавца не содержит.
 *
 * КАК СЧИТАЕТСЯ. В выгрузке есть «Расход, руб», «Клики» и «CPC, руб»:
 *     расход кликов = Клики × CPC
 *     остаток       = Расход − расход кликов     ← это и есть оплата за заказ
 * Ставка оценивается как остаток ÷ «Продажи, руб» (атрибуция неполная, поэтому доля ниже ставки):
 * до 10,5% → ставка 10%, выше → 23%.
 *
 * Печатает расхождение с текущим ozon.meta.ozzOn и с --apply приводит список в соответствие.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const XLSX = require("xlsx");

const OUT = path.join(__dirname, "..", "decrypted");
const file = process.argv[2];
const apply = process.argv.includes("--apply");
if (!file) { console.error("usage: node scripts/ozon-ozz-detect.cjs <выгрузка XWAY.xlsx> [--apply]"); process.exit(1); }

const ctx = {}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(OUT, "wb-data.js"), "utf8") + "\nglobalThis.__RD=REAL_DATA;", ctx);
const RD = ctx.__RD, O = RD.ozon || {};
O.meta = O.meta || {};
const ozzBox = O.meta.ozzOn || {};
const prev = Object.assign({}, ozzBox.bySup || {});

// наши = артикул ∈ supplierCode каталога ВБ
const ours = new Set(RD.catalog.map(c => String(c.supplierCode || "").trim()).filter(Boolean));
const nameBySup = {};
(O.catalog || []).forEach(c => { nameBySup[String(c.sku)] = c.name || ""; });

const num = v => {
  const s = String(v == null ? "" : v).replace(/[₽\s ]/g, "").replace(/,/g, "");
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
};

const wb = XLSX.readFile(file);
const sh = wb.Sheets[wb.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(sh, { header: 1, raw: false, defval: "" });
const head = rows[0].map(x => String(x).trim());
const idx = n => head.findIndex(h => h.toLowerCase() === n.toLowerCase());
const need = { art: idx("Артикул"), spend: idx("Расход, руб"), clicks: idx("Клики"), cpc: idx("CPC, руб"), sales: idx("Продажи, руб") };
for (const [k, v] of Object.entries(need)) {
  if (v < 0) { console.error("Нет колонки для «" + k + "». Шапка файла:\n  " + head.join(" | ")); process.exit(2); }
}

const found = [];
for (let i = 1; i < rows.length; i++) {
  const r = rows[i]; if (!r || !r.length) continue;
  const art = String(r[need.art] || "").trim();
  if (!art || !ours.has(art)) continue;
  const spend = num(r[need.spend]), clicks = num(r[need.clicks]), cpc = num(r[need.cpc]), sales = num(r[need.sales]);
  if (spend <= 0) continue;
  const clickSpend = clicks * cpc;
  const ozz = spend - clickSpend;
  if (ozz < Math.max(1, spend * 0.02)) continue;          // шум округления CPC
  const share = sales > 0 ? ozz / sales * 100 : null;
  found.push({ art, spend, clicks, clickSpend, ozz, sales, share, rate: share == null ? null : (share <= 10.5 ? 10 : 23) });
}
found.sort((a, b) => b.ozz - a.ozz);

const rub = v => Math.round(v).toLocaleString("ru-RU") + " ₽";
console.log("\nОПЛАТА ЗА ЗАКАЗ ПО ДАННЫМ ВЫГРУЗКИ — " + path.basename(file));
console.log("расход ОЗЗ = «Расход» − Клики × CPC   (правило РЕК-20)\n");
if (!found.length) {
  console.log("  Ни по одному нашему товару остатка нет: весь расход объясняется кликами.");
} else {
  console.log("  код      расход   из них клики   ОСТАТОК (ОЗЗ)   продажи     доля   ставка");
  for (const f of found)
    console.log("  " + f.art.padEnd(8) + rub(f.spend).padStart(9) + rub(f.clickSpend).padStart(14) +
      rub(f.ozz).padStart(15) + rub(f.sales).padStart(11) +
      (f.share == null ? "     —" : (f.share.toFixed(1) + "%").padStart(8)) +
      (f.rate ? ("   " + f.rate + "%") : "      ?") + "  " + (nameBySup[f.art] || "").slice(0, 32));
}

const now = {};
found.forEach(f => { if (f.rate) now[f.art] = f.rate; });
const add = Object.keys(now).filter(k => prev[k] !== now[k]);
const gone = Object.keys(prev).filter(k => !(k in now));
console.log("\nСверка со списком ozon.meta.ozzOn (в нём сейчас " + Object.keys(prev).length + " кодов):");
if (add.length) {
  console.log("  ДОБАВИТЬ/ПОПРАВИТЬ: " + add.map(k => k + "=" + now[k] + "%" + (prev[k] ? " (было " + prev[k] + "%)" : "")).join(" · "));
  console.log("  (если тумблер у кода уже выключен — это хвост до 30 дней после выключения, РЕК-20: ждать, а не искать виноватого)");
}
if (gone.length) console.log("  СПИСАНИЙ БОЛЬШЕ НЕТ (кандидаты на удаление): " + gone.join(" · ") +
  "\n    ⚠ одна выгрузка — один день; убирать только если остаток пуст несколько выгрузок подряд");
if (!add.length && !gone.length) console.log("  расхождений нет");

if (apply) {
  const next = Object.assign({}, prev);
  for (const k of add) next[k] = now[k];
  O.meta.ozzOn = Object.assign({}, ozzBox, { bySup: next, setAt: new Date().toISOString().slice(0, 10) });
  fs.writeFileSync(path.join(OUT, "wb-data.js"), "const REAL_DATA = " + JSON.stringify(RD) + ";\n");
  console.log("\nЗаписано: в ozzOn теперь " + Object.keys(next).length + " кодов. Дальше: node scripts/encrypt.cjs <код>");
  console.log("Удаление НЕ автоматическое — только руками: node scripts/ozon-ozz.cjs drop <код>");
} else if (add.length || gone.length) {
  console.log("\nСУХОЙ ПРОГОН. Применить добавления: повторите с --apply");
}
