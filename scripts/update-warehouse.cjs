// Заливает «свои» остатки и то, что едет к продавцу, из выгрузок 1С.
//
//   node scripts/update-warehouse.cjs stock  <файл.xls> [дата]   — остатки на СВОИХ складах
//   node scripts/update-warehouse.cjs china  <файл.xls> [дата]   — товары в пути из Китая
//   node scripts/update-warehouse.cjs order  <файл.xls> [дата]   — открытые заказы производству
//
// Пишет:
//   REAL_DATA.warehouse = {date, split:false, byWh:{склад:шт}, bySup:{код:{qty, wh:{склад:шт}}}}
//   REAL_DATA.inbound   = {china:{date,total,bySup}, order:{date,total,bySup}}
// Ключ везде — «Номенклатура.Код» = арт. поставщика = WB supplierCode = артикул Озона.
//
// Форматы 1С, которые понимает скрипт:
//   A. «Ведомость по товарам на складах» — шапка со «Номенклатура.Код» и колонками складов + «Итог».
//      Каждая колонка склада становится отдельным складом (Евросиб = Новосибирск, СХ Солнечногорск = Москва).
//   B. «Ведомость по заказам поставщикам» — строки-заголовки «Заказ поставщику …», под ними код/кол-во.
//      Берём только строки с числовым кодом; отрицательные и служебные ±1 игнорируем.
// Числа: «1,234.000» = 1234. Коды: «487 160» = 487160 (1С печатает с разделителем разрядов).
//
// Дальше: node scripts/encrypt.cjs <код>
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');
const XLSX=require('./node_modules/xlsx');
const OUT=path.join(__dirname,'..','decrypted');
let argv=process.argv.slice(2);
/* --wh <склад> — ЯВНО СКАЗАТЬ, ЧЕЙ ЭТО ФАЙЛ. Складов у продавца три, и два из них
   в Новосибирске: «FBS» (Нск-1) и «Евросиб» (Нск-2). 1С печатает в шапке одну и ту же
   подпись, поэтому по имени колонки их не различить — выгрузка второго склада молча
   затирала бы первый. Значение: msk | nsk1 | nsk2 (или прямое имя склада). */
const takeArg=k=>{const i=argv.indexOf(k); if(i<0) return null; const v=argv[i+1]; argv.splice(i,2); return v;};
const whArg=takeArg('--wh');
const kind=(argv[0]||'').toLowerCase();
const file=argv[1];
const dateArg=argv[2]||new Date().toISOString().slice(0,10);
if(!['stock','china','order'].includes(kind)||!file){
  console.error('usage: node scripts/update-warehouse.cjs [--wh msk|nsk1|nsk2] <stock|china|order> <файл.xls> [ГГГГ-ММ-ДД]');process.exit(1);}

const S=v=>(''+(v==null?'':v)).replace(/ /g,' ').replace(/\s+/g,' ').trim();
// 1С печатает разделитель разрядов и пробелом, и ЗАПЯТОЙ: «487 160» и «474,092» → 487160/474092.
// Без срезания запятой строки не проходили /^\d+$/ и файл молча читался как пустой.
const code=v=>S(v).replace(/[\s ,]/g,'');
const num=v=>{ const s=S(v).replace(/[\s ]/g,'').replace(/,/g,''); if(!s) return 0;
  const n=parseFloat(s); return isNaN(n)?0:n; };
// Продавец выгружает склад с разными подписями колонки: «Склад Евросиб», «Нск», «Новосибирск».
// Без приведения к одному имени мерж по складам добавил бы ВТОРОЙ склад рядом со старым
// и задвоил остаток (старый бы сохранился как «отсутствующий в файле»). Приводим к каноничным
// именам — тем, что понимает дашборд (whShort в index.html).
// ТРИ СКЛАДА (правила продавца 27.08.2026):
//   СХ Солнечногорск (Москва) — только FBS для Wildberries, никуда не отгружает;
//   Склад FBS (Новосибирск-1) — FBS для Wildberries + поставки на Ozon;
//   Склад Евросиб (Новосибирск-2) — поставки на Ozon + перемещение на Нск-1.
const WH_MSK='СХ Солнечногорск', WH_MSK2='РЦ Солнечногорский', WH_NSK1='Склад FBS', WH_NSK2='Склад Евросиб';
const WH_ALIAS={msk:WH_MSK, msk2:WH_MSK2, nsk1:WH_NSK1, nsk2:WH_NSK2};
const whForced=whArg? (WH_ALIAS[(''+whArg).toLowerCase()]||S(whArg)) : null;
/* «РЦ Солнечногорский (Москва)» — ОТДЕЛЬНАЯ площадка, появилась 28.08.2026. Держим её
   отдельным складом, а не сливаем с «СХ Солнечногорск»: продавец видит обе строки, а на
   маршрутизацию это не влияет — оба московских склада ведут себя одинаково (только FBS
   для Wildberries, никуда не отгружают), и `whKey()` в index.html разбирает их по «солнечногор».
   Проверка порядка важна: правило РЦ стоит ДО общего московского, иначе он бы схлопнулся. */
const canonWh=v=>{ if(whForced) return whForced; const s=S(v);
  if(/(^|\W)fbs(\W|$)|фбс/i.test(s)) return WH_NSK1;
  if(/евросиб/i.test(s)) return WH_NSK2;
  if(/рц\s*солнечногор/i.test(s)) return WH_MSK2;
  if(/солнечногор|москв|^мск$/i.test(s)) return WH_MSK;
  if(/новосиб|^нск$/i.test(s)) return WH_NSK2;   // «просто Новосибирск» без уточнения — Евросиб
  return s; };

const ctx={};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-data.js'),'utf8')+'\nglobalThis.__RD=REAL_DATA;',ctx);
const RD=ctx.__RD;
const supSet=new Set(RD.catalog.map(c=>S(c.supplierCode)).filter(Boolean));
const nameBySup={}; RD.catalog.forEach(c=>{ const s=S(c.supplierCode); if(s&&!nameBySup[s]) nameBySup[s]=c.name; });

const wb=XLSX.read(fs.readFileSync(file),{type:'buffer',cellStyles:false,cellFormula:false});
const rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,raw:false,defval:''});

// ---- определяем раскладку ----
// Заголовок «Номенклатура.Код» встречается и в описании отчёта («Группировки строк: …»),
// поэтому ищем ТОЧНОЕ совпадение ячейки. Раскладку «по заказам» опознаём по строкам
// «Заказ поставщику …» — в ней колонок складов нет вообще.
const isOrders = rows.some(r=>(r||[]).some(x=>/^Заказ поставщику\b/i.test(S(x))));
/* Колонка кода: в ведомости 1С это «Номенклатура.Код», а в рабочем файле продавца
   (свод по трём складам) — просто «Код». Ищем по точному совпадению обеих подписей. */
const CODE_HDRS=['Номенклатура.Код','Код'];
let hr=-1, iCodeFound=-1;
for(let i=0;i<Math.min(24,rows.length);i++){
  const idx=(rows[i]||[]).findIndex(x=>CODE_HDRS.includes(S(x)));
  if(idx>=0){ hr=i; iCodeFound=idx; break; } }
const layout = isOrders ? 'B' : 'A';
if(layout==='A'&&hr<0){ console.error('не нашёл строку-шапку с ячейкой «Номенклатура.Код» или «Код»'); process.exit(1); }
const bySup={}, byWh={}; let taken=0, skipped={}, total=0;
let cols=[];   // колонки-склады из шапки (нужны и ниже, при мерже по складам)
const inbCols={china:[],order:[]};   // колонки «едет ко мне» — это не склад
const mpCols=[]; const mpBy={};      // колонки складов маркетплейсов — тоже не наш склад
const inbBy={china:{},order:{}};

if(layout==='A'){
  const H=rows[hr].map(S);
  const iCode=iCodeFound>=0? iCodeFound : H.findIndex(x=>CODE_HDRS.includes(x));
  // колонки складов — всё между кодом и «Итог» (сам «Итог» не берём, чтобы не задвоить)
  for(let i=iCode+1;i<H.length;i++){ const h=H[i]; if(!h) continue; if(/^Итог/i.test(h)) break;
    // «плановый запас» и прочие справочные колонки складами не являются
    if(/плановый|запас|норма/i.test(h)) continue;
    /* Рабочий файл продавца везёт рядом со складами справочные колонки: вместимость
       паллеты («Паллет Озон (св-во Номенклатура)») и название («Номенклатура»).
       Складами они не являются — иначе вместимость попала бы в остаток как отдельный склад. */
    if(/^паллет/i.test(h) || /^номенклатура$/i.test(h) || /наименован|название/i.test(h)) continue;
    /* Справочные колонки-свойства номенклатуры: «Код Ozon (св-во Номенклатура)»,
       «Артикул для WB», «Кратность отгрузки», «Паллет Озон». Складами не являются.
       Признак «(св-во …)» надёжнее любого списка имён — 1С помечает так все свойства.
       ВАЖНО: этот отсев должен идти ДО проверки на склады маркетплейсов, иначе
       «Код Ozon (св-во Номенклатура)» попадёт туда как «склад Озона». */
    if(/св-во|кратност|артикул/i.test(h)) continue;
    if(/^код(\s|$)/i.test(h)) continue;
    /* СКЛАДЫ МАРКЕТПЛЕЙСОВ — НЕ НАШ СКЛАД. В 1С товар, лежащий на складах Ozon и WB,
       учитывается отдельными складами («Склад ОЗОН ПФО», «Склад ОЗОН СФО», «Склад РВБ ПФО»).
       Если засчитать их в REAL_DATA.warehouse, они задвоятся с ozStock/wbStock: в покрытии
       площадки этот товар уже есть, а подсорт решит, что его можно ещё раз отгрузить. */
    if(/озон|ozon|рвб|вайлдбер|wildberries/i.test(h)){ mpCols.push({i,name:h}); continue; }
    // В одном файле продавец присылает и склады, и то, что едет К НЕМУ. Это НЕ склад:
    // «в пути ко мне (Китай)» → inbound.china, «заказано производству» → inbound.order.
    // Без этого разделения колонка Китая становилась бы третьим складом и попадала
    // в покрытие/подсорт как реальный остаток.
    if(/китай|в пути ко мне/i.test(h)){ inbCols.china.push({i,name:h}); continue; }
    if(/заказан|производств|свободн/i.test(h)){ inbCols.order.push({i,name:h}); continue; }
    cols.push({i,name:canonWh(h)}); }
  if(!cols.length){ console.error('не нашёл колонок складов в шапке: '+JSON.stringify(H)); process.exit(1); }
  console.log('раскладка «ведомость по складам» · шапка в строке '+(hr+1)+' · склады: '+cols.map(c=>c.name).join(' · '));
  for(let i=hr+1;i<rows.length;i++){
    const r=rows[i]; const k=code(r[iCode]);
    if(!k||!/^\d+$/.test(k)) continue;                       // «Итог» и пустые строки
    let sum=0; const wh={};
    cols.forEach(c=>{ const v=num(r[c.i]); if(v>0){ wh[c.name]=(wh[c.name]||0)+v; sum+=v; } });
    let inbSum=0;
    ['china','order'].forEach(t=>inbCols[t].forEach(c=>{ const v=num(r[c.i]); if(v>0){ inbSum+=v;
      if(supSet.has(k)) inbBy[t][k]=(inbBy[t][k]||0)+v; } }));
    mpCols.forEach(c=>{ const v=num(r[c.i]); if(v>0) mpBy[c.name]=(mpBy[c.name]||0)+v; });
    if(sum<=0 && inbSum<=0) continue;
    if(!supSet.has(k)){ skipped[k]=(skipped[k]||0)+sum+inbSum; continue; }
    if(sum<=0) continue;   // только «в пути» — склада нет, но inbound уже записан выше
    const e=bySup[k]||(bySup[k]={qty:0,wh:{}});
    e.qty+=sum; Object.entries(wh).forEach(([n,v])=>{ e.wh[n]=(e.wh[n]||0)+v; byWh[n]=(byWh[n]||0)+v; });
    taken++; total+=sum;
  }
} else {
  // Б: строки-заголовки «Заказ поставщику …», под ними пары код/количество.
  // Колонку кода берём из шапки, количество — следующая за ней.
  const HB=(hr>=0? rows[hr]:[]).map(S);
  const iCode=Math.max(1,HB.findIndex(x=>CODE_HDRS.includes(x)));
  const iQty=iCode+1;
  console.log('раскладка «ведомость по заказам поставщикам»');
  let orders=0;
  for(let i=0;i<rows.length;i++){
    const r=rows[i]; const c0=S(r[iCode]);
    if(/^Заказ поставщику/i.test(c0)){ orders++; continue; }
    const k=code(r[iCode]); if(!k||!/^\d+$/.test(k)) continue;
    const q=num(r[iQty]); if(q<=0) continue;                 // отрицательные/нулевые остатки заказа — мусор
    if(!supSet.has(k)){ skipped[k]=(skipped[k]||0)+q; continue; }
    const e=bySup[k]||(bySup[k]={qty:0,wh:{}});
    e.qty+=q; taken++; total+=q;
  }
  console.log('заказов поставщикам в файле: '+orders);
}

// Страховка: если из файла не взято НИ ОДНОЙ строки — это почти всегда сбой разбора
// (сменился формат кода/шапки), а не «склад опустел». Пишем ошибку и НЕ трогаем снимок.
if(taken===0){
  console.error('\n❌ Из файла не взято ни одной строки — снимок НЕ изменён.');
  console.error('   Проверьте колонку с кодом («Номенклатура.Код») и формат кодов в файле.');
  process.exit(1);
}
if(kind==='stock'){
  // МЕРЖ ПО СКЛАДАМ, а не замена целиком. Продавец присылает и полную ведомость (все склады
  // в шапке), и выгрузку по ОДНОМУ складу («Номенклатура.Код» + «СХ Солнечногорск»). Полная
  // замена во втором случае молча обнуляла бы второй склад — а он реальный.
  // Правило: склады, названные в шапке файла, перезаписываются целиком (нет строки = 0 там),
  // склады, которых в файле нет, сохраняются как были.
  const fileWh=new Set(Object.keys(byWh));
  cols.forEach(c=>fileWh.add(c.name));                       // и те, что в шапке, но без остатков
  const prev=(RD.warehouse&&RD.warehouse.bySup)||{};
  const kept=new Set();
  Object.entries(prev).forEach(([k,v])=>{
    const keep={}; let sum=0;
    Object.entries(v.wh||{}).forEach(([n,q])=>{ if(!fileWh.has(n)){ keep[n]=q; sum+=q; kept.add(n); } });
    if(sum<=0) return;
    const e=bySup[k]||(bySup[k]={qty:0,wh:{}});
    e.qty+=sum; Object.entries(keep).forEach(([n,q])=>{ e.wh[n]=(e.wh[n]||0)+q; byWh[n]=(byWh[n]||0)+q; });
  });
  console.log('склады из файла (перезаписаны): '+[...fileWh].join(' · ')
    +(kept.size? ' | сохранены как были: '+[...kept].join(' · ') : ' | других складов в снимке не было'));
  RD.warehouse={date:dateArg, split:false, byWh, bySup};
  // колонки «едет ко мне» из этого же файла — полная замена соответствующего слоя
  ['china','order'].forEach(t=>{ if(!inbCols[t].length) return;
    const tot=Object.values(inbBy[t]).reduce((a,b)=>a+b,0);
    RD.inbound=RD.inbound||{};
    const was=(RD.inbound[t]&&RD.inbound[t].total)||0;
    RD.inbound[t]={date:dateArg, total:tot, bySup:inbBy[t]};
    console.log((t==='china'?'Едет из Китая':'Заказано производству')+': '
      +was.toLocaleString('ru-RU')+' → '+tot.toLocaleString('ru-RU')+' шт (позиций '+Object.keys(inbBy[t]).length+')');
  });
} else {
  RD.inbound=RD.inbound||{};
  RD.inbound[kind]={date:dateArg, total, bySup:Object.fromEntries(Object.entries(bySup).map(([k,v])=>[k,v.qty]))};
}
fs.writeFileSync(path.join(OUT,'wb-data.js'),
  '// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\n'
  +'const REAL_DATA = '+JSON.stringify(RD)+';\n');

const label={stock:'Остатки своих складов',china:'В пути из Китая',order:'Заказано производству'}[kind];
const uk=Object.keys(skipped);
console.log('\n'+label+' на '+dateArg+': позиций '+Object.keys(bySup).length+' · '+total.toLocaleString('ru-RU')+' шт');
if(kind==='stock') Object.entries(byWh).forEach(([n,v])=>console.log('   '+n+': '+v.toLocaleString('ru-RU')+' шт'));
/* Коды не из каталога — это РОЗНИЧНЫЕ товары продавца, которых нет ни на ВБ, ни на Озоне
   (подтверждено 28.08.2026). Их пропуск — норма, а не потеря данных: связывать их с
   маркетплейсами не нужно. Формулировка мягкая специально, чтобы будущая сессия не начала
   «чинить» это. */
const skipQty=uk.reduce((a,k)=>a+skipped[k],0);
if(mpCols.length){
  console.log('\nСклады МАРКЕТПЛЕЙСОВ в файле — пропущены (этот товар уже учтён в остатках площадок):');
  mpCols.forEach(c=>console.log('   '+c.name+': '+Math.round(mpBy[c.name]||0).toLocaleString('ru-RU')+' шт'));
}
console.log('Розничные коды (нет на ВБ и Озоне, в расчёт не идут): '+uk.length+' кодов · '
  +Math.round(skipQty).toLocaleString('ru-RU')+' шт'
  +(uk.length? ' · '+uk.slice(0,12).map(k=>k+' ('+skipped[k]+')').join(', ')+(uk.length>12?' …':'') : ''));
const top=Object.entries(bySup).sort((a,b)=>b[1].qty-a[1].qty).slice(0,8);
if(top.length){ console.log('\nТоп по количеству:');
  top.forEach(([k,v])=>console.log('   1С '+k+' · '+v.qty.toLocaleString('ru-RU')+' шт'
    +(Object.keys(v.wh).length? ' ('+Object.entries(v.wh).map(([n,q])=>n+' '+q).join(' / ')+')':'')
    +'  · '+(nameBySup[k]||'').slice(0,38))); }
console.log('\nДальше: node scripts/encrypt.cjs <код>');
