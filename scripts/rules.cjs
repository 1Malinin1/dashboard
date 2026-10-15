#!/usr/bin/env node
/**
 * rules.cjs — работа со сводом правил ПРАВИЛА.md
 *
 * Зачем: контекст сессии не переживает перерыв, и правило, однажды выведенное из ошибки,
 * возвращается ошибкой же. Свод даёт правилам номер, статус и историю отмен, а этот скрипт —
 * способ их найти и проверить целостность.
 *
 *   node scripts/rules.cjs list [тема]        список правил (кратко)
 *   node scripts/rules.cjs show <ID>          одно правило целиком
 *   node scripts/rules.cjs find <слово...>    поиск по тексту
 *   node scripts/rules.cjs preflight <тема>   чек-лист перед ответом по теме
 *   node scripts/rules.cjs check              проверка целостности свода
 *   node scripts/rules.cjs revoke <ID> --вместо <ID>   пометить правило отменённым
 *   node scripts/rules.cjs themes             какие темы есть
 */
const fs = require("fs");
const path = require("path");

const FILE = path.join(__dirname, "..", "ПРАВИЛА.md");

const FIELDS = {
  "статус": "status", "с": "since", "отменено": "revokedAt", "заменено на": "replacedBy",
  "отменяет": "revokes", "темы": "themes", "источник": "source", "правило": "rule",
  "правило (как было)": "rule", "почему отменено": "whyRevoked", "проверка": "check",
  "цена ошибки": "cost", "исключение": "exception", "примечание": "note",
};
const REQUIRED = ["status", "since", "rule"];
const ID_RE = /^[А-ЯЁA-Z]+-\d{2}$/;

function parse() {
  if (!fs.existsSync(FILE)) {
    console.error("Нет файла " + FILE);
    process.exit(2);
  }
  const lines = fs.readFileSync(FILE, "utf8").split(/\r?\n/);
  const rules = [];
  let cur = null, section = "";
  for (const line of lines) {
    let m = /^#\s+(.+)$/.exec(line);
    if (m && !/^#\s/.test(line.slice(1))) { section = m[1].trim(); continue; }
    m = /^###\s+([^\s·]+)\s*·\s*(.+)$/.exec(line);
    if (m) {
      cur = { id: m[1].trim(), title: m[2].trim(), section, themes: "", raw: [] };
      rules.push(cur);
      continue;
    }
    if (!cur) continue;
    cur.raw.push(line);
    m = /^-\s+\*\*(.+?):\*\*\s*(.*)$/.exec(line);
    if (m) {
      const key = FIELDS[m[1].trim().toLowerCase()];
      cur._last = key || null;
      if (key) cur[key] = (cur[key] ? cur[key] + " " : "") + m[2].trim();
      continue;
    }
    // продолжение многострочного поля (вложенный список или перенос)
    if (cur._last && /^\s+\S/.test(line)) {
      cur[cur._last] += " " + line.trim();
    }
  }
  for (const r of rules) {
    delete r._last;
    r.themeList = r.themes ? r.themes.split(",").map(s => s.trim()).filter(Boolean) : [];
    r.text = r.raw.join("\n");
  }
  return rules;
}

const PAD = (s, n) => String(s) + " ".repeat(Math.max(0, n - String(s).length));
const active = r => r.status && r.status.startsWith("действует");

function cmdList(theme) {
  const rules = parse();
  const sel = theme ? rules.filter(r => r.themeList.includes(theme)) : rules;
  if (!sel.length) {
    console.log(theme ? `Правил по теме «${theme}» нет. Темы: ${themesOf(rules).join(", ")}` : "Свод пуст.");
    return;
  }
  let sec = null;
  for (const r of sel) {
    if (r.section !== sec) { sec = r.section; console.log("\n— " + sec + " —"); }
    const mark = active(r) ? " " : "✗";
    console.log(` ${mark} ${PAD(r.id, 10)} ${r.title}${active(r) ? "" : "  (отменено → " + (r.replacedBy || "?") + ")"}`);
  }
  const act = sel.filter(active).length;
  console.log(`\nвсего ${sel.length}, действует ${act}, отменено ${sel.length - act}`);
}

function cmdShow(id) {
  const r = parse().find(x => x.id.toLowerCase() === String(id).toLowerCase());
  if (!r) { console.error("Нет правила " + id); process.exit(1); }
  console.log(`\n### ${r.id} · ${r.title}   [${r.section}]`);
  console.log(r.text.replace(/^\n+|\n+$/g, ""));
}

function cmdFind(words) {
  const q = words.join(" ").toLowerCase();
  const hits = parse().filter(r => (r.id + " " + r.title + " " + r.text).toLowerCase().includes(q));
  if (!hits.length) { console.log("Ничего не нашлось по «" + q + "»"); return; }
  for (const r of hits) {
    console.log(`${active(r) ? " " : "✗"} ${PAD(r.id, 10)} ${r.title}`);
    const rule = (r.rule || "").replace(/\s+/g, " ");
    console.log("    " + rule.slice(0, 160) + (rule.length > 160 ? "…" : ""));
  }
  console.log(`\nнайдено ${hits.length}; целиком — node scripts/rules.cjs show <ID>`);
}

function themesOf(rules) {
  const s = new Set();
  for (const r of rules) r.themeList.forEach(t => s.add(t));
  return [...s].sort();
}

function cmdPreflight(theme) {
  const rules = parse();
  if (!theme) {
    console.log("Укажи тему. Доступные: " + themesOf(rules).join(" · "));
    process.exit(1);
  }
  const sel = rules.filter(r => active(r) && r.themeList.includes(theme));
  if (!sel.length) {
    console.log(`По теме «${theme}» действующих правил нет. Темы: ${themesOf(rules).join(", ")}`);
    return;
  }
  console.log("\n╔" + "═".repeat(68));
  console.log(`║ ЧЕК-ЛИСТ ПЕРЕД ОТВЕТОМ — тема «${theme}», ${sel.length} правил`);
  if (/реклам/i.test(theme)) {
    // Механика Ozon/XWAY вынесена из CLAUDE.md 14.10.2026, чтобы не грузить её в каждое
    // сообщение. Без этого напоминания сессия её просто не откроет и будет решать на память.
    console.log("║");
    console.log("║ ⚠ СНАЧАЛА ПРОЧИТАЙ ЦЕЛИКОМ: СПРАВОЧНИК-ОЗОН.md");
    console.log("║   (механика XWAY, порядок расчёта по товару, единый шаблон запуска,");
    console.log("║    разбор уже оплаченных ошибок). Без него решения принимать нельзя.");
  }
  console.log("╚" + "═".repeat(68));
  for (const r of sel) {
    console.log(`\n[${r.id}] ${r.title}`);
    const rule = (r.rule || "").replace(/\s+/g, " ");
    console.log("  " + wrap(rule, 76, "  "));
    if (r.check) console.log("  проверка: " + wrap(r.check.replace(/\s+/g, " "), 76, "  "));
  }
  console.log("\n— Пройди каждый пункт и напиши в ответе, что проверено. Пропуск = ошибка.\n");
}

function wrap(s, n, pad) {
  const out = []; let line = "";
  for (const w of String(s).split(" ")) {
    if ((line + " " + w).trim().length > n) { out.push(line.trim()); line = w; }
    else line += " " + w;
  }
  if (line.trim()) out.push(line.trim());
  return out.join("\n" + pad);
}

function cmdCheck() {
  const rules = parse();
  const err = [], warn = [];
  const byId = new Map();
  for (const r of rules) {
    if (!ID_RE.test(r.id)) err.push(`${r.id}: номер не в формате РАЗДЕЛ-NN`);
    if (byId.has(r.id)) err.push(`${r.id}: номер встречается дважды`);
    byId.set(r.id, r);
    for (const f of REQUIRED) if (!r[f]) err.push(`${r.id}: нет обязательного поля «${f}»`);
    if (r.status && !/^(действует|отменено)/.test(r.status)) err.push(`${r.id}: статус «${r.status}» не «действует»/«отменено»`);
    if (!r.themeList.length) warn.push(`${r.id}: не указаны темы — правило не попадёт в preflight`);
    if (active(r) && !r.source) warn.push(`${r.id}: нет источника (цитата продавца или замер)`);
    if (active(r) && !r.check && !r.cost) warn.push(`${r.id}: нет ни проверки, ни цены ошибки`);
  }
  for (const r of rules) {
    if (!active(r)) {
      if (!r.replacedBy) err.push(`${r.id}: отменено, но не указано «заменено на»`);
      else if (!byId.has(r.replacedBy.trim())) err.push(`${r.id}: заменено на ${r.replacedBy}, которого нет в своде`);
      if (!r.revokedAt) warn.push(`${r.id}: отменено, но нет даты отмены`);
    }
    if (r.revokes) {
      for (const t of r.revokes.split(",").map(s => s.trim())) {
        const tgt = byId.get(t);
        if (!tgt) err.push(`${r.id}: отменяет ${t}, которого нет в своде`);
        else if (active(tgt)) err.push(`${r.id}: отменяет ${t}, но у ${t} статус «действует» — противоречие`);
      }
    }
  }
  console.log(`правил ${rules.length}, действует ${rules.filter(active).length}, отменено ${rules.filter(r => !active(r)).length}`);
  console.log("темы: " + themesOf(rules).join(" · "));
  if (warn.length) { console.log("\nпредупреждения (" + warn.length + "):"); warn.forEach(w => console.log("  · " + w)); }
  if (err.length) { console.log("\nОШИБКИ (" + err.length + "):"); err.forEach(e => console.log("  ✗ " + e)); process.exit(1); }
  console.log("\nсвод целостен ✓");
}

function cmdRevoke(id, insteadOf) {
  if (!insteadOf) { console.error("Нужно: revoke <ID> --вместо <новый ID>"); process.exit(1); }
  const rules = parse();
  const r = rules.find(x => x.id === id);
  if (!r) { console.error("Нет правила " + id); process.exit(1); }
  if (!active(r)) { console.error(id + " уже отменено"); process.exit(1); }
  const today = new Date().toISOString().slice(0, 10);
  let src = fs.readFileSync(FILE, "utf8");
  const head = `### ${r.id} · ${r.title}`;
  const i = src.indexOf(head);
  const stPat = /- \*\*статус:\*\* .*/;
  const tail = src.slice(i);
  const next = tail.indexOf("\n### ", 1);
  let block = next === -1 ? tail : tail.slice(0, next);
  const newBlock = block
    .replace(head, `### ${r.id} · (ОТМЕНЕНО) ${r.title}`)
    .replace(stPat, `- **статус:** отменено`)
    .replace(/- \*\*правило:\*\*/, `- **отменено:** ${today}\n- **заменено на:** ${insteadOf}\n- **правило (как было):**`);
  src = src.slice(0, i) + newBlock + (next === -1 ? "" : tail.slice(next));
  fs.writeFileSync(FILE, src);
  console.log(`${id} помечено отменённым, замена ${insteadOf}.`);
  console.log("Теперь заведи новое правило вручную и поставь ему поле «отменяет: " + id + "», потом прогони check.");
}

const [, , cmd, ...rest] = process.argv;
const flagIdx = rest.indexOf("--вместо");
const insteadOf = flagIdx >= 0 ? rest[flagIdx + 1] : null;
const args = flagIdx >= 0 ? rest.slice(0, flagIdx) : rest;

switch (cmd) {
  case "list": cmdList(args[0]); break;
  case "show": cmdShow(args[0]); break;
  case "find": cmdFind(args); break;
  case "preflight": cmdPreflight(args[0]); break;
  case "check": cmdCheck(); break;
  case "revoke": cmdRevoke(args[0], insteadOf); break;
  case "themes": console.log(themesOf(parse()).join("\n")); break;
  default:
    console.log(fs.readFileSync(__filename, "utf8").split("*/")[0].split("/**")[1].trim());
}
