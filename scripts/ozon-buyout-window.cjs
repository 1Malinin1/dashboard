// % ВЫКУПА ОЗОНА — по той же логике, что и на ВБ (wb-buyout-window.cjs).
// Пишет REAL_DATA.ozon.meta.buyoutWin.history. Дальше: node scripts/encrypt.cjs <код>
//
// ЗАЧЕМ. До 08.09.2026 выкуп Озона считался как «НЕ ОТМЕНЁН ÷ ВСЕ ЗАКАЗЫ» по статусам из
// выгрузки «Заказы» — 92,1%. Это завышало результат: больше половины заказов в накопителе
// висят в статусах «Доставляется» / «Ожидает отгрузки» / «Ожидает сборки», то есть исход
// у них ещё не наступил, а формула засчитывала их как проданные. Часть из них отменится.
//
// ФОРМУЛА (правило продавца, 01.09.2026 для ВБ, 08.09.2026 распространено на Озон):
//   % выкупа = ДОСТАВЛЕНО ÷ (ДОСТАВЛЕНО + ОТМЕНЕНО)   — «от ЗАКРЫТЫХ заказов».
// Заказ уходит в одно из двух состояний: доставлен или отменён. Пока он «в пути», исход
// неизвестен, и держать его в знаменателе — значит занижать процент тем сильнее, чем свежее
// период. На зрелом периоде обе формулы («÷ закрытые» и «÷ все заказы») сходятся.
// Проверка на подённой воронке дала стабильную цифру на трёх независимых окнах:
// июль 80,3% · 01–14.08 79,3% · 15–28.08 80,7% (против 92,1% по старой формуле).
//
// ПРАВИЛО ПРИМЕНЕНИЯ — КАК НА ВБ: замер действует С ДАТЫ ЗАМЕРА И ВПЕРЁД, прошлые дни
// не пересчитываются. Ключ — дата ЗАМЕРА (`builtAt`), а не даты окна внутри отчёта: тот же
// период, измеренный позже, покажет процент выше (доставки доезжают), и подстановка свежего
// процента в старые дни завысила бы прошлое. Дни РАНЬШЕ самого первого замера считаются
// по нему же — другого источника для них нет.
// Повторный замер того же окна НЕ перезаписывает запись — иначе прошлое поехало бы.
//
// ИСТОЧНИК — отчёт Озона «Аналитика → По товарам» ЗА ПЕРИОД (не подённый), лист «По товарам».
// Колонки ищем ПО ИМЕНИ: «Заказано товаров» · «Доставлено товаров» · «Отменено товаров».
// Подённый отчёт тоже читается — дни просто суммируются.
//
// Использование:
//   node scripts/ozon-buyout-window.cjs list
//   node scripts/ozon-buyout-window.cjs <отчёт.xlsx> [ещё.xlsx ...] [--win ОТ ДО]
//   node scripts/ozon-buyout-window.cjs --from-funnel [--win ОТ ДО]   — замер по воронке в снимке
'use strict';
const fs=require('fs'), vm=require('vm'), path=require('path');
const XLSX=require('./node_modules/xlsx');
const OUT=path.join(__dirname,'..','decrypted');

const MIN_CLOSED=10;                      // свой % у товара — при 10+ ЗАКРЫТЫХ заказах
const argv=process.argv.slice(2);
const wi=argv.indexOf('--win');
const winFrom=wi>=0? argv[wi+1] : null, winTo=wi>=0? argv[wi+2] : null;
const fromFunnel=argv.includes('--from-funnel');
const files=argv.filter((a,i)=>!a.startsWith('--') && !(wi>=0&&(i===wi+1||i===wi+2)));

const cd={}; vm.createContext(cd);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-data.js'),'utf8')+'\nglobalThis.__RD=REAL_DATA;',cd);
const RD=cd.__RD, O=RD.ozon;
if(!O) throw new Error('в снимке нет блока Озона');
O.meta=O.meta||{};
const supSet=new Set(RD.catalog.map(c=>(''+(c.supplierCode||'')).trim()).filter(Boolean));
const hist=(O.meta.buyoutWin&&Array.isArray(O.meta.buyoutWin.history))? O.meta.buyoutWin.history.slice() : [];
const pc=n=>(n*100).toFixed(1)+'%';

function showHistory(){
  if(!hist.length){ console.log('Замеров нет — выкуп Озона берётся из meta.buyoutAll ('
    +pc(O.meta.buyoutAll||1)+', старая формула «не отменён ÷ все заказы»).'); return; }
  console.log('ИСТОРИЯ ЗАМЕРОВ ВЫКУПА ОЗОНА (день берёт ПОСЛЕДНИЙ замер не позже себя;');
  console.log('дни раньше первого замера — по первому; прошлое задним числом не меняется):');
  hist.forEach(h=>console.log('   замер '+(h.builtAt||'').slice(0,10)+'  окно '+h.from+' … '+h.to
    +'  выкуп '+pc(h.all)+'   (доставлено '+h.delivered+' · отменено '+h.cancelled
    +' · в пути '+h.open+')  свой % у '+Object.keys(h.bySku||{}).length+' товаров'));
}

if(argv[0]==='list'||(!files.length&&!fromFunnel)){
  showHistory();
  if(!files.length&&!fromFunnel&&argv[0]!=='list')
    console.error('\nusage: node scripts/ozon-buyout-window.cjs <отчёт.xlsx> ... | --from-funnel | list');
  process.exit(0);
}

// Озон-формат чисел: запятая = разделитель тысяч, точка = десятичная
function num(v){ const n=parseFloat((''+v).replace(/[\s ,₽%]/g,'')); return isNaN(n)?0:n; }
function idxOf(row,pred){ for(let i=0;i<row.length;i++){ if(pred((''+(row[i]||'')).replace(/\s+/g,' ').trim())) return i; } return -1; }

// ---- сбор: {bySku:{art:{o,d,c}}, days:Set}
const agg={}, days=new Set();
function add(art,o,d,c){ const e=agg[art]||(agg[art]={o:0,d:0,c:0}); e.o+=o; e.d+=d; e.c+=c; }

if(fromFunnel){
  const F=O.funnel||[];
  if(!F.length) throw new Error('в снимке нет воронки Озона');
  F.forEach(r=>{ if(winFrom&&r.date<winFrom) return; if(winTo&&r.date>winTo) return;
    days.add(r.date); add(r.sku, r.ordersQty||0, r.buyoutQty||0, r.cancelQty||0); });
  console.log('Источник: воронка из снимка'+(winFrom? ' ('+winFrom+' … '+winTo+')':' (весь период)'));
}else{
  for(const f of files){
    const wb=XLSX.read(fs.readFileSync(f),{type:'buffer',cellStyles:false,cellFormula:false});
    const sh=wb.Sheets['По товарам']||wb.Sheets[wb.SheetNames[0]];
    const rows=XLSX.utils.sheet_to_json(sh,{header:1,raw:false,defval:''});
    let hr=-1; for(let i=0;i<25;i++){ if((''+((rows[i]||[])[0])).trim()==='Товары'){hr=i;break;} }
    if(hr<0) throw new Error('не нашёл шапку («Товары») в '+path.basename(f));
    const top=rows[hr], sub=rows[hr+1]||[];
    const cArt=idxOf(top,v=>v==='Артикул'), cDay=idxOf(top,v=>v==='День');
    const cOrd=idxOf(sub,v=>v.startsWith('Заказано товаров'));
    const cDel=idxOf(sub,v=>v.startsWith('Доставлено товаров'));
    const cCan=idxOf(sub,v=>v.startsWith('Отменено товаров'));
    if(cArt<0||cOrd<0||cDel<0||cCan<0) throw new Error('не нашёл колонки в '+path.basename(f)
      +' (артикул='+cArt+' заказано='+cOrd+' доставлено='+cDel+' отменено='+cCan+')');
    let taken=0, skipped=0;
    for(let i=hr+2;i<rows.length;i++){
      const r=rows[i]; const art=(''+(r[cArt]||'')).trim();
      if(!art) continue;
      const day=cDay>=0? (''+(r[cDay]||'')).trim() : '';
      if(cDay>=0 && !/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;       // «Итого и среднее» и прочее
      if(!supSet.has(art)){ skipped++; continue; }
      if(day){ if(winFrom&&day<winFrom) continue; if(winTo&&day>winTo) continue; days.add(day); }
      add(art, num(r[cOrd]), num(r[cDel]), num(r[cCan])); taken++;
    }
    console.log('  '+path.basename(f)+': строк наших '+taken+' · чужих пропущено '+skipped
      +(cDay>=0? ' · подённый':' · за период'));
  }
}

// ---- период окна
let from=winFrom, to=winTo;
if(days.size){ const d=[...days].sort(); from=from||d[0]; to=to||d[d.length-1]; }
if(!from||!to) throw new Error('не удалось определить период окна — укажите его: --win ГГГГ-ММ-ДД ГГГГ-ММ-ДД');

let O_=0,D=0,C=0;
Object.values(agg).forEach(e=>{ O_+=e.o; D+=e.d; C+=e.c; });
const closed=D+C;
if(closed<=0) throw new Error('в отчёте нет закрытых заказов (доставлено+отменено = 0)');
const all=D/closed;
const open=Math.max(0,O_-closed);
const bySku={};
Object.entries(agg).forEach(([a,e])=>{ const cl=e.d+e.c; if(cl>=MIN_CLOSED) bySku[a]=+(e.d/cl).toFixed(4); });

console.log('\nOZON · окно '+from+' … '+to+' · наших карточек '+Object.keys(agg).length);
console.log('  заказано '+O_+' · доставлено '+D+' · отменено '+C+' · «в пути» '+open
  +' ('+(O_?(open/O_*100).toFixed(1):'0')+'%)');
console.log('  ВЫКУП (от закрытых): '+D+' ÷ ('+D+'+'+C+') = '+pc(all));
console.log('  для сверки: доставлено ÷ все заказы = '+(O_?pc(D/O_):'—')
  +'   (занижено на «в пути»)');
console.log('  прежняя формула в снимке (не отменён ÷ все заказы): '+pc(O.meta.buyoutAll||1));
console.log('  свой % у '+Object.keys(bySku).length+' товаров ('+MIN_CLOSED+'+ закрытых), у остальных общий');

// ---- запись: замер той же даты И того же окна не перезаписывается
const key=from+'…'+to;
const already=hist.find(h=>h.from+'…'+h.to===key);
if(already){
  console.log('\nОкно '+key+' уже измерялось ('+pc(already.all)+', замер '
    +(already.builtAt||'').slice(0,10)+') — прежняя запись СОХРАНЕНА, чтобы не пересчитывать прошлое.');
}else{
  hist.push({from,to,all:+all.toFixed(4),ordered:O_,delivered:D,cancelled:C,open,
    minClosed:MIN_CLOSED, bySku, source: fromFunnel? 'ozon-funnel' : 'ozon-analytics-period',
    builtAt:new Date().toISOString()});
  hist.sort((a,b)=>(a.builtAt||'')<(b.builtAt||'')?-1:1);
  O.meta.buyoutWin={history:hist,
    note:'% выкупа = доставлено ÷ (доставлено + отменено), «от закрытых заказов». '
      +'Замер действует с даты замера (builtAt) и вперёд; дни раньше первого замера — по первому.'};
  fs.writeFileSync(path.join(OUT,'wb-data.js'),
    '// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\n'
    +'const REAL_DATA = '+JSON.stringify(RD)+';\n');
  console.log('\nДобавлен замер: окно '+key+' · выкуп '+pc(all));
}
console.log('');
showHistory();
console.log('\nДальше: node scripts/ozon-finance.cjs  (проверить цифры) && node scripts/encrypt.cjs <код>');
