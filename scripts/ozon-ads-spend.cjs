// ФАКТИЧЕСКИЙ РАСХОД НА РЕКЛАМУ ОЗОНА — ПО ТОВАРАМ И ПЕРИОДАМ.
// Пишет REAL_DATA.ozon.meta.adSpend. Дальше: node scripts/encrypt.cjs <код>
//
// ЗАЧЕМ (решение продавца 17.09.2026, дословно): «по умолчанию затраты на продвижение
// по всем товарам ты берёшь согласно нашей проверки юнитки за август, но дополнительно
// я тебе ещё буду скидывать затраты на рекламу с xway … я запустил выборочно товары.
// То есть по умолчанию у тебя есть модель по расчётам, но если в отчёте с xway будет
// другая цифра — ты и берёшь её».
//
// ПРАВИЛО ПРИМЕНЕНИЯ — ПОТОВАРНОЕ, А НЕ НА ВСЮ ПЛОЩАДКУ. Он уточнил в тот же день:
// «ближайшие 2-3 недели изменения будет только у <8 SKU> … в этих товарах будет другая
// экономика в плане трат на рекламу (ДРР), так как я запустил дополнительно рекламу,
// а у всех других (на озоне) будет фикса как и идёт по августу». Поэтому:
//   · товар ЕСТЬ в выгрузке за эти даты → его реклама = ФАКТ из выгрузки (ставка не применяется);
//   · товара НЕТ → работает ставка из отчёта юнит-экономики (август 4,23%).
// Не заменяй это «общим процентом по площадке»: тогда расход размажется по всем 143 товарам,
// и товары без рекламы получат чужие траты, а рекламируемые — заниженные.
//
// РАСПРЕДЕЛЕНИЕ ПО ДНЯМ — ПРОПОРЦИОНАЛЬНО ВЫРУЧКЕ ДНЯ (как у ВБ в adRowsFromPerf): выгрузка
// даёт итог за период, а не по дням. На неделю/месяц это не влияет, внутри периода день
// приблизителен. Если у товара в периоде выручки нет вовсе, весь его расход падает на
// последний день периода — иначе расход просто исчез бы из прибыли.
//
// Команды:
//   node scripts/ozon-ads-spend.cjs list
//   node scripts/ozon-ads-spend.cjs set <с ГГГГ-ММ-ДД> <по ГГГГ-ММ-ДД> "4095529612=12345, 493370=6789"
//   node scripts/ozon-ads-spend.cjs <выгрузка.xlsx> [с ГГГГ-ММ-ДД] [по ГГГГ-ММ-ДД]
//   node scripts/ozon-ads-spend.cjs drop <с> <по>
//
// Ключ товара принимается И числовым SKU Озона (4095529612), И кодом 1С = артикулом
// продавца (493373) — в снимке хранится ВСЕГДА код 1С: по нему ключуется и каталог Озона,
// и себестоимость, и связка с ВБ.
'use strict';
const fs=require('fs'), vm=require('vm'), path=require('path');
const OUT=path.join(__dirname,'..','decrypted');
const DATA=path.join(OUT,'wb-data.js');

const S=v=>(''+(v==null?'':v)).replace(/ /g,' ').replace(/\s+/g,' ').trim();
// «10,000.00 ₽» → 10000 ; «26 459,00» → 26459
const num=v=>{ const t=S(v).replace(/[₽$\s ]/g,'');
  if(!t) return 0;
  const s = /,\d{3}(\D|$)/.test(t) || /\.\d{2}$/.test(t) ? t.replace(/,/g,'') : t.replace(/,/g,'.');
  const n=parseFloat(s); return isNaN(n)?0:n; };
const F=v=>Math.round(v).toLocaleString('ru-RU');
const isIso=s=>/^\d{4}-\d{2}-\d{2}$/.test(s||'');

const ctx={}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(DATA,'utf8')+'\nglobalThis.__RD=REAL_DATA;',ctx);
const RD=ctx.__RD, O=RD.ozon;
if(!O) throw new Error('в снимке нет блока Озона');
O.meta=O.meta||{};

// ---- карты ключей: числовой SKU Озона → код 1С (он же артикул продавца)
const supSet=new Set(), byOzonSku={};
(O.catalog||[]).forEach(c=>{ const s=(''+c.sku).trim(); if(!s) return; supSet.add(s);
  if(c.ozonSku!=null && c.ozonSku!=='') byOzonSku[(''+c.ozonSku).trim()]=s; });
const nameOf={}; (O.catalog||[]).forEach(c=>nameOf[(''+c.sku).trim()]=c.name||'');
function resolveKey(k){ const t=S(k).replace(/\s/g,'');
  if(supSet.has(t)) return t;
  if(byOzonSku[t]) return byOzonSku[t];
  return null; }

const A=O.meta.adSpend && Array.isArray(O.meta.adSpend.parts)
  ? O.meta.adSpend : {parts:[]};
const cmd=(process.argv[2]||'').toLowerCase();

function save(){
  const parts=A.parts.slice().sort((a,b)=>a.from<b.from?-1:1);
  const bySup={};
  parts.forEach(p=>Object.entries(p.bySup||{}).forEach(([s,v])=>bySup[s]=(bySup[s]||0)+v));
  O.meta.adSpend={ parts, bySup, watch: A.watch||null,
    from: parts.length? parts[0].from : null,
    to:   parts.length? parts[parts.length-1].to : null,
    loadedAt:new Date().toISOString().slice(0,10),
    note:'ФАКТ расхода на рекламу по товарам. Перекрывает ставку из unitReports ТОЛЬКО '
      +'у тех товаров и дат, что есть в частях; остальные считаются по ставке.' };
  fs.writeFileSync(DATA,'// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\n'
    +'const REAL_DATA = '+JSON.stringify(RD)+';\n');
}
/* РАСХОД ЗА ДНИ, КОТОРЫХ НЕТ В РЯДУ ЗАКАЗОВ, МОЛЧА ПРОПАДАЕТ — ловим это здесь
   (поймано 21.09.2026). Расход разносится по дням пропорционально выручке дня, а товару
   без продаж строка кладётся на ПОСЛЕДНИЙ ДЕНЬ ЧАСТИ, ВЗЯТЫЙ ИЗ РЯДА ЗАКАЗОВ. Если в окне
   части ни одного дня заказов нет (реклама пришла раньше заказов — обычное дело, выгрузки
   приходят вразнобой), то последнего дня не существует: `ozon-finance.cjs` пропускает такую
   часть целиком, а `ozApplyAdFact` в index.html кладёт строку на дату вне ряда, и её отсекает
   фильтр периода. Ни ошибки, ни пустой таблицы — деньги просто исчезают из прибыли.
   Реальный случай: 105 568 ₽ за 18–20.09 при заказах по 17.09 — пропали бы целиком.
   Чинить арифметикой нельзя (без выручки дня расход не на что разнести), поэтому ПРЕДУПРЕЖДАЕМ:
   залейте заказы Озона за эти дни и расход подхватится сам. Не убирай проверку. */
function warnGaps(){
  const ds=(RD.ozon&&RD.ozon.orderSeries&&RD.ozon.orderSeries.dates)||[];
  const bad=A.parts.map(p=>({p, n:ds.filter(d=>d>=p.from&&d<=p.to).length}))
    .filter(x=>x.n===0);
  if(!bad.length) return;
  const last=ds[ds.length-1]||'—';
  console.log('\n⚠  ВНИМАНИЕ: расход есть, а заказов Озона за эти дни НЕТ — в прибыль он НЕ ПОПАДЁТ:');
  bad.forEach(({p})=>{
    const tot=Object.values(p.bySup||{}).reduce((a,b)=>a+b,0);
    console.log('     '+p.from+' … '+p.to+'   '+F(tot)+' ₽   (заказы Озона есть только по '+last+')');
  });
  console.log('     Залейте заказы Озона за эти даты (ozon-ingest-orders.cjs → ozon-build.cjs),');
  console.log('     и расход разнесётся сам. Пересчитывать или удалять часть не нужно.');
}
function showWatch(){
  const W=A.watch;
  if(!W||!W.sups||!W.sups.length) return;
  console.log('\nПОД НАБЛЮДЕНИЕМ (продавец запустил рекламу, ждём выгрузку XWAY) — '+W.sups.length+' товаров, отмечено '+(W.setAt||'').slice(0,10)+':');
  W.sups.forEach(s=>{ const covered=A.parts.some(p=>(p.bySup||{})[s]!=null);
    console.log('   '+s.padEnd(10)+(covered? 'есть факт':'СЧИТАЕТСЯ ПО СТАВКЕ')+'   '+(nameOf[s]||'').slice(0,46)); });
}
function show(){
  if(!A.parts.length){ console.log('Фактических выгрузок рекламы Озона нет — вся площадка считается по ставке из отчёта юнит-экономики.'); showWatch(); return; }
  console.log('ФАКТ расхода на рекламу Озона (перекрывает ставку только у этих товаров и дат):');
  A.parts.slice().sort((a,b)=>a.from<b.from?-1:1).forEach(p=>{
    const tot=Object.values(p.bySup||{}).reduce((a,b)=>a+b,0);
    console.log('   '+p.from+' … '+p.to+'   товаров '+String(Object.keys(p.bySup||{}).length).padStart(3)
      +' · расход '+F(tot).padStart(10)+' ₽'+(p.src? '   ('+p.src+')':''));
    Object.entries(p.bySup||{}).sort((a,b)=>b[1]-a[1]).forEach(([s,v])=>
      console.log('        '+s.padEnd(10)+F(v).padStart(9)+' ₽   '+(nameOf[s]||'').slice(0,46)));
  });
  warnGaps();
  showWatch();
}

if(cmd==='list' || !process.argv[2]){ show(); if(!process.argv[2]) console.log('\nusage: list | set <с> <по> "ключ=₽, …" | <файл.xlsx> [с] [по] | drop <с> <по> | watch "<ключи>"|off'); process.exit(0); }

/* СПИСОК «ПОД НАБЛЮДЕНИЕМ» — товары, по которым продавец ЗАПУСТИЛ рекламу, но выгрузки
   XWAY по ним ещё нет (17.09.2026: «ближайшие 2-3 недели изменения будет только у <8 SKU>…
   а у всех других будет фикса как и идёт по августу»). Пока факта нет, они считаются
   по августовской ставке — и дашборд обязан об этом сказать, иначе расход этих кампаний
   молча окажется заниженным. Никакой арифметики список не меняет. */
if(cmd==='watch'){
  const rest=process.argv.slice(3).join(' ').trim();
  if(rest.toLowerCase()==='off'){ A.watch=null; save(); console.log('Список наблюдения очищен.'); process.exit(0); }
  if(!rest){ showWatch(); if(!A.watch) console.log('Список наблюдения пуст.'); process.exit(0); }
  const sups=[], bad=[];
  rest.split(/[,;\s]+/).forEach(t=>{ if(!t) return; const k=resolveKey(t); if(k) sups.push(k); else bad.push(t); });
  if(bad.length){ console.error('нет таких товаров на Озоне: '+bad.join(', ')); process.exit(1); }
  A.watch={sups:[...new Set(sups)], setAt:new Date().toISOString().slice(0,10)};
  save(); console.log('Под наблюдением: '+A.watch.sups.length+' товаров'); showWatch();
  console.log('\nДальше: node scripts/encrypt.cjs <код>'); process.exit(0);
}

if(cmd==='drop'){
  const from=process.argv[3], to=process.argv[4];
  if(!isIso(from)||!isIso(to)){ console.error('usage: drop <с ГГГГ-ММ-ДД> <по ГГГГ-ММ-ДД>'); process.exit(1); }
  const before=A.parts.length;
  A.parts=A.parts.filter(p=>!(p.from===from && p.to===to));
  if(A.parts.length===before){ console.error('такой части нет: '+from+' … '+to); process.exit(1); }
  save(); console.log('Удалено: '+from+' … '+to+'\n'); show();
  console.log('\nДальше: node scripts/encrypt.cjs <код>'); process.exit(0);
}

let FROM, TO, bySup={}, src='';
if(cmd==='set'){
  FROM=process.argv[3]; TO=process.argv[4];
  const list=process.argv.slice(5).join(' ');
  if(!isIso(FROM)||!isIso(TO)||!list){ console.error('usage: set <с ГГГГ-ММ-ДД> <по ГГГГ-ММ-ДД> "4095529612=12345, 493370=6789"'); process.exit(1); }
  const bad=[];
  list.split(/[,;\n]+/).forEach(p=>{ const t=S(p); if(!t) return;
    const m=t.split('='); if(m.length<2){ bad.push(t); return; }
    const key=resolveKey(m[0]), v=num(m[1]);
    if(!key){ bad.push(m[0]); return; }
    bySup[key]=(bySup[key]||0)+v; });
  if(bad.length){ console.error('не понял / нет такого товара на Озоне: '+bad.join(', ')); process.exit(1); }
  src='введено вручную';
}else{
  // ---- разбор выгрузки XWAY по Озону
  const file=process.argv[2];
  if(!fs.existsSync(file)){ console.error('нет файла: '+file); process.exit(1); }
  /* Период из имени файла — те же три формата, что у ВБ (update-ads-perf.cjs):
     ГГГГММДД, ДДММГГГГ и «2026-09-11» с дефисами. Дальше — явные аргументы. */
  function isoFrom8(t){
    if(/^20\d{6}$/.test(t)){ const mm=+t.slice(4,6), dd=+t.slice(6,8);
      if(mm>=1&&mm<=12&&dd>=1&&dd<=31) return t.slice(0,4)+'-'+t.slice(4,6)+'-'+t.slice(6,8); }
    const m=t.match(/^(\d{2})(\d{2})(20\d{2})$/);
    if(m && +m[2]>=1 && +m[2]<=12) return m[3]+'-'+m[2]+'-'+m[1];
    return null; }
  const b=path.basename(file);
  /* ГРАНИЦУ `\b` БРАТЬ НЕЛЬЗЯ (18.09.2026): при загрузке пробелы в имени заменяются на «_»
     («XWAY_RICHFAMILY_2026-09-17_2026-09-17.xlsx»), а между «_» и «2» границы слова НЕТ —
     дата не находилась. Смотрим на соседние цифры. Тот же фикс в update-ads-perf.cjs. */
  const dash=[...b.matchAll(/(?<![0-9])(20\d{2})-(\d{2})-(\d{2})(?![0-9])/g)]
    .filter(m=>+m[2]>=1&&+m[2]<=12&&+m[3]>=1&&+m[3]<=31).map(m=>m[1]+'-'+m[2]+'-'+m[3]);
  const packed=[...b.matchAll(/\d{8}/g)].map(m=>isoFrom8(m[0])).filter(Boolean);
  const u=[...new Set(dash.length? dash : packed)].sort();
  FROM=process.argv[3]||u[0]; TO=process.argv[4]||u[u.length-1]||u[0];
  if(!isIso(FROM)||!isIso(TO)){
    console.error('не понял период из имени файла — укажите: <файл.xlsx> <с ГГГГ-ММ-ДД> <по ГГГГ-ММ-ДД>'); process.exit(1); }

  /* ЧИТАЕМ СВОИМ XML-ЧИТАТЕЛЕМ, А НЕ SheetJS: выгрузки Ozon пишут кириллицу числовыми
     сущностями, и SheetJS теряет на них старший байт («Артикул» → «@B8:C;») — ровно это
     случилось с отчётом юнит-экономики 17.09.2026. Если файл не читается — печатаем шапку. */
  const {openWorkbook}=require('./xlsx-xml-reader.cjs');
  const wb=openWorkbook(file);
  let rows=null, sheet='';
  for(const nm of wb.sheetNames){ const r=wb.readSheet(nm); if(r&&r.length){ rows=r; sheet=nm; break; } }
  if(!rows){ console.error('не смог прочитать ни один лист файла. Листы: '+wb.sheetNames.join(' | ')); process.exit(1); }

  /* ШАПКА ИЩЕТСЯ ПО ИМЕНАМ, а не по индексам — формат выгрузок меняется (у ВБ XWAY
     за месяц переименовал и валюту, и порядок колонок). Если колонка не нашлась,
     скрипт ПАДАЕТ и печатает шапку файла: молчаливый ноль опаснее падения. */
  const KEY=/(артикул|sku|ozon id|озон)/i, SPEND=/(расход|затрат|потрачен|списан|spend|cost)/i;
  let hr=-1, H=[];
  for(let i=0;i<Math.min(15,rows.length);i++){
    const R=(rows[i]||[]).map(S);
    if(R.some(x=>KEY.test(x)) && R.some(x=>SPEND.test(x))){ hr=i; H=R; break; } }
  if(hr<0){
    console.error('не нашёл шапку с колонками «Артикул/SKU» и «Расход».');
    console.error('Лист «'+sheet+'», первые строки:');
    rows.slice(0,12).forEach((r,i)=>console.error('  r'+i+': '+(r||[]).map(c=>S(c).slice(0,26)).join(' | ')));
    console.error('Добавьте нужное имя колонки в regexp KEY/SPEND, НЕ заменяя старые.');
    process.exit(1); }
  // из нескольких подходящих колонок берём самую «точную»: «Расход, ₽» важнее «Расход на показы»
  const iSpend=H.findIndex(x=>/^расход/i.test(x))>=0? H.findIndex(x=>/^расход/i.test(x)) : H.findIndex(x=>SPEND.test(x));
  const keyCols=H.map((x,i)=>({x,i})).filter(o=>KEY.test(o.x)).map(o=>o.i);
  if(iSpend<0||!keyCols.length){ console.error('шапка найдена, но колонок не хватает: '+H.filter(Boolean).join(' | ')); process.exit(1); }

  let miss=0, missKeys=new Set(), zero=[];
  for(let i=hr+1;i<rows.length;i++){
    const R=rows[i]||[]; let key=null;
    for(const c of keyCols){ const k=resolveKey(R[c]); if(k){ key=k; break; } }
    const spend=num(R[iSpend]);
    if(!key){ if(keyCols.some(c=>S(R[c])) && spend) { miss++; keyCols.forEach(c=>{ if(S(R[c])) missKeys.add(S(R[c])); }); } continue; }
    /* СТРОКА С НУЛЕВЫМ РАСХОДОМ — ЭТО «КАМПАНИИ НЕ БЫЛО», А НЕ «РЕКЛАМА СТОИЛА 0».
       В выгрузку попадают все карточки рекламного кабинета, в том числе те, по которым
       ставка не крутилась. Записать им ноль — значит сказать, что площадка не взяла
       за продвижение ничего, хотя средняя ставка из юнит-экономики (её платят все)
       никуда не делась. Такие товары остаются на СТАВКЕ. */
    if(spend<=0){ zero.push(key); continue; }
    bySup[key]=(bySup[key]||0)+spend;
  }
  if(zero.length) console.log('  строк с нулевым расходом (кампания не крутилась, остаются на ставке): '
    +zero.length+'  ('+zero.join(', ')+')');
  if(!Object.keys(bySup).length){
    console.error('в файле не нашлось ни одного нашего товара Озона. Шапка: '+H.filter(Boolean).join(' | ')); process.exit(1); }
  if(miss) console.log('  строк с расходом, но чужим/неизвестным артикулом: '+miss
    +(missKeys.size<=8? '  ('+[...missKeys].join(', ')+')':''));
  src=path.basename(file);
  wb.cleanup();
}
if(FROM>TO){ const t=FROM; FROM=TO; TO=t; }

/* ПОВТОРНАЯ ЗАЛИВКА ТОГО ЖЕ ПЕРИОДА НЕ ДВОИТСЯ: часть с пересекающимися датами
   заменяется целиком (то же правило, что у ВБ в update-ads-perf.cjs). */
const replaced=A.parts.filter(p=>!(p.to<FROM||p.from>TO));
A.parts=A.parts.filter(p=>(p.to<FROM||p.from>TO));
A.parts.push({from:FROM,to:TO,loadedAt:new Date().toISOString().slice(0,10),src,bySup});
save();

const tot=Object.values(bySup).reduce((a,b)=>a+b,0);
console.log('Реклама Ozon по факту за '+FROM+' … '+TO+': товаров '+Object.keys(bySup).length+' · расход '+F(tot)+' ₽');
if(replaced.length) console.log('  ВНИМАНИЕ: период пересёкся с уже залитым — заменено: '
  +replaced.map(p=>p.from+'…'+p.to).join(', '));
console.log('');
show();
console.log('\nУ этих товаров за эти даты реклама считается ПО ФАКТУ, у остальных — по ставке из отчёта юнит-экономики.');
console.log('Дальше: node scripts/encrypt.cjs <код>   (и проверить: node scripts/ozon-finance.cjs)');
