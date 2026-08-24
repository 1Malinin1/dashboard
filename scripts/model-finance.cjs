// Достраивает финансы ОЦЕНКОЙ за даты после последнего фактического отчёта о реализации.
// Пишет MODELED_FINANCE в decrypted/wb-reports.js. Дальше: node scripts/encrypt.cjs <код>
//
// ЗАЧЕМ. Продавцу закрыли доступ к отчётам «О реализации» (24.08.2026), но заказы, выкупы,
// себестоимость и рекламу он видит. Прибыль складывается из них по коэффициентам, снятым
// с фактических 5 недель (`REAL_DATA.meta.model`, см. calibrate-model.cjs).
//
// ЦЕПОЧКА (на каждый день и артикул):
//   заказано ₽ (факт, дозревания не требует)         ← REAL_DATA.orderSeries.money
//     × денежный выкуп окна                          ← moneyBuyout, по умолчанию из meta.buyoutWin
//   = выручка
//     × payoutRate (62.0%)                            ← meta.model
//   = «итого к оплате»
//   − себестоимость проданного (штуки × цена на дату) ← orderSeries.bySku × выкуп × costAt
//   − реклама (вводится аргументом, по умолчанию 0)
//   = прибыль
//
// ЧЕСТНОСТЬ. Каждая строка помечена `est:true` — дашборд обязан показывать её как ОЦЕНКУ,
// никогда не смешивая с фактом молча. Разложение удержаний внутри строки условное:
// комиссия и удержания разнесены в тех же долях, что были по факту, чтобы вкладка «Финансы»
// не показывала пустые колонки. Точность: «итого к оплате» из выручки — 0.3%, но сама
// выручка — оценка (выкуп снят с прошлого окна), поэтому итог ±10–15%.
//
// Использование:
//   node scripts/model-finance.cjs [--from ГГГГ-ММ-ДД] [--to ГГГГ-ММ-ДД]
//                                  [--ads СУММА] [--buyout 0.667] [--clear]
//   --from по умолчанию = следующий день после последней даты BAKED_FINANCE
//   --to   по умолчанию = последняя дата, за которую есть заказы
//   --ads  расход на рекламу за ВЕСЬ период (разносится пропорционально выручке дня)
//   --clear убирает оценку из снимка (когда придёт настоящий отчёт)
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');
const OUT=path.join(__dirname,'..','decrypted');

const argv=process.argv.slice(2);
const arg=(k,d)=>{const i=argv.indexOf(k);return i>=0&&argv[i+1]?argv[i+1]:d;};
const CLEAR=argv.includes('--clear');

const ctx={};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-data.js'),'utf8')+'\n'
  +fs.readFileSync(path.join(OUT,'wb-reports.js'),'utf8')
  +'\nglobalThis.__O={REAL_DATA,BAKED_AT,BAKED_PERIOD,BAKED_FINANCE_ROWS,BAKED_ADS_ROWS,'
  +'BAKED_FUNNEL_ROWS:(typeof BAKED_FUNNEL_ROWS!=="undefined"?BAKED_FUNNEL_ROWS:0),'
  +'BAKED_FINANCE,BAKED_ADS,BAKED_FUNNEL:(typeof BAKED_FUNNEL!=="undefined"?BAKED_FUNNEL:[])};',ctx);
const O=ctx.__O, RD=O.REAL_DATA;

function write(modeled){
  fs.writeFileSync(path.join(OUT,'wb-reports.js'),
    '// Зашитый снимок отчётов (финансы + реклама + воронка) по нашим артикулам.\n'
    +'const BAKED_AT="'+O.BAKED_AT+'", BAKED_PERIOD="'+O.BAKED_PERIOD+'";\n'
    +'const BAKED_FINANCE_ROWS='+O.BAKED_FINANCE_ROWS+', BAKED_ADS_ROWS='+O.BAKED_ADS_ROWS+', BAKED_FUNNEL_ROWS='+O.BAKED_FUNNEL_ROWS+';\n'
    +'const BAKED_FINANCE='+JSON.stringify(O.BAKED_FINANCE)+';\n'
    +'const BAKED_ADS='+JSON.stringify(O.BAKED_ADS)+';\n'
    +'const BAKED_FUNNEL='+JSON.stringify(O.BAKED_FUNNEL)+';\n'
    +'const MODELED_FINANCE='+JSON.stringify(modeled)+';\n');
}
if(CLEAR){ write([]); console.log('Оценка убрана из снимка. Дальше: node scripts/encrypt.cjs <код>'); process.exit(0); }

const MODEL=RD.meta&&RD.meta.model;
if(!MODEL){ console.error('нет REAL_DATA.meta.model — сначала node scripts/calibrate-model.cjs'); process.exit(1); }
const BW=RD.meta&&RD.meta.buyoutWin;

const S=RD.orderSeries, M=S.money||{};
const finDates=[...new Set(O.BAKED_FINANCE.map(r=>r.date))].sort();
const lastFact=finDates[finDates.length-1];
const addD=(d,n)=>{const t=new Date(d+'T00:00:00Z');t.setUTCDate(t.getUTCDate()+n);return t.toISOString().slice(0,10);};
const moneyDates=Object.keys(M).sort();
const FROM=arg('--from', addD(lastFact,1));
const TO=arg('--to', moneyDates[moneyDates.length-1]||S.dates[S.dates.length-1]);
const ADS=parseFloat(arg('--ads','0'))||0;
// Денежный выкуп: доля заказанных ₽, которая доходит до выручки. По умолчанию берём
// штучный выкуп дозревшего окна — он ближе всего к правде и уже проверен на зрелость.
const MB=parseFloat(arg('--buyout', BW&&BW.all? String(BW.all) : '0.75'));
if(FROM>TO){ console.error('нечего моделировать: from '+FROM+' > to '+TO); process.exit(1); }

const catBySku={}; RD.catalog.forEach(x=>catBySku[''+x.sku]=x);
function costAt(sku,d){ const x=catBySku[sku]; if(!x) return 0;
  const h=x.costHistory; if(!h||!h.length) return x.costPrice||0;
  let v=x.costPrice||0; for(const e of h){ if(e.from==null||e.from<=d) v=e.cost; } return v; }
// доли удержаний внутри выручки — из факта, чтобы вкладка «Финансы» не была пустой
const commRate=MODEL.commissionRate, payRate=MODEL.payoutRate;
const holdRate=Math.max(0,(1-commRate)-payRate);          // всё, что удерживают сверх комиссии
const factLogShare=(()=>{ let log=0,hold=0;
  O.BAKED_FINANCE.forEach(r=>{ log+=r.logistics||0;
    hold+=(r.logistics||0)+(r.penalty||0)+(r.storage||0)+(r.reimb||0)+(r.deduction||0)+(r.priyomka||0)+(r.loyalty||0)+(r.loyaltyPts||0); });
  return hold? log/hold : 0; })();

const dIdx={}; S.dates.forEach((d,i)=>dIdx[d]=i);
const rows=[]; let revTot=0,cogsTot=0,qtyTot=0,noCost=new Set();
for(let d=FROM; d<=TO; d=addD(d,1)){
  const i=dIdx[d]; const money=M[d]||null;
  if(i==null && !money) continue;
  // выручка дня по артикулам — из заказанных ₽; если денег нет, оцениваем через средний чек
  const bySku={};
  if(money){ Object.entries(money).forEach(([sku,v])=>{ bySku[sku]={rev:(v[0]||0)*MB}; }); }
  if(i!=null) Object.entries(S.bySku).forEach(([sku,arr])=>{
    const q=arr[i]||0; if(!q) return;
    const bo=(BW&&BW.bySku&&BW.bySku[sku]>0)? BW.bySku[sku] : (BW&&BW.all? BW.all : MB);
    const e=bySku[sku]||(bySku[sku]={});
    e.qty=q*bo;
    if(e.rev==null) e.rev=e.qty*(MODEL.avgTicket||0);      // денег за день нет — через средний чек
  });
  Object.entries(bySku).forEach(([sku,e])=>{
    const rev=e.rev||0; if(rev<=0 && !e.qty) return;
    const c=catBySku[sku]; const cp=costAt(sku,d);
    const qty=e.qty!=null? e.qty : (MODEL.avgTicket? rev/MODEL.avgTicket : 0);
    if(!cp && qty>0) noCost.add(sku);
    const payout=rev*(1-commRate);
    const hold=rev*holdRate;
    const log=hold*factLogShare, rest=hold-log;
    rows.push({id:d+'_'+sku, date:d, sku,
      name:(c&&c.name)||sku, category:(c&&c.category)||'',
      qty:+qty.toFixed(2), returnsQty:0, revenue:+rev.toFixed(2),
      payout:+payout.toFixed(2), logistics:+log.toFixed(2), penalty:0, storage:0,
      reimb:+rest.toFixed(2), deduction:0, priyomka:0, loyalty:0, loyaltyPts:0,
      cogsEst:+(qty*cp).toFixed(2), est:true});
    revTot+=rev; cogsTot+=qty*cp; qtyTot+=qty;
  });
}
// реклама за период разносится пропорционально выручке дня (в BAKED_ADS не пишем — там факт)
if(ADS>0 && revTot>0) rows.forEach(r=>{ r.adEst=+(ADS*(r.revenue/revTot)).toFixed(2); });

write(rows);

const R=n=>Math.round(n).toLocaleString('ru-RU')+' ₽';
const net=revTot*payRate, profit=net-cogsTot-ADS;
console.log('ОЦЕНКА ФИНАНСОВ за '+FROM+' … '+TO+'  ('+rows.length+' строк, факт заканчивается '+lastFact+')');
console.log('─'.repeat(64));
console.log('  денежный выкуп применён:  '+(MB*100).toFixed(1)+'%'+(BW? ' (окно '+BW.from+'…'+BW.to+')':''));
console.log('  выручка (оценка):         '+R(revTot));
console.log('  итого к оплате ('+(payRate*100).toFixed(1)+'%):  '+R(net));
console.log('  себестоимость проданного: '+R(cogsTot)+'  ('+Math.round(qtyTot).toLocaleString('ru-RU')+' шт)');
console.log('  реклама:                  '+R(ADS));
console.log('  ПРИБЫЛЬ (оценка):         '+R(profit)+'   маржа '+(revTot?(profit/revTot*100).toFixed(1):'—')+'%');
if(noCost.size) console.log('  ⚠ без себестоимости артикулов: '+noCost.size);
console.log('\nСтроки помечены est:true — на дашборде показываются как ОЦЕНКА.');
console.log('Когда придёт настоящий отчёт за этот период: node scripts/model-finance.cjs --clear');
console.log('Дальше: node scripts/encrypt.cjs <код>');
