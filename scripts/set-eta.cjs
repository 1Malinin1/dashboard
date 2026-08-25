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
// ДВЕ ДАТЫ У ОДНОЙ ПАРТИИ. Продавец различает «приедет ко мне на склад» и «встанет
// в продажу на площадке» — между ними ещё около месяца на приёмку и отгрузку. Для вопроса
// «на сколько хватит» важна ВТОРАЯ: пока партия лежит у него на складе непринятой,
// она продажи не закрывает. Поэтому `eta` = приход на склад, `etaSale` = выход в продажу;
// «Запас и темп» берёт `etaSale`, а если её нет — `eta`.
//
// Использование:
//   node scripts/set-eta.cjs order 2026-11-09              — приход на склад
//   node scripts/set-eta.cjs order --sale 2026-12-10       — выход в продажу
//   node scripts/set-eta.cjs order 2026-11-09 512189       — только по одному коду 1С
//   node scripts/set-eta.cjs drop china                    — убрать партию целиком
//   node scripts/set-eta.cjs list                          — показать, что сейчас задано
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');
const OUT=path.join(__dirname,'..','decrypted');
const KINDS={china:'из Китая', order:'заказ производству'};

let argv=process.argv.slice(2);
const SALE=argv.includes('--sale'); argv=argv.filter(a=>a!=='--sale');
const kind=argv[0], date=argv[1], code=argv[2];
if(!kind || (kind!=='list' && kind!=='drop' && !KINDS[kind])){
  console.error('usage: node scripts/set-eta.cjs <china|order> [--sale] <ГГГГ-ММ-ДД> [код1С]\n'
    +'       node scripts/set-eta.cjs drop <china|order>\n'
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
      console.log('   приход НА СКЛАД: '+b.eta+(d>=0? ' (через '+d+' дн)' : ' — ПРОСРОЧЕНА на '+(-d)+' дн, уточните срок')); }
    else console.log('   приход на склад: НЕ ЗАДАН');
    if(b.etaSale){ const d=days(today,b.etaSale);
      console.log('   ВЫХОД В ПРОДАЖУ: '+b.etaSale+(d>=0? ' (через '+d+' дн)' : ' — ПРОСРОЧЕН на '+(-d)+' дн')
        +'   ← по этой дате считается «Запас и темп»'); }
    else console.log('   выход в продажу: не задан — берётся дата прихода на склад');
    const per=b.etaBySup||{};
    const k2=Object.keys(per); if(k2.length) console.log('   свои даты у '+k2.length+' кодов: '
      +k2.slice(0,8).map(c=>c+'→'+per[c]).join(', ')+(k2.length>8?' …':''));
  });
  process.exit(0);
}
// убрать партию целиком (загрузили по ошибке / всё уже пришло)
if(kind==='drop'){
  const k=date;
  if(!KINDS[k]){ console.error('usage: node scripts/set-eta.cjs drop <china|order>'); process.exit(1); }
  if(!RD.inbound[k]){ console.log('партии «'+KINDS[k]+'» и так нет'); process.exit(0); }
  const was=RD.inbound[k].total||0;
  delete RD.inbound[k];
  fs.writeFileSync(path.join(OUT,'wb-data.js'),
    '// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\n'
    +'const REAL_DATA = '+JSON.stringify(RD)+';\n');
  console.log('Убрана партия «'+KINDS[k]+'» ('+was.toLocaleString('ru-RU')+' шт)');
  console.log('\nДальше: node scripts/encrypt.cjs <код>'); process.exit(0);
}
if(!/^\d{4}-\d{2}-\d{2}$/.test(date||'')){ console.error('дата в формате ГГГГ-ММ-ДД'); process.exit(1); }
const b=RD.inbound[kind];
if(!b){ console.error('партии «'+KINDS[kind]+'» в снимке нет — сначала залейте её update-warehouse.cjs'); process.exit(1); }
const what=SALE? 'выход в продажу' : 'приход на склад';
if(code){
  const c=(''+code).replace(/[\s ,]/g,'');
  if(!(b.bySup||{})[c]){ console.error('кода '+c+' нет в этой партии'); process.exit(1); }
  const map=SALE? (b.etaSaleBySup||(b.etaSaleBySup={})) : (b.etaBySup||(b.etaBySup={}));
  map[c]=date;
  console.log('Код '+c+' ('+b.bySup[c].toLocaleString('ru-RU')+' шт) — '+what+' '+date);
} else {
  if(SALE) b.etaSale=date; else b.eta=date;
  console.log(KINDS[kind]+': '+(b.total||0).toLocaleString('ru-RU')+' шт — '+what+' '+date
    +' (через '+days(today,date)+' дн от '+today+')');
}
fs.writeFileSync(path.join(OUT,'wb-data.js'),
  '// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\n'
  +'const REAL_DATA = '+JSON.stringify(RD)+';\n');
console.log('\nДальше: node scripts/encrypt.cjs <код>');
