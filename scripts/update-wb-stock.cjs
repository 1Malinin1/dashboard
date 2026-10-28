// Обновляет остатки ВБ в каталоге (REAL_DATA.catalog[].wbStock) из отчёта «Остатки на складах».
// Ключ — «Артикул WB» (fallback «Артикул продавца» = supplierCode). Остаток = «Всего находится
// на складах» (колонки складов = разбивка этого итога; «в пути до получателей»/«возвраты» — НЕ остаток).
// Отчёт — полный снимок: товар, которого в отчёте нет, считаем за 0 (обнуляем, печатаем список).
// Обновляет RD.meta.stockSnapshotDate. Дальше: node scripts/encrypt.cjs <код>.
//
// Использование: node scripts/update-wb-stock.cjs <stocks_report.xlsx> [YYYY-MM-DD] [--history-only]
//   --history-only — только точка истории `RD.wbStockHistory[дата]` (для старых отчётов): каталог,
//   отгрузки и дата снимка не трогаются. Дата обязательна.
//   --no-ship — не закрывать отгрузки ростом остатка (пересчёт по новой методике: рост — не приёмка).
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');
const XLSX=require('./node_modules/xlsx');
const OUT=path.join(__dirname,'..','decrypted');
const argv=process.argv.slice(2); const histOnly=argv.includes('--history-only'), noShip=argv.includes('--no-ship');
const pos=argv.filter(a=>!/^--/.test(a)); const file=pos[0], dateArg=pos[1];
if(!file||(histOnly&&!/^\d{4}-\d{2}-\d{2}$/.test(dateArg||''))){console.error('usage: node scripts/update-wb-stock.cjs <stocks_report.xlsx> [YYYY-MM-DD] [--history-only]  (при --history-only дата обязательна)');process.exit(1);}
function num(v){const n=parseFloat((''+v).replace(/\s/g,'').replace(',','.'));return isNaN(n)?0:n;}

const ctx={};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-data.js'),'utf8')+'\nglobalThis.__RD=REAL_DATA;',ctx);
const RD=ctx.__RD;

const wb=XLSX.read(fs.readFileSync(file),{type:'buffer',cellStyles:false,cellFormula:false});
const rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,raw:false,defval:''});
let hr=0; for(let i=0;i<Math.min(6,rows.length);i++){ if(rows[i].map(x=>''+x).indexOf('Артикул WB')>=0){hr=i;break;} }
const H=rows[hr].map(x=>''+x);
const iWB=H.indexOf('Артикул WB'), iSup=H.indexOf('Артикул продавца');
// ТРИ формата остатков FBO, продавец их чередует (какой отдаётся — тот и шлёт):
//   · отчёт ВБ «Остатки на складах»  → «Всего находится на складах» (колонки складов — его разбивка);
//   · короткий отчёт ВБ              → «Склад WB РФ» (уже сводная цифра по всем складам);
//   · выгрузка сервиса XWAY          → «Текущий остаток товара» (когда ВБ виснет и не отдаёт отчёт).
// Все три про ОДНО И ТО ЖЕ: товар на складах WB (FBO). Товар на своём складе, который продаётся
// по FBS, сюда НЕ входит — он живёт в REAL_DATA.warehouse.
/* КОЛОНКА ОСТАТКА — ТОЛЬКО «СКЛАД WB РФ». Приоритет именно такой, и вот почему.
   В полном отчёте «Всего находится на складах» = «Склад WB РФ» + «Склад WB СГТ РФ» + именные
   склады (Коледино, Электросталь, Котовск, Краснодар, Самара …) — равенство держится построчно
   на всех 4 141 строке, колонки не пересекаются. НО именные склады СГОРЕЛИ (пожары, август 2026),
   и ВБ скрыл по ним реальные остатки: цифры в этих колонках остались висеть, товара за ними нет.
   Продавец подтвердил 27.08: живой остаток — только «Склад WB РФ».
   Замер 27.08: «Всего находится» 107 680 шт против 41 228 в «Склад WB РФ»; прирост «Всего» с 24.08
   (54 138 шт) целиком лёг в сгоревшие склады — то есть это фантом, а не приёмка.
   Поэтому «Всего находится» НЕ БЕРЁМ, а если он в файле есть — громко говорим, что пропустили. */
const iRF=H.findIndex(h=>/^склад wb рф/i.test(h));
const iAll=H.findIndex(h=>/всего наход/i.test(h));
const iXway=H.findIndex(h=>/текущий остаток/i.test(h));
const iStock=iRF>=0? iRF : (iAll>=0? iAll : iXway);
/* + «СК ВЕЛИКИЙ КАМЕНЬ» (продавец 28.10.2026: «его считай, тк это склад ВБ, но товар находится не в России, и поэтому
   остатки не находятся в общей вкладке „склады РФ“»). Живой склад ВБ (Беларусь), в «Склад WB РФ» не входит:
   на 28.10 там 1 506 шт наших (15.10 — 579). Прибавляем только к «Склад WB РФ» — в «Всего находится» он уже есть. */
const iLive=iStock===iRF? H.map((h,i)=>/великий камень/i.test(h)? i : -1).filter(i=>i>=0) : [];
const skippedAll=iRF>=0 && iAll>=0;   // в файле есть обе — «Всего находится» осознанно пропущен
const onlyAll=iRF<0 && iAll>=0;       // «Склад WB РФ» нет вовсе — считаем по «Всего», но предупреждаем
/* ОСТОРОЖНО С XWAY. Замер 26.08: XWAY дал 76 719 шт, отчёт самого ВБ на следующий день —
   52 745. Разница 23 974 совпала с 80% новосибирского склада КОД В КОД (487199: 3 464 против
   3 466; 493369: 1 919 против 1 919; 493372: 1 899 против 1 903 …). То есть «Текущий остаток
   товара» в XWAY = FBO + FBS, а FBS — это товар с НАШЕГО склада, который уже посчитан
   в REAL_DATA.warehouse. Залив такой файл как wbStock, мы задваиваем товар: покрытие ВБ
   раздувается и подсорт занижается. Поэтому предупреждаем громко. */
const isXway=/текущий остаток/i.test(H[iStock]||"");
if(iWB<0||iStock<0){console.error('не нашёл колонки (Артикул WB='+iWB+', Всего находится='+iStock+')');process.exit(1);}

const repByWB={}, repBySup={}, altByWB={}; let repRows=0, repTotal=0;
for(let i=hr+1;i<rows.length;i++){ const r=rows[i];
  const sku=(''+(r[iWB]||'')).trim(), sup=(''+(iSup>=0?r[iSup]:'')||'').trim();
  if(!/^\d+$/.test(sku) && !sup) continue;
  const s=num(r[iStock])+iLive.reduce((a,i)=>a+num(r[i]),0);
  if(/^\d+$/.test(sku)){ repByWB[sku]=(repByWB[sku]||0)+s;
    if(skippedAll) altByWB[sku]=(altByWB[sku]||0)+num(r[iAll]); }
  if(sup){ repBySup[sup]=(repBySup[sup]||0)+s; }
  repRows++; repTotal+=s;
}

/* ИСТОРИЯ ОСТАТКОВ ВБ ПО ДНЯМ — `RD.wbStockHistory[дата] = {код 1С: шт}` (с 28.10.2026). Вкладка «Остатки»
   берёт ВБ ТОЛЬКО отсюда (продавец 28.10: «приоритет для данного раздела — отчёты по остаткам»). Раньше ВБ по
   дням брался из воронки, а у неё остаток — на МОМЕНТ ВЫГРУЗКИ файла, не на конец дня: дни, выгруженные разом,
   получали одну цифру (20–24.10 — пять одинаковых 40 424), и база у неё другая (считает «СК Великий Камень»),
   поэтому на стыке с отчётом рисовалось −1 516 вместо +1 753. Колонка та же, что у `wbStock` («Склад WB РФ»).
   Отчёт показывает остаток на утро даты файла. XWAY-формат в историю не пишем: он FBO+FBS. */
function histPoint(){
  const m={};
  RD.catalog.forEach(c=>{ const sku=''+c.sku, sup=(''+(c.supplierCode||'')).trim(); if(!sup) return;
    const v=repByWB[sku]!=null? repByWB[sku] : (repBySup[sup]!=null? repBySup[sup] : 0);
    if(v) m[sup]=(m[sup]||0)+v; });
  return m; }
if(histOnly){
  if(isXway){ console.error('выгрузка XWAY (FBO+FBS) в историю остатков ВБ не пишется'); process.exit(1); }
  RD.wbStockHistory=RD.wbStockHistory||{}; const m=histPoint(); RD.wbStockHistory[dateArg]=m;
  fs.writeFileSync(path.join(OUT,'wb-data.js'),
    '// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\n'
    +'const REAL_DATA = '+JSON.stringify(RD)+';\n');
  const ds=Object.keys(RD.wbStockHistory).sort();
  console.log('История остатков ВБ: точка '+dateArg+' · '+Object.keys(m).length+' кодов · '
    +Object.values(m).reduce((a,b)=>a+b,0).toLocaleString('ru-RU')+' шт · всего точек '+ds.length+' ['+ds[0]+' … '+ds[ds.length-1]+']');
  process.exit(0);
}

let matched=0, zeroed=0, oldTotal=0, newTotal=0; const zeroedHad=[];
const grew={};   // арт.поставщика → на сколько вырос остаток (для закрытия отгрузок, см. ниже)
RD.catalog.forEach(c=>{ const sku=''+c.sku, sup=(''+(c.supplierCode||'')).trim();
  oldTotal+=(c.wbStock||0);
  const was=c.wbStock||0;
  let v=null;
  if(repByWB[sku]!=null) v=repByWB[sku];
  else if(sup && repBySup[sup]!=null) v=repBySup[sup];
  if(v!=null){ c.wbStock=v; matched++; }
  else { if((c.wbStock||0)>0) zeroedHad.push({sku,name:c.name,was:c.wbStock}); c.wbStock=0; zeroed++; }
  newTotal+=(c.wbStock||0);
  const d=(c.wbStock||0)-was; if(sup && d>0) grew[sup]=(grew[sup]||0)+d;
});

// ---- Автозакрытие отгрузок на ВБ ----
// ВБ не показывает путь товара от отправки до приёмки, поэтому продавец сообщает об отгрузке
// сам (wb-shipment.cjs), а признаком прихода служит РОСТ остатка по этому же коду 1С: продажи
// остаток только уменьшают, значит рост = принятая поставка. Закрываем самые старые отгрузки
// первыми, не больше, чем вырос остаток. Печатаем, что закрылось, — продавцу на сверку.
RD.meta=RD.meta||{}; RD.meta.stockSnapshotDate=dateArg||new Date().toISOString().slice(0,10);
const closed=[];
if(noShip) console.log('--no-ship: отгрузки на ВБ ростом остатка не закрываются (пересчёт по методике)');
if(!noShip) Object.keys(grew).forEach(sup=>{
  let left=grew[sup];
  (RD.shipments||[]).filter(s=>s.mp==='wb'&&s.sup===sup&&s.left>0)
    .sort((a,b)=>a.date<b.date?-1:1)
    .forEach(s=>{ if(left<=0) return;
      const q=Math.min(s.left,left); s.left-=q; left-=q;
      (s.arrived||(s.arrived=[])).push({date:RD.meta.stockSnapshotDate,qty:q});
      closed.push({id:s.id,sup,qty:q,left:s.left,grew:grew[sup]}); });
});

/* ВОЗВРАТ СТАТУСА «На вывод», ЕСЛИ ОСТАТОК КОНЧИЛСЯ. Логика одна на все загрузчики
   остатков — см. lib/out-when-empty.cjs (правило продавца 13.10.2026). Проверка стоит
   ПЕРЕД записью снимка, чтобы изменённый статус попал в тот же файл. */
require('./lib/out-when-empty.cjs').check(RD);
if(!isXway){ RD.wbStockHistory=RD.wbStockHistory||{}; RD.wbStockHistory[RD.meta.stockSnapshotDate]=histPoint(); }
fs.writeFileSync(path.join(OUT,'wb-data.js'),
  '// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\n'
  +'const REAL_DATA = '+JSON.stringify(RD)+';\n');

console.log('Отчёт остатков: строк данных '+repRows+' · суммарный остаток в отчёте '+Math.round(repTotal).toLocaleString('ru-RU')+' шт (весь аккаунт)');
console.log('Наш каталог: '+RD.catalog.length+' товаров · совпало с отчётом '+matched+' · нет в отчёте (→0) '+zeroed);
console.log('Остаток каталога (наши товары): было '+oldTotal.toLocaleString('ru-RU')+' → стало '+newTotal.toLocaleString('ru-RU')+' шт');
if(iLive.length){ let vk=0; for(let i=hr+1;i<rows.length;i++){ const sku=(''+(rows[i][iWB]||'')).trim(); if(RD.catalog.some(c=>''+c.sku===sku)) iLive.forEach(j=>vk+=num(rows[i][j])); }
  console.log('В т.ч. «'+iLive.map(i=>H[i]).join('», «')+'» (склад ВБ вне РФ): '+Math.round(vk).toLocaleString('ru-RU')+' шт наших'); }
console.log('Дата снимка остатков: '+RD.meta.stockSnapshotDate
  +(isXway? ' · в историю остатков ВБ НЕ записано (XWAY = FBO+FBS)' : ' · точка истории остатков ВБ записана ('+Object.keys(RD.wbStockHistory||{}).length+' точек)'));
if(isXway){
  // прикидываем, сколько из залитого — это FBS с нашего склада (замер 26.08: ≈80% Нск)
  const wh=(RD.warehouse&&RD.warehouse.bySup)||{};
  let nsk=0; Object.values(wh).forEach(v=>Object.entries(v.wh||{}).forEach(([n,q])=>{ if(/евросиб/i.test(n)) nsk+=q; }));
  console.log('\n⚠ ЭТО ВЫГРУЗКА XWAY — в ней «Текущий остаток» включает FBS (товар с ВАШЕГО склада).');
  console.log('  Он уже посчитан в REAL_DATA.warehouse, поэтому покрытие ВБ будет ЗАВЫШЕНО,');
  console.log('  а подсорт — занижен. Ориентир FBS ≈ 80% склада Нск = '+Math.round(nsk*0.8).toLocaleString('ru-RU')+' шт.');
  console.log('  Для расчётов лучше отчёт самого ВБ («Всего находится на складах» / «Склад WB РФ»).');
}
if(skippedAll){
  let all=0; RD.catalog.forEach(c=>{ all+=altByWB[''+c.sku]||0; });
  console.log('\nВ файле есть и «Всего находится на складах» — ПРОПУЩЕН осознанно.');
  console.log('  По нему вышло бы '+Math.round(all).toLocaleString('ru-RU')+' шт против '+newTotal.toLocaleString('ru-RU')+' по «Склад WB РФ».');
  console.log('  Разница — сгоревшие склады (Коледино/Электросталь/Котовск/Краснодар/Самара):');
  console.log('  ВБ скрыл по ним остатки, цифры висят, товара за ними нет.');
}
if(onlyAll){
  console.log('\n⚠ В ОТЧЁТЕ НЕТ КОЛОНКИ «Склад WB РФ» — взял «Всего находится на складах».');
  console.log('  В неё попадают сгоревшие склады, остаток может оказаться завышенным.');
  console.log('  Лучше перевыгрузить отчёт так, чтобы была колонка «Склад WB РФ».');
}
const openSh=(RD.shipments||[]).filter(s=>s.mp==='wb'&&s.left>0);
if(closed.length){
  console.log('\nПоставки на ВБ, принятые по росту остатка ('+closed.length+'):');
  closed.forEach(x=>console.log('  '+x.id+' · пришло '+x.qty+' шт (остаток по коду вырос на '+x.grew+')'
    +(x.left>0? ' · ещё в пути '+x.left : ' · отгрузка закрыта')));
}
if(openSh.length) console.log('Осталось в пути на ВБ: '+openSh.reduce((a,s)=>a+s.left,0)+' шт по '+openSh.length+' позициям');
if(zeroedHad.length){ console.log('\nОбнулены (не найдены в отчёте, но раньше был остаток) — '+zeroedHad.length+' шт:');
  zeroedHad.sort((a,b)=>b.was-a.was).slice(0,20).forEach(x=>console.log('  '+x.sku+'  '+x.name.slice(0,34)+'  было '+x.was)); }
