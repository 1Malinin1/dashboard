#!/usr/bin/env node
/**
 * memo-audit.cjs [файл=CLAUDE.md] — опись «несущих» элементов памятки.
 *
 * ЗАЧЕМ. CLAUDE.md сжимается, и главный риск — что при переписывании молча выпадет
 * имя функции, поле данных, числовая константа или запрет («не возвращай X»).
 * Такая пропажа не даёт ни ошибки, ни пустой таблицы: следующая сессия просто не знает,
 * что правило было, и «чинит» обратно. Поэтому опись снимается ДО и ПОСЛЕ, и сравнивается.
 *
 *   node scripts/memo-audit.cjs            — печатает опись
 *   node scripts/memo-audit.cjs --save X   — сохраняет опись в X.json
 *   node scripts/memo-audit.cjs --diff X   — что пропало против сохранённой описи
 */
const fs = require("fs"), path = require("path");
const args = process.argv.slice(2);
// значения флагов (--save X, --diff X) не должны приниматься за имя разбираемого файла
const flagVals = new Set();
args.forEach((a, i) => { if (a === "--save" || a === "--diff") flagVals.add(args[i + 1]); });
const file = args.find(a => !a.startsWith("--") && !flagVals.has(a)) || "CLAUDE.md";
const root = path.join(__dirname, "..");
const src = fs.readFileSync(path.join(root, file), "utf8");

// 1. Идентификаторы кода в обратных кавычках: функции, поля, файлы, константы.
//    Это главная связка памятки с кодом — потеря такого имени рвёт её молча.
const ident = new Set();
for (const m of src.matchAll(/`([^`\n]{2,80})`/g)) {
  const t = m[1].trim();
  if (/^[A-Za-zА-Яа-я0-9_$][\w$.\-/]*(\(\))?$/.test(t) && /[A-Za-z_]/.test(t)) ident.add(t);
}
// 2. Числовые константы с единицей — пороги, по которым принимаются решения.
const num = new Set();
for (const m of src.matchAll(/(\d[\d  ,.]*)\s*(₽\/дн|₽\/день|₽\/нед|₽|%|п\.п\.|шт|дн|дней|дня)/g))
  num.add((m[1].replace(/[  ]/g, "") + " " + m[2]).trim());
// 3. Запреты и требования синхронности — то, ради чего памятка и существует.
const BAN = /(не возвращай|НЕ ВОЗВРАЩАЙ|держи синхронно|ДЕРЖИ СИНХРОННО|не удаляй|НЕ УДАЛЯЙ|не трогай|НЕ ТРОГАЙ|капкан|КАПКАН|не заменяй|не «чини»|не чини|не путай|НЕ ПУТАЙ|обязан|ОБЯЗАН|нельзя|НЕЛЬЗЯ)/;
const bans = src.split("\n").map((l, i) => [i + 1, l]).filter(([, l]) => BAN.test(l));
// Сравнивать строки-запреты ДОСЛОВНО нельзя: при сжатии текст переформулируется, и каждая
// переписанная строка выглядит пропажей. Поэтому ключ запрета = слово-запрет + идентификаторы
// в той же строке. Если такая пара где-то в файле осталась — правило не потеряно.
// Ключ раскладывается на ПАРЫ «слово-запрета + ОДИН идентификатор»: при переформулировке
// переносы строк уезжают, и привязка к целой строке снова давала бы ложные пропажи.
const banKeys = l => {
  const w = (l.match(BAN) || [""])[0].toLowerCase();
  const ids = [...l.matchAll(/`([^`\n]{2,60})`/g)].map(m => m[1].trim());
  return ids.length ? ids.map(i => w + "|" + i) : [w + "|—"];
};

const inv = { ident: [...ident].sort(), num: [...num].sort(), bans: bans.length,
              banText: bans.map(([n, l]) => l.trim().slice(0, 120)),
              banKeys: [...new Set(bans.flatMap(([, l]) => banKeys(l)))], bytes: Buffer.byteLength(src, 'utf8'),
              lines: src.split("\n").length, heads: (src.match(/^#{2,3} .*/gm) || []) };

const save = args.indexOf("--save"), diff = args.indexOf("--diff");
if (save >= 0) {
  fs.writeFileSync(path.join(root, args[save + 1]), JSON.stringify(inv, null, 1));
  console.log("опись сохранена: " + args[save + 1]);
}
if (diff >= 0) {
  const old = JSON.parse(fs.readFileSync(path.join(root, args[diff + 1]), "utf8"));
  const gone = (a, b) => a.filter(x => !b.includes(x));
  const gi = gone(old.ident, inv.ident), gn = gone(old.num, inv.num), gh = gone(old.heads, inv.heads);
  const gb = gone(old.banKeys || [], inv.banKeys || []);
  console.log("\nБЫЛО: " + old.bytes.toLocaleString("ru-RU") + " байт, " + old.lines + " строк");
  console.log("СТАЛО: " + inv.bytes.toLocaleString("ru-RU") + " байт, " + inv.lines + " строк  ("
    + (100 - inv.bytes / old.bytes * 100).toFixed(1) + "% сжатия)\n");
  const блок = (t, a) => { console.log(t + ": " + a.length); a.slice(0, 400).forEach(x => console.log("   " + x)); };
  блок("ПРОПАЛИ ИДЕНТИФИКАТОРЫ", gi);
  блок("ПРОПАЛИ КОНСТАНТЫ", gn);
  блок("ПРОПАЛИ ЗАГОЛОВКИ", gh);
  console.log("ПРОПАЛИ ЗАПРЕТЫ (по ключу «слово+идентификаторы»): " + gb.length + "   [строк всего: было " + old.bans + ", стало " + inv.bans + "]");
  gb.slice(0, 200).forEach(x => console.log("   " + x));
  if (!gi.length && !gn.length && !gh.length && !gb.length) console.log("\n✓ не пропало НИЧЕГО");
  process.exit(0);
}
if (save < 0) {
  console.log(file + ": " + inv.bytes.toLocaleString("ru-RU") + " байт, " + inv.lines + " строк");
  console.log("  идентификаторов кода: " + inv.ident.length);
  console.log("  числовых констант:    " + inv.num.length);
  console.log("  строк-запретов:       " + inv.bans);
  console.log("  заголовков:           " + inv.heads.length);
}
