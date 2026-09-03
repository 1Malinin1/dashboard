// История остатков Озона по дням: REAL_DATA.ozon.stockHistory[дата] = {артикул: доступно_к_продаже}
// Дальше: node scripts/encrypt.cjs <код>
//
// ЗАЧЕМ. Отчёт Озона «Остатки на складах» — это СНИМОК НА МОМЕНТ выгрузки, истории в нём нет,
// и продавец её взять негде («остатки только в моменте, за предыдущие дни дать не могу»,
// 03.09.2026). Без истории нельзя доказать аут задним числом, а ауты — крупнейший источник
// потерь: арт. Ozon 487175 за декаду 21–30.08 потерял 95 474 ₽/день при живых показах.
// Поэтому каждую присланную выгрузку складываем отдельной датой и больше не теряем.
//
// У ВБ такой проблемы НЕТ: подённый отчёт аналитики несёт колонки «Остатки Склад WB» и
// «Остатки Свой склад» по каждому артикулу, и они уже лежат в BAKED_FUNNEL (wbStock/ownStock)
// с 14.07.2026. Этот скрипт — только про Озон.
//
// ДАТА берётся из шапки листа и ТОЛЬКО из новой формулировки «Плата за вынужденное размещение
// на 3 сен» — она совпала со снимком (файл «на 3 сен» дал ровно 30 568 шт, столько же насчитал
// ozon-build для 2026-09-03). Старая формулировка «Стоимость размещения на N мес» — это дата
// ПЛАТЫ, а не снимка: в архиве три файла помечены «27 авг», но содержимое разное (29 997 /
// 29 997 / 29 448 шт). Такие файлы скрипт датировать отказывается и требует `--date`.
// Молча подставлять «сегодня» нельзя тем более — файл может быть недельной давности.
//
// Использование:
//   node scripts/ozon-stock-history.cjs <stocks_report.xlsx …> [--date 2026-09-03]
//   node scripts/ozon-stock-history.cjs list           — что уже накоплено
'use strict';
const fs=require('fs'), vm=require('vm'), path=require('path');
const XLSX=require('./node_modules/xlsx');
const OUT=path.join(__dirname,'..','decrypted');

const argv=process.argv.slice(2);
let forced=null;
const files=[];
for(let i=0;i<argv.length;i++){
  if(argv[i]==='--date'){ forced=argv[++i]; continue; }
  files.push(argv[i]);
}

const ctx={}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-data.js'),'utf8')+'\nglobalThis.__RD=REAL_DATA;',ctx);
const RD=ctx.__RD;
RD.ozon=RD.ozon||{}; RD.ozon.stockHistory=RD.ozon.stockHistory||{};

const fmt=n=>n.toLocaleString('ru-RU');
if(files[0]==='list' || !files.length){
  const ds=Object.keys(RD.ozon.stockHistory).sort();
  if(!ds.length){ console.log('История остатков Озона пуста.'); process.exit(0); }
  console.log('История остатков Озона — '+ds.length+' '+(ds.length===1?'день':'дн.')+':');
  ds.forEach(d=>{ const m=RD.ozon.stockHistory[d];
    const sum=Object.values(m).reduce((a,b)=>a+b,0);
    console.log('  '+d+': '+fmt(sum)+' шт по '+Object.keys(m).length+' артикулам');
  });
  process.exit(0);
}

const MON={янв:1,фев:2,мар:3,апр:4,мая:5,май:5,июн:6,июл:7,авг:8,сен:9,окт:10,ноя:11,дек:12};
// «наши» артикулы — те, что есть в каталоге Озона (он собран по связке с ВБ)
const ours=new Set((RD.ozon.catalog||[]).map(c=>''+c.sku));
const S=v=>(''+(v==null?'':v)).trim();
const num=v=>{ const n=parseFloat(S(v).replace(/\s/g,'').replace(',','.')); return isNaN(n)?0:n; };

let added=0, updated=0;
files.forEach(f=>{
  const wb=XLSX.readFile(f);
  const sheet=wb.SheetNames.find(n=>/^товары$/i.test(n));
  if(!sheet) throw new Error('нет листа «Товары» в '+path.basename(f)+' (есть: '+wb.SheetNames.join(', ')+')');
  const rows=XLSX.utils.sheet_to_json(wb.Sheets[sheet],{header:1,raw:false,defval:''});
  // дата: из шапки, иначе из --date
  let iso=forced;
  if(!iso){
    const head=(rows[0]||[]).map(S).join(' | ');
    /* ВЕРИМ ТОЛЬКО НОВОЙ ФОРМУЛИРОВКЕ «Плата за вынужденное размещение на N мес» — она совпадает
       с датой снимка (проверено: файл с «на 3 сен» дал ровно те же 30 568 шт, что ozon-build
       посчитал для 2026-09-03). У СТАРЫХ выгрузок в шапке стоит «Стоимость размещения на N мес»,
       и это дата ПЛАТЫ, а не снимка: три архивных файла помечены «27 авг», но содержимое разное
       (29 997 / 29 997 / 29 448 шт). Такие файлы датировать автоматически нельзя — только --date,
       иначе в историю уедет неверный день и разбор аутов будет врать. */
    const m=head.match(/Плата за вынужденное размещение\s+на\s+(\d+)\s+([а-яё]+)/i);
    if(m){ const mo=MON[m[2].toLowerCase().slice(0,3)];
      if(mo) iso='2026-'+String(mo).padStart(2,'0')+'-'+String(+m[1]).padStart(2,'0'); }
    else if(/Стоимость размещения\s+на\s+\d+/i.test(head))
      throw new Error('в '+path.basename(f)+' шапка старого формата («Стоимость размещения на …») — '
        +'это дата ПЛАТЫ, а не снимка, ей верить нельзя. Передайте дату явно: --date ГГГГ-ММ-ДД');
  }
  if(!iso) throw new Error('не нашёл дату в шапке '+path.basename(f)
    +' — передайте её явно: --date ГГГГ-ММ-ДД (подставлять «сегодня» нельзя, файл может быть старым)');

  /* Колонки ищем ПО ИМЕНИ: между версиями отчёта их порядок плывёт (в старых выгрузках нет
     колонок платы, и «Доступно к продаже» стоит на 7-й позиции вместо 12-й). В названиях
     Озона попадается неразрывный пробел, поэтому в шаблоне «.» вместо пробела. */
  const hdr=(rows[0]||[]).map(S), sub=(rows[1]||[]).map(S);
  let col=hdr.findIndex(h=>/^Доступно к.продаже/i.test(h));
  if(col<0) col=sub.findIndex(h=>/^Доступно к.продаже/i.test(h));
  if(col<0) throw new Error('не нашёл колонку «Доступно к продаже» в '+path.basename(f));
  // строка данных начинается после «шапки-описания» — ищем первую, где артикул похож на код
  let start=1; while(start<rows.length && !ours.has(S(rows[start][0]))) start++;

  const day={}; let rowsRead=0, skipped=0;
  for(let i=start;i<rows.length;i++){
    const art=S(rows[i][0]); if(!art) continue;
    if(!ours.has(art)){ skipped++; continue; }
    /* Один артикул идёт НЕСКОЛЬКИМИ строками (разные карточки под одним арт. поставщика:
       «Маркируемый» и «Уценка, Маркируемый»). Остатки СКЛАДЫВАЕМ, а не присваиваем: пустая
       строка уценки шла последней и затирала реальный остаток нулём. */
    day[art]=(day[art]||0)+num(rows[i][col]);
    rowsRead++;
  }
  if(!rowsRead) throw new Error('в '+path.basename(f)+' не нашлось ни одного нашего артикула — снимок не записан');
  const was=RD.ozon.stockHistory[iso];
  RD.ozon.stockHistory[iso]=day;
  was? updated++ : added++;
  const sum=Object.values(day).reduce((a,b)=>a+b,0);
  console.log('  '+iso+': '+fmt(sum)+' шт по '+Object.keys(day).length+' артикулам'
    +' (строк '+rowsRead+', чужих пропущено '+skipped+')'+(was? '  ← перезаписан':''));
});

fs.writeFileSync(path.join(OUT,'wb-data.js'),
  '// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\n'
  +'const REAL_DATA = '+JSON.stringify(RD)+';\n');

const ds=Object.keys(RD.ozon.stockHistory).sort();
console.log('\nИстория остатков Озона: '+ds.length+' дн. ['+ds[0]+' … '+ds[ds.length-1]+']'
  +'  · добавлено '+added+', перезаписано '+updated);
console.log('Дальше: node scripts/encrypt.cjs <код>');
