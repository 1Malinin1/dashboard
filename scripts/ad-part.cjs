// Пометка частей накопителя рекламы (`REAL_DATA.adPerf.parts`).
//
// ЗАЧЕМ (решение продавца 09.09.2026). Накопитель складывает все загруженные выгрузки
// XWAY, и `bySku` — их сумма: она идёт в знаменатель ДРР и в CPO. Пока выгрузки шли
// по активным дням, это было правильно. 09.09 продавец прислал 03–25.08 — период,
// когда реклама фактически не крутилась: расход 3 241 ₽ за 23 дня при выручке
// 20 251 351 ₽. Часть нужна для ПРИБЫЛИ (расход всё-таки был), но в ДРР она добавляет
// огромный знаменатель без числителя и роняет цифру вдвое: 2,5% вместо 5,6% в заказах.
// Продавец принимает решения по ставкам, глядя на ДРР, поэтому такая часть помечается
// `spendOnly:true` — «расход считаем, выручку в ДРР не берём».
//
// ЧТО МЕНЯЕТСЯ ОТ ФЛАГА:
//   · `adPerf.bySku` (ДРР, CPO, показы, клики, «Отдача», пирамида ДРР) — пересобирается
//     БЕЗ таких частей;
//   · `adPerf.from`/`to` — границы активного периода, тоже без них (в UI это подпись
//     «Период рекламы»);
//   · РАСХОД НА ПРИБЫЛЬ НЕ МЕНЯЕТСЯ: `adRowsFromPerf` в index.html и `recAdsInWindow`
//     ходят по `parts[]` и берут только `spend`, поэтому помеченная часть продолжает
//     уменьшать прибыль своих дней. Ровно это и просил продавец.
//
// Использование:
//   node scripts/ad-part.cjs list
//   node scripts/ad-part.cjs spend-only <ГГГГ-ММ-ДД> <ГГГГ-ММ-ДД>   — пометить часть
//   node scripts/ad-part.cjs full       <ГГГГ-ММ-ДД> <ГГГГ-ММ-ДД>   — снять пометку
//   node scripts/ad-part.cjs drop       <ГГГГ-ММ-ДД> <ГГГГ-ММ-ДД>   — удалить часть совсем
// Дальше: node scripts/encrypt.cjs <код>
'use strict';
const fs=require('fs'), vm=require('vm'), path=require('path');
const OUT=path.join(__dirname,'..','decrypted');
const F=v=>Math.round(v).toLocaleString('ru-RU');

const cd={}; vm.createContext(cd);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-data.js'),'utf8')+'\nglobalThis.__RD=REAL_DATA;',cd);
const RD=cd.__RD, P=RD.adPerf;
if(!P||!Array.isArray(P.parts)) throw new Error('в снимке нет накопителя adPerf.parts');

const SUMK=['spend','imp','clicks','carts','ord','rub','othOrd','othRub','totOrd','totRub'];
function totals(p){ const t={}; SUMK.forEach(k=>t[k]=0);
  Object.values(p.bySku||{}).forEach(e=>SUMK.forEach(k=>t[k]+=e[k]||0)); return t; }
function days(p){ return Math.round((Date.parse(p.to)-Date.parse(p.from))/864e5)+1; }

// Пересборка сводки: части со `spendOnly` в ДРР/CPO не участвуют.
function rebuild(){
  const use=P.parts.filter(p=>!p.spendOnly);
  const merged={};
  use.forEach(p=>Object.entries(p.bySku).forEach(([sku,e])=>{
    const m=merged[sku]||(merged[sku]={spend:0,rk:0,imp:0,clicks:0,carts:0,ord:0,rub:0,othOrd:0,othRub:0,totOrd:0,totRub:0});
    SUMK.forEach(k=>m[k]+=e[k]||0);
    m.rk=Math.max(m.rk,e.rk||0);
  }));
  P.bySku=merged;
  if(use.length){ P.from=use[0].from; P.to=use[use.length-1].to; }
  P.spendOnlyNote='Части с spendOnly:true дают расход в прибыль, но НЕ входят в знаменатель ДРР.';
}

function show(){
  const bo=(RD.meta&&RD.meta.buyoutWin&&RD.meta.buyoutWin.all)||0;
  console.log('НАКОПИТЕЛЬ РЕКЛАМЫ · частей '+P.parts.length+' · период для ДРР '+P.from+' … '+P.to);
  let spAll=0, spDrr=0, revDrr=0;
  P.parts.forEach(p=>{ const t=totals(p); spAll+=t.spend;
    if(!p.spendOnly){ spDrr+=t.spend; revDrr+=t.totRub; }
    console.log('  '+p.from+'…'+p.to+' ('+String(days(p)).padStart(2)+' дн)  расход '+F(t.spend).padStart(9)
      +' ₽ · выручка '+F(t.totRub).padStart(11)+' ₽ · ДРР '+(t.totRub? (t.spend/t.totRub*100).toFixed(1):'—')+'%'
      +(p.spendOnly? '   ← только расход, в ДРР не идёт':''));
  });
  console.log('  ─────');
  console.log('  расход ВСЕГО (идёт в прибыль):        '+F(spAll)+' ₽');
  console.log('  расход в знаменателе ДРР:             '+F(spDrr)+' ₽');
  console.log('  выручка в знаменателе ДРР:            '+F(revDrr)+' ₽');
  if(revDrr) console.log('  ДРР: в заказах '+(spDrr/revDrr*100).toFixed(1)+'%'
    +(bo? ' · в выкупе '+(spDrr/(revDrr*bo)*100).toFixed(1)+'% (выкуп '+(bo*100).toFixed(1)+'%)':''));
}

const [cmd,from,to]=process.argv.slice(2);
if(!cmd||cmd==='list'){ show(); process.exit(0); }
if(!['spend-only','full','drop'].includes(cmd)){
  console.error('usage: node scripts/ad-part.cjs list | spend-only <от> <до> | full <от> <до> | drop <от> <до>');
  process.exit(1);
}
if(!from||!to){ console.error('нужны даты части: '+cmd+' <ГГГГ-ММ-ДД> <ГГГГ-ММ-ДД>'); process.exit(1); }
const i=P.parts.findIndex(p=>p.from===from&&p.to===to);
if(i<0){ console.error('части '+from+'…'+to+' нет. Есть: '+P.parts.map(p=>p.from+'…'+p.to).join(', ')); process.exit(1); }

if(cmd==='drop'){ const t=totals(P.parts[i]); P.parts.splice(i,1);
  console.log('Часть '+from+'…'+to+' удалена (расход '+F(t.spend)+' ₽ больше НЕ уменьшает прибыль).'); }
else { if(cmd==='spend-only') P.parts[i].spendOnly=true; else delete P.parts[i].spendOnly;
  console.log('Часть '+from+'…'+to+(cmd==='spend-only'
    ? ' помечена «только расход»: её выручка убрана из знаменателя ДРР, расход в прибыли остался.'
    : ' снова участвует в ДРР целиком.')); }
rebuild();

fs.writeFileSync(path.join(OUT,'wb-data.js'),
  '// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\n'
  +'const REAL_DATA = '+JSON.stringify(RD)+';\n');
console.log('');
show();
console.log('\nДальше: node scripts/encrypt.cjs <код>');
