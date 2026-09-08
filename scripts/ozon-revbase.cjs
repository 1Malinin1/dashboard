// БАЗА ВЫРУЧКИ ОЗОНА: коэффициент перехода с «Предельной цены» на «цену реализации».
// Пишет REAL_DATA.ozon.meta.revBase.history. Дальше: node scripts/encrypt.cjs <код>
//
// ЗАЧЕМ. 31.08.2026 Ozon сменил методику расчёта продаж в аналитике: воронка «Заказано
// на сумму» перешла с цены продавца («Предельная цена», ex «Ваша цена») на «цену
// реализации». Перелом ровно 31.08 — до 30.08 воронка совпадала с нашим рядом заказов
// (88–104%), с 31.08 даёт 70,7–75,2% при СОВПАДАЮЩИХ ШТУКАХ. То есть продажи не падали,
// изменилась цена, по которой Ozon их считает.
//
// РЕШЕНИЕ ПРОДАВЦА (08.09.2026): «не нужно пересчитывать всю историю, давай только
// поменяем с выхода обновления, считай только с 31.08 получается по новому». Правило то
// же, что у процента выкупа: НОВАЯ БАЗА ДЕЙСТВУЕТ С ДАТЫ И ВПЕРЁД, прошлые дни остаются
// как были. Поэтому здесь ИСТОРИЯ ЗАПИСЕЙ, а не одно число: повторный замер не переписывает
// прошлое, а добавляет запись, действующую со своей даты.
//
// КАК СЧИТАЕТСЯ k. Сравниваем СРЕДНИЙ ЧЕК воронки со средним чеком нашего ряда заказов
// за окно замера: k = (воронка ₽ / воронка шт) ÷ (ряд ₽ / ряд шт). Именно по чеку, а не
// по сумме: у воронки и ряда чуть разное число штук (разные срезы выгрузок), и деление
// сумм смешало бы разницу в цене с разницей в штуках. На окне 31.08–06.09 обе меры
// сходятся: 73,06% по чеку и 73,35% по суммам.
//
// ЧЕГО ЭТОТ КОЭФФИЦИЕНТ НЕ ЗНАЧИТ. Он описывает, как Ozon ТЕПЕРЬ СЧИТАЕТ продажи, а не
// доказывает, сколько продавец получает на счёт. Это решает только финотчёт Ozon
// («Начисления» / «Отчёт о реализации товаров»). Когда он придёт — сверить с ним и,
// если нужно, добавить новую запись со своей даты.
//
// НЕ ПУТАТЬ с колонкой «Оплачено покупателем» в выгрузке «Заказы»: она про живые деньги
// покупателя, идёт на уровне ОТПРАВЛЕНИЯ и не включает оплату баллами Ozon — базой
// выручки быть не может (см. CLAUDE.md, раздел про ценовую логику Ozon).
//
// Использование:
// ПРАВИЛО ЗАМЕРЕНО, НО НЕ ПРИМЕНЯЕТСЯ (решение 08.09.2026 — см. флаг `applied`). Продавец
// возразил: комиссия не росла, цену он не снижал, в экономике не изменилось НИЧЕГО, а расчёт
// по новой базе выводил его в ноль. Проверка подтвердила его правоту: скидка покупателю
// существовала и ДО перелома (24.08 — 71,0%, 28.08 — 68,7%, 30.08 — 71,0% от его цены),
// а воронка Ozon в те же дни считала выручку по ПОЛНОЙ цене (01–30.08 — 98,7%, июль — 99,8%).
// То есть покупатель платил ~72%, а Ozon засчитывал продавцу 100% — ровно механика соинвеста
// («Озон даёт соинвест за свой счёт», 04.09.2026). 31.08 изменилась только витрина аналитики.
// Если бы продавец реально получал 72%, июль был бы −1,0 млн ₽, а вся история −2,2 млн ₽ —
// это не прошло бы мимо расчётного счёта. Поэтому k записан как ЗАМЕР, а расчёт остаётся
// на «Предельной цене» до финотчёта Ozon. Включить обратно: `on`.
//
// Использование:
//   node scripts/ozon-revbase.cjs list                    — показать историю и статус
//   node scripts/ozon-revbase.cjs measure                 — замерить и добавить запись
//   node scripts/ozon-revbase.cjs measure --from 2026-08-31         — с какой даты действует
//   node scripts/ozon-revbase.cjs measure --win 2026-08-31 2026-09-06 — окно замера
//   node scripts/ozon-revbase.cjs set 0.73 --from 2026-09-15         — задать вручную
//   node scripts/ozon-revbase.cjs off / on                — применять правило или нет
'use strict';
const fs=require('fs'), vm=require('vm'), path=require('path');
const OUT=path.join(__dirname,'..','decrypted');

const argv=process.argv.slice(2);
const cmd=(argv[0]||'list').toLowerCase();
const arg=n=>{ const i=argv.indexOf('--'+n); return i>=0? argv[i+1] : null; };
const SWITCH_DAY='2026-08-31';   // день, когда Ozon переключил методику

const ctx={}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-data.js'),'utf8')+'\nglobalThis.__RD=REAL_DATA;',ctx);
const RD=ctx.__RD, O=RD.ozon;
if(!O) throw new Error('в снимке нет блока Озона');
O.meta=O.meta||{};
const hist=(O.meta.revBase&&Array.isArray(O.meta.revBase.history))? O.meta.revBase.history.slice() : [];
let applied=(O.meta.revBase && O.meta.revBase.applied===true);   // по умолчанию НЕ применяется

const pc=n=>(n*100).toFixed(2)+'%';
const f=n=>Math.round(n).toLocaleString('ru-RU');
const today=new Date().toISOString().slice(0,10);

function showHistory(){
  if(!hist.length){ console.log('Замеров базы выручки нет — вся история Озона считается по «Предельной цене».'); return; }
  console.log('ЗАМЕРЫ БАЗЫ ВЫРУЧКИ ОЗОНА:');
  hist.forEach(h=>console.log('   с '+h.from+'  k = '+pc(h.k)
    +'   (замер '+(h.measuredFrom||'?')+' … '+(h.measuredTo||'?')+', '+(h.days||0)+' дн., '
    +(h.builtAt||'').slice(0,10)+')'));
  console.log(applied
    ? '   СТАТУС: ПРИМЕНЯЕТСЯ. Дни ДО '+hist[0].from+' считаются по «Предельной цене» (k = 100%).'
    : '   СТАТУС: НЕ ПРИМЕНЯЕТСЯ — расчёт идёт по «Предельной цене» на всей истории.\n'
      +'   Это замер, а не правило: ждём финотчёт Ozon. Включить: node scripts/ozon-revbase.cjs on');
}

function save(){
  O.meta.revBase={history:hist, applied,
    note:'k = во сколько раз выручка по новой методике Ozon меньше суммы по «Предельной цене». '
      +'Применяется, только если applied===true; действует с даты записи и вперёд, прошлое не пересчитывается.'};
  fs.writeFileSync(path.join(OUT,'wb-data.js'),
    '// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\n'
    +'const REAL_DATA = '+JSON.stringify(RD)+';\n');
}

if(cmd==='list'){ showHistory(); process.exit(0); }
if(cmd==='off'||cmd==='on'){
  applied=(cmd==='on'); save();
  console.log(applied? 'Правило ВКЛЮЧЕНО: выручка Озона считается по замеренной базе с даты записи.'
    : 'Правило ВЫКЛЮЧЕНО: выручка Озона считается по «Предельной цене» на всей истории.');
  console.log('');
  showHistory();
  console.log('\nДальше: node scripts/ozon-finance.cjs  (проверить цифры) && node scripts/encrypt.cjs <код>');
  process.exit(0);
}

// ---- замер k по воронке Озона против нашего ряда заказов
function measure(wFrom,wTo){
  const S=O.orderSeries||{}, dates=S.dates||[], byArt=S.byArt||{}, money=S.money||{};
  const F=O.funnel||[];
  const fd={}; F.forEach(r=>{ if(r.date<wFrom||r.date>wTo) return;
    const e=fd[r.date]||(fd[r.date]={sum:0,q:0}); e.sum+=r.ordersSum||0; e.q+=r.ordersQty||0; });
  const days=Object.keys(fd).sort();
  if(!days.length) throw new Error('в снимке нет воронки Озона за '+wFrom+' … '+wTo
    +' — залейте отчёт «Аналитика → По товарам, подённо» через ozon-funnel-build.cjs');
  let F$=0,Fq=0,M$=0,Mq=0; const rows=[];
  days.forEach(d=>{
    const i=dates.indexOf(d); if(i<0) return;
    const m=money[d]||{}; let s=0; Object.values(m).forEach(v=>s+=v[0]||0);
    let q=0; Object.values(byArt).forEach(a=>q+=a[i]||0);
    if(!s||!q) return;
    F$+=fd[d].sum; Fq+=fd[d].q; M$+=s; Mq+=q;
    rows.push({d, fs:fd[d].sum, fq:fd[d].q, ms:s, mq:q});
  });
  if(!rows.length) throw new Error('нет дней, где есть и воронка, и ряд заказов');
  const kCheck=(F$/Fq)/(M$/Mq), kMoney=F$/M$;
  return {rows, F$,Fq,M$,Mq, kCheck, kMoney, from:rows[0].d, to:rows[rows.length-1].d};
}

let entry=null;
if(cmd==='measure'){
  const win=argv.indexOf('--win');
  const wFrom=win>=0? argv[win+1] : SWITCH_DAY;
  const wTo  =win>=0? argv[win+2] : '9999-12-31';
  const m=measure(wFrom,wTo);
  console.log('ЗАМЕР по воронке Озона против ряда заказов ('+m.from+' … '+m.to+', '+m.rows.length+' дн.)');
  console.log('   дата        воронка ₽     ряд ₽    k(сумма)   чек вор.  чек ряд   k(чек)');
  m.rows.forEach(r=>console.log('   '+r.d+' '+f(r.fs).padStart(11)+' '+f(r.ms).padStart(11)
    +'   '+pc(r.fs/r.ms).padStart(7)+'   '+f(r.fs/r.fq).padStart(7)+'  '+f(r.ms/r.mq).padStart(7)
    +'  '+pc((r.fs/r.fq)/(r.ms/r.mq)).padStart(7)));
  console.log('   ИТОГО: воронка '+f(m.F$)+' ₽ / '+m.Fq+' шт · ряд '+f(m.M$)+' ₽ / '+m.Mq+' шт');
  console.log('   k по чеку   '+pc(m.kCheck)+'  ← берём это');
  console.log('   k по суммам '+pc(m.kMoney)+'  (для сверки; расходится на разницу в штуках)');
  const from=arg('from') || (hist.length? today : SWITCH_DAY);
  entry={from, k:+m.kCheck.toFixed(4), kMoney:+m.kMoney.toFixed(4),
    measuredFrom:m.from, measuredTo:m.to, days:m.rows.length,
    funnelRub:Math.round(m.F$), funnelQty:m.Fq, seriesRub:Math.round(m.M$), seriesQty:m.Mq,
    source:'воронка Ozon «Заказано на сумму» ÷ ряд заказов по «Предельной цене», по среднему чеку',
    builtAt:new Date().toISOString()};
}else if(cmd==='set'){
  const k=parseFloat((argv[1]||'').replace(',','.'));
  if(!(k>0&&k<=2)) throw new Error('usage: node scripts/ozon-revbase.cjs set <k> [--from ГГГГ-ММ-ДД]');
  entry={from:arg('from')||today, k:+k.toFixed(4), source:'задано вручную', builtAt:new Date().toISOString()};
}else{
  console.error('usage: node scripts/ozon-revbase.cjs list | measure [--from ГГГГ-ММ-ДД] [--win ОТ ДО] | set <k> [--from ГГГГ-ММ-ДД]');
  process.exit(1);
}

// ЗАПИСЬ С ТОЙ ЖЕ ДАТОЙ НЕ ПЕРЕЗАПИСЫВАЕТСЯ — иначе прошлое поехало бы (правило продавца).
const dup=hist.find(h=>h.from===entry.from);
if(dup){
  console.log('\nЗапись с датой '+entry.from+' уже есть (k = '+pc(dup.k)+') — СОХРАНЕНА как была.');
  console.log('Чтобы применить новый коэффициент, укажите другую дату начала: --from '+today);
}else{
  hist.push(entry); hist.sort((a,b)=>a.from<b.from?-1:1);
  save();
  console.log('\nДобавлена запись: с '+entry.from+'  k = '+pc(entry.k)
    +(applied? '' : '   (правило ВЫКЛЮЧЕНО — это только замер; включить: on)'));
}
console.log('');
showHistory();
console.log('\nДальше: node scripts/ozon-finance.cjs  (проверить цифры) && node scripts/encrypt.cjs <код>');
