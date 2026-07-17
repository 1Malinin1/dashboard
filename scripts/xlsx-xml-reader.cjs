// Резервный читатель .xlsx напрямую по XML внутри архива — используйте, когда
// SheetJS (XLSX.read) виснет/падает на большом файле с богатой структурой
// (много листов, comments/threadedComments, огромный calcChain, битые части
// вроде persons/threadedComments — Excel их создаёт, но некоторые архиваторы
// либо сам Excel иногда пишут с ошибками, и это не мешает открыть файл в Excel,
// но ломает строгий разбор). Проверялось на РНП-таблице продавца (26 листов).
//
// Ограничение: читает только значения ячеек (через <v>/sharedStrings), без
// формул/стилей — этого достаточно для выгрузки цифр из отчётных листов.
//
// Использование как библиотеки:
//   const { openWorkbook } = require('./xlsx-xml-reader.cjs');
//   const wb = openWorkbook('/путь/к/файлу.xlsx');   // распаковывает во временную папку
//   const rows = wb.readSheet('Название листа');      // rows[i][col] — построчно, 0-индексация
//   console.log(wb.sheetNames);
//
// Как CLI (просмотр первых строк листа):
//   node scripts/xlsx-xml-reader.cjs файл.xlsx "Название листа" [maxRows=10]
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

function unescapeXml(s) {
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}
function colToIndex(ref) {
  const m = ref.match(/^([A-Z]+)/); let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function openWorkbook(xlsxPath) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xlsxread-'));
  // requires `unzip` on PATH (обычно есть в любом linux-контейнере)
  execFileSync('unzip', ['-o', '-q', xlsxPath, '-d', tmp], { stdio: ['ignore', 'ignore', 'ignore'] });

  const wbxml = fs.readFileSync(path.join(tmp, 'xl', 'workbook.xml'), 'utf8');
  const nameToRid = {};
  for (const m of wbxml.matchAll(/<sheet[^>]*name="([^"]*)"[^>]*r:id="([^"]*)"/g)) nameToRid[m[1]] = m[2];
  for (const m of wbxml.matchAll(/<sheet[^>]*r:id="([^"]*)"[^>]*name="([^"]*)"/g)) nameToRid[m[2]] = m[1];

  const rels = fs.readFileSync(path.join(tmp, 'xl', '_rels', 'workbook.xml.rels'), 'utf8');
  const ridToFile = {};
  for (const m of rels.matchAll(/<Relationship[^>]*Id="([^"]*)"[^>]*Target="([^"]*)"/g)) ridToFile[m[1]] = m[2];

  let sharedStrings = [];
  const ssPath = path.join(tmp, 'xl', 'sharedStrings.xml');
  if (fs.existsSync(ssPath)) {
    const sx = fs.readFileSync(ssPath, 'utf8');
    for (const si of sx.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      let t = ''; for (const tm of si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) t += tm[1];
      sharedStrings.push(unescapeXml(t));
    }
  }

  function readSheet(name, maxRows) {
    const rid = nameToRid[name]; if (!rid) return null;
    let file = ridToFile[rid]; if (!file) return null;
    file = file.replace(/^\/?xl\//, '').replace(/^\//, '');
    const xml = fs.readFileSync(path.join(tmp, 'xl', file), 'utf8');
    const rows = []; let ri = 0;
    for (const rm of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const cm of rm[1].matchAll(/<c r="([A-Z]+\d+)"([^>]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ci = colToIndex(cm[1]);
        const isStr = /t="s"/.test(cm[2]);
        const body = cm[3] || '';
        const vMatch = body.match(/<v>([\s\S]*?)<\/v>/);
        let val = '';
        if (vMatch) val = isStr ? (sharedStrings[+vMatch[1]] || '') : vMatch[1];
        else { const tMatch = body.match(/<t[^>]*>([\s\S]*?)<\/t>/); if (tMatch) val = unescapeXml(tMatch[1]); }
        cells[ci] = val;
      }
      rows.push(cells);
      if (maxRows && ++ri >= maxRows) break;
    }
    return rows;
  }

  return { sheetNames: Object.keys(nameToRid), readSheet, tmpDir: tmp, cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }) };
}

module.exports = { openWorkbook };

if (require.main === module) {
  const [file, sheet, maxRows] = process.argv.slice(2);
  if (!file || !sheet) { console.error('usage: node scripts/xlsx-xml-reader.cjs <файл.xlsx> "<лист>" [maxRows]'); process.exit(1); }
  const wb = openWorkbook(file);
  console.log('листы:', wb.sheetNames.join(' | '));
  const rows = wb.readSheet(sheet, +(maxRows || 10));
  if (!rows) { console.log('лист не найден'); process.exit(1); }
  rows.forEach((r, i) => console.log('r' + i + ': ' + (r || []).map(c => ('' + (c ?? '')).slice(0, 24)).join(' | ')));
  wb.cleanup();
}
