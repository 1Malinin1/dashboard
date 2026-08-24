// Удаляет ОДИН день из данных ВБ: REAL_DATA.orderSeries (dates + bySku + money)
// и BAKED_FUNNEL в decrypted/wb-reports.js.
// Зачем: продавец иногда присылает отчёт за СЕГОДНЯ — он неполный (выгружен утром),
// и окно «последние 7 дней», по которому считается подсорт, из-за него проседает.
// Ряды bySku держатся строго одной длины с dates, поэтому индекс вырезается из ВСЕХ.
//
// Использование: node scripts/wb-drop-day.cjs 2026-08-24
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');
const OUT=path.join(__dirname,'..','decrypted');
const day=process.argv[2];
if(!/^\d{4}-\d{2}-\d{2}$/.test(day||'')){console.error('usage: node scripts/wb-drop-day.cjs ГГГГ-ММ-ДД');process.exit(1);}

const ctx={};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-data.js'),'utf8')+'\nglobalThis.__RD=REAL_DATA;',ctx);
const RD=ctx.__RD, os=RD.orderSeries;
const i=os.dates.indexOf(day);
if(i<0){ console.error('дня '+day+' в ряду заказов нет — нечего удалять'); process.exit(1); }

let qty=0; Object.values(os.bySku).forEach(a=>qty+=a[i]||0);
let rub=0; if(os.money&&os.money[day]) Object.values(os.money[day]).forEach(v=>rub+=v[0]||0);
os.dates.splice(i,1);
Object.keys(os.bySku).forEach(k=>os.bySku[k].splice(i,1));
if(os.money) delete os.money[day];
const bad=Object.entries(os.bySku).filter(([,v])=>v.length!==os.dates.length);
if(bad.length){ console.error('❌ ряды разъехались с осью дат ('+bad.length+') — снимок НЕ записан'); process.exit(1); }
fs.writeFileSync(path.join(OUT,'wb-data.js'),
  '// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\n'
  +'const REAL_DATA = '+JSON.stringify(RD)+';\n');

// воронка: перечитываем ВЕСЬ файл отчётов и пишем его обратно в ТОЙ ЖЕ форме.
// Формат обязан совпадать с bake-funnel.cjs: encrypt.cjs ждёт и служебные константы
// (BAKED_AT, *_ROWS) — без них шифрование падает с ReferenceError.
const c2={};vm.createContext(c2);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-reports.js'),'utf8')
  +'\nglobalThis.__B={BAKED_AT,BAKED_PERIOD,BAKED_FINANCE_ROWS,BAKED_ADS_ROWS,'
  +'BAKED_FUNNEL_ROWS:(typeof BAKED_FUNNEL_ROWS!=="undefined"?BAKED_FUNNEL_ROWS:0),'
  +'BAKED_FINANCE,BAKED_ADS,BAKED_FUNNEL:(typeof BAKED_FUNNEL!=="undefined"?BAKED_FUNNEL:[])};',c2);
const B=c2.__B, before=B.BAKED_FUNNEL.length;
const kept=B.BAKED_FUNNEL.filter(r=>r.date!==day);
fs.writeFileSync(path.join(OUT,'wb-reports.js'),
  '// Зашитый снимок отчётов (финансы + реклама + воронка) по нашим артикулам.\n'
  +'const BAKED_AT="'+B.BAKED_AT+'", BAKED_PERIOD="'+B.BAKED_PERIOD+'";\n'
  +'const BAKED_FINANCE_ROWS='+B.BAKED_FINANCE_ROWS+', BAKED_ADS_ROWS='+B.BAKED_ADS_ROWS+', BAKED_FUNNEL_ROWS='+kept.length+';\n'
  +'const BAKED_FINANCE='+JSON.stringify(B.BAKED_FINANCE)+';\n'
  +'const BAKED_ADS='+JSON.stringify(B.BAKED_ADS)+';\n'
  +'const BAKED_FUNNEL='+JSON.stringify(kept)+';\n');

console.log('Удалён день '+day+': заказов '+qty+' шт · '+Math.round(rub).toLocaleString('ru-RU')+' ₽ · строк воронки '+(before-kept.length));
console.log('Ряд заказов: дней '+os.dates.length+' (по '+os.dates[os.dates.length-1]+')');
const dd=[...new Set(kept.map(r=>r.date))].sort();
console.log('Воронка: '+kept.length+' строк · дней '+dd.length+' ('+dd[0]+' … '+dd[dd.length-1]+')');
console.log('\nДальше: node scripts/encrypt.cjs <код>');
