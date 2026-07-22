// Запекает воронку продаж (детальный отчёт WB «Воронка продаж», подённо) в зашитый
// снимок: добавляет/обновляет BAKED_FUNNEL в decrypted/wb-reports.js. Источник — те же
// подённые файлы аналитики, откуда берутся заказы и суммы (лист «Товары» + «Общая
// информация»). Колонки читаются ПО ИМЕНИ (формат отчёта менялся — индексы «плывут»).
// Даты из файлов перезаписывают те же дни снимка; прочие дни сохраняются.
//
// Использование: node scripts/bake-funnel.cjs <день1.xlsx> <день2.xlsx> ...
// Дальше: node scripts/encrypt.cjs <код> && git add wb-secure.js && commit/push.
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');
const XLSX=require('./node_modules/xlsx');
const ROOT=path.join(__dirname,'..'), OUT=path.join(ROOT,'decrypted');
const files=process.argv.slice(2);
if(!files.length){console.error('usage: node scripts/bake-funnel.cjs <день1.xlsx> ...');process.exit(1);}
function num(v){const n=parseFloat((''+v).replace(/[\s ]/g,'').replace(',','.'));return isNaN(n)?0:n;}

// 1) каталог: множество наших sku + категории/названия
const cd={};vm.createContext(cd);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-data.js'),'utf8')+'\nglobalThis.__RD=REAL_DATA;',cd);
const catalog=cd.__RD.catalog;
const skuSet=new Set(catalog.map(c=>''+c.sku));
const catBySku={}, nameBySku={}; catalog.forEach(c=>{catBySku[c.sku]=c.category; nameBySku[c.sku]=c.name;});

// 2) уже зашитые баки (чтобы переписать wb-reports.js целиком, не потеряв финансы/рекламу)
const rd={};vm.createContext(rd);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-reports.js'),'utf8')
  +'\nglobalThis.__B={BAKED_AT,BAKED_PERIOD,BAKED_FINANCE_ROWS,BAKED_ADS_ROWS,BAKED_FINANCE,BAKED_ADS,'
  +'BAKED_FUNNEL:(typeof BAKED_FUNNEL!=="undefined"?BAKED_FUNNEL:[]),'
  +'BAKED_FUNNEL_ROWS:(typeof BAKED_FUNNEL_ROWS!=="undefined"?BAKED_FUNNEL_ROWS:0)};',rd);
const B=rd.__B;

// 3) парсим подённые файлы воронки
function readDay(f){
  const wb=XLSX.read(fs.readFileSync(f),{type:'buffer',cellStyles:false,cellFormula:false});
  const oi=XLSX.utils.sheet_to_json(wb.Sheets['Общая информация'],{header:1,raw:false,defval:''});
  let per='';oi.forEach(r=>{ if((''+r[0]).toLowerCase().includes('текущий')) per=''+r[1]; });
  const m=per.match(/(\d{2})-(\d{2})-(\d{4})/); if(!m) throw new Error('нет даты периода в "'+per+'" ('+f+')');
  const iso=m[3]+'-'+m[2]+'-'+m[1];
  const rows=XLSX.utils.sheet_to_json(wb.Sheets['Товары'],{header:1,raw:false,defval:''});
  // шапка не всегда в row 0: в новом формате row 0 — заголовок отчёта, а шапка в row 1
  // (плюс появился лишний столбец «Артикул продавца» — читаем по ИМЕНИ через indexOf, сдвиг не важен).
  let hr=0; for(let i=0;i<Math.min(8,rows.length);i++){ if(rows[i].map(x=>''+x).indexOf('Артикул WB')>=0){ hr=i; break; } }
  const H=rows[hr].map(x=>''+x);
  const ix=n=>H.indexOf(n);
  const c={sku:ix('Артикул WB'),name:ix('Название'),cat:ix('Предмет'),
    imp:ix('Показы'),cv:ix('Переходы в карточку'),ac:ix('Положили в корзину'),af:ix('Добавили в отложенные'),
    oq:ix('Заказали товаров, шт'),bq:ix('Выкупили, шт'),cq:ix('Отменили, шт'),
    os:ix('Заказали на сумму, ₽'),bs:ix('Выкупили на сумму, ₽'),cs:ix('Отменили на сумму, ₽'),
    wbs:ix('Остатки «Склад WB», шт'),ows:ix('Остатки «Свой склад», шт')};
  if(c.sku<0||c.imp<0||c.oq<0) throw new Error('не нашёл ключевые колонки воронки в '+f+' (Артикул WB/Показы/Заказали)');
  const recs=[]; let matched=0;
  const tot={imp:0,cv:0,ac:0,oq:0,bq:0,cq:0,os:0,bs:0,cs:0};
  for(let i=hr+1;i<rows.length;i++){
    const r=rows[i]; const sku=(''+(r[c.sku]||'')).trim(); if(!skuSet.has(sku)) continue; matched++;
    const rec={id:iso+'_'+sku,date:iso,sku,name:nameBySku[sku]||(''+(r[c.name]||'')).trim(),category:catBySku[sku]||(''+(r[c.cat]||'')).trim(),
      impressions:num(r[c.imp]),cardViews:num(r[c.cv]),addCart:num(r[c.ac]),addFav:c.af>=0?num(r[c.af]):0,
      ordersQty:num(r[c.oq]),buyoutQty:num(r[c.bq]),cancelQty:c.cq>=0?num(r[c.cq]):0,
      ordersSum:c.os>=0?num(r[c.os]):0,buyoutSum:c.bs>=0?num(r[c.bs]):0,cancelSum:c.cs>=0?num(r[c.cs]):0,
      wbStock:c.wbs>=0?num(r[c.wbs]):0,ownStock:c.ows>=0?num(r[c.ows]):0};
    recs.push(rec);
    tot.imp+=rec.impressions;tot.cv+=rec.cardViews;tot.ac+=rec.addCart;tot.oq+=rec.ordersQty;tot.bq+=rec.buyoutQty;tot.cq+=rec.cancelQty;tot.os+=rec.ordersSum;tot.bs+=rec.buyoutSum;tot.cs+=rec.cancelSum;
  }
  return {iso,recs,matched,tot};
}

const byDate={}; // iso → records
for(const f of files){
  const d=readDay(f);
  byDate[d.iso]=d.recs;
  console.log('  '+d.iso+': '+d.matched+' тов. · показы '+d.tot.imp.toLocaleString('ru-RU')
    +' · заказы '+d.tot.oq+' шт / '+Math.round(d.tot.os).toLocaleString('ru-RU')+' ₽'
    +' · выкуп '+d.tot.bq+' шт / '+Math.round(d.tot.bs).toLocaleString('ru-RU')+' ₽');
}

// 4) мержим: новые даты перекрывают старые, прочие дни снимка сохраняем
const newDates=new Set(Object.keys(byDate));
const kept=(B.BAKED_FUNNEL||[]).filter(r=>!newDates.has(r.date));
const merged=kept.concat(...Object.values(byDate)).sort((a,b)=>a.date<b.date?-1:(a.date>b.date?1:(a.sku<b.sku?-1:1)));
B.BAKED_FUNNEL=merged;
B.BAKED_FUNNEL_ROWS=merged.length;

// 5) переписываем decrypted/wb-reports.js целиком (со всеми баками)
fs.writeFileSync(path.join(OUT,'wb-reports.js'),
  '// Зашитый снимок отчётов (финансы + реклама + воронка) по нашим артикулам.\n'
  +'const BAKED_AT="'+B.BAKED_AT+'", BAKED_PERIOD="'+B.BAKED_PERIOD+'";\n'
  +'const BAKED_FINANCE_ROWS='+B.BAKED_FINANCE_ROWS+', BAKED_ADS_ROWS='+B.BAKED_ADS_ROWS+', BAKED_FUNNEL_ROWS='+B.BAKED_FUNNEL_ROWS+';\n'
  +'const BAKED_FINANCE='+JSON.stringify(B.BAKED_FINANCE)+';\n'
  +'const BAKED_ADS='+JSON.stringify(B.BAKED_ADS)+';\n'
  +'const BAKED_FUNNEL='+JSON.stringify(B.BAKED_FUNNEL)+';\n');

const allDates=[...new Set(merged.map(r=>r.date))].sort();
console.log('\nВоронка в снимке: '+merged.length+' строк · дней '+allDates.length
  +' ('+allDates[0]+' … '+allDates[allDates.length-1]+')');
console.log('Дальше: node scripts/encrypt.cjs <код> → git add wb-secure.js');
