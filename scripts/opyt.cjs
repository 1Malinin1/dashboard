#!/usr/bin/env node
/**
 * opyt.cjs — рабочая память по рекламе: закономерности + журнал правок (ОПЫТ.md)
 *
 * Заведено 14.10.2026: «запоминать все закономерности и пытаться повторить результат,
 * имея прошлый опыт… записывай ровно столько, сколько нужно, чтобы принять правильное решение».
 * Отсюда формат: одна строка — один факт, а вывод фильтруется под конкретный код,
 * чтобы не тащить в ответ весь файл.
 *
 *   node scripts/opyt.cjs brief <код> [площадка]   что мы уже знаем по этому товару + закономерности (площадки)
 *   node scripts/opyt.cjs due [дата]               какие правки пора проверять (по умолчанию сегодня)
 *   node scripts/opyt.cjs list                     всё кратко
 *   node scripts/opyt.cjs change "<площадка>|<код>|<что изменено>|<база>|<дата проверки>"   добавить правку
 *   node scripts/opyt.cjs close <ID> "<исход>"     пометить исход правки
 *   node scripts/opyt.cjs pattern "<площадка>|<текст>|<эффект>|<где>"                       новая закономерность
 *   node scripts/opyt.cjs confirm <ID> "<где>"     засчитать подтверждение
 *   node scripts/opyt.cjs add-mp-column [площадка] добавить колонку «площадка» в обе таблицы (один раз)
 *
 * ПЛОЩАДКА — колонка «площадка» (Ozon / ВБ / обе), добавлена 19.10.2026: вкладка «Реклама» показывает блок
 * «Гипотезы и опыты» отдельно по каждой площадке и считает цифры правки по данным именно этой площадки.
 * Код 1С один на обеих площадках, а слова в записи («ОЗЗ», «П+Р») — ненадёжный признак, поэтому площадка
 * пишется явно. Старая форма без площадки (4 части у change, 3 у pattern) работает: пишется «Ozon»
 * (весь журнал до 19.10 — правки кампаний Ozon) с предупреждением.
 * Колонки ищутся ПО ЗАГОЛОВКУ таблицы — так же их читает дашборд (opytMap в index.html); файл без колонки
 * «площадка» тоже читается.
 */
const fs = require("fs");
const path = require("path");
const FILE = path.join(__dirname, "..", "ОПЫТ.md");

const read = () => fs.readFileSync(FILE, "utf8");
const write = s => fs.writeFileSync(FILE, s);

// канонические ключи колонок по заголовку (порядок колонок в файле может быть любым)
const COLS = [["id", /^id$/i], ["mp", /^площадк/i], ["date", /^дата/i], ["code", /^код/i], ["what", /^что/i],
  ["base", /^база/i], ["check", /^проверит/i], ["outcome", /^исход/i], ["text", /^закономерн/i],
  ["conf", /^подтв/i], ["effect", /^эффект/i], ["where", /^где/i]];
const MP_DEFAULT = "Ozon";
function normMp(s) {
  const v = String(s || "").trim().toLowerCase();
  if (/^(ozon|озон)$/.test(v)) return "Ozon";
  if (/^(вб|wb|wildberries)$/.test(v)) return "ВБ";
  if (/^(обе|оба|все)$/.test(v)) return "обе";
  return null;
}
const splitRow = l => l.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(c => c.trim());
const isSep = cells => cells.every(c => /^:?-{2,}:?$/.test(c));

// таблица раздела: шапка, индексы колонок и строки-объекты (с номером строки в файле)
function table(section, src) {
  src = src || read();
  const lines = src.split("\n");
  const i = lines.findIndex(l => l.startsWith("## " + section));
  if (i < 0) return { head: [], idx: {}, rows: [], lines };
  let head = null; const rows = [];
  for (let k = i + 1; k < lines.length && !/^## /.test(lines[k]); k++) {
    if (!/^\|/.test(lines[k])) continue;
    const cells = splitRow(lines[k]);
    if (isSep(cells)) continue;
    if (!head) { head = { cells, line: k }; continue; }
    rows.push({ cells, line: k });
  }
  const idx = {};
  (head ? head.cells : []).forEach((h, n) => { const c = COLS.find(x => x[1].test(h)); if (c && idx[c[0]] == null) idx[c[0]] = n; });
  rows.forEach(r => { r.o = {}; Object.keys(idx).forEach(key => { r.o[key] = r.cells[idx[key]] || ""; }); });
  return { head, idx, rows, lines };
}
const PAT = () => table("ЗАКОНОМЕРНОСТИ").rows.map(r => r.o);
const CHG = () => table("ЖУРНАЛ ПРАВОК КАМПАНИЙ").rows.map(r => r.o);
const today = () => new Date().toISOString().slice(0, 10);
const ddmm = d => d.slice(8, 10) + "." + d.slice(5, 7);
const noOut = r => !r.outcome || r.outcome === "—";
const mpTag = r => r.mp ? "[" + r.mp + "] " : "";

function cmdBrief(code, mp) {
  if (!code) { console.error("нужен код 1С"); process.exit(1); }
  const want = mp ? normMp(mp) : null;
  const okMp = r => !want || !r.mp || r.mp === want || r.mp === "обе";
  const mine = CHG().filter(r => r.code === code && okMp(r));
  console.log("\n╔ ЧТО МЫ УЖЕ ЗНАЕМ — код " + code + (want ? " · " + want : ""));
  if (mine.length) {
    console.log("║ правки по этому товару:");
    for (const r of mine) console.log("║   [" + r.id + "] " + mpTag(r) + r.date + " · " + r.what + "\n║        база: " + r.base + " · проверить " + r.check + " · исход: " + (noOut(r) ? "ещё нет" : r.outcome));
  } else console.log("║ правок по этому товару ещё не было");
  console.log("║");
  console.log("║ закономерности" + (want ? " площадки " + want : " (площадка — в скобках)") + ":");
  for (const p of PAT().filter(okMp)) console.log("║   [" + p.id + "] " + mpTag(p) + p.text + "\n║        " + p.effect + "  (подтв. " + p.conf + ")");
  console.log("╚ порядок расчёта и настройки — ПРАВИЛА.md: node scripts/rules.cjs preflight реклама-озон|реклама-вб\n");
}

function cmdDue(d) {
  const lim = d || today();
  const due = CHG().filter(r => noOut(r) && r.check && r.check !== "—" && cmp(r.check, lim) <= 0);
  if (!due.length) { console.log("На " + lim + " проверять нечего. Ближайшие:");
    CHG().filter(noOut).slice(0, 5).forEach(r => console.log("  " + r.check + "  " + mpTag(r) + r.code + "  " + r.what)); return; }
  console.log("ПОРА ПРОВЕРИТЬ (" + due.length + "):");
  for (const r of due) console.log("  [" + r.id + "] " + mpTag(r) + r.code + " · " + r.what + "\n      база: " + r.base);
  console.log("\nПосле проверки: node scripts/opyt.cjs close <ID> \"<исход>\"");
}
// даты в файле вида «21.10» или «2026-10-21»
function cmp(a, b) {
  const norm = s => /^\d{2}\.\d{2}$/.test(s) ? new Date().getFullYear() + "-" + s.slice(3) + "-" + s.slice(0, 2) : s;
  return norm(a) < norm(b) ? -1 : norm(a) > norm(b) ? 1 : 0;
}

function cmdList() {
  console.log("\nЗАКОНОМЕРНОСТИ (" + PAT().length + "):");
  for (const p of PAT()) console.log("  [" + p.id + "] " + mpTag(p) + "подтв. " + p.conf + " · " + p.text);
  const c = CHG();
  console.log("\nПРАВКИ (" + c.length + ", без исхода " + c.filter(noOut).length + "):");
  for (const r of c) console.log("  [" + r.id + "] " + mpTag(r) + r.date + " " + r.code + " · " + r.what + " · проверить " + r.check + (noOut(r) ? "" : " → " + r.outcome));
}

function nextId(prefix, list) {
  const n = list.map(r => parseInt(((r.id || "").match(/\d+/) || [0])[0], 10)).reduce((a, b) => Math.max(a, b), 0);
  return prefix + "-" + String(n + 1).padStart(2, "0");
}
/* Площадка в начале аргумента: «Ozon|…», «ВБ|…». Без неё (старая форма) — MP_DEFAULT с предупреждением. */
function takeMp(parts, need) {
  const m = normMp(parts[0]);
  if (m && parts.length >= need + 1) return { mp: m, rest: parts.slice(1) };
  if (m) return null;                    // площадка названа, но частей не хватает — не записывать «ВБ» в колонку кода
  if (parts.length >= need) {
    console.warn("площадка не указана — записываю «" + MP_DEFAULT + "». Для Wildberries начните с «ВБ|».");
    return { mp: MP_DEFAULT, rest: parts };
  }
  return null;
}
// строка таблицы в порядке её колонок (колонки «площадка» в файле может и не быть — тогда пропускается)
function rowLine(T, o) {
  const keys = T.head.cells.map(h => { const c = COLS.find(x => x[1].test(h)); return c ? c[0] : null; });
  return "| " + keys.map(k => (k && o[k] != null) ? o[k] : "").join(" | ") + " |";
}

function cmdChange(arg) {
  const t = takeMp(String(arg || "").split("|").map(s => s.trim()), 4);
  if (!t) { console.error('нужно: "<площадка>|<код>|<что изменено>|<база>|<дата проверки>"'); process.exit(1); }
  const p = t.rest;
  const T = table("ЖУРНАЛ ПРАВОК КАМПАНИЙ");
  if (!T.head) { console.error("не нашёл таблицу журнала"); process.exit(1); }
  const id = nextId("И", T.rows.map(r => r.o));
  const line = rowLine(T, { id, mp: t.mp, date: ddmm(today()), code: p[0], what: p[1], base: p[2], check: p[3], outcome: "—" });
  write(read().trimEnd() + "\n" + line + "\n");
  console.log("Записано " + id + " [" + t.mp + "]: " + p[0] + " · " + p[1] + " · проверить " + p[3]);
}

function cmdClose(id, outcome) {
  if (!id || !outcome) { console.error('нужно: close <ID> "<исход>"'); process.exit(1); }
  let s = read();
  const re = new RegExp("^(\\|\\s*" + id + "\\s*\\|.*\\|)\\s*—\\s*\\|\\s*$", "m");
  if (!re.test(s)) { console.error("Не найдена правка " + id + " без исхода"); process.exit(1); }
  s = s.replace(re, "$1 " + outcome + " |");
  write(s);
  console.log(id + " закрыт: " + outcome);
}

function cmdPattern(arg) {
  const t = takeMp(String(arg || "").split("|").map(s => s.trim()), 3);
  if (!t) { console.error('нужно: "<площадка>|<текст>|<эффект>|<где>"'); process.exit(1); }
  const p = t.rest;
  const T = table("ЗАКОНОМЕРНОСТИ");
  if (!T.head) { console.error("не нашёл таблицу закономерностей"); process.exit(1); }
  const id = nextId("П", T.rows.map(r => r.o));
  const line = rowLine(T, { id, mp: t.mp, text: p[0], conf: "1", effect: p[1], where: p[2] });
  let s = read();
  const i = s.indexOf("\n---\n\n## ЖУРНАЛ ПРАВОК");
  if (i < 0) { console.error("не нашёл границу разделов"); process.exit(1); }
  s = s.slice(0, i) + "\n" + line + s.slice(i);
  write(s);
  console.log("Записана " + id + " [" + t.mp + "]: " + p[0]);
}

function cmdConfirm(id, where) {
  if (!id || !where) { console.error('нужно: confirm <ID> "<где>"'); process.exit(1); }
  const T = table("ЗАКОНОМЕРНОСТИ"), r = T.rows.find(x => x.o.id === id);
  if (!r || T.idx.conf == null || T.idx.where == null) { console.error("Не найдена закономерность " + id); process.exit(1); }
  const c = r.cells.slice();
  c[T.idx.conf] = String((parseInt(c[T.idx.conf], 10) || 0) + 1);
  c[T.idx.where] = c[T.idx.where] + " · " + where;
  T.lines[r.line] = "| " + c.join(" | ") + " |";
  write(T.lines.join("\n"));
  console.log(id + ": подтверждений стало больше, добавлено «" + where + "»");
}

/* Один раз: вставить колонку «площадка» в обе таблицы (после ID у закономерностей, после «дата» у журнала),
   существующим строкам — указанная площадка. Повторный запуск ничего не меняет. */
function cmdAddMpColumn(mpArg) {
  const mp = normMp(mpArg || MP_DEFAULT);
  if (!mp) { console.error("площадка: Ozon / ВБ / обе"); process.exit(1); }
  let s = read(), changed = 0;
  for (const [sec, after] of [["ЗАКОНОМЕРНОСТИ", "id"], ["ЖУРНАЛ ПРАВОК КАМПАНИЙ", "date"]]) {
    const T = table(sec, s);
    if (!T.head) continue;
    if (T.idx.mp != null) { console.log(sec + ": колонка «площадка» уже есть"); continue; }
    const at = T.idx[after] + 1;
    const ins = (k, v) => { const c = splitRow(T.lines[k]); c.splice(at, 0, v); T.lines[k] = "| " + c.join(" | ") + " |"; };
    ins(T.head.line, "площадка");
    const sep = T.lines.findIndex((l, k) => k > T.head.line && /^\|/.test(l) && isSep(splitRow(l)));
    if (sep > 0) T.lines[sep] = "|" + "---|".repeat(splitRow(T.lines[sep]).length + 1);   // тот же вид «|---|---|»
    T.rows.forEach(r => ins(r.line, mp));
    s = T.lines.join("\n"); changed += T.rows.length;
    console.log(sec + ": колонка добавлена, строк — " + T.rows.length + " (" + mp + ")");
  }
  if (changed) write(s);
}

const [, , cmd, a, b] = process.argv;
switch (cmd) {
  case "brief": cmdBrief(a, b); break;
  case "due": cmdDue(a); break;
  case "list": cmdList(); break;
  case "change": cmdChange(a); break;
  case "close": cmdClose(a, b); break;
  case "pattern": cmdPattern(a); break;
  case "confirm": cmdConfirm(a, b); break;
  case "add-mp-column": cmdAddMpColumn(a); break;
  default: console.log(read().split("*/")[0].split("/**")[1].trim());
}
