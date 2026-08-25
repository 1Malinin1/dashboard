// Обновляет остатки ВБ в каталоге (REAL_DATA.catalog[].wbStock) из отчёта «Остатки на складах».
// Ключ — «Артикул WB» (fallback «Артикул продавца» = supplierCode). Остаток = «Всего находится
// на складах» (колонки складов = разбивка этого итога; «в пути до получателей»/«возвраты» — НЕ остаток).
// Отчёт — полный снимок: товар, которого в отчёте нет, считаем за 0 (обнуляем, печатаем список).
// Обновляет RD.meta.stockSnapshotDate. Дальше: node scripts/encrypt.cjs <код>.
//
// Использование: node scripts/update-wb-stock.cjs <stocks_report.xlsx> [YYYY-MM-DD]
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');
const XLSX=require('./node_modules/xlsx');
const OUT=path.join(__dirname,'..','decrypted');
const file=process.argv[2], dateArg=process.argv[3];
if(!file){console.error('usage: node scripts/update-wb-stock.cjs <stocks_report.xlsx> [YYYY-MM-DD]');process.exit(1);}
function num(v){const n=parseFloat((''+v).replace(/\s/g,'').replace(',','.'));return isNaN(n)?0:n;}

const ctx={};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-data.js'),'utf8')+'\nglobalThis.__RD=REAL_DATA;',ctx);
const RD=ctx.__RD;

const wb=XLSX.read(fs.readFileSync(file),{type:'buffer',cellStyles:false,cellFormula:false});
const rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,raw:false,defval:''});
let hr=0; for(let i=0;i<Math.min(6,rows.length);i++){ if(rows[i].map(x=>''+x).indexOf('Артикул WB')>=0){hr=i;break;} }
const H=rows[hr].map(x=>''+x);
const iWB=H.indexOf('Артикул WB'), iSup=H.indexOf('Артикул продавца');
// Два формата остатков FBO, продавец их чередует:
//   · отчёт ВБ «Остатки на складах» → «Всего находится на складах» (колонки складов = его разбивка);
//   · выгрузка сервиса XWAY → «Текущий остаток товара» (одна колонка, когда ВБ виснет и не отдаёт отчёт).
// Оба про ОДНО И ТО ЖЕ: товар на складах WB (FBO). Товар на своём складе, который продаётся
// по FBS, сюда НЕ входит — он живёт в REAL_DATA.warehouse.
const iStock=H.findIndex(h=>/всего наход/i.test(h) || /текущий остаток/i.test(h));
if(iWB<0||iStock<0){console.error('не нашёл колонки (Артикул WB='+iWB+', Всего находится='+iStock+')');process.exit(1);}

const repByWB={}, repBySup={}; let repRows=0, repTotal=0;
for(let i=hr+1;i<rows.length;i++){ const r=rows[i];
  const sku=(''+(r[iWB]||'')).trim(), sup=(''+(iSup>=0?r[iSup]:'')||'').trim();
  if(!/^\d+$/.test(sku) && !sup) continue;
  const s=num(r[iStock]);
  if(/^\d+$/.test(sku)){ repByWB[sku]=(repByWB[sku]||0)+s; }
  if(sup){ repBySup[sup]=(repBySup[sup]||0)+s; }
  repRows++; repTotal+=s;
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
Object.keys(grew).forEach(sup=>{
  let left=grew[sup];
  (RD.shipments||[]).filter(s=>s.mp==='wb'&&s.sup===sup&&s.left>0)
    .sort((a,b)=>a.date<b.date?-1:1)
    .forEach(s=>{ if(left<=0) return;
      const q=Math.min(s.left,left); s.left-=q; left-=q;
      (s.arrived||(s.arrived=[])).push({date:RD.meta.stockSnapshotDate,qty:q});
      closed.push({id:s.id,sup,qty:q,left:s.left,grew:grew[sup]}); });
});

fs.writeFileSync(path.join(OUT,'wb-data.js'),
  '// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\n'
  +'const REAL_DATA = '+JSON.stringify(RD)+';\n');

console.log('Отчёт остатков: строк данных '+repRows+' · суммарный остаток в отчёте '+Math.round(repTotal).toLocaleString('ru-RU')+' шт (весь аккаунт)');
console.log('Наш каталог: '+RD.catalog.length+' товаров · совпало с отчётом '+matched+' · нет в отчёте (→0) '+zeroed);
console.log('Остаток каталога (наши товары): было '+oldTotal.toLocaleString('ru-RU')+' → стало '+newTotal.toLocaleString('ru-RU')+' шт');
console.log('Дата снимка остатков: '+RD.meta.stockSnapshotDate);
const openSh=(RD.shipments||[]).filter(s=>s.mp==='wb'&&s.left>0);
if(closed.length){
  console.log('\nПоставки на ВБ, принятые по росту остатка ('+closed.length+'):');
  closed.forEach(x=>console.log('  '+x.id+' · пришло '+x.qty+' шт (остаток по коду вырос на '+x.grew+')'
    +(x.left>0? ' · ещё в пути '+x.left : ' · отгрузка закрыта')));
}
if(openSh.length) console.log('Осталось в пути на ВБ: '+openSh.reduce((a,s)=>a+s.left,0)+' шт по '+openSh.length+' позициям');
if(zeroedHad.length){ console.log('\nОбнулены (не найдены в отчёте, но раньше был остаток) — '+zeroedHad.length+' шт:');
  zeroedHad.sort((a,b)=>b.was-a.was).slice(0,20).forEach(x=>console.log('  '+x.sku+'  '+x.name.slice(0,34)+'  было '+x.was)); }
