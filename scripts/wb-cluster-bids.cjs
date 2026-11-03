#!/usr/bin/env node
/**
 * wb-cluster-bids.cjs — ставка CPM по каждому кластеру кампании ВБ «Ручная ставка» под ДРР 6% по ключу (03.11.2026).
 *
 *   node scripts/wb-cluster-bids.cjs <кластеры.json> --rev <выручка в выкупе на заказ, ₽> [--drr 6] [--min 220] [--min-views 300]
 *   --min — минимальная ставка ВБ для зоны («не менее 220 ₽» в окне XWAY AI у Поиска, «не менее 90» у Рекомендаций;
 *   своя у товара, в MCP её нет — со скрина продавца). Ставка под 6% ниже минимума → «ниже минимума ВБ»: на ручной
 *   ставке 6% по этому ключу недостижимы — исключать ключ или пробовать «Единую ставку» (у неё минимум ниже, продавец 03.11).
 *
 * ЗАЧЕМ. Продавец 03.11.2026: «главное у нас это ставка, рассчитать необходимую ставку по каждому запросу ты можешь,
 * так что подыгрываем под ДРР по ключу на 6%». Позиции не нужны (ставка их и определяет), почасовая — тоже (время
 * выбираем заранее), полный расход кампании продавец присылает сам (в кластерах MCP видна только часть расхода).
 *
 * ФОРМУЛА. Платим за 1 000 показов. ДРР кластера = расход ÷ (заказы × выручка в выкупе на заказ R).
 *   ставка под цель = цель ДРР × R × заказов на 1 000 показов.
 * Заказов на 1 000 показов у кластера мало, поэтому частоту сглаживаем к средней по кампании (как будто у кластера
 * уже есть 3 «средних» заказа): p = (заказы + 3) ÷ (показы + 3 ÷ p_кампании). Так кластер с 0 заказов на 50 показах
 * не получает ставку 0, а кластер с 1 заказом на 100 показах — ставку до небес.
 *   · кластер без заказов и с показами ≥ --min-views (по умолчанию: столько, сколько кампании в среднем нужно на 2 заказа)
 *     → «исключить»: данных достаточно, а заказа нет;
 *   · ставка ниже текущей более чем вдвое → «снизить»; выше текущей → «можно поднять» (ограничиваем ×1,5 за шаг).
 * Вход — JSON из get_shops_products_campaigns_clusters (XWAY MCP), поля views/orders/expense/bid/excluded.
 */
"use strict";
const fs = require("fs");
const a = process.argv.slice(2), file = a.find(x => !x.startsWith("--") && !/^\d/.test(x));
const opt = k => { const i = a.indexOf("--" + k); return i >= 0 ? +a[i + 1] : null; };
const R = opt("rev"), DRR = (opt("drr") || 6) / 100;
if (!file || !R) { console.error("usage: node scripts/wb-cluster-bids.cjs <кластеры.json> --rev <₽ на заказ в выкупе> [--drr 6]"); process.exit(1); }
const d = JSON.parse(fs.readFileSync(file, "utf8")), it = d.items || [];
const g = (x, k) => +(x[k] || 0);
const V = it.reduce((s, x) => s + g(x, "views"), 0), O = it.reduce((s, x) => s + g(x, "orders"), 0), E = it.reduce((s, x) => s + g(x, "expense"), 0);
const p0 = O / Math.max(1, V), minViews = opt("min-views") || Math.round(2 / Math.max(p0, 1e-6));
console.log(`кампания ${d.campaign_id} · товар ${d.product_id} · ${d.period && d.period.from}…${d.period && d.period.to}`);
console.log(`кластеров ${it.length} · показы ${V} · заказы ${O} · расход по кластерам ${Math.round(E)} ₽ · ДРР по кластерам ${(E / Math.max(1, O * R) * 100).toFixed(1)}%`);
console.log(`R = ${R} ₽ · цель ДРР ${DRR * 100}% → предел на заказ ${Math.round(DRR * R)} ₽ · заказов на 1 000 показов в среднем ${(p0 * 1000).toFixed(2)} → средняя ставка под цель ${Math.round(DRR * R * p0 * 1000)} ₽`);
const rows = it.map(x => {
  const v = g(x, "views"), o = g(x, "orders"), e = g(x, "expense"), bid = x.bid == null ? null : +x.bid;
  const p = (o + 3) / (v + 3 / Math.max(p0, 1e-6));
  let target = Math.round(DRR * R * p * 1000), act;
  const MIN = opt("min");
  if (x.excluded) act = "уже исключён";
  else if (MIN && target < MIN) act = "НИЖЕ МИНИМУМА ВБ";
  else if (!o && v >= minViews) act = "ИСКЛЮЧИТЬ";
  else if (bid && target < bid / 2) act = "СНИЗИТЬ";
  else if (bid && target > bid) { target = Math.min(target, Math.round(bid * 1.5)); act = "можно поднять"; }
  else if (bid && target < bid) act = "снизить";
  else act = "держать";
  return { n: x.name, v, c: g(x, "clicks"), o, e, bid, target, drr: o ? e / (o * R) * 100 : null, act, pop: x.popularity };
}).sort((a, b) => b.e - a.e);
const act = rows.filter(r => r.act !== "уже исключён");
console.log("\nкластер                                    показы клики зак  расход  ДРР%  ставка → под 6%   действие");
act.slice(0, +(opt("top") || 40)).forEach(r => console.log((r.n || "").slice(0, 42).padEnd(42) + String(r.v).padStart(7) + String(r.c).padStart(6) + String(r.o).padStart(4)
  + String(Math.round(r.e)).padStart(8) + (r.drr == null ? "—" : r.drr.toFixed(0)).padStart(6) + String(r.bid == null ? "—" : r.bid).padStart(8) + " → " + String(r.target).padStart(5) + "   " + r.act));
const sum = k => act.filter(r => r.act === k);
if (opt("min")) console.log(`ниже минимума ВБ ${opt("min")} ₽ (6% по ключу недостижимы на ручной ставке): ${sum("НИЖЕ МИНИМУМА ВБ").length} ключей, расход ${Math.round(sum("НИЖЕ МИНИМУМА ВБ").reduce((s, r) => s + r.e, 0))} ₽`);
console.log(`\nИТОГ: исключить ${sum("ИСКЛЮЧИТЬ").length} (расход на них ${Math.round(sum("ИСКЛЮЧИТЬ").reduce((s, r) => s + r.e, 0))} ₽) · снизить ${sum("СНИЗИТЬ").length + sum("снизить").length} · поднять ${sum("можно поднять").length} · держать ${sum("держать").length}`);
if (opt("json")) fs.writeFileSync(file.replace(/\.json$/, "") + ".bids.json", JSON.stringify(rows));
