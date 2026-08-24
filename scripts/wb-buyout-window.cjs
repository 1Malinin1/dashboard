// Считает % ВЫКУПА ВБ по окну из СВОДНОГО отчёта аналитики «Воронка продаж» за период
// (не подённого!) и пишет его в REAL_DATA.meta.buyoutWin. Дальше: node scripts/encrypt.cjs <код>
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ ИСТОЧНИК. Подённая воронка в снимке для выкупа не годится: значение
// заморожено на момент выгрузки и задним числом не обновляется, поэтому день, выгруженный
// в тот же день, навсегда остаётся с нулевым выкупом (см. buyoutFromFunnel в index.html).
// Сводный отчёт за период, выгруженный СЕГОДНЯ, такой проблемы не имеет.
//
// ЧТО ИМЕННО НУЖНО. «Продаж/день» = заказов/день (GROSS, все статусы) × выкуп, поэтому
// множитель обязан быть «выкуплено ÷ ВСЕ заказы». Собственный «Процент выкупа» ВБ считается
// от НЕотменённых заказов и получается на ~18 п.п. выше — если взять его, отмены посчитаются
// дважды и продаж/день будет завышен.
//
// ЗРЕЛОСТЬ. В отчёте есть заказано/выкуплено/отменено, значит «ещё в пути» = зак − вык − отм.
// Пока их доля велика, выкуп по окну занижен. Поэтому в файле берутся ОБА периода (текущий
// и «предыдущий период», который на две недели старше и почти дозрел) и выбирается первый,
// у которого в пути меньше MATURE_OPEN_PCT. На реальных данных 24.08: окно 03–16.08 — 22.1%
// в пути и 58.5% выкупа (занижено), предыдущее 20.07–02.08 — 5.5% в пути и 75.0% (верно).
//
// Использование: node scripts/wb-buyout-window.cjs <отчёт_за_период.xlsx> [--force-current]
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');
const XLSX=require('./node_modules/xlsx');
const OUT=path.join(__dirname,'..','decrypted');
const MATURE_OPEN_PCT=10;   // «ещё в пути» больше этого — окну не верим
const MIN_ORD=10;           // свой % у товара только при таком числе заказов в окне

let args=process.argv.slice(2);
const forceCur=args.includes('--force-current'); args=args.filter(a=>a!=='--force-current');
const file=args[0];
if(!file){ console.error('usage: node scripts/wb-buyout-window.cjs <отчёт_за_период.xlsx> [--force-current]'); process.exit(1); }

const num=v=>{const s=(''+v).replace(/[\s ]/g,'').replace(/,/g,'.');const n=parseFloat(s);return isNaN(n)?0:n;};
// «С 03-08-2026 по 16-08-2026» → {from:'2026-08-03', to:'2026-08-16'}
function parsePeriod(s){
  const m=(''+s).match(/(\d{2})-(\d{2})-(\d{4}).*?(\d{2})-(\d{2})-(\d{4})/);
  if(!m) return null;
  return {from:m[3]+'-'+m[2]+'-'+m[1], to:m[6]+'-'+m[5]+'-'+m[4]};
}

const ctx={};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-data.js'),'utf8')+'\nglobalThis.__RD=REAL_DATA;',ctx);
const RD=ctx.__RD;
const ourSku=new Set(RD.catalog.map(x=>''+x.sku));
const nameBySku={}; RD.catalog.forEach(x=>nameBySku[''+x.sku]=x.name);

const wb=XLSX.read(fs.readFileSync(file),{type:'buffer',cellStyles:false,cellFormula:false});
const gi=XLSX.utils.sheet_to_json(wb.Sheets['Общая информация']||{},{header:1,raw:false,defval:''});
let pCur=null,pPrev=null;
gi.forEach(row=>{ const k=(''+(row[0]||'')).toLowerCase();
  if(/текущий период/.test(k)) pCur=parsePeriod(row[1]);
  else if(/прошлый период|предыдущий период/.test(k)) pPrev=parsePeriod(row[1]); });
if(!pCur){ console.error('не нашёл период в листе «Общая информация» — это точно сводный отчёт воронки за период?'); process.exit(1); }

const sh=wb.Sheets['Товары'];
if(!sh){ console.error('нет листа «Товары»'); process.exit(1); }
const rows=XLSX.utils.sheet_to_json(sh,{header:1,raw:false,defval:''});
// шапка — по имени: индексы между версиями отчёта плывут
let hr=-1; for(let i=0;i<Math.min(6,rows.length);i++){
  if((rows[i]||[]).some(x=>/^Артикул WB$/i.test((''+x).trim()))){ hr=i; break; } }
if(hr<0){ console.error('не нашёл шапку с «Артикул WB»'); process.exit(1); }
const H=(rows[hr]||[]).map(x=>(''+x).replace(/\s+/g,' ').trim());
const col=re=>H.findIndex(h=>re.test(h));
const iSku=col(/^Артикул WB$/i);
const C={ o:col(/^Заказали товаров, шт$/i), b:col(/^Выкупили, шт$/i), x:col(/^Отменили, шт$/i) };
const P={ o:col(/^Заказали товаров, шт \(предыдущий/i), b:col(/^Выкуп[а-я]*, шт \(предыдущий/i), x:col(/^Отменили, шт \(предыдущий/i) };
if(iSku<0||C.o<0||C.b<0){ console.error('не нашёл колонки (Артикул WB / Заказали / Выкупили)'); process.exit(1); }

function collect(idx){
  if(idx.o<0||idx.b<0) return null;
  const bySku={}; let o=0,b=0,x=0,rowsN=0;
  for(let i=hr+1;i<rows.length;i++){ const r=rows[i]; const sku=(''+(r[iSku]||'')).trim();
    if(!ourSku.has(sku)) continue;
    const ro=num(r[idx.o]), rb=num(r[idx.b]), rx=idx.x>=0? num(r[idx.x]) : 0;
    const e=bySku[sku]||(bySku[sku]={o:0,b:0}); e.o+=ro; e.b+=rb;
    o+=ro; b+=rb; x+=rx; rowsN++; }
  if(!o) return null;
  const open=Math.max(0,o-b-x);
  return {ordered:o,bought:b,cancelled:x,open,openPct:+(open/o*100).toFixed(1),
    all:+(b/o).toFixed(4), ofNotCancelled:+((o-x)>0? b/(o-x):0).toFixed(4), rows:rowsN, bySku};
}
const cur=collect(C), prev=collect(P);
if(!cur){ console.error('в файле нет наших товаров с заказами'); process.exit(1); }

// выбираем окно: сначала текущее, если дозрело; иначе предыдущее
let pick='current', win=cur, per=pCur;
if(!forceCur && cur.openPct>MATURE_OPEN_PCT && prev && prev.openPct<=MATURE_OPEN_PCT){
  pick='prev'; win=prev; per=pPrev||{from:null,to:null};
}
const bySkuPct={};
Object.entries(win.bySku).forEach(([s,v])=>{ if(v.o>=MIN_ORD) bySkuPct[s]=+(v.b/v.o).toFixed(4); });

RD.meta=RD.meta||{};
RD.meta.buyoutWin={
  from:per.from, to:per.to, all:win.all, bySku:bySkuPct,
  ordered:win.ordered, bought:win.bought, cancelled:win.cancelled,
  open:win.open, openPct:win.openPct, minOrd:MIN_ORD, picked:pick,
  source:'wb-analytics-period', builtAt:new Date().toISOString(),
  alt: (pick==='current'&&prev)? {from:(pPrev||{}).from,to:(pPrev||{}).to,all:prev.all,openPct:prev.openPct}
     : (pick==='prev')? {from:pCur.from,to:pCur.to,all:cur.all,openPct:cur.openPct} : null
};
fs.writeFileSync(path.join(OUT,'wb-data.js'),
  '// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\n'
  +'const REAL_DATA = '+JSON.stringify(RD)+';\n');

const pc=n=>(n*100).toFixed(1)+'%';
function show(l,p,per){
  if(!p){ console.log(l+' — нет данных'); return; }
  console.log(l+' ('+(per&&per.from||'?')+' … '+(per&&per.to||'?')+'):');
  console.log('   заказано '+p.ordered+' · выкуплено '+p.bought+' · отменено '+p.cancelled
    +' · ещё в пути '+p.open+' ('+p.openPct+'%)');
  console.log('   выкуп от ВСЕХ заказов (идёт в расчёт): '+pc(p.all)
    +'   · от неотменённых (как показывает ВБ): '+pc(p.ofNotCancelled));
}
console.log('Сводный отчёт воронки ВБ · наших карточек '+cur.rows);
show('ТЕКУЩИЙ ПЕРИОД',cur,pCur);
show('ПРЕДЫДУЩИЙ ПЕРИОД',prev,pPrev);
console.log('\nВЫБРАНО: '+(pick==='current'?'текущий':'предыдущий')+' период — '
  +RD.meta.buyoutWin.from+' … '+RD.meta.buyoutWin.to+' · выкуп '+pc(RD.meta.buyoutWin.all)
  +' · в пути '+RD.meta.buyoutWin.openPct+'%');
if(pick==='prev') console.log('   (текущее окно отброшено: в пути '+cur.openPct+'% > '+MATURE_OPEN_PCT+'% — выкуп по нему занижен)');
console.log('   свой % у '+Object.keys(bySkuPct).length+' товаров (10+ заказов), у остальных общий');
const old=RD.catalog.map(x=>x.buyoutPct14d).filter(x=>x>0);
console.log('   для сравнения buyoutPct14d из каталога: '+(old.reduce((a,b)=>a+b,0)/old.length).toFixed(1)+'%'
  +' — это «от неотменённых», для продаж/день не подходит');
console.log('\nДальше: node scripts/encrypt.cjs <код>');
