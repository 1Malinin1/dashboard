// Считает % ВЫКУПА ВБ по окну из СВОДНОГО отчёта аналитики «Воронка продаж» за период
// (не подённого!) и пишет его в REAL_DATA.meta.buyoutWin. Дальше: node scripts/encrypt.cjs <код>
//
// ЗАЧЕМ ОТДЕЛЬНЫЙ ИСТОЧНИК. Подённая воронка в снимке для выкупа не годится: значение
// заморожено на момент выгрузки и задним числом не обновляется, поэтому день, выгруженный
// в тот же день, навсегда остаётся с нулевым выкупом (см. buyoutFromFunnel в index.html).
// Сводный отчёт за период, выгруженный СЕГОДНЯ, такой проблемы не имеет.
//
// ПРАВИЛО ПРОДАВЦА (01.09.2026, он же присылает файл каждый понедельник):
//   окно = 14 дней, ПРОПУСТИВ последние 7. Сегодня 01.09 → 25–31.08 не берём, считаем по
//   предыдущим двум неделям. Свежая неделя выброшена сознательно: товар ещё едет.
//
// % ВЫКУПА = ВЫКУПЛЕНО ÷ (ВЫКУПЛЕНО + ОТМЕНЕНО) — «от ЗАКРЫТЫХ заказов».
// Именно так считает сам ВБ в колонке «Процент выкупа», и именно эту цифру продавец видит
// в кабинете. Сверка на файле 10–23.08: 1829 ÷ (1829 + 577) = 76.0% при «Процент выкупа = 76»
// в листе «Фильтры»; предыдущий период 1942 ÷ (1942 + 1202) = 61.8% при 62 в файле.
//
// ПОЧЕМУ ЭТО ЛУЧШЕ ПРЕЖНЕГО «выкуплено ÷ ВСЕ заказы». Заказ уходит в одно из двух состояний —
// выкуп или отмена; пока он «в пути», исход неизвестен. Старая формула считала все «в пути»
// как невыкупленные и занижала цифру тем сильнее, чем свежее окно: на этом же файле она даёт
// 62.9% против 76.0%. Новая формула просто не учитывает неопределившиеся заказы и
// предполагает, что они разойдутся в той же пропорции.
// НА ЗРЕЛОМ ОКНЕ ОБЕ ФОРМУЛЫ СОВПАДАЮТ: при «в пути» → 0 имеем заказано = выкуп + отмена,
// то есть b/o = b/(b+x). Так что это не смена смысла, а снятие смещения.
//
// ЧЕГО НЕ ПУТАТЬ: «от неотменённых» (b ÷ (заказано − отменено) = 78.5%) — это НЕ то же самое,
// там в знаменателе сидят ещё не доехавшие заказы. И не `buyoutPct14d` из каталога (88.4%).
//
// Использование: node scripts/wb-buyout-window.cjs <отчёт_за_период.xlsx> [--force-current]
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');
const XLSX=require('./node_modules/xlsx');
const OUT=path.join(__dirname,'..','decrypted');
/* ПОРОГ ЗРЕЛОСТИ — 5%, А НЕ 10% (уточнено 31.08.2026 замером «одно окно дважды»).
   Окно 03–16.08 замерили с разницей в неделю:
     24.08 (через 8 дн):  выкуп 58.5%, в пути 22.1%
     31.08 (через 15 дн): выкуп 66.1%, в пути  9.4%
   Из рассосавшихся 12.7 п.п. выкупом стали 7.6 (60%), отменой 5.1 (40%). То есть при 9.4%
   «в пути» цифра ещё занижена примерно на 4–6 п.п. — старый порог 10% пропускал такое окно
   как «зрелое». Контроль на июльском окне: 25.08 при 5.5% в пути было 75.0%, 31.08 при 4.0%
   стало 75.6% — то есть ниже 5% доползание уже меньше процента. Отсюда порог 5%.
   Не ослабляй обратно: занижённый выкуп тянет вниз продажи/день в подсорте и завышает ДРР. */
const MATURE_OPEN_PCT=5;   // «ещё в пути» больше этого — окну не верим
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

/* Лист ищем ПО СОДЕРЖИМОМУ. Обычно он называется «Товары», но если продавец выгрузил
   отчёт с фильтром по предмету, лист называется этим предметом («Пушкары»). Требуем
   «Артикул WB» И «Заказали товаров, шт», чтобы не схватить «Промосервисы …». */
function findSheet(wb){
  const names=['Товары',...wb.SheetNames.filter(n=>n!=='Товары')];
  for(const n of names){ const sh=wb.Sheets[n]; if(!sh) continue;
    const rr=XLSX.utils.sheet_to_json(sh,{header:1,raw:false,defval:''});
    for(let i=0;i<Math.min(6,rr.length);i++){
      const H=(rr[i]||[]).map(x=>(''+x).replace(/\s+/g,' ').trim());
      if(H.some(h=>/^Артикул WB$/i.test(h)) && H.some(h=>/^Заказали товаров, шт$/i.test(h)))
        return {rows:rr, name:n}; } }
  return null;
}
const found=findSheet(wb);
if(!found){ console.error('не нашёл лист с «Артикул WB» и «Заказали товаров, шт» — это точно сводный отчёт воронки?'); process.exit(1); }
const rows=found.rows;
console.log('Лист: «'+found.name+'»'+(found.name!=='Товары'? '  (отчёт отфильтрован по предмету — покрытие будет частичным)':''));
// шапка — по имени: индексы между версиями отчёта плывут
let hr=-1; for(let i=0;i<Math.min(6,rows.length);i++){
  if((rows[i]||[]).some(x=>/^Артикул WB$/i.test((''+x).trim()))){ hr=i; break; } }
if(hr<0){ console.error('не нашёл шапку с «Артикул WB»'); process.exit(1); }
const H=(rows[hr]||[]).map(x=>(''+x).replace(/\s+/g,' ').trim());
const col=re=>H.findIndex(h=>re.test(h));
const iSku=col(/^Артикул WB$/i);
const C={ o:col(/^Заказали товаров, шт$/i), b:col(/^Выкупили, шт$/i), x:col(/^Отменили, шт$/i),
  ro:col(/^Заказали на сумму, ₽$/i), rb:col(/^Выкупили на сумму, ₽$/i), rx:col(/^Отменили на сумму, ₽$/i) };
const P={ o:col(/^Заказали товаров, шт \(предыдущий/i), b:col(/^Выкуп[а-я]*, шт \(предыдущий/i), x:col(/^Отменили, шт \(предыдущий/i),
  ro:col(/^Заказали на сумму, ₽ \(предыдущий/i), rb:col(/^Выкупили на сумму, ₽ \(предыдущий/i),
  rx:col(/^Отменили на сумму, ₽ \(предыдущий/i) };
if(iSku<0||C.o<0||C.b<0){ console.error('не нашёл колонки (Артикул WB / Заказали / Выкупили)'); process.exit(1); }

function collect(idx){
  if(idx.o<0||idx.b<0) return null;
  const bySku={}; let o=0,b=0,x=0,rowsN=0,ro=0,rb=0,rxx=0;
  for(let i=hr+1;i<rows.length;i++){ const r=rows[i]; const sku=(''+(r[iSku]||'')).trim();
    if(!ourSku.has(sku)) continue;
    const rro=num(r[idx.o]), rrb=num(r[idx.b]), rx=idx.x>=0? num(r[idx.x]) : 0;
    const e=bySku[sku]||(bySku[sku]={o:0,b:0,x:0}); e.o+=rro; e.b+=rrb; e.x+=rx;
    o+=rro; b+=rrb; x+=rx; rowsN++;
    if(idx.ro>=0) ro+=num(r[idx.ro]); if(idx.rb>=0) rb+=num(r[idx.rb]);
    if(idx.rx>=0) rxx+=num(r[idx.rx]); }
  if(!o) return null;
  const open=Math.max(0,o-b-x), closed=b+x;
  return {ordered:o,bought:b,cancelled:x,open,openPct:+(open/o*100).toFixed(1),closed,
    // ГЛАВНАЯ ЦИФРА: выкуп от ЗАКРЫТЫХ заказов — как в кабинете ВБ
    all: closed? +(b/closed).toFixed(4) : 0,
    ofAllOrders:+(b/o).toFixed(4),                       // прежняя формула, для сверки
    ofNotCancelled:+((o-x)>0? b/(o-x):0).toFixed(4),
    /* ДЕНЕЖНЫЙ выкуп — на той же базе: выкуплено ₽ ÷ (выкуплено ₽ + отменено ₽).
       Он идёт в модель финансов, где выручка считается из ЗАКАЗАННЫХ рублей
       (чек выкупленного отличается от чека заказанного). */
    orderedRub:ro, boughtRub:rb, cancelledRub:rxx,
    moneyAll: (rb+rxx)? +(rb/(rb+rxx)).toFixed(4) : null,
    moneyOfAll: ro? +(rb/ro).toFixed(4) : null,
    rows:rowsN, bySku};
}
const cur=collect(C), prev=collect(P);
if(!cur){ console.error('в файле нет наших товаров с заказами'); process.exit(1); }

/* ОКНО — ВСЕГДА ТЕКУЩИЙ ПЕРИОД ФАЙЛА. Продавец выгружает его по правилу «пропустить
   последние 7 дней, взять 14», поэтому выбирать за него не нужно. Прежняя логика
   («если в пути больше порога — берём предыдущий период») была костылём под старую
   формулу b/o, которая на свежем окне занижала выкуп; формула «от закрытых заказов»
   этим не страдает. Предыдущий период считается и печатается для сверки. */
let pick='current', win=cur, per=pCur;
const bySkuPct={};
// свой % — только если по товару накопилось MIN_ORD ЗАКРЫТЫХ заказов (выкуп+отмена)
Object.entries(win.bySku).forEach(([s,v])=>{ const cl=(v.b||0)+(v.x||0);
  if(cl>=MIN_ORD) bySkuPct[s]=+(v.b/cl).toFixed(4); });

/* МЕРЖ, А НЕ ЗАМЕНА. Отчёт может быть отфильтрован по одному предмету («Пушкары»), и тогда
   полная перезапись стёрла бы свой % выкупа у всех остальных категорий — а он теперь идёт
   в ДРР по уровням и в потолок CPO. Новые значения перекрывают старые, ненайденные
   сохраняются со своего прошлого окна. Сколько строк реально обновлено — печатается. */
const prevWin=(RD.meta&&RD.meta.buyoutWin)||null;
const prevBy=(prevWin&&prevWin.bySku)||{};
const kept=Object.keys(prevBy).filter(k=>bySkuPct[k]==null).length;
const mergedBy={...prevBy, ...bySkuPct};

RD.meta=RD.meta||{};
RD.meta.buyoutWin={
  from:per.from, to:per.to, all:win.all, bySku:mergedBy,
  bySkuFresh:Object.keys(bySkuPct).length, bySkuKept:kept, sheet:found.name,
  moneyAll:win.moneyAll, moneyOfAll:win.moneyOfAll,
  orderedRub:win.orderedRub, boughtRub:win.boughtRub, cancelledRub:win.cancelledRub,
  ordered:win.ordered, bought:win.bought, cancelled:win.cancelled, closed:win.closed,
  ofAllOrders:win.ofAllOrders, ofNotCancelled:win.ofNotCancelled,
  basis:'closed-orders',        // выкуплено ÷ (выкуплено + отменено), как в кабинете ВБ
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
  console.log('   ВЫКУП от закрытых заказов (идёт в расчёт): '+pc(p.all)+'   ← как «Процент выкупа» в кабинете ВБ');
  console.log('   для сверки: от всех заказов '+pc(p.ofAllOrders)+' (занижено на «в пути»)'
    +' · от неотменённых '+pc(p.ofNotCancelled));
  if(p.moneyAll!=null) console.log('   ДЕНЕЖНЫЙ выкуп (для модели финансов): '+pc(p.moneyAll)
    +'   (заказано '+Math.round(p.orderedRub).toLocaleString('ru-RU')+' ₽ → выкуплено '+Math.round(p.boughtRub).toLocaleString('ru-RU')+' ₽)');
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
