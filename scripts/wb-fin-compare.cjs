// СВЕРКА «ОЦЕНКА ПРОТИВ ОТЧЁТА» по ВБ: за каждую неделю, по которой есть и отчёт о реализации
// (BAKED_FINANCE), и оценка (MODELED_FINANCE), печатает расхождение по статьям и по товарам.
// Запускать после каждой заливки фин. отчёта (ingest-finance → bake-snapshot → calibrate-model → model-finance).
//
// ЗАЧЕМ. Оценка считает выручку по дню ЗАКАЗА (заказано ₽ × денежный выкуп), отчёт ВБ — по дню ПРОДАЖИ
// (выкуп случается в среднем через 5 дней после заказа). Поэтому в одной неделе цифры расходятся на несколько
// процентов просто из-за сдвига, и «сошлось / не сошлось» надо судить по трём строкам:
//   1) оценка как есть (по дню заказа);
//   2) та же оценка, разложенная по дню продажи через срок «заказ → продажа» (model.lag);
//   3) отчёт.
// Разница 2↔3 — настоящая ошибка оценки (выкуп, цена, возвраты); 1↔2 — только сдвиг во времени.
//
// Срок «заказ → продажа» снимается из накопителя decrypted/acc-finance.json (если он есть после ingest-finance)
// и сохраняется в REAL_DATA.meta.model.lag; без накопителя берётся сохранённый.
//
// Использование: node scripts/wb-fin-compare.cjs [--from ГГГГ-ММ-ДД --to ГГГГ-ММ-ДД] [--top 15]
'use strict';
const fs=require('fs'),vm=require('vm'),path=require('path');
const OUT=path.join(__dirname,'..','decrypted');
const argv=process.argv.slice(2), arg=(k,d)=>{const i=argv.indexOf(k);return i>=0&&argv[i+1]?argv[i+1]:d;};
const ctx={};vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(OUT,'wb-data.js'),'utf8')+'\n'+fs.readFileSync(path.join(OUT,'wb-reports.js'),'utf8')
  +'\nglobalThis.__O={RD:REAL_DATA,F:BAKED_FINANCE,M:(typeof MODELED_FINANCE!=="undefined"?MODELED_FINANCE:[])};',ctx);
const {RD,F,M}=ctx.__O;
const addD=(d,n)=>{const t=new Date(d+'T00:00:00Z');t.setUTCDate(t.getUTCDate()+n);return t.toISOString().slice(0,10);};
const dayN=s=>Math.round(Date.parse(s+'T00:00:00Z')/864e5);
const R=n=>Math.round(n).toLocaleString('ru-RU'), P=(a,b)=>b? ((a/b-1)*100>=0?'+':'')+((a/b-1)*100).toFixed(1)+'%' : '—';
const HOLD=r=>(r.logistics||0)+(r.penalty||0)+(r.storage||0)+(r.reimb||0)+(r.deduction||0)+(r.priyomka||0)+(r.loyalty||0)+(r.loyaltyPts||0);

// ---- срок «заказ → продажа» из накопителя (если есть)
let lag=RD.meta&&RD.meta.model&&RD.meta.model.lag;
try{
  const acc=Object.values(JSON.parse(fs.readFileSync(path.join(OUT,'acc-finance.json'),'utf8')));
  const k={}; let tq=0, mx='';
  for(const r of acc){ if(r.docType!=='Продажа'||r.basis!=='Продажа'||!r.orderDate||!r.date) continue;
    const L=dayN(r.date)-dayN(r.orderDate); if(L<0||L>60) continue; k[L]=(k[L]||0)+(r.qty||0); tq+=r.qty||0; if(r.date>mx) mx=r.date; }
  if(tq>=300){ const kernel={}; let mean=0; Object.keys(k).forEach(L=>{ kernel[L]=+(k[L]/tq).toFixed(5); mean+=L*k[L]/tq; });
    lag={kernel,mean:+mean.toFixed(2),sales:tq,reportTo:mx};
    RD.meta.model=RD.meta.model||{}; RD.meta.model.lag=lag;
    fs.writeFileSync(path.join(OUT,'wb-data.js'),'// Автосгенерировано из выгрузки продавца. Обновляется целиком при новой загрузке.\n'
      +'const REAL_DATA = '+JSON.stringify(RD)+';\n');
    console.log('Срок «заказ → продажа» снят с '+tq+' продаж (отчёт по '+mx+'): в среднем '+lag.mean+' дн. — записан в meta.model.lag'); }
}catch(e){ /* накопителя нет — берём сохранённый срок */ }

// ---- недели, где есть и факт, и оценка
const estDates=new Set(M.map(r=>r.date));
const factDates=[...new Set(F.map(r=>r.date))].filter(d=>estDates.has(d)).sort();
const FROM=arg('--from',factDates[0]), TO=arg('--to',factDates[factDates.length-1]);
if(!factDates.length){ console.log('Нет дней, где есть и отчёт, и оценка, — сверять нечего.'); process.exit(0); }
const cat={}; RD.catalog.forEach(x=>cat[''+x.sku]=x);
function costAt(sku,d){ const x=cat[sku]; if(!x) return 0; const h=x.costHistory; if(!h||!h.length) return x.costPrice||0;
  let v=x.costPrice||0; for(const e of h){ if(e.from==null||e.from<=d) v=e.cost; } return v; }
const blocks=(RD.meta.model&&RD.meta.model.blocks)||[];
const rateFor=d=>{ let p=blocks[0]; blocks.forEach(b=>{ if(b.to<d) p=b; }); return p? p.payoutRate : RD.meta.model.payoutRate; };

const fact={rev:0,net:0,qty:0,cogs:0}, est={rev:0,net:0,qty:0,cogs:0}, bySku={};
const S=sku=>bySku[sku]||(bySku[sku]={fRev:0,fNet:0,fQty:0,fCogs:0,eRev:0,eNet:0,eQty:0,eCogs:0});
F.forEach(r=>{ if(r.date<FROM||r.date>TO) return; const q=(r.qty||0)-(r.returnsQty||0), net=(r.payout||0)-HOLD(r), c=q*costAt(r.sku,r.date);
  fact.rev+=r.revenue||0; fact.net+=net; fact.qty+=q; fact.cogs+=c; const s=S(r.sku); s.fRev+=r.revenue||0; s.fNet+=net; s.fQty+=q; s.fCogs+=c; });
M.forEach(r=>{ if(r.date<FROM||r.date>TO) return; const net=(r.revenue||0)*rateFor(r.date);
  est.rev+=r.revenue||0; est.net+=net; est.qty+=r.qty||0; est.cogs+=r.cogsEst||0; const s=S(r.sku); s.eRev+=r.revenue||0; s.eNet+=net; s.eQty+=r.qty||0; s.eCogs+=r.cogsEst||0; });
// оценка по дню ПРОДАЖИ: выручка дня d = Σ оценка(d − L) × доля продаж со сроком L
let estSale=null;
if(lag&&lag.kernel){ const revByDate={}; M.forEach(r=>{ revByDate[r.date]=(revByDate[r.date]||0)+(r.revenue||0); });
  estSale=0; let miss=0;
  for(let d=FROM; d<=TO; d=addD(d,1)) for(const [L,w] of Object.entries(lag.kernel)){ const od=addD(d,-(+L));
    if(revByDate[od]==null) miss+=w; else estSale+=revByDate[od]*w; }
  if(miss>0.5) estSale=null; }

console.log('\nСВЕРКА ВБ «оценка против отчёта» за '+FROM+' … '+TO);
console.log('─'.repeat(78));
const line=(name,e,f)=>console.log('  '+name.padEnd(30)+R(e).padStart(12)+R(f).padStart(13)+R(f-e).padStart(12)+'  '+P(f,e));
console.log('  '+''.padEnd(30)+'оценка'.padStart(12)+'отчёт'.padStart(13)+'разница'.padStart(12));
line('продано, шт',est.qty,fact.qty);
line('выручка',est.rev,fact.rev);
if(estSale!=null) line('  выручка по дню продажи*',estSale,fact.rev);
line('итого к оплате',est.net,fact.net);
line('себестоимость',est.cogs,fact.cogs);
line('прибыль до рекламы',est.net-est.cogs,fact.net-fact.cogs);
console.log('  доля «к оплате» в выручке:   оценка '+(est.net/est.rev*100).toFixed(2)+'%   отчёт '+(fact.net/fact.rev*100).toFixed(2)+'%');
if(estSale!=null) console.log('  * та же оценка, но выручка разнесена по дням продажи (срок заказ → продажа в среднем '+lag.mean+' дн.).\n'
  +'    Разница этой строки с отчётом — настоящая ошибка оценки; остальное — сдвиг во времени, за месяц он уходит.');
const top=+arg('--top','12');
const L=Object.entries(bySku).map(([sku,s])=>({sku,sup:(cat[sku]||{}).supplierCode||sku,name:((cat[sku]||{}).name||'').slice(0,30),
  d:(s.fNet-s.fCogs)-(s.eNet-s.eCogs),s})).sort((a,b)=>Math.abs(b.d)-Math.abs(a.d)).slice(0,top);
console.log('\n  Товары с самым большим расхождением прибыли до рекламы (отчёт − оценка):');
L.forEach(x=>console.log('   '+String(x.sup).padEnd(8)+x.name.padEnd(31)+' шт '+String(Math.round(x.s.fQty)).padStart(4)+' / '+String(Math.round(x.s.eQty)).padStart(4)
  +' · к оплате '+(x.s.fRev? (x.s.fNet/x.s.fRev*100).toFixed(0)+'%':'  —')+' · прибыль '+R(x.s.fNet-x.s.fCogs).padStart(9)+' / '+R(x.s.eNet-x.s.eCogs).padStart(9)+' · Δ '+R(x.d).padStart(9)));
