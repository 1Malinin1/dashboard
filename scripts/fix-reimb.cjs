// РАЗОВАЯ ПРАВКА (12.11.2026): «Возмещение издержек» больше не вычитается из «Итого к оплате» ВБ.
//
// ПОЧЕМУ. Сверка с кабинетом ВБ (отчёт №896659722, скрин продавца 12.11.2026): «Итого к оплате» =
// К перечислению − доставка − хранение − обработка − прочие удержания − штрафы − корректировка ВВ − лояльность − баллы.
// Строки «Возмещение издержек по перемещению и операционной обработке товара» в итог не входят: в них же
// «Вознаграждение ВВ» и НДС стоят с минусом на ту же сумму — это перекладка внутри комиссии. Старый разбор
// вычитал колонку как расход (29.06–02.08: 927 963 ₽ = 1,38% выручки — «итого к оплате» было занижено).
// Новые отчёты разбираются уже верно (lib/parse-wb.cjs: reimb = 0, сумма справочно в reimbInfo).
//
// Что делает: во всех строках BAKED_FINANCE переносит reimb → reimbInfo и ставит reimb = 0.
// Повторный запуск ничего не делает: метка REAL_DATA.meta.finReimbFix.
// Использование: node scripts/fix-reimb.cjs [--dry]     дальше: calibrate-model → model-finance → encrypt
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');
const OUT=path.join(__dirname,'..','decrypted');
const DRY=process.argv.includes('--dry');
const ctx={};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-data.js'),'utf8')+'\n'+fs.readFileSync(path.join(OUT,'wb-reports.js'),'utf8')
  +'\nglobalThis.__O={REAL_DATA,BAKED_AT,BAKED_PERIOD,BAKED_FINANCE_ROWS,BAKED_ADS_ROWS,'
  +'BAKED_FUNNEL_ROWS:(typeof BAKED_FUNNEL_ROWS!=="undefined"?BAKED_FUNNEL_ROWS:0),BAKED_FINANCE,BAKED_ADS,'
  +'BAKED_FUNNEL:(typeof BAKED_FUNNEL!=="undefined"?BAKED_FUNNEL:[]),MODELED_FINANCE:(typeof MODELED_FINANCE!=="undefined"?MODELED_FINANCE:[])};',ctx);
const O=ctx.__O, RD=O.REAL_DATA; RD.meta=RD.meta||{};
if(RD.meta.finReimbFix){ console.log('Уже исправлено '+RD.meta.finReimbFix.at+' — ничего не делаю.'); process.exit(0); }
let n=0,sum=0,rev=0;
for(const r of O.BAKED_FINANCE){ rev+=r.revenue||0; if(!r.reimb) continue; n++; sum+=r.reimb;
  if(!DRY){ r.reimbInfo=+((r.reimbInfo||0)+r.reimb).toFixed(2); r.reimb=0; } }
const R=x=>Math.round(x).toLocaleString('ru-RU');
console.log('Строк с «возмещением издержек»: '+n+' · сумма '+R(sum)+' ₽ ('+(sum/rev*100).toFixed(2)+'% выручки) — больше не вычитается, «итого к оплате» выросло на эту сумму');
if(DRY){ console.log('(сухой прогон, ничего не записано)'); process.exit(0); }
RD.meta.finReimbFix={at:new Date().toISOString().slice(0,10),rows:n,delta:Math.round(sum),
  note:'«возмещение издержек» в «Итого к оплате» ВБ не входит (сверено с кабинетом); reimb → reimbInfo'};
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
