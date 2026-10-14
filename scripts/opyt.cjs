#!/usr/bin/env node
/**
 * opyt.cjs — рабочая память по рекламе: закономерности + журнал правок (ОПЫТ.md)
 *
 * Заведено 14.10.2026: «запоминать все закономерности и пытаться повторить результат,
 * имея прошлый опыт… записывай ровно столько, сколько нужно, чтобы принять правильное решение».
 * Отсюда формат: одна строка — один факт, а вывод фильтруется под конкретный код,
 * чтобы не тащить в ответ весь файл.
 *
 *   node scripts/opyt.cjs brief <код>          что мы уже знаем по этому товару + все закономерности
 *   node scripts/opyt.cjs due [дата]           какие правки пора проверять (по умолчанию сегодня)
 *   node scripts/opyt.cjs list                 всё кратко
 *   node scripts/opyt.cjs change "<код>|<что изменено>|<база>|<дата проверки>"   добавить правку
 *   node scripts/opyt.cjs close <ID> "<исход>" пометить исход правки
 *   node scripts/opyt.cjs pattern "<текст>|<эффект>|<где>"                       новая закономерность
 *   node scripts/opyt.cjs confirm <ID> "<где>" засчитать подтверждение
 */
const fs = require("fs");
const path = require("path");
const FILE = path.join(__dirname, "..", "ОПЫТ.md");

const read = () => fs.readFileSync(FILE, "utf8");
const write = s => fs.writeFileSync(FILE, s);

function rows(section) {
  const src = read();
  const i = src.indexOf("## " + section);
  if (i < 0) return [];
  const end = src.indexOf("\n## ", i + 1);
  const block = src.slice(i, end < 0 ? src.length : end);
  return block.split("\n")
    .filter(l => /^\|/.test(l) && !/^\|\s*-+/.test(l) && !/\|\s*ID\s*\|/.test(l))
    .map(l => l.replace(/^\||\|$/g, "").split("|").map(c => c.trim()));
}
const PAT = () => rows("ЗАКОНОМЕРНОСТИ");
const CHG = () => rows("ЖУРНАЛ ПРАВОК КАМПАНИЙ");
const today = () => new Date().toISOString().slice(0, 10);
const ddmm = d => d.slice(8, 10) + "." + d.slice(5, 7);

function cmdBrief(code) {
  if (!code) { console.error("нужен код 1С"); process.exit(1); }
  const mine = CHG().filter(r => r[2] === code);
  console.log("\n╔ ЧТО МЫ УЖЕ ЗНАЕМ — код " + code);
  if (mine.length) {
    console.log("║ правки по этому товару:");
    for (const r of mine) console.log("║   [" + r[0] + "] " + r[1] + " · " + r[3] + "\n║        база: " + r[4] + " · проверить " + r[5] + " · исход: " + (r[6] === "—" ? "ещё нет" : r[6]));
  } else console.log("║ правок по этому товару ещё не было");
  console.log("║");
  console.log("║ закономерности, которые применяются ко ВСЕМ решениям по рекламе Ozon:");
  for (const p of PAT()) console.log("║   [" + p[0] + "] " + p[1] + "\n║        " + p[3] + "  (подтв. " + p[2] + ")");
  console.log("╚ порядок расчёта и настройки — ПРАВИЛА.md: node scripts/rules.cjs preflight реклама-озон\n");
}

function cmdDue(d) {
  const lim = d || today();
  const due = CHG().filter(r => r[6] === "—" && r[5] && r[5] !== "—" && cmp(r[5], lim) <= 0);
  if (!due.length) { console.log("На " + lim + " проверять нечего. Ближайшие:");
    CHG().filter(r => r[6] === "—").slice(0, 5).forEach(r => console.log("  " + r[5] + "  " + r[2] + "  " + r[3])); return; }
  console.log("ПОРА ПРОВЕРИТЬ (" + due.length + "):");
  for (const r of due) console.log("  [" + r[0] + "] " + r[2] + " · " + r[3] + "\n      база: " + r[4]);
  console.log("\nПосле проверки: node scripts/opyt.cjs close <ID> \"<исход>\"");
}
// даты в файле вида «21.10» или «2026-10-21»
function cmp(a, b) {
  const norm = s => /^\d{2}\.\d{2}$/.test(s) ? new Date().getFullYear() + "-" + s.slice(3) + "-" + s.slice(0, 2) : s;
  return norm(a) < norm(b) ? -1 : norm(a) > norm(b) ? 1 : 0;
}

function cmdList() {
  console.log("\nЗАКОНОМЕРНОСТИ (" + PAT().length + "):");
  for (const p of PAT()) console.log("  [" + p[0] + "] подтв. " + p[2] + " · " + p[1]);
  const c = CHG();
  console.log("\nПРАВКИ (" + c.length + ", без исхода " + c.filter(r => r[6] === "—").length + "):");
  for (const r of c) console.log("  [" + r[0] + "] " + r[1] + " " + r[2] + " · " + r[3] + " · проверить " + r[5] + (r[6] === "—" ? "" : " → " + r[6]));
}

function nextId(prefix, list) {
  const n = list.map(r => parseInt((r[0].match(/\d+/) || [0])[0], 10)).reduce((a, b) => Math.max(a, b), 0);
  return prefix + "-" + String(n + 1).padStart(2, "0");
}

function cmdChange(arg) {
  const p = String(arg || "").split("|").map(s => s.trim());
  if (p.length < 4) { console.error('нужно: "<код>|<что изменено>|<база>|<дата проверки>"'); process.exit(1); }
  const list = CHG(), id = nextId("И", list);
  const line = "| " + id + " | " + ddmm(today()) + " | " + p[0] + " | " + p[1] + " | " + p[2] + " | " + p[3] + " | — |";
  let s = read().trimEnd() + "\n" + line + "\n";
  write(s);
  console.log("Записано " + id + ": " + p[0] + " · " + p[1] + " · проверить " + p[3]);
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
  const p = String(arg || "").split("|").map(s => s.trim());
  if (p.length < 3) { console.error('нужно: "<текст>|<эффект>|<где>"'); process.exit(1); }
  const list = PAT(), id = nextId("П", list);
  const line = "| " + id + " | " + p[0] + " | 1 | " + p[1] + " | " + p[2] + " |";
  let s = read();
  const i = s.indexOf("\n---\n\n## ЖУРНАЛ ПРАВОК");
  if (i < 0) { console.error("не нашёл границу разделов"); process.exit(1); }
  s = s.slice(0, i) + "\n" + line + s.slice(i);
  write(s);
  console.log("Записана " + id + ": " + p[0]);
}

function cmdConfirm(id, where) {
  if (!id || !where) { console.error('нужно: confirm <ID> "<где>"'); process.exit(1); }
  let s = read(), done = false;
  s = s.split("\n").map(l => {
    if (!new RegExp("^\\|\\s*" + id + "\\s*\\|").test(l)) return l;
    const c = l.replace(/^\||\|$/g, "").split("|").map(x => x.trim());
    c[2] = String((parseInt(c[2], 10) || 0) + 1);
    c[4] = c[4] + " · " + where;
    done = true;
    return "| " + c.join(" | ") + " |";
  }).join("\n");
  if (!done) { console.error("Не найдена закономерность " + id); process.exit(1); }
  write(s);
  console.log(id + ": подтверждений стало больше, добавлено «" + where + "»");
}

const [, , cmd, a, b] = process.argv;
switch (cmd) {
  case "brief": cmdBrief(a); break;
  case "due": cmdDue(a); break;
  case "list": cmdList(); break;
  case "change": cmdChange(a); break;
  case "close": cmdClose(a, b); break;
  case "pattern": cmdPattern(a); break;
  case "confirm": cmdConfirm(a, b); break;
  default: console.log(read().split("*/")[0].split("/**")[1].trim());
}
