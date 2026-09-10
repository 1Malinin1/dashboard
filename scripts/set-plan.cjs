// План по чистой прибыли на месяц — по каждой площадке отдельно.
// Пишет REAL_DATA.meta.plan. Дальше: node scripts/encrypt.cjs <код>
//
// ЗАЧЕМ (решение продавца 10.09.2026). Рекомендации отвечали на вопрос «что горит»,
// но не на вопрос «мы успеваем к цели или нет». Продавец попросил поставить план по
// прибыли на каждый маркетплейс и идти к нему, выполняя рекомендации. План живёт
// В СНИМКЕ, а не в коде: он меняется каждый месяц и его ставит человек, а не расчёт.
//
// ЧТО ВАЖНО ЗНАТЬ ПРО ЦИФРЫ, КОТОРЫЕ БУДУТ СРАВНИВАТЬСЯ С ПЛАНОМ:
// · МЕСЯЦ ЗДЕСЬ КАЛЕНДАРНЫЙ на обеих площадках. У ВБ «свой» месяц идёт целыми неделями
//   (сентябрь 31.08–27.09), и для сверки с закрывающими документами надо смотреть блок
//   недель на «Главной». План — управленческая цель, её проще держать по календарю,
//   и Озон иначе с ВБ не сложить.
// · ПРИБЫЛЬ ВБ С 03.08 — ОЦЕНКА (`MODELED_FINANCE`), а не отчёт: отчёты о реализации
//   продавцу закрыли 24.08.2026. Факт заканчивается 02.08.
// · ПРИБЫЛЬ ОЗОНА СЧИТАЕТСЯ ПО «ПРЕДЕЛЬНОЙ ЦЕНЕ» (см. meta.revBase, applied:false).
//   Если финотчёт Ozon покажет, что продавец получает цену реализации, план по Озону
//   придётся пересматривать целиком — сейчас его выполнение считается по действующей модели.
//
// Использование:
//   node scripts/set-plan.cjs list
//   node scripts/set-plan.cjs 2026-09 --wb 6280000 --oz 5500000
//   node scripts/set-plan.cjs 2026-09 --wb 6280000            (озон не трогаем)
//   node scripts/set-plan.cjs drop 2026-09
'use strict';
const fs=require('fs'), vm=require('vm'), path=require('path');
const OUT=path.join(__dirname,'..','decrypted');
const F=v=>Math.round(v).toLocaleString('ru-RU');
const MON=['янв','фев','мар','апр','май','июн','июл','авг','сен','окт','ноя','дек'];
const label=k=>{ const [y,m]=k.split('-'); return MON[+m-1]+' '+y; };

const cd={}; vm.createContext(cd);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-data.js'),'utf8')+'\nglobalThis.__RD=REAL_DATA;',cd);
const RD=cd.__RD;
RD.meta=RD.meta||{};
const plan=RD.meta.plan||(RD.meta.plan={});

function show(){
  const keys=Object.keys(plan).sort();
  if(!keys.length){ console.log('Планов нет. Поставить: node scripts/set-plan.cjs 2026-09 --wb 6280000 --oz 5500000'); return; }
  console.log('ПЛАН ПО ЧИСТОЙ ПРИБЫЛИ (календарный месяц, по площадкам):');
  keys.forEach(k=>{ const p=plan[k];
    console.log('   '+label(k)+'   ВБ '+F(p.wb||0).padStart(10)+' ₽ · Ozon '+F(p.oz||0).padStart(10)
      +' ₽ · вместе '+F((p.wb||0)+(p.oz||0)).padStart(11)+' ₽'
      +(p.setAt? '   (поставлен '+p.setAt.slice(0,10)+')':'')); });
}

const a=process.argv.slice(2);
if(!a.length||a[0]==='list'){ show(); process.exit(0); }
if(a[0]==='drop'){
  const k=a[1]; if(!k||!plan[k]){ console.error('нет плана на '+k+'. Есть: '+Object.keys(plan).join(', ')); process.exit(1); }
  delete plan[k]; console.log('План на '+label(k)+' удалён.');
}else{
  const k=a[0];
  if(!/^\d{4}-\d{2}$/.test(k)){ console.error('первый аргумент — месяц ГГГГ-ММ (например 2026-09), либо list / drop'); process.exit(1); }
  const num=n=>{ const i=a.indexOf(n); if(i<0) return null;
    const v=parseFloat((''+a[i+1]).replace(/[\s _]/g,'')); return isNaN(v)? null : v; };
  const wb=num('--wb'), oz=num('--oz');
  if(wb==null&&oz==null){ console.error('укажите хотя бы одно: --wb <сумма> и/или --oz <сумма>'); process.exit(1); }
  const cur=plan[k]||{};
  plan[k]={ wb: wb!=null? wb : (cur.wb||0), oz: oz!=null? oz : (cur.oz||0),
    setAt: new Date().toISOString() };
  console.log('План на '+label(k)+': ВБ '+F(plan[k].wb)+' ₽ · Ozon '+F(plan[k].oz)+' ₽ · вместе '+F(plan[k].wb+plan[k].oz)+' ₽');
}

fs.writeFileSync(path.join(OUT,'wb-data.js'),
  '// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\n'
  +'const REAL_DATA = '+JSON.stringify(RD)+';\n');
console.log('');
show();
console.log('\nДальше: node scripts/encrypt.cjs <код>');
