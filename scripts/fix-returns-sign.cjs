// РАЗОВАЯ ПРАВКА (12.11.2026): знак возвратов в зашитом факте ВБ за 29.06–02.08.2026.
//
// ЧТО БЫЛО. В строках «Возврат» отчёта о реализации ВБ пишет «К перечислению» плюсом, а в итоге недели
// вычитает. Старый разбор складывал колонку как есть — возврат ПРИБАВЛЯЛ деньги к «к перечислению».
// Доказательство в самом снимке: 13 строк «в этот день по товару был только возврат» — выручка
// отрицательная, а «к перечислению» положительное.
//
// КАК ЧИНИМ БЕЗ ИСХОДНЫХ ФАЙЛОВ (их нет, в снимке только свод «день × товар»):
//   payout_верный = payout × (продано − возвращено) ÷ (продано + возвращено)
// Точно, когда цена и комиссия продажи и возврата одного товара в один день равны (товар и день одни и те же);
// для дня «только возврат» — точно всегда (payout меняет знак).
// Повторный запуск ничего не делает: метка REAL_DATA.meta.finReturnsFix.
// Новые отчёты разбираются уже с верным знаком (scripts/lib/parse-wb.cjs).
//
// Использование: node scripts/fix-returns-sign.cjs [--dry]     дальше: calibrate-model → model-finance → encrypt
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');
const OUT=path.join(__dirname,'..','decrypted');
const DRY=process.argv.includes('--dry');
const UNTIL='2026-08-02';   // всё, что залито позже, разобрано уже верно
const ctx={};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-data.js'),'utf8')+'\n'+fs.readFileSync(path.join(OUT,'wb-reports.js'),'utf8')
  +'\nglobalThis.__O={REAL_DATA,BAKED_AT,BAKED_PERIOD,BAKED_FINANCE_ROWS,BAKED_ADS_ROWS,'
  +'BAKED_FUNNEL_ROWS:(typeof BAKED_FUNNEL_ROWS!=="undefined"?BAKED_FUNNEL_ROWS:0),BAKED_FINANCE,BAKED_ADS,'
  +'BAKED_FUNNEL:(typeof BAKED_FUNNEL!=="undefined"?BAKED_FUNNEL:[]),MODELED_FINANCE:(typeof MODELED_FINANCE!=="undefined"?MODELED_FINANCE:[])};',ctx);
const O=ctx.__O, RD=O.REAL_DATA; RD.meta=RD.meta||{};
if(RD.meta.finReturnsFix){ console.log('Уже исправлено '+RD.meta.finReturnsFix.at+' — ничего не делаю.'); process.exit(0); }
let n=0,before=0,after=0,rev=0,payAll=0;
for(const r of O.BAKED_FINANCE){ if(r.date>UNTIL) continue; rev+=r.revenue||0; payAll+=r.payout||0;
  const q=r.qty||0, ret=r.returnsQty||0; if(!(ret>0)) continue;
  const fixed=(r.payout||0)*(q-ret)/(q+ret);
  before+=r.payout||0; after+=fixed; n++;
  if(!DRY) r.payout=+fixed.toFixed(2); }
const R=x=>Math.round(x).toLocaleString('ru-RU');
console.log('Строк «день × товар» с возвратами: '+n+' · «к перечислению» по ним было '+R(before)+' ₽ → стало '+R(after)+' ₽ (−'+R(before-after)+' ₽)');
console.log('За 29.06–02.08: «к перечислению» '+R(payAll)+' → '+R(payAll-(before-after))+' ₽ · это '+((before-after)/rev*100).toFixed(2)+'% выручки ('+R(rev)+' ₽)');
if(DRY){ console.log('(сухой прогон, ничего не записано)'); process.exit(0); }
RD.meta.finReturnsFix={at:new Date().toISOString().slice(0,10),until:UNTIL,rows:n,delta:Math.round(before-after),
  note:'возвраты в «к перечислению» шли плюсом; исправлено по формуле payout×(продано−возвраты)÷(продано+возвраты)'};
fs.writeFileSync(path.join(OUT,'wb-data.js'),'// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\n'
  +'const REAL_DATA = '+JSON.stringify(RD)+';\n');
fs.writeFileSync(path.join(OUT,'wb-reports.js'),
  '// Зашитый снимок отчётов (финансы + реклама + воронка) по нашим артикулам.\n'
  +'const BAKED_AT="'+O.BAKED_AT+'", BAKED_PERIOD="'+O.BAKED_PERIOD+'";\n'
  +'const BAKED_FINANCE_ROWS='+O.BAKED_FINANCE_ROWS+', BAKED_ADS_ROWS='+O.BAKED_ADS_ROWS+', BAKED_FUNNEL_ROWS='+O.BAKED_FUNNEL_ROWS+';\n'
  +'const BAKED_FINANCE='+JSON.stringify(O.BAKED_FINANCE)+';\n'
  +'const BAKED_ADS='+JSON.stringify(O.BAKED_ADS)+';\n'
  +'const BAKED_FUNNEL='+JSON.stringify(O.BAKED_FUNNEL)+';\n'
  +'const MODELED_FINANCE='+JSON.stringify(O.MODELED_FINANCE)+';\n');
console.log('Записано. Дальше: node scripts/calibrate-model.cjs → node scripts/model-finance.cjs → node scripts/encrypt.cjs <код>');
