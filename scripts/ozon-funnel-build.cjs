// Запекает воронку продаж Озона в REAL_DATA.ozon.funnel (внутри decrypted/wb-data.js).
// Источник — отчёт Озона «Аналитика → По товарам, подённо» (лист «По товарам»):
// многоуровневая шапка (секция «Воронка продаж»), данные с ~13-й строки, по строке на товар×день.
// Колонки ищем ПО ИМЕНИ (в под-строке шапки) — у Озона индексы «плывут».
// Ступени → как у ВБ-воронки: Показы всего · Посещения карточки · В корзину всего ·
// Заказано товаров · Доставлено товаров (=аналог «Выкупили» у ВБ, «дозревает»).
// Артикул продавца = связка с ВБ (= supplierCode = ozon.catalog.sku). Берём только НАШИ товары.
// Мерж по ключу «дата+артикул» — отчёт можно дробить по строкам и грузить частями, не боясь
// ни потерь, ни задвоения. Дальше: node scripts/encrypt.cjs <код>.
//
// Использование: node scripts/ozon-funnel-build.cjs <отчёт.xlsx> [ещё.xlsx ...]
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');
const XLSX=require('./node_modules/xlsx');
const OUT=path.join(__dirname,'..','decrypted');
const files=process.argv.slice(2);
if(!files.length){console.error('usage: node scripts/ozon-funnel-build.cjs <отчёт.xlsx> ...');process.exit(1);}
// Озон-формат чисел: запятая = разделитель тысяч, точка = десятичная, суффиксы ₽/%.
function num(v){const n=parseFloat((''+v).replace(/[\s ,₽%]/g,''));return isNaN(n)?0:n;}

// каталог: наши артикулы (supplierCode ВБ) + имена/категории из ozon-каталога (или ВБ)
const cd={};vm.createContext(cd);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-data.js'),'utf8')+'\nglobalThis.__RD=REAL_DATA;',cd);
const RD=cd.__RD;
const supSet=new Set(RD.catalog.map(c=>(''+(c.supplierCode||'')).trim()).filter(Boolean));
const wbBySup={}; RD.catalog.forEach(c=>{const s=(''+(c.supplierCode||'')).trim();if(s)wbBySup[s]=c;});
const ozCat=(RD.ozon&&RD.ozon.catalog)||[];
const ozBySku={}; ozCat.forEach(c=>ozBySku[(''+c.sku).trim()]=c);
if(!RD.ozon){console.error('В снимке нет RD.ozon — сначала соберите каталог Озона (ozon-build.cjs).');process.exit(1);}

function idxOf(row,pred){ for(let i=0;i<row.length;i++){ if(pred((''+(row[i]||'')).replace(/\s+/g,' ').trim())) return i; } return -1; }

function readReport(f){
  const wb=XLSX.read(fs.readFileSync(f),{type:'buffer',cellStyles:false,cellFormula:false});
  const sh=wb.Sheets['По товарам']||wb.Sheets[wb.SheetNames[0]];
  const rows=XLSX.utils.sheet_to_json(sh,{header:1,raw:false,defval:''});
  // строка-шапка: где встречается «Товары» (первый столбец) и «Артикул»/«День»
  let hr=-1; for(let i=0;i<20;i++){ if((''+(rows[i]&&rows[i][0])).trim()==='Товары'){hr=i;break;} }
  if(hr<0) throw new Error('не нашёл шапку («Товары») в '+f);
  const top=rows[hr], sub=rows[hr+1]||[];
  const cArt=idxOf(top,v=>v==='Артикул'), cDay=idxOf(top,v=>v==='День'), cOzSku=idxOf(top,v=>v==='SKU');
  // метрики воронки — по под-строке шапки
  const cImp=idxOf(sub,v=>v.startsWith('Показы всего'));
  const cCard=idxOf(sub,v=>v.startsWith('Посещения карточки'));
  const cCart=idxOf(sub,v=>v.startsWith('Добавления в корзину всего'));
  const cOrd=idxOf(sub,v=>v.startsWith('Заказано товаров'));
  const cDeliv=idxOf(sub,v=>v.startsWith('Доставлено товаров'));
  const cCancel=idxOf(sub,v=>v.startsWith('Отменено товаров'));
  const cSum=idxOf(sub,v=>v.startsWith('Заказано на сумму'));
  if([cArt,cDay,cImp,cCard,cCart,cOrd,cDeliv].some(x=>x<0))
    throw new Error('не нашёл ключевые колонки воронки в '+f+' (арт='+cArt+' день='+cDay+' показы='+cImp+' карточка='+cCard+' корзина='+cCart+' заказы='+cOrd+' доставлено='+cDeliv+')');
  const recs=[]; let matched=0, skipped=0; const ozSkuByArt={};   // артикул продавца → числовой SKU Озона (для ссылки)
  const tot={imp:0,card:0,cart:0,ord:0,deliv:0,sum:0};
  for(let i=hr+1;i<rows.length;i++){
    const r=rows[i]; const art=(''+(r[cArt]||'')).trim(); const day=(''+(r[cDay]||'')).trim();
    if(!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;          // не строка данных (напр. «Итого и среднее»)
    if(!supSet.has(art)){ skipped++; continue; }            // не наш товар
    if(cOzSku>=0 && !ozSkuByArt[art]){ const s=(''+(r[cOzSku]||'')).trim(); if(s) ozSkuByArt[art]=s; }
    const oz=ozBySku[art], wb=wbBySup[art];
    const name=(oz&&oz.name)||(wb&&wb.name)||(''+(r[0]||'')).trim()||art;
    const category=(wb&&wb.category)||(oz&&oz.category)||'Без категории';
    const imp=num(r[cImp]),card=num(r[cCard]),cart=num(r[cCart]),ord=num(r[cOrd]),deliv=num(r[cDeliv]),
      cancel=cCancel>=0?num(r[cCancel]):0, sum=cSum>=0?num(r[cSum]):0;
    // отчёт Озона не отдаёт «Доставлено на сумму» — ОЦЕНКА: доставлено × средний чек заказа (sum/ord)
    const avg = ord>0 ? sum/ord : 0;
    const buyoutSum = Math.round(deliv*avg);
    recs.push({id:day+'_'+art,date:day,sku:art,name,category,
      impressions:imp,cardViews:card,addCart:cart,addFav:0,
      ordersQty:ord,buyoutQty:deliv,cancelQty:cancel,
      ordersSum:Math.round(sum),buyoutSum,cancelSum:0,wbStock:0,ownStock:0});
    matched++;
    tot.imp+=imp;tot.card+=card;tot.cart+=cart;tot.ord+=ord;tot.deliv+=deliv;tot.sum+=sum;
  }
  return {recs,matched,skipped,tot,ozSkuByArt};
}

const byDate={}; const ozSkuByArt={};
for(const f of files){
  const {recs,matched,skipped,tot,ozSkuByArt:m}=readReport(f);
  recs.forEach(r=>{ (byDate[r.date]||(byDate[r.date]=[])).push(r); });
  Object.assign(ozSkuByArt,m);
  console.log('  '+path.basename(f)+': строк наших '+matched+' (пропущено чужих '+skipped+') · показы '+tot.imp.toLocaleString('ru-RU')
    +' · заказы '+tot.ord+' · доставлено '+tot.deliv+' · заказано '+Math.round(tot.sum).toLocaleString('ru-RU')+' ₽');
}
// вписать числовой SKU Озона в каталог (для прямой ссылки на ozon.ru/product/{ozonSku})
let ozLinked=0; ozCat.forEach(c=>{ const s=ozSkuByArt[String(c.sku)]; if(s){ c.ozonSku=s; ozLinked++; } });
console.log('  SKU Озона проставлен у '+ozLinked+' товаров каталога (для ссылок)');

// Мерж по ключу «дата + артикул», а НЕ по дню целиком. Продавец дробит один большой отчёт
// на части ПО СТРОКАМ (шапка та же, дни те же, товары разные), поэтому замена дня целиком
// затирала бы товары из уже загруженной части. При таком ключе:
//   · одна и та же строка, залитая дважды, просто перезаписывает сама себя (задвоения нет);
//   · части одного дня складываются;
//   · исправленная выгрузка корректно перекрывает старые цифры.
const old=(RD.ozon.funnel||[]);
const map={}; old.forEach(r=>{ map[r.date+'_'+r.sku]=r; });
let replaced=0, fresh=0;
Object.values(byDate).forEach(list=>list.forEach(r=>{ const k=r.date+'_'+r.sku;
  if(map[k]) replaced++; else fresh++; map[k]=r; }));
const merged=Object.values(map).sort((a,b)=>a.date<b.date?-1:(a.date>b.date?1:(a.sku<b.sku?-1:1)));
RD.ozon.funnel=merged;
console.log('  строк товар×день: новых '+fresh+' · перезаписано (уже были) '+replaced);

fs.writeFileSync(path.join(OUT,'wb-data.js'),
  '// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\n'
  +'const REAL_DATA = '+JSON.stringify(RD)+';\n');

const allDates=[...new Set(merged.map(r=>r.date))].sort();
const skus=new Set(merged.map(r=>r.sku)).size;
console.log('\nВоронка Озона в снимке: '+merged.length+' строк · дней '+allDates.length
  +' ('+allDates[0]+' … '+allDates[allDates.length-1]+') · товаров '+skus);
console.log('Дальше: node scripts/encrypt.cjs <код> → git add wb-secure.js');
