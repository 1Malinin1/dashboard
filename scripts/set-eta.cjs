// Проставляет ОЖИДАЕМУЮ ДАТУ ПРИХОДА партии (ETA) в REAL_DATA.inbound.<china|order>.eta
// Дальше: node scripts/encrypt.cjs <код>
//
// ЗАЧЕМ. Раньше у партии хранилась только дата ЗАГРУЗКИ файла и подпись «приедет примерно
// через 3 месяца». Дата загрузки не меняется, поэтому надпись висела вечно: и через месяц,
// и через полгода дашборд обещал «через 3 месяца». Теперь хранится КОНКРЕТНАЯ дата прихода,
// а «сколько осталось дней» дашборд считает от СЕГОДНЯ и пересчитывает сам каждый день.
// Партия, дата которой уже прошла, помечается «просрочена» — это сигнал уточнить срок,
// а не тихо считать её приехавшей.
//
// Использование:
//   node scripts/set-eta.cjs china 2026-11-15          — вся партия из Китая
//   node scripts/set-eta.cjs order 2026-12-20          — весь заказ производству
//   node scripts/set-eta.cjs china 2026-11-15 512189   — только по одному коду 1С
//   node scripts/set-eta.cjs list                      — показать, что сейчас задано
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');
const OUT=path.join(__dirname,'..','decrypted');
const KINDS={china:'из Китая', order:'заказ производству'};

const kind=process.argv[2], date=process.argv[3], code=process.argv[4];
if(!kind || (kind!=='list' && !KINDS[kind])){
  console.error('usage: node scripts/set-eta.cjs <china|order> <ГГГГ-ММ-ДД> [код1С]\n'
    +'       node scripts/set-eta.cjs list'); process.exit(1); }

const ctx={};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-data.js'),'utf8')+'\nglobalThis.__RD=REAL_DATA;',ctx);
const RD=ctx.__RD;
RD.inbound=RD.inbound||{};

const today=new Date().toISOString().slice(0,10);
const days=(a,b)=>Math.round((new Date(b+'T00:00:00Z')-new Date(a+'T00:00:00Z'))/864e5);

if(kind==='list'){
  Object.keys(KINDS).forEach(k=>{
    const b=RD.inbound[k];
    if(!b){ console.log(KINDS[k]+': партии нет'); return; }
    const n=Object.keys(b.bySup||{}).length;
    console.log(KINDS[k]+': '+(b.total||0).toLocaleString('ru-RU')+' шт по '+n+' кодам · загружено '+b.date);
    if(b.eta){ const d=days(today,b.eta);
      console.log('   ожидаемый приход: '+b.eta+(d>=0? ' (через '+d+' дн)' : ' — ПРОСРОЧЕНА на '+(-d)+' дн, уточните срок')); }
    else console.log('   ожидаемый приход: НЕ ЗАДАН — расчёт «на сколько хватит до партии» работать не будет');
    const per=b.etaBySup||{};
    const k2=Object.keys(per); if(k2.length) console.log('   свои даты у '+k2.length+' кодов: '
      +k2.slice(0,8).map(c=>c+'→'+per[c]).join(', ')+(k2.length>8?' …':''));
  });
  process.exit(0);
}
if(!/^\d{4}-\d{2}-\d{2}$/.test(date||'')){ console.error('дата в формате ГГГГ-ММ-ДД'); process.exit(1); }
const b=RD.inbound[kind];
if(!b){ console.error('партии «'+KINDS[kind]+'» в снимке нет — сначала залейте её update-warehouse.cjs'); process.exit(1); }
if(code){
  const c=(''+code).replace(/[\s ,]/g,'');
  if(!(b.bySup||{})[c]){ console.error('кода '+c+' нет в этой партии'); process.exit(1); }
  (b.etaBySup||(b.etaBySup={}))[c]=date;
  console.log('Код '+c+' ('+b.bySup[c].toLocaleString('ru-RU')+' шт) — приход '+date);
} else {
  b.eta=date;
  console.log(KINDS[kind]+': '+(b.total||0).toLocaleString('ru-RU')+' шт — приход '+date
    +' (через '+days(today,date)+' дн от '+today+')');
}
fs.writeFileSync(path.join(OUT,'wb-data.js'),
  '// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\n'
  +'const REAL_DATA = '+JSON.stringify(RD)+';\n');
console.log('\nДальше: node scripts/encrypt.cjs <код>');
